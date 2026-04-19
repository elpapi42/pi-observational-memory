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
	liveTailEntries,
	rawLiveTokens,
	rawTailEntriesBetween,
	rawTokensFromIndex,
	rawTokensSinceLastBound,
	rawTokensSinceLastCompaction,
} from "./branch.js";
import { renderSummary, runPruner, runReflector } from "./compaction.js";
import { DEFAULTS, loadConfig, type Config } from "./config.js";
import { runObserver } from "./observer.js";
import { parseObservations } from "./parse.js";
import { serializeBranchEntries } from "./serialize.js";
import { estimateStringTokens } from "./tokens.js";
import { OBSERVATION_CUSTOM_TYPE, type MemoryDetails, type Observation, type ObservationEntryData, type Reflection } from "./types.js";

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
		const priorReflectionContents = priorDetails ? priorDetails.reflections.map((r) => r.content) : [];
		const priorObservationContents = priorDetails ? priorDetails.observations.map((o) => o.content) : [];
		const pendingObservations = collectObservationsPendingNextCompaction(entries);
		const allPriorObservationContents = [
			...priorObservationContents,
			...pendingObservations.map((o) => o.content),
		];

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

			const content = await runObserver({
				model: resolved.model as any,
				apiKey: resolved.apiKey,
				headers: resolved.headers,
				priorReflections: priorReflectionContents,
				priorObservations: allPriorObservationContents,
				chunk,
			});
			if (!content) {
				if (ctx.hasUI && ctx.ui) ctx.ui.notify(
					"Observational memory: observer returned empty content (no observation recorded)",
					"warning",
				);
				return;
			}

			const observationTokens = estimateStringTokens(content);
			const data = {
				content,
				coversFromId,
				coversUpToId,
				tokenCount: observationTokens,
			};
			pi.appendEntry(OBSERVATION_CUSTOM_TYPE, data);
			if (ctx.hasUI && ctx.ui) ctx.ui.notify(
				`Observational memory: observation recorded (~${observationTokens.toLocaleString()} tokens)`,
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
				const priorReflectionContents = priorDetails ? priorDetails.reflections.map((r) => r.content) : [];
				const priorObservationContents = priorDetails ? priorDetails.observations.map((o) => o.content) : [];
				const pendingObservations = collectObservationsPendingNextCompaction(entries);
				const allPriorObservationContents = [
					...priorObservationContents,
					...pendingObservations.map((o) => o.content),
				];
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
					priorObservations: allPriorObservationContents,
					chunk: gapChunk,
					signal,
				});
				const gapPromise: Promise<void> = gapCall.then(() => undefined, () => undefined);
				observerPromise = gapPromise;
				try {
					const content = await gapCall;
					if (content) {
						const observationTokens = estimateStringTokens(content);
						gapObservationData = {
							content,
							coversFromId: gapFromId,
							coversUpToId: gapUpToId,
							tokenCount: observationTokens,
						};
						pi.appendEntry(OBSERVATION_CUSTOM_TYPE, gapObservationData);
						if (ctx.hasUI && ctx.ui) ctx.ui.notify(
							`Observational memory: sync catch-up observation recorded (~${observationTokens.toLocaleString()} tokens)`,
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
		const workingObservations: Observation[] = [
			...(priorDetails ? priorDetails.observations : []),
			...deltaObservationData.map((d) => ({ content: d.content, tokenCount: d.tokenCount })),
		];

		const observationTokens = workingObservations.reduce((sum, o) => sum + o.tokenCount, 0);

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
				);
				finalObservations = prunerResult.observations;
				if (prunerResult.fellBack && ctx.hasUI) {
					ctx.ui.notify(
						"Observational memory: pruner output unparseable; kept prior observation set unchanged",
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
			version: 2,
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
			const liveRaw = rawLiveTokens(entries);

			const priorDetails = getPriorMemoryDetails(entries);
			const detailsObsTokens = priorDetails ? priorDetails.observations.reduce((s, o) => s + o.tokenCount, 0) : 0;
			const detailsRefTokens = priorDetails ? priorDetails.reflections.reduce((s, r) => s + r.tokenCount, 0) : 0;

			const pendingObs = collectObservationsPendingNextCompaction(entries);
			const treeObsTokens = pendingObs.reduce((s, o) => s + o.tokenCount, 0);

			const keepRecentTokens = SettingsManager.create(ctx.cwd).getCompactionKeepRecentTokens();

			const lines = [
				"── State ──",
				`Raw since last observation: ~${sinceBound.toLocaleString()} tokens (observer fires at ${config.observationThresholdTokens.toLocaleString()})`,
				`Raw since last compaction:  ~${sinceCompaction.toLocaleString()} tokens (compaction fires at ${config.compactionThresholdTokens.toLocaleString()})`,
				`Raw live (kept tail + new): ~${liveRaw.toLocaleString()} tokens`,
				`Observations pending:       ~${treeObsTokens.toLocaleString()} tokens (${pendingObs.length} entries)`,
				`Observations:               ~${detailsObsTokens.toLocaleString()} tokens (${priorDetails?.observations.length ?? 0} entries)`,
				`Reflections:                ~${detailsRefTokens.toLocaleString()} tokens`,
				`Observer in flight:         ${observerInFlight}`,
				`Compact in flight:          ${compactInFlight}`,
				"",
				"── Parameters ──",
				`Observation threshold: ${config.observationThresholdTokens.toLocaleString()} tokens`,
				`Compaction threshold:  ${config.compactionThresholdTokens.toLocaleString()} tokens`,
				`Reflection threshold:  ${config.reflectionThresholdTokens.toLocaleString()} tokens`,
				`Pi kept tail size:     ${keepRecentTokens.toLocaleString()} tokens`,
			];

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("om-view", {
		description: "Print observational memory details (--full to include raw uncompacted tail)",
		handler: async (args, ctx) => {
			ensureConfig(ctx.cwd);
			const full = args.includes("--full");
			const entries = ctx.sessionManager.getBranch() as Parameters<typeof getPriorMemoryDetails>[0];
			const priorDetails = getPriorMemoryDetails(entries);
			const pendingObs = collectObservationsPendingNextCompaction(entries);

			const sections: string[] = [];

			sections.push("── Reflections (from most recent compaction) ──");
			if (priorDetails && priorDetails.reflections.length > 0) {
				sections.push(priorDetails.reflections.map((r) => r.content).join("\n"));
			} else {
				sections.push("(none)");
			}
			sections.push("");
			sections.push("── Observations (from most recent compaction) ──");
			if (priorDetails && priorDetails.observations.length > 0) {
				sections.push(priorDetails.observations.map((o) => o.content).join("\n"));
			} else {
				sections.push("(none)");
			}
			sections.push("");
			sections.push("── Observations pending next compaction (in tree) ──");
			if (pendingObs.length > 0) {
				sections.push(pendingObs.map((o) => o.content).join("\n"));
			} else {
				sections.push("(none)");
			}

			if (full) {
				const tail = liveTailEntries(entries);
				sections.push("");
				sections.push("── Raw uncompacted tail ──");
				sections.push(tail.length > 0 ? serializeBranchEntries(tail) : "(none)");
			}

			ctx.ui.notify(sections.join("\n"), "info");
		},
	});

	void parseObservations;
	void rawTokensFromIndex;
}
