import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveCompactAfterTokens } from "../config.js";
import { latestRealContextTokens, observedTokensSinceLastCompaction, rawTokensSinceLastCompaction, type Entry } from "../session-ledger/index.js";
import type { Runtime } from "../runtime.js";

/**
/**
 * Whether the real-context clock applies: ratio mode with a usable context
 * window. Both the clock and the threshold must share a basis — ratio
 * thresholds are window-relative, so without a window the threshold falls
 * back to the calibrated ledger budget and the ledger clocks apply too
 * (measuring absolute provider usage against a ledger threshold would
 * compare different units).
 */
function usesRealContextClock(runtime: Runtime, contextWindow: number | undefined): boolean {
	return (
		runtime.config.compactAfterTokensMode === "ratio" &&
		typeof contextWindow === "number" &&
		contextWindow > 0
	);
}

/**
 * Tokens counted toward the proactive threshold, measured in the threshold's
 * own currency. Ratio-mode thresholds are a percentage of the model context
 * window, so the clock must be real provider-reported context: comparing a
 * window percentage against a chars/4 ledger estimate drifts with
 * system-prompt/tool-schema overhead everywhere, and by 30-40% on CJK-heavy
 * sessions where the estimate undercounts real usage — pushing the effective
 * trigger past Pi's native compaction. Calibrated thresholds are absolute
 * ledger budgets, so the ledger clocks apply: normally only tokens the
 * observer has covered (compacting past the frontier would discard entries no
 * memory describes; Pi's own threshold compaction backstops a stalled
 * observer), or raw tokens when Pi's automatic compaction is disabled and
 * there is no backstop — the compaction hook still protects unobserved
 * entries (catch-up, retention, or delegation to Pi's native summarizer).
 * Ratio mode falls back to the ledger clocks when no provider usage exists or
 * the context window is unknown.
 */
export function compactionProgress(runtime: Runtime, entries: Entry[], contextWindow?: number): number {
	if (usesRealContextClock(runtime, contextWindow)) {
		const real = latestRealContextTokens(entries);
		if (real !== undefined) return real;
	}
	return runtime.config.piAutoCompactionEnabled === false
		? rawTokensSinceLastCompaction(entries)
		: observedTokensSinceLastCompaction(entries);
}

/**
 * Label for the compaction clock in use: "real" when ratio mode is measuring
 * provider-reported context, otherwise the ledger-clock label matching the Pi
 * auto-compaction setting.
 */
export function progressLabel(runtime: Runtime, entries: Entry[], contextWindow?: number): "observed" | "estimated" | "real" {
	if (usesRealContextClock(runtime, contextWindow) && latestRealContextTokens(entries) !== undefined) {
		return "real";
	}
	return runtime.config.piAutoCompactionEnabled === false ? "estimated" : "observed";
}

/** Human-readable unit for the compaction clock, for notify and status lines. */
export function progressUnit(runtime: Runtime, entries: Entry[], contextWindow?: number): string {
	return progressLabel(runtime, entries, contextWindow) === "real"
		? "real context tokens"
		: `${progressLabel(runtime, entries, contextWindow)} source tokens`;
}

type CompactionTriggerCtx = Parameters<Parameters<ExtensionAPI["on"]>[1]>[1];

export function registerCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	// Pi emits agent_settled only after retries, automatic compaction, and queued
	// continuation have finished, so retry policy stays owned by Pi.
	pi.on("agent_settled", (_event, ctx) => maybeTriggerCompaction(runtime, ctx));
}

/**
 * Trigger proactive compaction when the observed-source threshold is reached
 * and Pi is idle. Also called after an idle-mode consolidation run finishes, so
 * compaction is not starved by memory work that ran on the same settled event.
 */
export function maybeTriggerCompaction(runtime: Runtime, ctx: CompactionTriggerCtx): void {
	{
		runtime.ensureConfig(ctx.cwd);
		if (runtime.config.passive === true) return;
		if (runtime.compactInFlight) return;

		const entries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
		if (!entries) return;
		const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
		const progress = compactionProgress(runtime, entries, contextWindow);
		const threshold = resolveCompactAfterTokens(runtime.config, contextWindow);
		if (progress < threshold) return;

		// Capture ctx properties synchronously — the setTimeout + async work below
		// may outlive the extension ctx (stale after session replacement/reload).
		const hasUI = ctx.hasUI;
		const ui = ctx.ui;

		if (hasUI) ui?.notify(
			`Observational memory: compaction threshold reached (~${progress.toLocaleString()} ${progressUnit(runtime, entries, contextWindow)}); triggering compaction`,
			"info",
		);

		runtime.compactInFlight = true;
		setTimeout(() => {
			try {
				if (!ctx.isIdle()) {
					runtime.compactInFlight = false;
					if (hasUI) ui?.notify(
						"Observational memory: compaction deferred — agent became busy before compaction",
						"info",
					);
					return;
				}
				const currentEntries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
				if (!currentEntries) {
					runtime.compactInFlight = false;
					return;
				}
				const currentProgress = compactionProgress(runtime, currentEntries, contextWindow);
				if (currentProgress < threshold) {
					runtime.compactInFlight = false;
					if (hasUI) ui?.notify(
						"Observational memory: compaction skipped — another compaction already ran before deferred compaction",
						"info",
					);
					return;
				}
				ctx.compact({
					onComplete: () => {
						runtime.compactInFlight = false;
						if (hasUI) ui?.notify("Observational memory: compaction complete", "info");
					},
					onError: (error: { message: string }) => {
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
	}
}
