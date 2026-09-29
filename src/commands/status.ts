import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { observationPoolMetrics } from "../agents/dropper/pool.js";
import { reflectionPoolMetrics } from "../agents/reflection-dropper/pool.js";
import { resolveCompactAfterTokens, resolveObserveAfterTokens, resolveReflectAfterTokens } from "../config.js";
import type { IndexStatus, SessionEmbeddings } from "../embeddings.js";
import type { Runtime } from "../runtime.js";
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

function recallIndexLines(status: IndexStatus): string[] {
	if (status.state === "failed") return [`Recall index: unavailable, using keyword search — ${status.failure}`];
	const orphaned = status.orphaned > 0
		? [`Recall index: ${status.orphaned.toLocaleString()} orphaned documents not on this branch — run /om:index to prune`]
		: [];
	const missing = status.state === "present" && status.missing > 0 && !status.indexing
		? [`Recall index: ${status.missing.toLocaleString()} documents on this branch not embedded — run /om:index to embed them`]
		: [];
	return [recallIndexLine(status), ...missing, ...orphaned];
}

function recallIndexLine(status: Exclude<IndexStatus, { state: "failed" }>): string {
	if (status.state === "absent") {
		if (status.indexing) return "Recall index: building";
		if (status.autoBuild) return "Recall index: none yet — builds after the next turn";
		const shared = status.documents > status.orphaned
			? ` (${(status.documents - status.orphaned).toLocaleString()} documents already embedded from other branches)`
			: "";
		return `Recall index: none on this branch${shared} — run /om:index to build it`;
	}
	const queued = status.pending > 0 ? `, ${status.pending.toLocaleString()} queued` : "";
	const line = `Recall index: ${status.documents.toLocaleString()} documents / ${status.recentEmbedded.toLocaleString()} of ${status.recentTotal.toLocaleString()} since last compaction embedded (${status.recentTotal === 0 ? 100 : pct(status.recentEmbedded, status.recentTotal)}%)${queued}`;
	if (status.indexing) return `${line} — indexing`;
	return line;
}

export function registerStatusCommand(pi: ExtensionAPI, runtime: Runtime, embeddings?: SessionEmbeddings): void {
	pi.registerCommand("om:status", {
		description: "Show observational memory status",
		handler: async (_args, ctx) => {
			runtime.ensureConfig(ctx.cwd);
			const entries = ctx.sessionManager.getBranch() as Entry[];
			const folded = foldLedger(entries);
			const visible = visibleProjection(entries);
			const full = fullProjection(entries);
			const drift = diffProjection(visible, full);

			const visibleObservationTokens = tokenSum(visible.observations);
			const visibleReflectionTokens = tokenSum(visible.reflections);
			const activeObservationPool = observationPoolMetrics(folded.activeObservations, runtime.config.observationsPoolTargetTokens);
			const activeReflectionPool = reflectionPoolMetrics(folded.activeReflections, runtime.config.reflectionsPoolTargetTokens);
			const observationLine = appendSuffixes(
				`Observations: ${folded.observations.length} recorded / ${folded.droppedObservationIds.size} dropped / ${folded.activeObservations.length} active / ${visible.observations.length} visible`,
				[
					addedSuffix(drift.observationsOnlyInFull.length),
					removedSuffix(drift.droppedOnlyInFull.length),
				],
			);
			const reflectionLine = appendSuffixes(
				`Reflections:  ${folded.reflections.length} recorded / ${folded.droppedReflectionIds.size} dropped / ${folded.activeReflections.length} active / ${visible.reflections.length} visible`,
				[
					addedSuffix(drift.reflectionsOnlyInFull.length),
					removedSuffix(drift.droppedReflectionsOnlyInFull.length),
				],
			);
			const obsProgress = rawTokensSinceObservationCoverage(entries);
			const reflectionProgress = rawTokensSinceReflectionCoverage(entries);
			const compactionProgress = rawTokensSinceLastCompaction(entries);
			const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
			const compactThreshold = resolveCompactAfterTokens(runtime.config, contextWindow);
			const observeThreshold = resolveObserveAfterTokens(runtime.config, contextWindow);
			const reflectThreshold = resolveReflectAfterTokens(runtime.config, contextWindow);

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
				`Next observation: ~${obsProgress.toLocaleString()} / ${observeThreshold.toLocaleString()} tokens (${pct(obsProgress, observeThreshold)}%)`,
				`Next reflection:  ~${reflectionProgress.toLocaleString()} / ${reflectThreshold.toLocaleString()} tokens (${pct(reflectionProgress, reflectThreshold)}%)`,
				`Next compaction:  ~${compactionProgress.toLocaleString()} / ${compactThreshold.toLocaleString()} estimated source tokens (${pct(compactionProgress, compactThreshold)}%)`,
				`Visible observation pool: ~${visibleObservationTokens.toLocaleString()} / ${runtime.config.observationsPoolMaxTokens.toLocaleString()} tokens (${pct(visibleObservationTokens, runtime.config.observationsPoolMaxTokens)}%)`,
				`Active observation pool: ~${activeObservationPool.observationTokens.toLocaleString()} / ${runtime.config.observationsPoolTargetTokens.toLocaleString()} target tokens (${pct(activeObservationPool.observationTokens, runtime.config.observationsPoolTargetTokens)}%)`,
				`Visible reflection pool: ~${visibleReflectionTokens.toLocaleString()} tokens`,
				`Active reflection pool:  ~${activeReflectionPool.reflectionTokens.toLocaleString()} / ${runtime.config.reflectionsPoolTargetTokens.toLocaleString()} target tokens (${pct(activeReflectionPool.reflectionTokens, runtime.config.reflectionsPoolTargetTokens)}%)`,
			];
			const indexStatus = embeddings?.status(ctx.sessionManager.getSessionId(), entries);
			if (indexStatus) lines.push(...recallIndexLines(indexStatus));

			if (runtime.consolidationInFlight || runtime.compactInFlight || runtime.compactHookInFlight) {
				lines.push("", "── In flight ──");
				if (runtime.consolidationInFlight) {
					const phase = runtime.consolidationPhase ? ` (${runtime.consolidationPhase})` : "";
					lines.push(`Consolidation: running${phase}`);
				}
				if (runtime.compactInFlight) lines.push("Auto-compaction: running");
				if (runtime.compactHookInFlight) lines.push("Compaction hook: running");
			}

			if (runtime.lastObserverError || runtime.lastReflectorError || runtime.lastReflectionDropperError || runtime.lastDropperError) {
				lines.push("", "── Last error ──");
				if (runtime.lastObserverError) lines.push(`Observer: ${runtime.lastObserverError}`);
				if (runtime.lastReflectorError) lines.push(`Reflector: ${runtime.lastReflectorError}`);
				if (runtime.lastReflectionDropperError) lines.push(`Reflection dropper: ${runtime.lastReflectionDropperError}`);
				if (runtime.lastDropperError) lines.push(`Dropper: ${runtime.lastDropperError}`);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
