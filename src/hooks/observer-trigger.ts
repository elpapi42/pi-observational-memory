import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { debugLog, withDebugLogContext } from "../debug-log.js";
import { resolveTurnLimits } from "../config.js";
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
		const turnLimits = resolveTurnLimits(runtime.config);

		const chunkEntries = rawTailEntriesBetween(entries, coversFromId, coversUpToId);
		if (chunkEntries.length === 0) return;
		const { text: chunk, sourceEntryIds } = serializeSourceAddressedBranchEntries(chunkEntries);
		if (!chunk.trim() || sourceEntryIds.length === 0) return;

		if (ctx.hasUI) ctx.ui.notify(
			`Observational memory: observer running on ~${tokens.toLocaleString()}-token chunk`,
			"info",
		);
		const runId = `observer-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;

		// Capture ctx properties synchronously — the async work below may outlive
		// the extension ctx (stale after session replacement/reload).
		const hasUI = ctx.hasUI;
		const ui = ctx.ui;
		const model = ctx.model;
		const modelRegistry = ctx.modelRegistry;
		const cwd = ctx.cwd;

		void runtime.launchObserverTask(ctx, "observer", async () => withDebugLogContext({ enabled: runtime.config.debugLog === true, cwd, runId }, async () => {
			try {
				debugLog("observer.start", {
					tokens,
					coversFromId,
					coversUpToId,
					sourceEntryIds,
					sourceEntryCount: sourceEntryIds.length,
					priorReflections: reflections.length,
					priorObservations: priorObservationLines.length,
				});
				const resolved = await runtime.resolveModel({ model, modelRegistry, hasUI, ui });
				if (!resolved.ok) {
					debugLog("observer.model_unavailable", { reason: resolved.reason });
					if (!runtime.resolveFailureNotified && hasUI && ui) {
						ui.notify(
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
					maxTurns: turnLimits.observerMaxTurnsPerRun,
					thinkingLevel: runtime.config.thinkingLevel,
				});
				if (!records || records.length === 0) {
					debugLog("observer.empty", { coversFromId, coversUpToId });
					if (hasUI && ui) ui.notify(
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
				debugLog("observer.records", {
					count: records.length,
					observationTokens,
					coversFromId,
					coversUpToId,
					records,
				});
				pi.appendEntry(OBSERVATION_CUSTOM_TYPE, data);
				debugLog("observer.appended", { count: records.length, tokenCount: observationTokens, coversFromId, coversUpToId });
				if (hasUI && ui) ui.notify(
					`Observational memory: ${records.length} observation${records.length === 1 ? "" : "s"} recorded (~${observationTokens.toLocaleString()} tokens)`,
					"info",
				);
			} catch (error) {
				debugLog("observer.error", { errorMessage: error instanceof Error ? error.message : String(error) });
				throw error;
			}
		}));
	});
}