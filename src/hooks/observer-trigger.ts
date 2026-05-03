import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	firstRawIdAfter,
	getMemoryState,
	lastObservationCoverEndIdx,
	rawTailEntriesBetween,
	rawTokensSinceLastBound,
} from "../branch.js";
import { observationsToPromptLines, runObserver } from "../observer.js";
import type { Runtime } from "../runtime.js";
import { serializeSourceAddressedBranchEntries } from "../serialize.js";
import { estimateStringTokens } from "../tokens.js";
import { OBSERVATION_CUSTOM_TYPE, reflectionToPromptLine, type ObservationEntryData } from "../types.js";

export function registerObserverTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("turn_end", (_event, ctx) => {
		runtime.ensureConfig(ctx.cwd);
		if (runtime.config.passive === true) return;
		if (runtime.observerInFlight) return;

		const entries = ctx.sessionManager.getBranch() as Parameters<typeof rawTokensSinceLastBound>[0];
		const tokens = rawTokensSinceLastBound(entries);
		if (tokens < runtime.config.observationThresholdTokens) return;

		const lastBoundIdx = lastObservationCoverEndIdx(entries);
		const coversFromId = firstRawIdAfter(entries, lastBoundIdx);
		if (!coversFromId) return;

		const leafId = ctx.sessionManager.getLeafId();
		if (!leafId) return;
		const coversUpToId = leafId;

		const { reflections, committedObs, pendingObs } = getMemoryState(entries);
		const priorObservationLines = observationsToPromptLines([...committedObs, ...pendingObs]);

		const chunkEntries = rawTailEntriesBetween(entries, coversFromId, coversUpToId);
		if (chunkEntries.length === 0) return;
		const { text: chunk, sourceEntryIds } = serializeSourceAddressedBranchEntries(chunkEntries);
		if (!chunk.trim() || sourceEntryIds.length === 0) return;

		if (ctx.hasUI) ctx.ui.notify(
			`Observational memory: observer running on ~${tokens.toLocaleString()}-token chunk`,
			"info",
		);

		void runtime.launchObserverTask(ctx, "observer", async () => {
			const resolved = await runtime.resolveModel(ctx as any);
			if (!resolved.ok) {
				if (!runtime.resolveFailureNotified && ctx.hasUI && ctx.ui) {
					ctx.ui.notify(
						`Observational memory: observer skipped — ${resolved.reason}`,
						"warning",
					);
					runtime.resolveFailureNotified = true;
				}
				return;
			}
			runtime.resolveFailureNotified = false;

			const records = await runObserver({
				model: resolved.model as any,
				apiKey: resolved.apiKey,
				headers: resolved.headers,
				priorReflections: reflections.map(reflectionToPromptLine),
				priorObservations: priorObservationLines,
				chunk,
				allowedSourceEntryIds: sourceEntryIds,
			});
			if (!records || records.length === 0) {
				if (ctx.hasUI && ctx.ui) ctx.ui.notify(
					"Observational memory: observer returned no observations",
					"warning",
				);
				return;
			}

			const observationTokens = records.reduce((sum, r) => sum + estimateStringTokens(r.content), 0);
			const data: ObservationEntryData = {
				records,
				coversFromId,
				coversUpToId,
				tokenCount: observationTokens,
			};
			pi.appendEntry(OBSERVATION_CUSTOM_TYPE, data);
			if (ctx.hasUI && ctx.ui) ctx.ui.notify(
				`Observational memory: ${records.length} observation${records.length === 1 ? "" : "s"} recorded (~${observationTokens.toLocaleString()} tokens)`,
				"info",
			);
		});
	});
}
