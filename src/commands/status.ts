import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { observationPoolMetrics } from "../agents/dropper/pool.js";
import { resolveCompactAfterTokens } from "../config.js";
import { DISABLED_MESSAGE, type Runtime } from "../runtime.js";
import {
	diffProjection,
	foldLedger,
	fullProjection,
	rawTokensSinceLastCompaction,
	rawTokensSinceObservationCoverage,
	rawTokensSinceReflectionCoverage,
	visibleProjection,
	type Entry,
} from "../session-ledger/index.js";

function pct(current: number, total: number): number {
	return total > 0 ? Math.round((current / total) * 100) : 0;
}

function tokenSum(items: { tokenCount: number }[]): number {
	return items.reduce((sum, item) => sum + item.tokenCount, 0);
}

function addedSuffix(count: number): string | undefined {
	return count > 0 ? `+${count.toLocaleString()}` : undefined;
}

function removedSuffix(count: number): string | undefined {
	return count > 0 ? `-${count.toLocaleString()}` : undefined;
}

function appendSuffixes(line: string, suffixes: (string | undefined)[]): string {
	const rendered = suffixes.filter((suffix): suffix is string => suffix !== undefined);
	return rendered.length > 0 ? `${line} ${rendered.join(" ")}` : line;
}

export function registerStatusCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:status", {
		description: "Show observational memory status",
		handler: async (_args, ctx) => {
			if (!(runtime.isEnabledForSession?.(ctx.sessionManager.getSessionId?.()) ?? runtime.enabled)) {
				ctx.ui.notify(DISABLED_MESSAGE, "info");
				return;
			}
			runtime.ensureConfig(ctx.cwd);
			const entries = ctx.sessionManager.getBranch() as Entry[];
			const folded = foldLedger(entries);
			const visible = visibleProjection(entries);
			const full = fullProjection(entries);
			const drift = diffProjection(visible, full);

			const visibleObservationTokens = tokenSum(visible.observations);
			const visibleReflectionTokens = tokenSum(visible.reflections);
			const activeObservationPool = observationPoolMetrics(folded.activeObservations, runtime.config.observationsPoolTargetTokens);
			const observationLine = appendSuffixes(
				`Observations: ${folded.observations.length} recorded / ${folded.droppedObservationIds.size} dropped / ${folded.activeObservations.length} active / ${visible.observations.length} visible`,
				[
					addedSuffix(drift.observationsOnlyInFull.length),
					removedSuffix(drift.droppedOnlyInFull.length),
				],
			);
			const reflectionLine = appendSuffixes(
				`Reflections:  ${folded.reflections.length} recorded / ${visible.reflections.length} visible`,
				[addedSuffix(drift.reflectionsOnlyInFull.length)],
			);
			const obsProgress = rawTokensSinceObservationCoverage(entries);
			const reflectionProgress = rawTokensSinceReflectionCoverage(entries);
			const compactionProgress = rawTokensSinceLastCompaction(entries);
			const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
			const compactThreshold = resolveCompactAfterTokens(runtime.config, contextWindow);

			const passiveLines = runtime.config.passive === true
				? [
					"── Mode ──",
					"Passive: automatic memory workers and auto-compaction disabled; manual/Pi compaction, commands, and recall remain active",
					"",
				]
				: [];

			const lines = [
				...passiveLines,
				"── Memory ──",
				observationLine,
				reflectionLine,
				"",
				"── Activity ──",
				`Next observation: ~${obsProgress.toLocaleString()} / ${runtime.config.observeAfterTokens.toLocaleString()} tokens (${pct(obsProgress, runtime.config.observeAfterTokens)}%)`,
				`Next reflection:  ~${reflectionProgress.toLocaleString()} / ${runtime.config.reflectAfterTokens.toLocaleString()} tokens (${pct(reflectionProgress, runtime.config.reflectAfterTokens)}%)`,
				`Next compaction:  ~${compactionProgress.toLocaleString()} / ${compactThreshold.toLocaleString()} estimated source tokens (${pct(compactionProgress, compactThreshold)}%)`,
				`Visible observation pool: ~${visibleObservationTokens.toLocaleString()} / ${runtime.config.observationsPoolMaxTokens.toLocaleString()} tokens (${pct(visibleObservationTokens, runtime.config.observationsPoolMaxTokens)}%)`,
				`Active observation pool: ~${activeObservationPool.observationTokens.toLocaleString()} / ${runtime.config.observationsPoolTargetTokens.toLocaleString()} target tokens (${pct(activeObservationPool.observationTokens, runtime.config.observationsPoolTargetTokens)}%)`,
				`Reflection pool:         ~${visibleReflectionTokens.toLocaleString()} tokens`,
			];

			if (runtime.consolidationInFlight || runtime.compactInFlight || runtime.compactHookInFlight) {
				lines.push("", "── In flight ──");
				if (runtime.consolidationInFlight) {
					const phase = runtime.consolidationPhase ? ` (${runtime.consolidationPhase})` : "";
					lines.push(`Consolidation: running${phase}`);
				}
				if (runtime.compactInFlight) lines.push("Auto-compaction: running");
				if (runtime.compactHookInFlight) lines.push("Compaction hook: running");
			}

			if (runtime.lastObserverError || runtime.lastReflectorError || runtime.lastDropperError) {
				lines.push("", "── Last error ──");
				if (runtime.lastObserverError) lines.push(`Observer: ${runtime.lastObserverError}`);
				if (runtime.lastReflectorError) lines.push(`Reflector: ${runtime.lastReflectorError}`);
				if (runtime.lastDropperError) lines.push(`Dropper: ${runtime.lastDropperError}`);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
