import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	collectObservationsByCoverage,
	findLastCompactionIndex,
	gapRawEntries,
	getMemoryState,
} from "../branch.js";
import { renderSummary, runPruner, runReflector } from "../compaction.js";
import { observationsToPromptLines, runObserver } from "../observer.js";
import type { Runtime } from "../runtime.js";
import { serializeBranchEntries } from "../serialize.js";
import { estimateStringTokens } from "../tokens.js";
import {
	OBSERVATION_CUSTOM_TYPE,
	type MemoryDetails,
	type ObservationEntryData,
	type ObservationRecord,
	type Reflection,
} from "../types.js";

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_before_compact", async (event, ctx) => {
		if (runtime.compactHookInFlight) {
			if (ctx.hasUI) ctx.ui.notify(
				"Observational memory: another compaction is already in progress; cancelling duplicate",
				"warning",
			);
			return { cancel: true };
		}
		runtime.compactHookInFlight = true;
		try {
			runtime.ensureConfig(ctx.cwd);
			const { preparation, branchEntries, signal } = event;
			const { firstKeptEntryId, tokensBefore } = preparation;

			const resolved = await runtime.resolveModel(ctx as any);
			if (!resolved.ok) {
				if (ctx.hasUI) ctx.ui.notify(
					`Observational memory: cannot compact — ${resolved.reason}. ` +
					"Fix the model/API key and try /compact manually.",
					"error",
				);
				return { cancel: true };
			}
			runtime.resolveFailureNotified = false;

			let entries = branchEntries as Parameters<typeof getMemoryState>[0];

			if (runtime.observerPromise) {
				try { await runtime.observerPromise; } catch { /* already notified via launchObserverTask */ }
				// In-flight observer may have appended a new observation entry during the await;
				// refresh from sessionManager so gap computation and coverage collection see it
				entries = ctx.sessionManager.getBranch() as typeof entries;
			}

			const memoryState = getMemoryState(entries);

			let gapObservationData: ObservationEntryData | null = null;
			const gap = gapRawEntries(entries, firstKeptEntryId);
			if (gap.length > 0) {
				const gapChunk = serializeBranchEntries(gap);
				if (gapChunk.trim()) {
					const gapFromId = gap[0].id;
					const gapUpToId = gap[gap.length - 1].id;
					const priorObservationLines = observationsToPromptLines([
						...memoryState.committedObs,
						...memoryState.pendingObs,
					]);
					const gapTokenEstimate = estimateStringTokens(gapChunk);
					if (ctx.hasUI) ctx.ui.notify(
						`Observational memory: sync catch-up observer running on ~${gapTokenEstimate.toLocaleString()}-token gap`,
						"info",
					);
					runtime.observerInFlight = true;
					const gapCall = runObserver({
						model: resolved.model as any,
						apiKey: resolved.apiKey,
						headers: resolved.headers,
						priorReflections: memoryState.reflections,
						priorObservations: priorObservationLines,
						chunk: gapChunk,
						signal,
					});
					const gapPromise: Promise<void> = gapCall.then(() => undefined, () => undefined);
					runtime.observerPromise = gapPromise;
					try {
						const records = await gapCall;
						if (records && records.length > 0) {
							const observationTokens = records.reduce((sum, r) => sum + estimateStringTokens(r.content), 0);
							gapObservationData = {
								records,
								coversFromId: gapFromId,
								coversUpToId: gapUpToId,
								tokenCount: observationTokens,
							};
							pi.appendEntry(OBSERVATION_CUSTOM_TYPE, gapObservationData);
							if (ctx.hasUI && ctx.ui) ctx.ui.notify(
								`Observational memory: sync catch-up recorded ${records.length} observation${records.length === 1 ? "" : "s"} (~${observationTokens.toLocaleString()} tokens)`,
								"info",
							);
						} else if (ctx.hasUI && ctx.ui) {
							ctx.ui.notify(
								"Observational memory: sync catch-up observer returned empty — proceeding with compaction",
								"warning",
							);
						}
					} catch (error) {
						const msg = error instanceof Error ? error.message : String(error);
						if (ctx.hasUI && ctx.ui) ctx.ui.notify(
							`Observational memory: sync catch-up observer failed: ${msg}. Cancelling compaction — ${gap.length} unobserved raw entries would be pruned without coverage. Try /compact again.`,
							"warning",
						);
						return { cancel: true };
					} finally {
						runtime.observerInFlight = false;
						if (runtime.observerPromise === gapPromise) runtime.observerPromise = null;
					}
				}
			}

			const priorCompactionIdx = findLastCompactionIndex(entries);
			const priorFirstKeptEntryId = priorCompactionIdx >= 0 ? entries[priorCompactionIdx].firstKeptEntryId : undefined;
			const deltaObservationData = collectObservationsByCoverage(entries, priorFirstKeptEntryId, firstKeptEntryId);
			if (gapObservationData) deltaObservationData.push(gapObservationData);

			if (deltaObservationData.length === 0) {
				if (ctx.hasUI) ctx.ui.notify("Observational memory: nothing to compact yet", "warning");
				return { cancel: true };
			}

			const workingReflections: Reflection[] = [...memoryState.reflections];
			const workingObservations: ObservationRecord[] = [
				...memoryState.committedObs,
				...deltaObservationData.flatMap((d) => d.records),
			];

			const observationTokens = workingObservations.reduce((sum, o) => sum + estimateStringTokens(o.content), 0);

			let finalReflections = workingReflections;
			let finalObservations = workingObservations;

			if (observationTokens >= runtime.config.reflectionThresholdTokens) {
				if (ctx.hasUI) ctx.ui.notify("Observational memory: running reflector + pruner...", "info");
				try {
					const newReflections = await runReflector(
						{ model: resolved.model as any, apiKey: resolved.apiKey, headers: resolved.headers, signal },
						workingReflections,
						workingObservations,
					);
					finalReflections = [...workingReflections, ...newReflections];

					const prunerResult = await runPruner(
						{ model: resolved.model as any, apiKey: resolved.apiKey, headers: resolved.headers, signal },
						finalReflections,
						workingObservations,
						runtime.config.reflectionThresholdTokens,
					);
					finalObservations = prunerResult.observations;
					if (prunerResult.fellBack && ctx.hasUI) {
						ctx.ui.notify(
							"Observational memory: pruner run failed; kept observation set unchanged",
							"warning",
						);
					}
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					if (ctx.hasUI) ctx.ui.notify(`Observational memory: reflect/prune failed: ${msg}`, "warning");
				}
			}

			const summary = renderSummary(finalReflections, finalObservations);

			if (finalObservations.length === 0) {
				throw new Error("invariant violated: finalObservations empty after delta guard");
			}

			const details: MemoryDetails = {
				type: "observational-memory",
				version: 3,
				observations: finalObservations,
				reflections: finalReflections,
			};

			if (ctx.hasUI) ctx.ui.notify(
				`Observational memory: compaction assembled — ${finalObservations.length} observation${finalObservations.length === 1 ? "" : "s"}, ${finalReflections.length} reflection${finalReflections.length === 1 ? "" : "s"}`,
				"info",
			);

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
					details,
				},
			};
		} finally {
			runtime.compactHookInFlight = false;
		}
	});
}
