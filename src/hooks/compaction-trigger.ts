import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { rawTokensSinceLastCompaction } from "../branch.js";
import type { Runtime } from "../runtime.js";

export function registerCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("agent_end", (_event, ctx) => {
		runtime.ensureConfig(ctx.cwd);
		if (runtime.compactInFlight) return;

		const entries = ctx.sessionManager.getBranch() as Parameters<typeof rawTokensSinceLastCompaction>[0];
		const tokens = rawTokensSinceLastCompaction(entries);
		if (tokens < runtime.config.compactionThresholdTokens) return;

		// Capture ctx properties synchronously — the setTimeout + async work below
		// may outlive the extension ctx (stale after session replacement/reload).
		const hasUI = ctx.hasUI;
		const ui = ctx.ui;

		if (hasUI) ui?.notify(
			`Observational memory: compaction threshold reached (~${tokens.toLocaleString()} tokens); triggering compaction`,
			"info",
		);

		runtime.compactInFlight = true;
		setTimeout(async () => {
			if (runtime.observerPromise) {
				try {
					await runtime.observerPromise;
				} catch {
					// errors already surfaced via launchObserverTask
				}
			}
			// After awaiting observerPromise, ctx may be stale.
			// Use captured hasUI/ui for notification; wrap ctx access in try/catch.
			try {
				if (!ctx.isIdle()) {
					runtime.compactInFlight = false;
					if (hasUI) ui?.notify(
						"Observational memory: compaction deferred — agent became busy after observer wait",
						"info",
					);
					return;
				}
				const currentEntries = ctx.sessionManager.getBranch() as Parameters<typeof rawTokensSinceLastCompaction>[0];
				const currentTokens = rawTokensSinceLastCompaction(currentEntries);
				if (currentTokens < runtime.config.compactionThresholdTokens) {
					runtime.compactInFlight = false;
					if (hasUI) ui?.notify(
						"Observational memory: compaction skipped — another compaction already ran during observer wait",
						"info",
					);
					return;
				}
				ctx.compact({
					onComplete: () => {
						runtime.compactInFlight = false;
						if (hasUI) ui?.notify("Observational memory: compaction complete", "info");
					},
					onError: (error) => {
						runtime.compactInFlight = false;
						if (error.message === "Compaction cancelled") {
							// We already notified the user with the real reason before returning { cancel: true }.
							return;
						}
						if (hasUI) ui?.notify(`Observational memory: ${error.message}`, "error");
					},
				});
			} catch (error) {
				runtime.compactInFlight = false;
				const msg = error instanceof Error ? error.message : String(error);
				if (hasUI) ui?.notify(`Observational memory: compact threw: ${msg}`, "error");
			}
		}, 0);
	});
}