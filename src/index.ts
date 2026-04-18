import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SettingsManager } from "@mariozechner/pi-coding-agent";
import {
	collectObservationsForCompaction,
	collectObservationsPendingNextCompaction,
	findLastBoundIndex,
	findLastCompactionIndex,
	firstRawIdAfter,
	getPriorMemoryDetails,
	rawLiveTokens,
	rawMessagesBetween,
	rawTokensFromIndex,
	rawTokensSinceLastBound,
	rawTokensSinceLastCompaction,
} from "./branch.js";
import { renderSummary, runPruner, runReflector } from "./compaction.js";
import { DEFAULTS, loadConfig, type Config } from "./config.js";
import { runObserver } from "./observer.js";
import { parseObservations } from "./parse.js";
import { serializeConversation } from "./serialize.js";
import { estimateStringTokens } from "./tokens.js";
import { OBSERVATION_CUSTOM_TYPE, type MemoryDetails, type Observation, type Reflection } from "./types.js";

export default function observationalMemory(pi: ExtensionAPI) {
	let config: Config = { ...DEFAULTS };
	let configLoaded = false;
	let observerInFlight = false;
	let compactInFlight = false;

	function ensureConfig(cwd: string): void {
		if (configLoaded) return;
		config = loadConfig(cwd);
		configLoaded = true;
	}

	async function resolveModel(ctx: { model: unknown; modelRegistry: any; hasUI: boolean; ui?: { notify: (m: string, lvl?: string) => void } }) {
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
		if (!model) return undefined;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) return undefined;
		return { model, apiKey: auth.apiKey as string, headers: auth.headers as Record<string, string> | undefined };
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

		const chunk = rawMessagesBetween(entries, coversFromId, coversUpToId);
		if (chunk.length === 0) return;

		observerInFlight = true;
		void (async () => {
			try {
				const resolved = await resolveModel(ctx as any);
				if (!resolved) return;

				const content = await runObserver({
					model: resolved.model as any,
					apiKey: resolved.apiKey,
					headers: resolved.headers,
					priorReflections: priorReflectionContents,
					priorObservations: allPriorObservationContents,
					chunk,
				});
				if (!content) return;

				const data = {
					content,
					coversFromId,
					coversUpToId,
					tokenCount: estimateStringTokens(content),
				};
				pi.appendEntry(OBSERVATION_CUSTOM_TYPE, data);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(`Observational memory: observer failed: ${msg}`, "warning");
			} finally {
				observerInFlight = false;
			}
		})();
	});

	pi.on("agent_end", (_event, ctx) => {
		ensureConfig(ctx.cwd);
		if (compactInFlight) return;

		const entries = ctx.sessionManager.getBranch() as Parameters<typeof rawTokensSinceLastCompaction>[0];
		const tokens = rawTokensSinceLastCompaction(entries);
		if (tokens < config.compactionThresholdTokens) return;

		compactInFlight = true;
		setTimeout(() => {
			if (!ctx.isIdle()) {
				compactInFlight = false;
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
		ensureConfig(ctx.cwd);
		const { preparation, branchEntries, signal } = event;
		const { firstKeptEntryId, tokensBefore } = preparation;

		const resolved = await resolveModel(ctx as any);
		if (!resolved) return;

		const entries = branchEntries as Parameters<typeof getPriorMemoryDetails>[0];
		const priorDetails = getPriorMemoryDetails(entries);
		const deltaObservationData = collectObservationsForCompaction(entries, firstKeptEntryId, priorDetails);

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

				const prunedObservations = await runPruner(
					{ model: resolved.model as any, apiKey: resolved.apiKey, headers: resolved.headers, signal },
					finalReflections,
					workingObservations,
				);
				finalObservations = prunedObservations;
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(`Observational memory: reflect/prune failed: ${msg}`, "warning");
			}
		}

		const summary = renderSummary(finalReflections, finalObservations);
		if (!summary.trim()) return;

		const details: MemoryDetails = {
			type: "observational-memory",
			version: 2,
			observations: finalObservations,
			reflections: finalReflections,
		};

		return {
			compaction: {
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
			},
		};
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
				"── Observational Memory (v2) ──",
				`Raw since last bound:       ~${sinceBound.toLocaleString()} tokens (observer fires at ${config.observationThresholdTokens.toLocaleString()})`,
				`Raw since last compaction:  ~${sinceCompaction.toLocaleString()} tokens (compaction fires at ${config.compactionThresholdTokens.toLocaleString()})`,
				`Raw live (kept tail + new): ~${liveRaw.toLocaleString()} tokens`,
				`Observations pending next compaction: ${pendingObs.length} entries, ~${treeObsTokens.toLocaleString()} tokens`,
				`Observations in details:    ${priorDetails?.observations.length ?? 0} entries, ~${detailsObsTokens.toLocaleString()} tokens`,
				`Reflections in details:     ${priorDetails?.reflections.length ?? 0} entries, ~${detailsRefTokens.toLocaleString()} tokens`,
				"",
				"── Parameters ──",
				`Observation threshold tokens: ${config.observationThresholdTokens.toLocaleString()}`,
				`Compaction threshold tokens:  ${config.compactionThresholdTokens.toLocaleString()}`,
				`Reflection threshold tokens:  ${config.reflectionThresholdTokens.toLocaleString()}`,
				`Pi keep-recent tokens:      ${keepRecentTokens.toLocaleString()}`,
				`Observer in flight:         ${observerInFlight}`,
				`Compact in flight:          ${compactInFlight}`,
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
			const lastCompactionIdx = findLastCompactionIndex(entries);
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
				const tailStart = lastCompactionIdx >= 0 ? lastCompactionIdx + 1 : 0;
				const tailMessages = rawMessagesBetween(
					entries,
					entries[tailStart]?.id ?? entries[0]?.id ?? "",
					ctx.sessionManager.getLeafId() ?? entries[entries.length - 1]?.id ?? "",
				);
				sections.push("");
				sections.push("── Raw uncompacted tail ──");
				sections.push(tailMessages.length > 0 ? serializeConversation(tailMessages) : "(none)");
			}

			ctx.ui.notify(sections.join("\n"), "info");
		},
	});

	void parseObservations;
	void rawTokensFromIndex;
}
