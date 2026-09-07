import { writeFileSync } from "node:fs";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	type ExtensionAPI,
	type Model,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
/**
 * Real-host smoke test task tool (#14).
 *
 * Stands in for the smoke harness's `smoke_task` mechanism:
 * `createAgentSession()` is OMP's documented SDK entry point for spawning an
 * in-process child `AgentSession` (see `docs/sdk.md`, "Build custom tools that
 * spawn sub-agents"). No `ui` option is passed, so the child's extension
 * runtime reports `hasUI: false` and has no TUI, stdin, or RPC command channel —
 * the same structural isolation a real native subagent has. The child loads the
 * *same* observational-memory extension the parent uses (not this task tool
 * itself), so the smoke test proves the extension stays disabled inside a
 * genuine child session rather than merely a session that never loaded it.
 *
 * Cross-process bridge: this tool executes inside the spawned OMP host
 * process, not the driver script's process, so results are written to
 * `OM_SMOKE_REPORT_PATH` as JSON for `run.ts` to read after the RPC turn
 * settles.
 */
export default function childTaskTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "smoke_task",
		label: "Task",
		description: "Delegate a task to a subagent",
		parameters: Type.Object({ task: Type.String() }),
		async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
			const omExtensionPath = requireEnv("OM_SMOKE_OM_EXTENSION_PATH");
			const providerExtensionPath = requireEnv("OM_SMOKE_PROVIDER_EXTENSION_PATH");
			const childMarker = requireEnv("OM_SMOKE_CHILD_MARKER");
			const reportPath = requireEnv("OM_SMOKE_REPORT_PATH");

			const loader = new DefaultResourceLoader({
				cwd: ctx.cwd,
				agentDir: ctx.cwd,
				additionalExtensionPaths: [omExtensionPath, providerExtensionPath],
				systemPromptOverride: () => `SMOKE_MARKER: ${childMarker}\nYou are a minimal test agent. Follow instructions literally and briefly.`,
			});
			await loader.reload();

			const childSessionManager = SessionManager.inMemory(ctx.cwd);
			const { session: child } = await createAgentSession({
				cwd: ctx.cwd,
				sessionManager: childSessionManager,
				model: ctx.model as Model<any> | undefined,
				resourceLoader: loader,
			});
			await child.prompt(args.task);
			await child.prompt("Now provide a second, different one-line status update.");
			const childPadding = "CHILD_PADDING ".repeat(10_000);
			await child.prompt(childPadding);
			await child.prompt(childPadding);
			const branchBeforeCompact = childSessionManager.getBranch();
			const activeToolNames = child.getActiveToolNames();
			const compaction = await child.compact();
			const branchAfterCompact = childSessionManager.getBranch();
			child.dispose();

			const omCustomTypes = ["om.observations.recorded", "om.reflections.recorded", "om.observations.dropped"];
			const omEntries = branchAfterCompact.filter(
				(entry: { type: string; customType?: string }) => entry.type === "custom" && omCustomTypes.includes(entry.customType ?? ""),
			);
			const compactionEntries = branchAfterCompact.filter((entry: { type: string }) => entry.type === "compaction");

			writeFileSync(reportPath, JSON.stringify({
				preCompactEntryCount: branchBeforeCompact.length,
				postCompactEntryCount: branchAfterCompact.length,
				activeToolNames,
				recallActive: activeToolNames.includes("recall"),
				omEntryCount: omEntries.length,
				omEntryCustomTypes: omEntries.map((entry: { customType?: string }) => entry.customType),
				compactionEntryCount: compactionEntries.length,
				compactionSummary: compaction?.summary ?? null,
				compactionDetails: compactionEntries.at(-1)?.details ?? null,
			}, null, 2));

			return {
				content: [{ type: "text", text: "Subagent finished. SMOKE_TASK_DONE" }],
				details: { childMarker },
			};
		},
	});
}

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} must be set before loading tests/smoke/child-task-tool.ts`);
	return value;
}
