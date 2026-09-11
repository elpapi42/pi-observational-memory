import type { ExtensionAPI, SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.js";
import { gateRecallTool } from "../tool-gate.js";

/**
 * Session-local lifecycle boundary for observational-memory activation (#10, #12).
 *
 * `session_start` fires for every new runtime/session boundary — startup,
 * reload, resume, fork, new session, and session switch — and always resets
 * activation and re-gates the `recall` tool out of the active allowlist, so a
 * fresh runtime/session never inherits a prior `/om` or a prior session's
 * restored tool allowlist.
 *
 * `session_shutdown` fires before the extension runtime for the outgoing
 * session is torn down. It invalidates that runtime's generation so any
 * observer/reflector/dropper/compaction work still in flight from the old
 * session stops before mutating state, writing to the ledger, or reporting
 * through a `ctx` that no longer belongs to the live session.
 *
 * Some OMP RPC session replacements rebind the existing extension runtime
 * without emitting `session_start`. The `before_agent_start` fence catches
 * that boundary before the next model turn and re-applies the recall gate.
 */
export function registerLifecycleReset(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_start", (_event: SessionStartEvent) => {
		runtime.resetActivation();
		gateRecallTool(pi, runtime);
	});
	pi.on("before_agent_start", (_event, ctx) => {
		const enabled = runtime.isEnabledForSession(ctx.sessionManager.getSessionId?.());
		if (!enabled && pi.getActiveTools().includes("recall")) gateRecallTool(pi, runtime);
	});
	pi.on("session_shutdown", (_event: SessionShutdownEvent) => {
		runtime.resetActivation();
		runtime.invalidateGeneration();
	});
}
