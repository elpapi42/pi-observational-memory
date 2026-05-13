import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { debugLog, withDebugLogContext } from "../debug-log.js";
import {
	collectObservationsByCoverage,
	findLastCompactionIndex,
	gapRawEntries,
	getMemoryState,
} from "../branch.js";
import {
	coverageTagCounts,
	migrateLegacyReflections,
	observationPoolTokens,
	renderSummary,
	runPruner,
	runReflector,
	type CoverageTagCounts,
	type PrunerResult,
	type ReflectorStats,
} from "../compaction.js";
import { observationsToPromptLines, runObserver } from "../observer.js";
import { CompactionProgressTracker } from "../progress.js";
import type { Runtime } from "../runtime.js";
import { serializeSourceAddressedBranchEntries } from "../serialize.js";
import { estimateStringTokens } from "../tokens.js";
import {
	OBSERVATION_CUSTOM_TYPE,
	reflectionToPromptLine,
	type MemoryDetailsV4,
	type MemoryReflection,
	type ObservationEntryData,
	type ObservationRecord,
} from "../types.js";

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count.toLocaleString()} ${count === 1 ? singular : pluralForm}`;
}

function formatCoverageCounts(counts: CoverageTagCounts): string {
	return `${counts.uncited.toLocaleString()}/${counts.cited.toLocaleString()}/${counts.reinforced.toLocaleString()} uncited/cited/reinforced`;
}

function formatReflectorStats(stats: ReflectorStats): string {
	const failed = stats.failedPass === undefined ? "" : `, failed pass ${stats.failedPass}`;
	return `reflector ${plural(stats.toolCalls, "tool call")}, +${stats.added.toLocaleString()} added, ${stats.merged.toLocaleString()} merged, ${stats.promoted.toLocaleString()} promoted, ${stats.duplicates.toLocaleString()} duplicate/no-op, ${stats.unsupported.toLocaleString()} unsupported${failed}`;
}

function formatPrunerStats(result: PrunerResult): string {
	return `pruner dropped ${plural(result.droppedIds.length, "observation")} in ${plural(result.passes.length, "pass", "passes")}, stop: ${result.stopReason}`;
}

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
		const progress = new CompactionProgressTracker();
		const WIDGET_NAME = "om_compact_progress";
		let clearWidget = () => {};
		try {
			runtime.ensureConfig(ctx.cwd);
			const runId = `compaction-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
			return await withDebugLogContext({ enabled: runtime.config.debugLog === true, cwd: ctx.cwd, runId }, async () => {
			const { preparation, branchEntries, signal } = event;
			const { firstKeptEntryId, tokensBefore } = preparation;

			// Capture ctx properties synchronously — after multiple awaits below,
			// the extension ctx may become stale (e.g. after session replacement/reload).
			const hasUI = ctx.hasUI;
			const ui = ctx.ui;
			debugLog("compaction.start", {
				firstKeptEntryId,
				tokensBefore,
				branchEntryCount: branchEntries.length,
				reflectionThresholdTokens: runtime.config.reflectionThresholdTokens,
				compactionMaxToolCalls: runtime.config.compactionMaxToolCalls,
			});

			const resolved = await runtime.resolveModel(ctx as any);
			if (!resolved.ok) {
				debugLog("compaction.model_unavailable", { reason: resolved.reason });
				if (hasUI) ui?.notify(
					`Observational memory: cannot compact — ${resolved.reason}. ` +
					"Fix the model/API key and try /compact manually.",
					"error",
				);
				return { cancel: true };
			}
			runtime.resolveFailureNotified = false;

			const updateWidget = () => {
				if (!hasUI || !ui) return;
				if (!progress.getPhase()) {
					ui.setWidget(WIDGET_NAME, undefined);
					return;
				}
				ui.setWidget(WIDGET_NAME, (_tui: any, theme: any) => {
					return new Text(
						progress.formatWidget(theme),
						0, 0,
					);
				});
			};
			clearWidget = () => {
				if (hasUI && ui) ui.setWidget(WIDGET_NAME, undefined);
			};

			let entries = branchEntries as Parameters<typeof getMemoryState>[0];

			if (runtime.observerPromise) {
				try { await runtime.observerPromise; } catch { /* already notified via launchObserverTask */ }
				// In-flight observer may have appended a new observation entry during the await;
				// refresh from sessionManager so gap computation and coverage collection see it
				entries = ctx.sessionManager.getBranch() as typeof entries;
			}

			const memoryState = getMemoryState(entries);
			debugLog("compaction.memory_state", {
				committedObservations: memoryState.committedObs.length,
				pendingObservations: memoryState.pendingObs.length,
				reflections: memoryState.reflections.length,
			});

			let gapObservationData: ObservationEntryData | null = null;
			const gap = gapRawEntries(entries, firstKeptEntryId);
			if (gap.length > 0) {
				const { text: gapChunk, sourceEntryIds } = serializeSourceAddressedBranchEntries(gap);
				if (gapChunk.trim() && sourceEntryIds.length > 0) {
					const gapFromId = gap[0].id;
					const gapUpToId = gap[gap.length - 1].id;
					const priorObservationLines = observationsToPromptLines([
						...memoryState.committedObs,
						...memoryState.pendingObs,
					]);
					const gapTokenEstimate = estimateStringTokens(gapChunk);
					debugLog("compaction.sync_catchup.start", {
						gapEntryCount: gap.length,
						sourceEntryIds,
						gapFromId,
						gapUpToId,
						tokenEstimate: gapTokenEstimate,
					});
					if (hasUI) ui?.notify(
						`Observational memory: sync catch-up observer running on ~${gapTokenEstimate.toLocaleString()}-token gap`,
						"info",
					);
					progress.setPhase("observer", 1, 1);
					updateWidget();
					runtime.observerInFlight = true;
					const gapCall = runObserver({
						model: resolved.model as any,
						apiKey: resolved.apiKey,
						headers: resolved.headers,
						priorReflections: memoryState.reflections.map(reflectionToPromptLine),
						priorObservations: priorObservationLines,
						chunk: gapChunk,
						allowedSourceEntryIds: sourceEntryIds,
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
							debugLog("compaction.sync_catchup.records", {
								count: records.length,
								observationTokens,
								coversFromId: gapFromId,
								coversUpToId: gapUpToId,
								records,
							});
							pi.appendEntry(OBSERVATION_CUSTOM_TYPE, gapObservationData);
							if (hasUI && ui) ui.notify(
								`Observational memory: sync catch-up recorded ${records.length} observation${records.length === 1 ? "" : "s"} (~${observationTokens.toLocaleString()} tokens)`,
								"info",
							);
						} else if (hasUI && ui) {
							debugLog("compaction.sync_catchup.empty", { gapEntryCount: gap.length });
							ui.notify(
								"Observational memory: sync catch-up observer returned empty — proceeding with compaction",
								"warning",
							);
						}
					} catch (error) {
						const msg = error instanceof Error ? error.message : String(error);
						debugLog("compaction.sync_catchup.error", { gapEntryCount: gap.length, errorMessage: msg });
						if (hasUI && ui) ui.notify(
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
			debugLog("compaction.delta", {
				priorFirstKeptEntryId,
				firstKeptEntryId,
				deltaObservationEntries: deltaObservationData.length,
				deltaObservationRecords: deltaObservationData.reduce((sum, data) => sum + data.records.length, 0),
				gapObservationRecords: gapObservationData?.records.length ?? 0,
			});

			if (deltaObservationData.length === 0) {
				// No new observations since last compaction. If we have existing memory,
				// carry it forward in a no-op compaction so it survives Pi's compaction.
				// If there is truly nothing (no prior memory either), cancel.
				if (memoryState.committedObs.length === 0 && memoryState.reflections.length === 0) {
					debugLog("compaction.no_delta_cancel", {
						committedObservations: memoryState.committedObs.length,
						pendingObservations: memoryState.pendingObs.length,
						reflections: memoryState.reflections.length,
					});
					if (hasUI) {
						ui?.notify(
							`Observational memory: nothing to compact yet — ${plural(memoryState.committedObs.length, "committed observation")} and ${plural(memoryState.pendingObs.length, "pending observation")}; no eligible delta before compact boundary`,
							"warning",
						);
					}
					return { cancel: true };
				}

				// Carry forward existing memory without running reflector/pruner
				const workingReflections: MemoryReflection[] = migrateLegacyReflections(memoryState.reflections);
				debugLog("compaction.no_delta_carry_forward", {
					observations: memoryState.committedObs.length,
					reflections: workingReflections.length,
				});
				const summary = renderSummary(workingReflections, memoryState.committedObs);
				const details: MemoryDetailsV4 = {
					type: "observational-memory",
					version: 4,
					observations: memoryState.committedObs,
					reflections: workingReflections,
				};
				if (hasUI) ui?.notify(
					`Observational memory: no new observations — carrying forward ${memoryState.committedObs.length} observation${memoryState.committedObs.length === 1 ? "" : "s"}, ${workingReflections.length} reflection${workingReflections.length === 1 ? "" : "s"}`,
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
			}

			const workingReflections: MemoryReflection[] = migrateLegacyReflections(memoryState.reflections);
			const workingObservations: ObservationRecord[] = [
				...memoryState.committedObs,
				...deltaObservationData.flatMap((d) => d.records),
			];

			const observationTokens = observationPoolTokens(workingObservations);
			debugLog("compaction.reflect_prune.gate", {
				observationTokens,
				reflectionThresholdTokens: runtime.config.reflectionThresholdTokens,
				willRun: observationTokens >= runtime.config.reflectionThresholdTokens,
				workingObservations: workingObservations.length,
				workingReflections: workingReflections.length,
			});

			let finalReflections = workingReflections;
			let finalObservations = workingObservations;

			if (observationTokens >= runtime.config.reflectionThresholdTokens) {
				try {
					debugLog("compaction.reflect_prune.start", {
						workingObservations: workingObservations.length,
						workingReflections: workingReflections.length,
						observationTokens,
					});
					if (hasUI) ui?.notify("Observational memory: running reflector + pruner...", "info");
					progress.setPhase("reflector", 1, 3);
					progress.setStartingCounts(workingReflections.length, workingObservations.length);
					updateWidget();
					const coverageBefore = coverageTagCounts(workingReflections, workingObservations);
					const reflectorResult = await runReflector(
						{ model: resolved.model as any, apiKey: resolved.apiKey, headers: resolved.headers, signal, onEvent: (event) => { progress.onEvent(event); updateWidget(); }, maxToolCalls: runtime.config.compactionMaxToolCalls },
						workingReflections,
						workingObservations,
						(pass, max) => { progress.setPhase("reflector", pass, max); updateWidget(); },
					);
					finalReflections = reflectorResult.reflections;
					const coverageAfter = coverageTagCounts(finalReflections, workingObservations);
					debugLog("compaction.reflector.result", {
						stats: reflectorResult.stats,
						coverageBefore,
						coverageAfter,
						beforeReflections: workingReflections.length,
						afterReflections: finalReflections.length,
					});

					const prunerResult = await runPruner(
						{ model: resolved.model as any, apiKey: resolved.apiKey, headers: resolved.headers, signal, onEvent: (event) => { progress.onEvent(event); updateWidget(); }, maxToolCalls: runtime.config.compactionMaxToolCalls },
						finalReflections,
						workingObservations,
						runtime.config.reflectionThresholdTokens,
						(pass, max) => { progress.setPhase("pruner", pass, max); updateWidget(); },
					);
					finalObservations = prunerResult.observations;
					debugLog("compaction.pruner.result", {
						stopReason: prunerResult.stopReason,
						fellBack: prunerResult.fellBack,
						droppedIds: prunerResult.droppedIds,
						passes: prunerResult.passes,
						beforeObservations: workingObservations.length,
						afterObservations: finalObservations.length,
					});
					updateWidget();
					if (hasUI) {
						ui?.notify(
							`Observational memory: diagnostics — ${formatReflectorStats(reflectorResult.stats)}; coverage ${formatCoverageCounts(coverageBefore)} → ${formatCoverageCounts(coverageAfter)}; ${formatPrunerStats(prunerResult)}`,
							"info",
						);
					}
					if (prunerResult.fellBack && hasUI) {
						ui?.notify(
							"Observational memory: pruner run failed; kept observation set unchanged",
							"warning",
						);
					}
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					debugLog("compaction.reflect_prune.error", { errorMessage: msg });
					if (hasUI) ui?.notify(`Observational memory: reflect/prune failed: ${msg}`, "warning");
				}
			}

			const summary = renderSummary(finalReflections, finalObservations);

			if (finalObservations.length === 0) {
				throw new Error("invariant violated: finalObservations empty after delta guard");
			}

			const details: MemoryDetailsV4 = {
				type: "observational-memory",
				version: 4,
				observations: finalObservations,
				reflections: finalReflections,
			};
			debugLog("compaction.result", {
				finalObservations: finalObservations.length,
				finalReflections: finalReflections.length,
				firstKeptEntryId,
				tokensBefore,
			});

			if (hasUI) ui?.notify(
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
			});
		} finally {
			runtime.compactHookInFlight = false;
			progress.clear();
			clearWidget();
		}
	});
}