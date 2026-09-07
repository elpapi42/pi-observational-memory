import type { ExtensionAPI, SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.js";

/**
 * Session-local lifecycle boundary for observational-memory activation (#10).
 *
 * `session_start` fires for every new runtime/session boundary — startup,
 * reload, resume, fork, new session, and session switch — and always resets
 * activation, so a fresh runtime/session never inherits a prior `/om`.
 *
 * `session_shutdown` fires before the extension runtime for the outgoing
 * session is torn down. It invalidates that runtime's generation so any
 * observer/reflector/dropper/compaction work still in flight from the old
 * session stops before mutating state, writing to the ledger, or reporting
 * through a `ctx` that no longer belongs to the live session.
 */
export function registerLifecycleReset(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_start", (_event: SessionStartEvent) => {
		runtime.resetActivation();
	});
	pi.on("session_shutdown", (_event: SessionShutdownEvent) => {
		runtime.invalidateGeneration();
	});
}
