import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { runObserver } from "../agents/observer/agent.js";
import { resolveObserverChunkMaxTokens, resolveWorkerMemoryMaxTokens } from "../config.js";
import { debugLog } from "../debug-log.js";
import type { ResolveCtx, Runtime } from "../runtime.js";
import { serializeSourceAddressedBranchEntries } from "../serialize.js";
import { uniqueNewRecords } from "../session-ledger/unique-new-records.js";
import {
	OM_OBSERVATIONS_RECORDED,
	boundWorkerMemory,
	buildObservationsRecordedData,
	foldLedger,
	fullProjection,
	isSourceEntry,
	latestCoverageIndex,
	observationToSummaryLine,
	reflectionToSummaryLine,
	type Entry,
	type UnobservedSourceSpan,
} from "../session-ledger/index.js";

/** Report completed catch-up coverage; partial records do not count as completed chunks. */
export interface CatchUpResult {
	/** Observer chunks with completed coverage, including completed-empty reviews. */
	chunksRecorded: number;
	/** Why catch-up stopped before covering the whole gap, if it did. */
	stoppedBecause?: "max_chunks" | "incomplete" | "error" | "model_unavailable" | "aborted";
}

interface CatchUpContext extends ResolveCtx {
	sessionManager: { getBranch: () => Entry[] };
}

/** Supply the compaction gap, ledger writer, and worker context for bounded synchronous catch-up. */
export interface CatchUpArgs {
	pi: Pick<ExtensionAPI, "appendEntry">;
	runtime: Runtime;
	ctx: CatchUpContext;
	entries: Entry[];
	gap: UnobservedSourceSpan;
	maxChunks: number;
	signal?: AbortSignal;
}

/**
 * Observe the unobserved source entries before Pi's proposed cut, one observer
 * chunk at a time, appending coverage as it goes. Runs inside
 * `session_before_compact`, where Pi waits for the hook and no session request
 * is in flight, so the memory model call does not compete with the session.
 * Each completed chunk advances the observation frontier; the caller re-resolves
 * the cut afterwards. Incomplete or failed reviews keep accepted records without
 * advancing coverage and stop catch-up. Aborted reviews append nothing. The
 * remaining gap is retained or delegated.
 */
export async function catchUpObserver(args: CatchUpArgs): Promise<CatchUpResult> {
	const { pi, runtime, ctx, entries, gap, maxChunks, signal } = args;
	const result: CatchUpResult = { chunksRecorded: 0 };
	if (maxChunks <= 0) return result;

	const resolved = await runtime.resolveModel({
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
		hasUI: ctx.hasUI,
		ui: ctx.ui,
	});
	if (!resolved.ok) {
		debugLog("compaction.catch_up.model_unavailable", { reason: resolved.reason });
		return { ...result, stoppedBecause: "model_unavailable" };
	}

	const contextWindow = (resolved.model as { contextWindow?: number }).contextWindow;
	const maxChunkTokens = resolveObserverChunkMaxTokens(runtime.config, contextWindow);
	// Start at the global observation frontier, not at the gap (which begins
	// at the retained-range start). A coverage marker claims everything before
	// it, so starting later would mark unread source between the frontier and
	// the range start as observed and the background observer would never
	// revisit it.
	const frontierIndex = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	let remaining = entries.slice(frontierIndex + 1, gap.lastIndex + 1).filter(isSourceEntry);
	let branch = entries;

	for (let chunkIndex = 0; chunkIndex < maxChunks && remaining.length > 0; chunkIndex++) {
		if (signal?.aborted) return { ...result, stoppedBecause: "aborted" };

		const { text: chunk, sourceEntryIds, estimatedTokens } = serializeSourceAddressedBranchEntries(remaining, { maxTokens: maxChunkTokens });
		const coversUpToId = sourceEntryIds.at(-1);
		if (!chunk.trim() || !coversUpToId) break;

		const fullMemory = fullProjection(branch);
		const memory = boundWorkerMemory(fullMemory.reflections, fullMemory.observations, resolveWorkerMemoryMaxTokens(runtime.config, contextWindow));
		if (runtime.config.showWorkerNotifications && ctx.hasUI) {
			ctx.ui?.notify(
				`Observational memory: observing ${sourceEntryIds.length} unobserved source entr${sourceEntryIds.length === 1 ? "y" : "ies"} (~${estimatedTokens.toLocaleString()} tokens) before compacting`,
				"info",
			);
		}
		debugLog("compaction.catch_up.chunk", { chunkIndex, sourceEntryCount: sourceEntryIds.length, estimatedTokens, coversUpToId });

		let outcome: Awaited<ReturnType<typeof runObserver>>;
		try {
			outcome = await runObserver({
				// SAFETY: Runtime resolves Pi registry models, which share the observer's Model contract.
				model: resolved.model as Parameters<typeof runObserver>[0]["model"],
				apiKey: resolved.apiKey,
				headers: resolved.headers,
				env: resolved.env,
				priorReflections: memory.reflections.map(reflectionToSummaryLine),
				priorObservations: memory.observations.map(observationToSummaryLine),
				chunk,
				allowedSourceEntryIds: sourceEntryIds,
				signal,
				maxTurns: runtime.config.agentMaxTurns,
				maxOutputTokens: runtime.config.agentMaxTokens,
				thinkingLevel: runtime.config.model?.thinking ?? "low",
				modelRegistry: ctx.modelRegistry,
			});
		} catch (error) {
			if (signal?.aborted) return { ...result, stoppedBecause: "aborted" };
			const errorMessage = error instanceof Error ? error.message : String(error);
			debugLog("compaction.catch_up.error", { chunkIndex, errorMessage });
			if (ctx.hasUI) ctx.ui?.notify(`Observational memory: catch-up observer failed: ${errorMessage}`, "warning");
			return { ...result, stoppedBecause: "error" };
		}

		if (signal?.aborted) {
			return { ...result, stoppedBecause: "aborted" };
		}
		const records = outcome.kind === "nothing-new"
			? []
			: uniqueNewRecords(outcome.records, foldLedger(branch).observationsById.keys());
		const completed = outcome.kind === "completed" || outcome.kind === "nothing-new";
		const data = buildObservationsRecordedData(records, completed
			? { kind: "completed", coversUpToId }
			: { kind: "incomplete", inputUpToId: coversUpToId });
		if (data) {
			pi.appendEntry(OM_OBSERVATIONS_RECORDED, data);
		}
		if (outcome.kind === "failed") {
			const errorMessage = runtime.recordConsolidationStageError(ctx, "observer", outcome.error);
			debugLog("compaction.catch_up.error", { chunkIndex, errorMessage, savedPartialRecordCount: records.length });
			return { ...result, stoppedBecause: "error" };
		}
		if (!completed) {
			debugLog("compaction.catch_up.incomplete", { chunkIndex, inputUpToId: coversUpToId, savedPartialRecordCount: records.length });
			return { ...result, stoppedBecause: "incomplete" };
		}

		result.chunksRecorded++;
		debugLog("compaction.catch_up.recorded", { chunkIndex, count: records.length, coversUpToId });

		// Coverage is positional: everything at or before the marker counts as
		// covered, including entries the serializer skipped for lack of
		// renderable content (e.g. an aborted assistant message).
		const coveredIndex = entries.findIndex((entry) => entry.id === coversUpToId);
		remaining = remaining.filter((entry) => entries.indexOf(entry) > coveredIndex);
		branch = ctx.sessionManager?.getBranch?.() ?? branch;
	}

	if (remaining.length > 0 && !result.stoppedBecause) result.stoppedBecause = "max_chunks";
	return result;
}
