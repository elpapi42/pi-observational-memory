import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveCompactAfterTokens } from "../config.js";
import { rawTokensSinceLastCompaction, type Entry } from "../session-ledger/index.js";
import type { Runtime } from "../runtime.js";

export function registerCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	// Pi emits agent_settled only after retries, automatic compaction, and queued
	// continuation have finished, so retry policy stays owned by Pi.
	pi.on("agent_settled", (_event, ctx) => {
		runtime.ensureConfig(ctx.cwd);
		if (runtime.config.passive === true) return;

		// Session generation for the in-flight flag: when the captured ctx goes
		// stale (session replacement/reload), a started compaction's
		// onComplete/onError callbacks are tied to the old session and never
		// fire, which would leave compactInFlight stuck true. Keying the flag
		// to the session lets a replaced session discard the stale flag
		// instead of disabling proactive compaction for the process lifetime.
		const sessionIdentity = ctx.sessionManager?.getSessionId?.() ?? ctx.sessionManager?.getSessionFile?.();
		if (runtime.compactInFlight) {
			if (sessionIdentity === runtime.compactInFlightSession) return;
			runtime.compactInFlight = false;
			runtime.compactInFlightSession = undefined;
			if (ctx.hasUI) ctx.ui.notify(
				"Observational memory: discarded stale in-flight compaction from a replaced session",
				"info",
			);
		}

		const entries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
		if (!entries) return;
		const progress = rawTokensSinceLastCompaction(entries);
		const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
		const threshold = resolveCompactAfterTokens(runtime.config, contextWindow);
		if (progress < threshold) return;

		// Capture ctx properties synchronously — the setTimeout + async work below
		// may outlive the extension ctx (stale after session replacement/reload).
		const hasUI = ctx.hasUI;
		const ui = ctx.ui;

		if (hasUI) ui?.notify(
			`Observational memory: compaction threshold reached (~${progress.toLocaleString()} estimated source tokens); triggering compaction`,
			"info",
		);

		const clearInFlight = () => {
			runtime.compactInFlight = false;
			runtime.compactInFlightSession = undefined;
		};

		runtime.compactInFlight = true;
		runtime.compactInFlightSession = sessionIdentity;
		setTimeout(() => {
			try {
				if (!ctx.isIdle()) {
					clearInFlight();
					if (hasUI) ui?.notify(
						"Observational memory: compaction deferred — agent became busy before compaction",
						"info",
					);
					return;
				}
				const currentEntries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
				if (!currentEntries) {
					clearInFlight();
					return;
				}
				const currentProgress = rawTokensSinceLastCompaction(currentEntries);
				if (currentProgress < threshold) {
					clearInFlight();
					if (hasUI) ui?.notify(
						"Observational memory: compaction skipped — another compaction already ran before deferred compaction",
						"info",
					);
					return;
				}
				ctx.compact({
					onComplete: () => {
						clearInFlight();
						if (hasUI) ui?.notify("Observational memory: compaction complete", "info");
					},
					onError: (error: { message: string }) => {
						clearInFlight();
						if (error.message === "Compaction cancelled") {
							// We already notified the user with the real reason before returning { cancel: true }.
							return;
						}
						if (hasUI) ui?.notify(`Observational memory: ${error.message}`, "error");
					},
				});
			} catch (error) {
				clearInFlight();
				const msg = error instanceof Error ? error.message : String(error);
				if (hasUI) ui?.notify(`Observational memory: compact threw: ${msg}`, "error");
			}
		}, 0);
	});
}
