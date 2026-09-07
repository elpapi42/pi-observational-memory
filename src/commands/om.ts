import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.js";
import { restoreRecallTool } from "../tool-gate.js";

/**
 * Strict bare `/om` activation command (#10).
 *
 * `/om` is the *only* enable path for observational memory. It is session-local,
 * in-memory, and idempotent: repeating it while already enabled reports that
 * state instead of scheduling duplicate activation work, and it takes no
 * arguments. Parent OMP TUI and independently controlled OMP RPC sessions can
 * both dispatch commands through this same registration; native subagents have
 * no command channel at all, so they have no path to this handler.
 *
 * Activation is lazy: flipping `runtime.enabled` is the entire effect of a
 * successful `/om`. No model is resolved, no observer catch-up pass runs, and
 * no ledger entry is written here — existing workers and thresholds simply
 * start observing the gate on their next normal lifecycle event.
 */
export function registerActivationCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om", {
		description: "Enable observational memory for this session",
		handler: async (args, ctx) => {
			if (args.trim().length > 0) {
				ctx.ui.notify("Usage: /om (no arguments)", "info");
				return;
			}

			// Passive is a hard lockout: it must block activation without ever
			// reading ledger state, resolving a model, or touching the clipboard.
			// Config load is the one exception — the lockout itself is only knowable
			// by reading `config.passive`.
			runtime.ensureConfig(ctx.cwd);
			if (runtime.config.passive === true) {
				ctx.ui.notify("Observational memory is locked out: passive mode is enabled for this runtime.", "warning");
				return;
			}

			if (runtime.isEnabledForSession?.(ctx.sessionManager?.getSessionId?.()) ?? runtime.enabled) {
				ctx.ui.notify("Observational memory is already enabled.", "info");
				return;
			}

			runtime.enabled = true;
			runtime.activatedSessionId = ctx.sessionManager?.getSessionId?.();
			restoreRecallTool(pi, runtime);
			ctx.ui.notify("Observational memory enabled for this session.", "info");
		},
	});
}
