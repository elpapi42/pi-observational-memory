import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SettingsManager } from "@mariozechner/pi-coding-agent";
import {
	collectObservationsByCoverage,
	collectObservationsPendingNextCompaction,
	findLastBoundIndex,
	findLastCompactionIndex,
	firstRawIdAfter,
	gapRawEntries,
	getPriorMemoryDetails,
	rawTailEntriesBetween,
	rawTokensFromIndex,
	rawTokensSinceLastBound,
	rawTokensSinceLastCompaction,
} from "./branch.js";
import { renderSummary, runPruner, runReflector } from "./compaction.js";
import { DEFAULTS, loadConfig, type Config } from "./config.js";
import { observationsToPromptLines, runObserver } from "./observer.js";
import { serializeBranchEntries } from "./serialize.js";
import { estimateStringTokens } from "./tokens.js";
import {
	OBSERVATION_CUSTOM_TYPE,
	type MemoryDetails,
	type ObservationEntryData,
	type ObservationRecord,
	type Reflection,
	type Relevance,
	RELEVANCE_VALUES,
} from "./types.js";

function countByRelevance(records: ObservationRecord[]): Record<Relevance, number> {
	const counts: Record<Relevance, number> = { low: 0, medium: 0, high: 0, critical: 0 };
	for (const r of records) counts[r.relevance]++;
	return counts;
}

function formatRelevanceHistogram(counts: Record<Relevance, number>): string {
	return RELEVANCE_VALUES
		.slice()
		.reverse()
		.map((r) => `${r}: ${counts[r]}`)
		.join(" · ");
}

