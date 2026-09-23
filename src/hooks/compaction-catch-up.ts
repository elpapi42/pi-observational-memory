import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { runObserver } from "../agents/observer/agent.js";
import { resolveObserverChunkMaxTokens } from "../config.js";
import { debugLog } from "../debug-log.js";
import type { Runtime } from "../runtime.js";
import { serializeSourceAddressedBranchEntries } from "../serialize.js";
import {
	OM_OBSERVATIONS_RECORDED,
	buildObservationsRecordedData,
	fullProjection,
	isSourceEntry,
	observationToSummaryLine,
	reflectionToSummaryLine,
	type Entry,
	type UnobservedSourceSpan,
} from "../session-ledger/index.js";

export type CatchUpResult = {
	/** Observer chunks that recorded observations. */
	chunksRecorded: number;
	/** Why catch-up stopped before covering the whole gap, if it did. */
	stoppedBecause?: "max_chunks" | "empty" | "error" | "model_unavailable" | "aborted";
};

export type CatchUpArgs = {
	pi: ExtensionAPI;
	runtime: Runtime;
	ctx: ExtensionContext;
	entries: Entry[];
	gap: UnobservedSourceSpan;
	maxChunks: number;
	signal?: AbortSignal;
};

/**
 * Observe the unobserved source entries before Pi's proposed cut, one observer
 * chunk at a time, appending coverage as it goes. Runs inside
 * `session_before_compact`, where Pi waits for the hook and no session request
 * is in flight, so the memory model call does not compete with the session.
 * Each recorded chunk advances the observation frontier; the caller re-resolves
 * the cut afterwards. A chunk that yields no observations, fails, or hits the
 * chunk cap stops the catch-up and the remaining gap is handled as before
 * (retained or delegated). Nothing is ever appended for a failed chunk.
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
	let remaining = entries.slice(gap.firstIndex, gap.lastIndex + 1).filter(isSourceEntry);
	let branch = entries;

	for (let chunkIndex = 0; chunkIndex < maxChunks && remaining.length > 0; chunkIndex++) {
		if (signal?.aborted) return { ...result, stoppedBecause: "aborted" };

		const { text: chunk, sourceEntryIds, estimatedTokens } = serializeSourceAddressedBranchEntries(remaining, { maxTokens: maxChunkTokens });
		const coversUpToId = sourceEntryIds.at(-1);
		if (!chunk.trim() || !coversUpToId) break;

		const memory = fullProjection(branch);
		if (runtime.config.showWorkerNotifications && ctx.hasUI) {
			ctx.ui.notify(
				`Observational memory: observing ${sourceEntryIds.length} unobserved source entr${sourceEntryIds.length === 1 ? "y" : "ies"} (~${estimatedTokens.toLocaleString()} tokens) before compacting`,
				"info",
			);
		}
		debugLog("compaction.catch_up.chunk", { chunkIndex, sourceEntryCount: sourceEntryIds.length, estimatedTokens, coversUpToId });

		let observations;
		try {
			observations = await runObserver({
				model: resolved.model as any,
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
			if (ctx.hasUI) ctx.ui.notify(`Observational memory: catch-up observer failed: ${errorMessage}`, "warning");
			return { ...result, stoppedBecause: "error" };
		}

		const data = observations && observations.length > 0 ? buildObservationsRecordedData(observations, coversUpToId) : undefined;
		if (!data) {
			debugLog("compaction.catch_up.empty", { chunkIndex, coversUpToId });
			return { ...result, stoppedBecause: "empty" };
		}

		pi.appendEntry(OM_OBSERVATIONS_RECORDED, data);
		result.chunksRecorded++;
		debugLog("compaction.catch_up.recorded", { chunkIndex, count: observations!.length, coversUpToId });

		// Coverage is positional: everything at or before the marker counts as
		// covered, including entries the serializer skipped for lack of
		// renderable content (e.g. an aborted assistant message).
		const coveredIndex = entries.findIndex((entry) => entry.id === coversUpToId);
		remaining = remaining.filter((entry) => entries.indexOf(entry) > coveredIndex);
		branch = (ctx.sessionManager?.getBranch?.() as Entry[] | undefined) ?? branch;
	}

	if (remaining.length > 0 && !result.stoppedBecause) result.stoppedBecause = "max_chunks";
	return result;
}
