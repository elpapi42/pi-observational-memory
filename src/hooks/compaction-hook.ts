import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { debugLog, withDebugLogContext } from "../debug-log.js";
import { resolveTurnLimits } from "../config.js";
import {
	collectObservationsByCoverage,
	findLastCompactionIndex,
	firstRawIdAfter,
	gapRawEntries,
	getMemoryState,
	lastObservationCoverEndIdx,
	rawTailEntriesBetween,
} from "../branch.js";
import {
	REFLECTOR_MAX_PASSES,
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
import { estimateEntryTokens, estimateStringTokens } from "../tokens.js";
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

type EntryLike = Parameters<typeof estimateEntryTokens>[0] & { id: string };

/**
 * A message entry whose role can be inspected.
 */
type MessageEntry = EntryLike & { type: "message"; message?: { role?: string } };

/**
 * Returns true if the entry is a message with role "user" — the start of a new turn.
 * In Pi's branch, a turn = user message + assistant response (with tool calls).
 */
function isTurnStart(entry: EntryLike): boolean {
	if (entry.type !== "message") return false;
	const e = entry as MessageEntry;
	return (e.message as { role?: string })?.role === "user";
}

/**
 * Split gap entries into batches that mimic active mode's turn_end observer trigger.
 *
 * Active mode fires at `turn_end` when rawTokensSinceLastBound >= threshold.
 * Each trigger observes everything accumulated since the last boundary.
 * The chunk is naturally bounded because the observer runs frequently.
 *
 * This function replicates that pattern for the passive-mode catch-up:
 * 1. Split entries into turns (at user-role message boundaries)
 * 2. Accumulate turns until total tokens >= threshold (same gate as active mode)
 * 3. Emit that accumulated batch as one chunk
 * 4. Repeat for remaining turns
 *
 * If the very first turn already exceeds the threshold, it is emitted alone
 * (we never skip entries). If remaining turns total less than the threshold,
 * they form a final chunk that will be observed (rather than deferred —
 * unlike the loop-level threshold check which defers sub-threshold remainders).
 */
function batchByTurnsAndThreshold(gap: EntryLike[], thresholdTokens: number): EntryLike[][] {
	if (gap.length === 0) return [];

	// Step 1: split into individual turns
	const turns: EntryLike[][] = [];
	let currentTurn: EntryLike[] = [];

	for (const entry of gap) {
		if (isTurnStart(entry) && currentTurn.length > 0) {
			turns.push(currentTurn);
			currentTurn = [];
		}
		currentTurn.push(entry);
	}
	if (currentTurn.length > 0) turns.push(currentTurn);

	// Step 2: accumulate turns into threshold-gated batches
	// This mirrors active mode: accumulate turns until threshold is met, then observe.
	const batches: EntryLike[][] = [];
	let batch: EntryLike[] = [];
	let batchTokens = 0;

	for (const turn of turns) {
		const turnTokens = turn.reduce((sum, e) => sum + estimateEntryTokens(e), 0);

		batch.push(...turn);
		batchTokens += turnTokens;

		// Emit batch when threshold is reached (same gate as active mode's turn_end check)
		if (batchTokens >= thresholdTokens) {
			batches.push(batch);
			batch = [];
			batchTokens = 0;
		}
	}

	// Remaining turns below threshold — still emit as final batch so they get observed
	if (batch.length > 0) batches.push(batch);

	return batches;
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
			const turnLimits = resolveTurnLimits(runtime.config);
			debugLog("compaction.start", {
				firstKeptEntryId,
				tokensBefore,
				branchEntryCount: branchEntries.length,
				reflectionThresholdTokens: runtime.config.reflectionThresholdTokens,
				turnLimits,
				legacyCompactionMaxToolCalls: runtime.config.compactionMaxToolCalls,
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

			// --- Sync catch-up observer: replay the active-mode observer loop ---
			//
			// Active mode flow:
			//   turn_end fires → check rawTokensSinceLastBound >= threshold → observe
			//   everything from last boundary to leaf → append entry → boundary advances
			//
			// Passive mode replay:
			//   1. Get the gap (raw entries about to be compacted away)
			//   2. Split gap into turns (at user-role message boundaries)
			//   3. Accumulate turns until threshold is met (same gate as active mode)
			//   4. Observe that batch — same as what active mode would have done at turn_end
			//   5. Append entry with coversFromId/coversUpToId → boundary advances
			//   6. Repeat for remaining batches
			const gap = gapRawEntries(entries, firstKeptEntryId);

			if (gap.length > 0) {
				const gapEndId = gap[gap.length - 1].id;
				const gapTokenEstimate = gap.reduce((sum, e) => sum + estimateEntryTokens(e), 0);

				// Pre-compute batches upfront so we can show accurate progress (pass N/total)
				const batches = batchByTurnsAndThreshold(gap as EntryLike[], runtime.config.observationThresholdTokens);

				debugLog("compaction.sync_catchup.start", {
					gapEntryCount: gap.length,
					gapFromId: gap[0].id,
					gapUpToId: gapEndId,
					tokenEstimate: gapTokenEstimate,
					batchCount: batches.length,
				});
				if (hasUI) ui?.notify(
					`Observational memory: sync catch-up observer running on ~${gapTokenEstimate.toLocaleString()}-token gap in ${batches.length} batch${batches.length === 1 ? "" : "es"}`,
					"info",
				);

				if (batches.length > 0) {
					runtime.observerInFlight = true;
					try {
						for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
							// Refresh entries — previous iteration may have appended an observation entry
							entries = ctx.sessionManager.getBranch() as typeof entries;

							const batch = batches[batchIdx];
							const chunkCoversFromId = batch[0].id;
							const chunkCoversUpToId = batch[batch.length - 1].id;

							const { text: chunkText, sourceEntryIds } = serializeSourceAddressedBranchEntries(
								batch as Parameters<typeof serializeSourceAddressedBranchEntries>[0],
							);
							if (!chunkText.trim() || sourceEntryIds.length === 0) continue;

							const passNum = batchIdx + 1;
							progress.setPhase("observer", passNum, batches.length);
							updateWidget();

							const batchTokens = batch.reduce((sum, e) => sum + estimateEntryTokens(e), 0);
							debugLog("compaction.sync_catchup.pass.start", {
								pass: passNum,
								totalPasses: batches.length,
								coversFromId: chunkCoversFromId,
								coversUpToId: chunkCoversUpToId,
								batchEntryCount: batch.length,
								batchTokens,
							});

							// Same prior context as observer-trigger.ts
							const currentMemoryState = getMemoryState(entries);
							const priorObservationLines = observationsToPromptLines([
								...currentMemoryState.committedObs,
								...currentMemoryState.pendingObs,
							]);

							const records = await runObserver({
								model: resolved.model as any,
								apiKey: resolved.apiKey,
								headers: resolved.headers,
								priorReflections: currentMemoryState.reflections.map(reflectionToPromptLine),
								priorObservations: priorObservationLines,
								chunk: chunkText,
								allowedSourceEntryIds: sourceEntryIds,
								signal,
								maxTurns: turnLimits.observerMaxTurnsPerRun,
								thinkingLevel: runtime.config.thinkingLevel,
							});

							if (records && records.length > 0) {
								const observationTokens = records.reduce((sum, r) => sum + estimateStringTokens(r.content), 0);
								const data: ObservationEntryData = {
									records,
									coversFromId: chunkCoversFromId,
									coversUpToId: chunkCoversUpToId,
									tokenCount: observationTokens,
								};
								pi.appendEntry(OBSERVATION_CUSTOM_TYPE, data);
								debugLog("compaction.sync_catchup.pass.records", {
									pass: passNum,
									count: records.length,
									observationTokens,
									coversFromId: chunkCoversFromId,
									coversUpToId: chunkCoversUpToId,
								});
							} else {
								debugLog("compaction.sync_catchup.pass.empty", {
									pass: passNum,
									batchEntryCount: batch.length,
								});
							}
						}

						if (hasUI && ui) {
							ui.notify(
								`Observational memory: sync catch-up completed ${batches.length} observer batch${batches.length === 1 ? "" : "es"}`,
								"info",
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
					}
				}
			}

			const priorCompactionIdx = findLastCompactionIndex(entries);
			const priorFirstKeptEntryId = priorCompactionIdx >= 0 ? entries[priorCompactionIdx].firstKeptEntryId : undefined;
			const deltaObservationData = collectObservationsByCoverage(entries, priorFirstKeptEntryId, firstKeptEntryId);
			debugLog("compaction.delta", {
				priorFirstKeptEntryId,
				firstKeptEntryId,
				deltaObservationEntries: deltaObservationData.length,
				deltaObservationRecords: deltaObservationData.reduce((sum, data) => sum + data.records.length, 0),
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
					progress.setPhase("reflector", 1, REFLECTOR_MAX_PASSES);
					progress.setStartingCounts(workingReflections.length, workingObservations.length);
					updateWidget();
					const coverageBefore = coverageTagCounts(workingReflections, workingObservations);
					const reflectorResult = await runReflector(
						{ model: resolved.model as any, apiKey: resolved.apiKey, headers: resolved.headers, signal, onEvent: (event) => { progress.onEvent(event); updateWidget(); }, maxTurns: turnLimits.reflectorMaxTurnsPerPass, thinkingLevel: runtime.config.thinkingLevel },
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
						{ model: resolved.model as any, apiKey: resolved.apiKey, headers: resolved.headers, signal, onEvent: (event) => { progress.onEvent(event); updateWidget(); }, maxTurns: turnLimits.prunerMaxTurnsPerPass, thinkingLevel: runtime.config.thinkingLevel },
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
