import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultScript, startMockModelServer } from "./mock-model-server.ts";
import { spawnRpcHost, type RpcHost } from "./rpc-client.ts";
import { spawnTuiHost, type TuiHost } from "./tui-client.ts";

/**
 * Real-host smoke test for observational memory's activation boundary (#14).
 *
 * See `tests/smoke/README.md` for prerequisites and invocation. This file is
 * deliberately outside `vitest.config.ts`'s `tests/**\/*.test.ts` include
 * pattern, so `bun run test` never picks it up; it is only run via
 * `bun run test:smoke`, which requires the real `omp` CLI on `PATH`.
 *
 * Scope note: the smoke covers both real OMP command surfaces. The TUI path
 * uses a real pseudo-terminal allocated by `script`; the RPC path uses OMP's
 * JSONL command route. Both paths reach the same extension command handlers,
 * and the separate RPC process also exercises independent headless activation.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const omExtensionPath = join(repoRoot, "src", "index.ts");
const providerExtensionPath = join(here, "fixture-provider.ts");
const taskToolExtensionPath = join(here, "child-task-tool.ts");
const seedExtensionPath = join(here, "seed-ledger.ts");
const notificationProbePath = join(here, "notification-probe.ts");
const tuiPtyPath = join(here, "tui-pty.py");
const ompBin = process.env.OM_SMOKE_OMP_BIN ?? "omp";

let failures = 0;
const steps: string[] = [];

function assert(condition: boolean, message: string): void {
	if (condition) {
		steps.push(`PASS: ${message}`);
		return;
	}
	failures += 1;
	steps.push(`FAIL: ${message}`);
	console.error(`FAIL: ${message}`);
}

function makeCwd(label: string): string {
	const cwd = join(tmpdir(), `om-smoke-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	return cwd;
}

function writeSettings(cwd: string, settings: Record<string, unknown>): void {
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(settings, null, 2));
}

async function pollStatusUntil(
	host: RpcHost,
	predicate: (text: string) => boolean,
	attempts: number,
	delayMs: number,
): Promise<string> {
	let lastText = "";
	for (let i = 0; i < attempts; i++) {
		const { notifications } = await host.promptAndSettle("/om:status");
		lastText = notifications.join("\n");
		if (predicate(lastText)) return lastText;
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, delayMs);
		await promise;
	}
	return lastText;
}

async function runProcessA(baseUrl: string): Promise<void> {
	const cwd = makeCwd("parent");
	writeSettings(cwd, {
		"observational-memory": {
			model: { provider: "om-smoke", id: "om-smoke-model" },
			observeAfterTokens: 1,
			reflectAfterTokens: 999_999_999,
			compactAfterTokens: 999_999_999,
			showWorkerNotifications: true,
		},
		compaction: { keepRecentTokens: 1, reserveTokens: 1 },
	});
	const reportPath = join(cwd, "child-report.json");
	const host = spawnRpcHost(
		ompBin,
		[omExtensionPath, providerExtensionPath, taskToolExtensionPath],
		{
			...process.env,
			OM_SMOKE_BASE_URL: baseUrl,
			OM_SMOKE_OM_EXTENSION_PATH: omExtensionPath,
			OM_SMOKE_PROVIDER_EXTENSION_PATH: providerExtensionPath,
			OM_SMOKE_NOTIFICATION_PROBE_PATH: notificationProbePath,
			OM_SMOKE_CHILD_MARKER: "smokeA-child",
			OM_SMOKE_REPORT_PATH: reportPath,
		},
		cwd,
	);

	try {
		const largePrompt = "SMOKE_PADDING ".repeat(10_000);
		await host.promptAndSettle(`SMOKE_MARKER: smokeA\nSMOKE_ACTION: plain\n${largePrompt}`);
		await host.promptAndSettle(`SMOKE_MARKER: smokeA\nSMOKE_ACTION: plain\n${largePrompt}`);
		await host.promptAndSettle("SMOKE_MARKER: smokeA\nSMOKE_ACTION: plain\nHello, please just acknowledge.");
		await host.promptAndSettle("SMOKE_MARKER: smokeA\nSMOKE_ACTION: plain\nSecond turn so compaction has an older turn to cut away.");

		const preActivationCompaction = await host.compact();
		assert(
			!preActivationCompaction.summary.includes("## Observations") && !preActivationCompaction.summary.includes("## Reflections"),
			"Process A: disabled compaction (pre-/om) injects no observational summary sections",
		);

		const activation = await host.promptAndSettle("/om");
		assert(
			activation.notifications.some((n) => n.includes("Observational memory enabled for this session.")),
			"Process A: /om dispatched over RPC activates observational memory",
		);

		const repeat = await host.promptAndSettle("/om");
		assert(
			repeat.notifications.some((n) => n.includes("already enabled")),
			"Process A: repeated /om is idempotent",
		);

		const statusAfterActivation = await host.promptAndSettle("/om:status");
		const statusText = statusAfterActivation.notifications.join("\n");
		assert(statusText.includes("── Memory ──"), "Process A: /om:status reports enabled memory section over RPC");
		assert(statusText.includes("Observations: 0 recorded"), "Process A: /om:status starts with zero observations recorded");

		const view = await host.promptAndSettle("/om:view");
		const viewText = view.notifications.join("\n");
		assert(
			viewText.includes("── Reflections ──") && !viewText.includes("Observational memory is disabled"),
			"Process A: /om:view reports enabled content over RPC",
		);

		await host.promptAndSettle(
			"SMOKE_MARKER: smokeA\nSMOKE_ACTION: plain\nPlease acknowledge this too. Some content for the observer to record.",
		);
		const observedStatus = await pollStatusUntil(host, (t) => t.includes("Observations: 1 recorded"), 15, 1000);
		assert(observedStatus.includes("Observations: 1 recorded"), "Process A: observer records one observation after activation");
		await host.promptAndSettle(`SMOKE_MARKER: smokeA\nSMOKE_ACTION: plain\n${largePrompt}`);
		await host.promptAndSettle(`SMOKE_MARKER: smokeA\nSMOKE_ACTION: plain\n${largePrompt}`);

		const postActivationCompaction = await host.compact();
		assert(
			postActivationCompaction.summary.includes("## Observations"),
			"Process A: enabled compaction supplies the observational projection",
		);

		await host.promptAndSettle(
			"SMOKE_MARKER: smokeA\nSMOKE_ACTION: call_task\nPlease call the smoke task tool and report the child session status.",
		);

		assert(existsSync(reportPath), `Process A: smoke_task wrote a child session report${existsSync(reportPath) ? "" : `; host stderr: ${host.stderrText()}`}`);
		if (existsSync(reportPath)) {
			const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
				activeToolNames: string[];
				recallActive: boolean;
				omToolResultCount: number;
				omEntryCount: number;
				observationalNotificationCount: number;
				omEntryCustomTypes: string[];
				compactionEntryCount: number;
				compactionSummary: string | null;
				compactionDetails: unknown;
			};
			assert(
				report.observationalNotificationCount === 0,
				"Child subagent produced no observational-memory notifications",
			);
			assert(report.omToolResultCount === 0, "Child subagent produced no observational-memory tool results");
			assert(
				!report.recallActive,
				`Child subagent cannot access observational-memory recall while disabled (active tools: ${JSON.stringify(report.activeToolNames)})`,
			);
			assert(report.omEntryCount === 0, `Child subagent wrote zero observational-memory ledger entries (found: ${JSON.stringify(report.omEntryCustomTypes)})`);
			assert(report.compactionEntryCount >= 1, "Child subagent produced a native compaction entry");
			assert(
				!(report.compactionSummary ?? "").includes("## Observations") && !(report.compactionSummary ?? "").includes("## Reflections"),
				"Child subagent's compaction summary carries no observational-memory sections",
			);
			const details = report.compactionDetails as Record<string, unknown> | null;
			assert(
				details === null || !("fullFold" in details) || !("observations" in details),
				"Child subagent's compaction details are native shape, not the observational-memory fold shape",
			);
		}

		await host.newSession();
		const resetStatus = await pollStatusUntil(
			host,
			(text) => text.includes("Observational memory is disabled; run /om to enable it."),
			15,
			1000,
		);
		assert(
			resetStatus.includes("Observational memory is disabled; run /om to enable it."),
			"Process A: new_session boundary resets activation instead of inheriting it",
		);
	} finally {
		await host.stop();
		rmSync(cwd, { recursive: true, force: true });
	}
}

async function runProcessTui(baseUrl: string): Promise<void> {
	const cwd = makeCwd("tui");
	writeSettings(cwd, {
		"observational-memory": {
			model: { provider: "om-smoke", id: "om-smoke-model" },
			observeAfterTokens: 1,
			reflectAfterTokens: 999_999_999,
			compactAfterTokens: 999_999_999,
			showWorkerNotifications: true,
		},
		compaction: { keepRecentTokens: 1, reserveTokens: 1 },
	});
	const host: TuiHost = spawnTuiHost(
		tuiPtyPath,
		ompBin,
		[omExtensionPath, providerExtensionPath],
		{ ...process.env, OM_SMOKE_BASE_URL: baseUrl },
		cwd,
	);

	try {
		await host.waitFor(
			(output) => output.includes("LSP Servers") || output.includes("No LSP servers"),
			30_000,
			"OMP TUI startup",
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 4_000));
		host.send("/om:status");
		await host.waitFor(
			(output) => output.includes("Observational memory is disabled; run /om to enable it."),
			30_000,
			"TUI initial disabled status",
		);
		assert(
			host.has("Observational memory is disabled; run /om to enable it."),
			"TUI: fresh session starts with observational memory disabled",
		);
		host.send("/om");
		await host.waitFor(
			(output) => output.includes("Observational memory enabled for this session."),
			30_000,
			"TUI /om activation",
		);
		assert(host.has("Observational memory enabled for this session."), "TUI: /om activates observational memory");

		host.send("/om:status");
		await host.waitFor((output) => output.includes("── Memory ──"), 30_000, "TUI /om:status");
		assert(host.has("── Memory ──"), "TUI: /om:status reports enabled memory");

		host.send("/om:view");
		await host.waitFor((output) => output.includes("── Reflections ──"), 30_000, "TUI /om:view");
		assert(host.has("── Reflections ──"), "TUI: /om:view reports enabled memory");
		const observationOffset = host.outputLength();
		host.send("SMOKE_MARKER: tui SMOKE_ACTION: plain Please record this TUI observation.");
		await host.waitForAfter(
			observationOffset,
			(output) => output.includes("Acknowledged."),
			30_000,
			"TUI observation model response",
		);
		await host.waitForAfter(
			observationOffset,
			(output) => output.includes("Observational memory: 1 observation recorded"),
			30_000,
			"TUI observer notification",
		);
		assert(
			host.has("Observational memory: 1 observation recorded"),
			"TUI: enabled session records an observational-memory observation",
		);


		const largePrompt = `SMOKE_MARKER: tui SMOKE_ACTION: plain ${"SMOKE_PADDING ".repeat(4_000)}`;
		const firstPromptOffset = host.outputLength();
		host.send(largePrompt);
		await host.waitForAfter(firstPromptOffset, (output) => output.includes("Acknowledged."), 30_000, "TUI model response");

		const secondPromptOffset = host.outputLength();
		host.send(largePrompt);
		await host.waitForAfter(secondPromptOffset, (output) => output.includes("Acknowledged."), 30_000, "TUI second model response");
		const compactionOffset = host.outputLength();
		for (let turn = 0; turn < 2; turn++) {
			const extraPromptOffset = host.outputLength();
			host.send(largePrompt);
			await host.waitForAfter(extraPromptOffset, (output) => output.includes("Acknowledged."), 30_000, "TUI extra model response");
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 3_000));
		host.send("/compact");
		const compactionOutput = await host.waitForAfter(
			compactionOffset,
			(output) => output.includes("compacted") || output.includes("Already compacted") || output.includes("Compaction failed"),
			30_000,
			"TUI enabled compaction",
		);
		const compacted = compactionOutput.includes("compacted") || compactionOutput.includes("Already compacted");
		if (!compacted) console.error(`TUI compaction output tail:\n${compactionOutput.slice(-2_000)}`);
		assert(compacted, "TUI: enabled non-empty projection reaches compaction");
		await new Promise<void>((resolve) => setTimeout(resolve, 2_000));

		const postCompactionStatusOffset = host.outputLength();
		host.send("/om:status");
		const postCompactionStatus = await host.waitForAfter(
			postCompactionStatusOffset,
			(output) => output.includes("Observations: 1 recorded"),
			30_000,
			"TUI post-compaction memory status",
		);
		assert(
			postCompactionStatus.includes("Observations: 1 recorded / 0 dropped / 1 active / 1 visible"),
			"TUI: enabled compaction preserves the observational-memory projection",
		);
	} finally {
		await host.stop();
		rmSync(cwd, { recursive: true, force: true });
	}
}

async function runProcessB(baseUrl: string): Promise<void> {
	const cwd = makeCwd("independent-rpc");
	writeSettings(cwd, { "observational-memory": { showWorkerNotifications: true } });
	const host = spawnRpcHost(ompBin, [omExtensionPath, providerExtensionPath], {
		...process.env,
		OM_SMOKE_BASE_URL: baseUrl,
	}, cwd);

	try {
		const initialStatus = await host.promptAndSettle("/om:status");
		assert(
			initialStatus.notifications.some((n) => n.includes("Observational memory is disabled; run /om to enable it.")),
			"Process B: independently controlled RPC session starts disabled, not inheriting Process A's activation",
		);

		const activation = await host.promptAndSettle("/om");
		assert(
			activation.notifications.some((n) => n.includes("Observational memory enabled for this session.")),
			"Process B: /om activates this independently controlled RPC session",
		);

		const status = await host.promptAndSettle("/om:status");
		assert(
			status.notifications.some((n) => n.includes("── Memory ──")),
			"Process B: /om:status reflects the independent session's own activation",
		);
	} finally {
		await host.stop();
		rmSync(cwd, { recursive: true, force: true });
	}
}

async function runProcessC(baseUrl: string): Promise<void> {
	const cwd = makeCwd("passive");
	writeSettings(cwd, { "observational-memory": { passive: true } });
	const host = spawnRpcHost(ompBin, [omExtensionPath, providerExtensionPath, seedExtensionPath], {
		...process.env,
		OM_SMOKE_BASE_URL: baseUrl,
	}, cwd);

	try {
		const activation = await host.promptAndSettle("/om");
		assert(
			activation.notifications.some((n) => n.includes("locked out: passive mode")),
			"Process C: passive mode is a hard lockout against real /om activation over RPC",
		);
		const seed = await host.promptAndSettle("/smoke_seed_om");
		assert(
			seed.notifications.some((n) => n.includes("Smoke observational-memory ledger seeded.")),
			"Process C: passive session contains pre-existing observational-memory ledger data",
		);

		const passivePadding = "PASSIVE_PADDING ".repeat(10_000);
		await host.promptAndSettle(passivePadding);
		await host.promptAndSettle(passivePadding);
		const passiveCompaction = await host.compact();
		assert(
			!passiveCompaction.summary.includes("## Observations") && !passiveCompaction.summary.includes("## Reflections"),
			"Process C: passive compaction delegates to native without observational summary sections",
		);

		const status = await host.promptAndSettle("/om:status");
		assert(
			status.notifications.some((n) => n.includes("Observational memory is disabled; run /om to enable it.")),
			"Process C: passive session's /om:status stays in the disabled state",
		);
	} finally {
		await host.stop();
		rmSync(cwd, { recursive: true, force: true });
	}
}

async function runProcessRestart(baseUrl: string): Promise<void> {
	const cwd = makeCwd("restart");
	writeSettings(cwd, { "observational-memory": { showWorkerNotifications: true } });
	const env = { ...process.env, OM_SMOKE_BASE_URL: baseUrl };
	const first = spawnRpcHost(ompBin, [omExtensionPath, providerExtensionPath], env, cwd, { noSession: false });

	try {
		const activation = await first.promptAndSettle("/om");
		assert(
			activation.notifications.some((n) => n.includes("Observational memory enabled for this session.")),
			"Restart boundary: first OMP process activates observational memory",
		);
	} finally {
		await first.stop();
	}

	const second = spawnRpcHost(ompBin, [omExtensionPath, providerExtensionPath], env, cwd, { noSession: false });
	try {
		const status = await second.promptAndSettle("/om:status");
		assert(
			status.notifications.some((n) => n.includes("Observational memory is disabled; run /om to enable it.")),
			"Restart boundary: a fresh OMP process does not inherit activation",
		);
	} finally {
		await second.stop();
		rmSync(cwd, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	for (const path of [omExtensionPath, providerExtensionPath, taskToolExtensionPath, seedExtensionPath, notificationProbePath, tuiPtyPath]) {
		if (!existsSync(path)) {
			console.error(`Missing required extension file: ${path}`);
			process.exit(1);
		}
	}

	const { server, baseUrl } = await startMockModelServer(defaultScript);
	try {
		await runProcessTui(baseUrl);
		await runProcessA(baseUrl);
		await runProcessB(baseUrl);
		await runProcessC(baseUrl);
		await runProcessRestart(baseUrl);
	} catch (error) {
		failures += 1;
		console.error("Smoke test crashed:", error);
	} finally {
		server.closeAllConnections?.();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	console.log("\n=== Real-host observational-memory smoke test ===");
	for (const step of steps) console.log(step);
	console.log(`\n${steps.length - failures}/${steps.length} checks passed.`);

	if (failures > 0) {
		console.error(`\n${failures} check(s) failed.`);
		process.exit(1);
	}
	console.log("\nAll real-host smoke checks passed.");
}

await main();
