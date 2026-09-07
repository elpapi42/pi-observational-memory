import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "./runtime.js";
import { RECALL_OBSERVATION_TOOL_NAME } from "./tools/recall-observation.js";

/**
 * Removes `recall` from the active model tool allowlist while observational
 * memory is disabled (#12). Called on every `session_start` boundary — startup,
 * reload, resume, fork, new session, session switch — the same events that reset
 * `runtime.enabled`, so a fresh or reloaded runtime always starts with `recall`
 * gated out alongside activation.
 *
 * Records whether `recall` was part of the allowlist *before* this gate removed
 * it, so {@link restoreRecallTool} can put it back only when it belongs — never
 * forcing it into an allowlist that excluded it for another reason (for example,
 * a `--tools` flag that never included it).
 */
export function gateRecallTool(pi: ExtensionAPI, runtime: Runtime): void {
	const active = pi.getActiveTools();
	const wasActive = active.includes(RECALL_OBSERVATION_TOOL_NAME);
	runtime.recallActiveBeforeGate = wasActive;
	if (wasActive) {
		pi.setActiveTools(active.filter((name) => name !== RECALL_OBSERVATION_TOOL_NAME));
	}
}

/**
 * Restores `recall` to the active allowlist on a successful `/om`, but only if
 * {@link gateRecallTool} found it active before gating removed it. Leaves every
 * other active tool untouched, and is a no-op if the gate never ran or found
 * `recall` already inactive for an unrelated reason.
 */
export function restoreRecallTool(pi: ExtensionAPI, runtime: Runtime): void {
	if (runtime.recallActiveBeforeGate !== true) return;
	const active = pi.getActiveTools();
	if (active.includes(RECALL_OBSERVATION_TOOL_NAME)) return;
	pi.setActiveTools([...active, RECALL_OBSERVATION_TOOL_NAME]);
}
