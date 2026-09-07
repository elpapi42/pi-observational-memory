import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultScript, startMockModelServer } from "./mock-model-server.ts";
import { spawnRpcHost, type RpcHost } from "./rpc-client.ts";

/**
 * Real-host smoke test for observational memory's activation boundary (#14).
 *
 * See `tests/smoke/README.md` for prerequisites and invocation. This file is
 * deliberately outside `vitest.config.ts`'s `tests/**\/*.test.ts` include
 * pattern, so `bun run test` never picks it up; it is only run via
 * `bun run test:smoke`, which requires the real `omp` CLI on `PATH`.
 *
 * Scope note: OMP's RPC mode (`--mode rpc`) dispatches slash commands through
 * the exact same extension command handlers a real interactive TUI
 * session uses (confirmed in OMP's RPC and extension docs — RPC
 * and TUI are both `ExtensionContext.mode` values reaching the same command
 * registration). Driving two independent RPC processes therefore exercises
 * "parent OMP session" and "independently controlled OMP RPC session"
 * exactly as the spec requires, without needing PTY automation of the
 * interactive terminal UI, which would be neither deterministic nor
 * CI-safe.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const omExtensionPath = join(repoRoot, "src", "index.ts");
const providerExtensionPath = join(here, "fixture-provider.ts");
const taskToolExtensionPath = join(here, "child-task-tool.ts");
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

		await host.promptAndSettle("SMOKE_MARKER: smokeA\nSMOKE_ACTION: call_task\nPlease call the smoke task tool now.");

		assert(existsSync(reportPath), `Process A: smoke_task wrote a child session report${existsSync(reportPath) ? "" : `; host stderr: ${host.stderrText()}`}`);
		if (existsSync(reportPath)) {
			const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
				omEntryCount: number;
				omEntryCustomTypes: string[];
				compactionEntryCount: number;
				compactionSummary: string | null;
				compactionDetails: unknown;
			};
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
	const host = spawnRpcHost(ompBin, [omExtensionPath, providerExtensionPath], {
		...process.env,
		OM_SMOKE_BASE_URL: baseUrl,
	}, cwd);

	try {
		const activation = await host.promptAndSettle("/om");
		assert(
			activation.notifications.some((n) => n.includes("locked out: passive mode")),
			"Process C: passive mode is a hard lockout against real /om activation over RPC",
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

async function main(): Promise<void> {
	for (const path of [omExtensionPath, providerExtensionPath, taskToolExtensionPath]) {
		if (!existsSync(path)) {
			console.error(`Missing required extension file: ${path}`);
			process.exit(1);
		}
	}

	const { server, baseUrl } = await startMockModelServer(defaultScript);
	try {
		await runProcessA(baseUrl);
		await runProcessB(baseUrl);
		await runProcessC(baseUrl);
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