export default function observationalMemory(pi: ExtensionAPI) {
	let config: Config = { ...DEFAULTS };
	let configLoaded = false;
	let observerInFlight = false;
	let observerPromise: Promise<void> | null = null;
	let compactInFlight = false;
	let compactHookInFlight = false;
	let resolveFailureNotified = false;

	type ResolveResult =
		| { ok: true; model: unknown; apiKey: string; headers?: Record<string, string> }
		| { ok: false; reason: string };

	function launchObserverTask(
		ctx: any,
		label: string,
		work: () => Promise<void>,
	): Promise<void> {
		observerInFlight = true;
		let promise!: Promise<void>;
		promise = (async () => {
			try {
				await work();
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI && ctx.ui) ctx.ui.notify(`Observational memory: ${label} failed: ${msg}`, "warning");
			} finally {
				observerInFlight = false;
				if (observerPromise === promise) observerPromise = null;
			}
		})();
		observerPromise = promise;
		return promise;
	}

	function ensureConfig(cwd: string): void {
		if (configLoaded) return;
		config = loadConfig(cwd);
		configLoaded = true;
	}

	async function resolveModel(ctx: { model: unknown; modelRegistry: any; hasUI: boolean; ui?: { notify: (m: string, lvl?: string) => void } }): Promise<ResolveResult> {
		let model = ctx.model;
		if (config.compactionModel) {
			const configured = ctx.modelRegistry.find(config.compactionModel.provider, config.compactionModel.id);
			if (configured) {
				model = configured;
			} else if (ctx.hasUI && ctx.ui) {
				ctx.ui.notify(
					`Observational memory: configured model ${config.compactionModel.provider}/${config.compactionModel.id} not found, using session model`,
					"warning",
				);
			}
		}
		if (!model) return { ok: false, reason: "no model available (session has no model and no compactionModel configured)" };
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			const provider = (model as { provider?: string }).provider ?? "unknown";
			return { ok: false, reason: `no API key for provider "${provider}"` };
		}
		return { ok: true, model, apiKey: auth.apiKey as string, headers: auth.headers as Record<string, string> | undefined };
	}

	pi.on("turn_end", (_event, ctx) => {
		ensureConfig(ctx.cwd);
		if (observerInFlight) return;

		const entries = ctx.sessionManager.getBranch() as Parameters<typeof rawTokensSinceLastBound>[0];
		const tokens = rawTokensSinceLastBound(entries);
		if (tokens < config.observationThresholdTokens) return;

		const lastBoundIdx = findLastBoundIndex(entries);
		const coversFromId = firstRawIdAfter(entries, lastBoundIdx);
		if (!coversFromId) return;

		const leafId = ctx.sessionManager.getLeafId();
		if (!leafId) return;
		const coversUpToId = leafId;

		const priorDetails = getPriorMemoryDetails(entries);
		const priorReflectionContents = priorDetails ? priorDetails.reflections : [];
		const committedObservationRecords = priorDetails ? priorDetails.observations : [];
		const pendingObservationData = collectObservationsPendingNextCompaction(entries);
		const pendingObservationRecords = pendingObservationData.flatMap((d) => d.records);
		const allPriorObservationLines = observationsToPromptLines([
			...committedObservationRecords,
			...pendingObservationRecords,
		]);

		const chunkEntries = rawTailEntriesBetween(entries, coversFromId, coversUpToId);
		if (chunkEntries.length === 0) return;
		const chunk = serializeBranchEntries(chunkEntries);
		if (!chunk.trim()) return;

		if (ctx.hasUI) ctx.ui.notify(
			`Observational memory: observer running on ~${tokens.toLocaleString()}-token chunk`,
			"info",
		);

		void launchObserverTask(ctx, "observer", async () => {
			const resolved = await resolveModel(ctx as any);
			if (!resolved.ok) {
				if (!resolveFailureNotified && ctx.hasUI && ctx.ui) {
					ctx.ui.notify(
						`Observational memory: observer skipped — ${resolved.reason}`,
						"warning",
					);
					resolveFailureNotified = true;
				}
				return;
			}
			resolveFailureNotified = false;

			const records = await runObserver({
				model: resolved.model as any,
				apiKey: resolved.apiKey,
				headers: resolved.headers,
				priorReflections: priorReflectionContents,
				priorObservations: allPriorObservationLines,
				chunk,
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

	pi.on("agent_end", (_event, ctx) => {
		ensureConfig(ctx.cwd);
		if (compactInFlight) return;

		const entries = ctx.sessionManager.getBranch() as Parameters<typeof rawTokensSinceLastCompaction>[0];
		const tokens = rawTokensSinceLastCompaction(entries);
		if (tokens < config.compactionThresholdTokens) return;

		if (ctx.hasUI) ctx.ui.notify(
			`Observational memory: compaction threshold reached (~${tokens.toLocaleString()} tokens); triggering compaction`,
			"info",
		);

		compactInFlight = true;
		setTimeout(async () => {
			if (observerPromise) {
				try {
					await observerPromise;
				} catch {
					// errors already surfaced via launchObserverTask
				}
			}
			if (!ctx.isIdle()) {
				compactInFlight = false;
				if (ctx.hasUI) ctx.ui.notify(
					"Observational memory: compaction deferred — agent became busy after observer wait",
					"info",
				);
				return;
			}
			const currentEntries = ctx.sessionManager.getBranch() as Parameters<typeof rawTokensSinceLastCompaction>[0];
			const currentTokens = rawTokensSinceLastCompaction(currentEntries);
			if (currentTokens < config.compactionThresholdTokens) {
				compactInFlight = false;
				if (ctx.hasUI) ctx.ui.notify(
					"Observational memory: compaction skipped — another compaction already ran during observer wait",
					"info",
				);
				return;
			}
			try {
				ctx.compact({
					onComplete: () => {
						compactInFlight = false;
						if (ctx.hasUI) ctx.ui.notify("Observational memory: compaction complete", "info");
					},
					onError: (error) => {
						compactInFlight = false;
						if (error.message === "Compaction cancelled") {
							// We already notified the user with the real reason before returning { cancel: true }.
							return;
						}
						if (ctx.hasUI) ctx.ui.notify(`Observational memory: ${error.message}`, "error");
					},
				});
			} catch (error) {
				compactInFlight = false;
				const msg = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(`Observational memory: compact threw: ${msg}`, "error");
			}
		}, 0);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (compactHookInFlight) {
			if (ctx.hasUI) ctx.ui.notify(
				"Observational memory: another compaction is already in progress; cancelling duplicate",
				"warning",
			);
			return { cancel: true };
		}
		compactHookInFlight = true;
		try {
		ensureConfig(ctx.cwd);
		const { preparation, branchEntries, signal } = event;
		const { firstKeptEntryId, tokensBefore } = preparation;

		const resolved = await resolveModel(ctx as any);
		if (!resolved.ok) {
			if (ctx.hasUI) ctx.ui.notify(
				`Observational memory: cannot compact — ${resolved.reason}. ` +
				"Fix the model/API key and try /compact manually.",
				"error",
			);
			return { cancel: true };
		}
		resolveFailureNotified = false;

		let entries = branchEntries as Parameters<typeof getPriorMemoryDetails>[0];

		if (observerPromise) {
			try { await observerPromise; } catch { /* already notified via launchObserverTask */ }
			// In-flight observer may have appended a new observation entry during the await;
			// refresh from sessionManager so gap computation and coverage collection see it.
			entries = ctx.sessionManager.getBranch() as typeof entries;
		}

		const priorDetails = getPriorMemoryDetails(entries);

		let gapObservationData: ObservationEntryData | null = null;
		const gap = gapRawEntries(entries, firstKeptEntryId);
		if (gap.length > 0) {
			const gapChunk = serializeBranchEntries(gap);
			if (gapChunk.trim()) {
				const gapFromId = gap[0].id;
				const gapUpToId = gap[gap.length - 1].id;
				const priorReflectionContents = priorDetails ? priorDetails.reflections : [];
				const committedObservationRecords = priorDetails ? priorDetails.observations : [];
				const pendingObservationData = collectObservationsPendingNextCompaction(entries);
				const pendingObservationRecords = pendingObservationData.flatMap((d) => d.records);
				const allPriorObservationLines = observationsToPromptLines([
					...committedObservationRecords,
					...pendingObservationRecords,
				]);
				const gapTokenEstimate = estimateStringTokens(gapChunk);
				if (ctx.hasUI) ctx.ui.notify(
					`Observational memory: sync catch-up observer running on ~${gapTokenEstimate.toLocaleString()}-token gap`,
					"info",
				);
				observerInFlight = true;
				const gapCall = runObserver({
					model: resolved.model as any,
					apiKey: resolved.apiKey,
					headers: resolved.headers,
					priorReflections: priorReflectionContents,
					priorObservations: allPriorObservationLines,
					chunk: gapChunk,
					signal,
				});
				const gapPromise: Promise<void> = gapCall.then(() => undefined, () => undefined);
				observerPromise = gapPromise;
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
					observerInFlight = false;
					if (observerPromise === gapPromise) observerPromise = null;
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

		const workingReflections: Reflection[] = priorDetails ? [...priorDetails.reflections] : [];
		const workingObservations: ObservationRecord[] = [
			...(priorDetails ? priorDetails.observations : []),
			...deltaObservationData.flatMap((d) => d.records),
		];

		const observationTokens = workingObservations.reduce((sum, o) => sum + estimateStringTokens(o.content), 0);

		let finalReflections = workingReflections;
		let finalObservations = workingObservations;

		if (observationTokens >= config.reflectionThresholdTokens) {
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
					config.reflectionThresholdTokens,
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
			compactHookInFlight = false;
		}
	});

	pi.registerCommand("om-status", {
		description: "Show observational memory status",
		handler: async (_args, ctx) => {
			ensureConfig(ctx.cwd);
			const entries = ctx.sessionManager.getBranch() as Parameters<typeof rawTokensSinceLastBound>[0];
			const sinceBound = rawTokensSinceLastBound(entries);
			const sinceCompaction = rawTokensSinceLastCompaction(entries);

			const priorDetails = getPriorMemoryDetails(entries);
			const committedObs = priorDetails ? priorDetails.observations : [];
			const committedObsTokens = committedObs.reduce((s, r) => s + estimateStringTokens(r.content), 0);
			const committedObsCount = committedObs.length;
			const committedRefs = priorDetails ? priorDetails.reflections : [];
			const committedRefsTokens = committedRefs.reduce((s, r) => s + estimateStringTokens(r), 0);
			const committedRefsCount = committedRefs.length;

			const pendingObsData = collectObservationsPendingNextCompaction(entries);
			const pendingObsRecords = pendingObsData.flatMap((d) => d.records);
			const pendingObsTokens = pendingObsData.reduce((s, d) => s + d.tokenCount, 0);
			const pendingObsCount = pendingObsRecords.length;

			const allObsRecords = [...committedObs, ...pendingObsRecords];
			const relevanceHistogram = countByRelevance(allObsRecords);

			const keepRecentTokens = SettingsManager.create(ctx.cwd).getCompactionKeepRecentTokens();

			const obsThreshold = config.observationThresholdTokens;
			const compThreshold = config.compactionThresholdTokens;
			const refThreshold = config.reflectionThresholdTokens;
			const observationPoolTokens = committedObsTokens + pendingObsTokens;
			const obsPct = Math.min(100, Math.round((sinceBound / obsThreshold) * 100));
			const compPct = Math.min(100, Math.round((sinceCompaction / compThreshold) * 100));
			const refPct = Math.min(100, Math.round((observationPoolTokens / refThreshold) * 100));

			const refLabel = committedRefsCount === 1 ? "entry" : "entries";
			const cObsLabel = committedObsCount === 1 ? "observation" : "observations";
			const pObsLabel = pendingObsCount === 1 ? "observation" : "observations";

			const lines = [
				"── Memory ──",
				`Reflections:   ~${committedRefsTokens.toLocaleString()} tokens (${committedRefsCount} ${refLabel})      — durable insights`,
				`Observations:`,
				`  committed    ~${committedObsTokens.toLocaleString()} tokens (${committedObsCount} ${cObsLabel}) — folded into last compaction`,
				`  pending      ~${pendingObsTokens.toLocaleString()} tokens (${pendingObsCount} ${pObsLabel}) — waiting for next compaction`,
				`  relevance    ${formatRelevanceHistogram(relevanceHistogram)}`,
				"",
				"── Activity ──",
				`Next observation: ~${sinceBound.toLocaleString()} / ${obsThreshold.toLocaleString()} tokens (${obsPct}%)`,
				`  → at ${obsThreshold.toLocaleString()} tokens, recent conversation is compressed into new observations`,
				`Next compaction:  ~${sinceCompaction.toLocaleString()} / ${compThreshold.toLocaleString()} tokens (${compPct}%)`,
				`  → at ${compThreshold.toLocaleString()} tokens, raw history is replaced by the updated reflections and`,
				`    observations, keeping only the last ${keepRecentTokens.toLocaleString()} tokens of conversation verbatim`,
				`Next reflection:  ~${observationPoolTokens.toLocaleString()} / ${refThreshold.toLocaleString()} tokens (${refPct}%)`,
				`  → if observations exceed ${refThreshold.toLocaleString()} tokens when compaction runs, reflections are`,
				`    distilled from them and redundant observations are pruned away`,
			];

			if (observerInFlight || compactInFlight) {
				lines.push("");
				lines.push("── In flight ──");
				if (observerInFlight) lines.push("Observer: running");
				if (compactInFlight) lines.push("Compaction: running");
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("om-view", {
		description: "Print observational memory details (reflections + observations)",
		handler: async (_args, ctx) => {
			ensureConfig(ctx.cwd);
			const entries = ctx.sessionManager.getBranch() as Parameters<typeof getPriorMemoryDetails>[0];
			const priorDetails = getPriorMemoryDetails(entries);
			const pendingObsData = collectObservationsPendingNextCompaction(entries);

			const committedRefs = priorDetails ? priorDetails.reflections : [];
			const committedRefTokens = committedRefs.reduce((s, r) => s + estimateStringTokens(r), 0);
			const committedRefCount = committedRefs.length;

			const committedObs = priorDetails ? priorDetails.observations : [];
			const committedObsTokens = committedObs.reduce((s, r) => s + estimateStringTokens(r.content), 0);
			const committedObsCount = committedObs.length;

			const pendingObsRecords = pendingObsData.flatMap((d) => d.records);
			const pendingObsTokens = pendingObsData.reduce((s, d) => s + d.tokenCount, 0);
			const pendingObsCount = pendingObsRecords.length;

			const totalObsCount = committedObsCount + pendingObsCount;
			const totalTokens = committedRefTokens + committedObsTokens + pendingObsTokens;
			const relevanceHistogram = countByRelevance([...committedObs, ...pendingObsRecords]);

			const plural = (n: number, singular: string, plural: string) => (n === 1 ? singular : plural);
			const renderObs = (r: ObservationRecord) =>
				`[${r.id}] ${r.timestamp} [${r.relevance}] ${r.content}`;

			const sections: string[] = [];

			sections.push(
				`Memory: ${committedRefCount} ${plural(committedRefCount, "reflection", "reflections")} · ` +
					`${totalObsCount} ${plural(totalObsCount, "observation", "observations")} ` +
					`(${committedObsCount} committed, ${pendingObsCount} pending) · ` +
					`~${totalTokens.toLocaleString()} tokens · ` +
					`relevance ${formatRelevanceHistogram(relevanceHistogram)}`,
			);
			sections.push("");

			sections.push(
				`── Reflections (${committedRefCount} ${plural(committedRefCount, "entry", "entries")}, ~${committedRefTokens.toLocaleString()} tokens) ──`,
			);
			if (committedRefs.length > 0) {
				sections.push(committedRefs.join("\n\n"));
			} else {
				sections.push("(none)");
			}

			sections.push("");
			sections.push(
				`── Observations — committed (${committedObsCount} ${plural(committedObsCount, "observation", "observations")}, ~${committedObsTokens.toLocaleString()} tokens) ──`,
			);
			if (committedObs.length > 0) {
				sections.push(committedObs.map(renderObs).join("\n"));
			} else {
				sections.push("(none)");
			}

			sections.push("");
			sections.push(
				`── Observations — pending (${pendingObsCount} ${plural(pendingObsCount, "observation", "observations")}, ~${pendingObsTokens.toLocaleString()} tokens) ──`,
			);
			if (pendingObsRecords.length > 0) {
				sections.push(pendingObsRecords.map(renderObs).join("\n"));
			} else {
				sections.push("(none)");
			}

			sections.push("");
			sections.push("Tip: use /tree to browse the raw messages still live in the session.");

			ctx.ui.notify(sections.join("\n"), "info");
		},
	});

	void rawTokensFromIndex;
}
