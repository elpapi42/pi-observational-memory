import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runDropper } from "../agents/dropper/agent.js";
import { observationPoolMetrics } from "../agents/dropper/pool.js";
import { runObserver } from "../agents/observer/agent.js";
import { runReflector } from "../agents/reflector/agent.js";
import { debugLog, withDebugLogContext } from "../debug-log.js";
import { type ResolveResult, type Runtime } from "../runtime.js";
import { serializeSourceAddressedBranchEntries } from "../serialize.js";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_NONE,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	OBSERVATION_COVERAGE_TYPES,
	buildObservationsDroppedData,
	buildObservationsNoneData,
	buildObservationsRecordedData,
	buildReflectionsRecordedData,
	earlierCoverageMarkerId,
	foldLedger,
	fullProjection,
	isSourceEntry,
	latestCoverageIndex,
	latestCoverageMarkerId,
	observationToSummaryLine,
	rawTokensSinceObservationCoverage,
	rawTokensSinceReflectionCoverage,
	reflectionToSummaryLine,
	type Entry,
	type Reflection,
} from "../session-ledger/index.js";

type ResolvedModel = Extract<ResolveResult, { ok: true }>;

type ConsolidationCtx = {
	cwd: string;
	hasUI: boolean;
	ui?: { notify: (message: string, type?: "warning" | "info" | "error") => void };
	model: unknown;
	modelRegistry: any;
	sessionManager: {
		getBranch: () => unknown;
		getSessionId?: () => string;
		getSessionFile?: () => string | undefined;
	};
};

type StageOutcome = "continue" | "abort";

type ReflectorStageResult = {
	outcome: StageOutcome;
	sameRunReflections: Reflection[];
	effectiveReflectionCoverageId?: string;
};

function sourceEntriesAfter(entries: Entry[], index: number): Entry[] {
	return entries.slice(index + 1).filter(isSourceEntry);
}

function appendEntry(pi: ExtensionAPI, customType: string, data: unknown): void {
	pi.appendEntry(customType, data);
}

function mergeReflections(existing: Reflection[], additional: Reflection[]): Reflection[] {
	const seen = new Set(existing.map((reflection) => reflection.id));
	const merged = [...existing];
	for (const reflection of additional) {
		if (seen.has(reflection.id)) continue;
		seen.add(reflection.id);
		merged.push(reflection);
	}
	return merged;
}

function anyStageDue(entries: Entry[], runtime: Runtime): boolean {
	return rawTokensSinceObservationCoverage(entries) >= runtime.config.observeAfterTokens
		|| rawTokensSinceReflectionCoverage(entries) >= runtime.config.reflectAfterTokens;
}

function makeModelResolver(runtime: Runtime, ctx: ConsolidationCtx): (stage: "observer" | "reflector" | "dropper") => Promise<ResolvedModel | undefined> {
	let cached: ResolveResult | undefined;
	return async (stage) => {
		cached ??= await runtime.resolveModel({
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			hasUI: ctx.hasUI,
			ui: ctx.ui,
		});
		if (cached.ok) {
			runtime.resolveFailureNotified = false;
			return cached;
		}
		debugLog(`${stage}.model_unavailable`, { reason: cached.reason });
		if (!runtime.resolveFailureNotified && ctx.hasUI && ctx.ui) {
			ctx.ui.notify(`Observational memory: ${stage} skipped — ${cached.reason}`, "warning");
			runtime.resolveFailureNotified = true;
		}
		return undefined;
	};
}

export function registerConsolidationTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	const launch = (_event: unknown, ctx: ConsolidationCtx) => {
		maybeLaunchConsolidation(pi, runtime, ctx);
	};
	pi.on("agent_start", launch);
	pi.on("turn_end", launch);
}

function debugSessionMetadata(ctx: ConsolidationCtx): { sessionId?: string; sessionFile?: string } {
	try {
		return {
			sessionId: ctx.sessionManager.getSessionId?.(),
			sessionFile: ctx.sessionManager.getSessionFile?.(),
		};
	} catch {
		return {};
	}
}

function maybeLaunchConsolidation(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx): void {
	runtime.ensureConfig(ctx.cwd);
	if (runtime.config.passive === true) return;
	if (runtime.consolidationInFlight) return;

	const entries = ctx.sessionManager.getBranch() as Entry[];
	if (!anyStageDue(entries, runtime)) return;

	const runId = `consolidation-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
	const consolidationCtx: ConsolidationCtx = {
		cwd: ctx.cwd,
		hasUI: ctx.hasUI,
		ui: ctx.ui,
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
		sessionManager: ctx.sessionManager,
	};

	const sessionMetadata = debugSessionMetadata(ctx);
	void runtime.launchConsolidationTask(ctx, async () => withDebugLogContext({
		enabled: runtime.config.debugLog === true,
		cwd: ctx.cwd,
		...sessionMetadata,
		runId,
	}, async () => {
		await runConsolidationPipeline(pi, runtime, consolidationCtx);
	}));
}

export async function runConsolidationPipeline(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
): Promise<void> {
	const resolveModel = makeModelResolver(runtime, ctx);

	runtime.consolidationPhase = "observer";
	try {
		const observerOutcome = await runObserverStage(pi, runtime, ctx, resolveModel);
		if (observerOutcome === "abort") return;
	} catch (error) {
		debugLog("observer.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "observer", error) });
		return;
	}

	runtime.consolidationPhase = "reflector";
	let reflectorResult: ReflectorStageResult;
	try {
		reflectorResult = await runReflectorStage(pi, runtime, ctx, resolveModel);
		if (reflectorResult.outcome === "abort") return;
	} catch (error) {
		debugLog("reflector.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "reflector", error) });
		return;
	}

	runtime.consolidationPhase = "dropper";
	try {
		await runDropperStage(pi, runtime, ctx, resolveModel, reflectorResult.sameRunReflections, reflectorResult.effectiveReflectionCoverageId);
	} catch (error) {
		debugLog("dropper.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "dropper", error) });
	}
}

async function runObserverStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "observer") => Promise<ResolvedModel | undefined>,
): Promise<StageOutcome> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const tokens = rawTokensSinceObservationCoverage(entries);
	if (tokens < runtime.config.observeAfterTokens) return "continue";

	const lastCoverageIdx = latestCoverageIndex(entries, OBSERVATION_COVERAGE_TYPES);
	const chunkEntries = sourceEntriesAfter(entries, lastCoverageIdx);
	const coversUpToId = chunkEntries.at(-1)?.id;
	if (!coversUpToId) return "continue";

	const { text: chunk, sourceEntryIds } = serializeSourceAddressedBranchEntries(chunkEntries);
	if (!chunk.trim() || sourceEntryIds.length === 0) return "continue";

	const memory = fullProjection(entries);
	const priorReflections = memory.reflections.map(reflectionToSummaryLine);
	const priorObservations = memory.observations.map(observationToSummaryLine);

	if (ctx.hasUI) ctx.ui?.notify(
		`Observational memory: observer running on ~${tokens.toLocaleString()}-token chunk`,
		"info",
	);
	debugLog("observer.start", {
		tokens,
		coversUpToId,
		sourceEntryIds,
		sourceEntryCount: sourceEntryIds.length,
		priorReflections: priorReflections.length,
		priorObservations: priorObservations.length,
	});

	const resolved = await resolveModel("observer");
	if (!resolved) return "abort";

	const observations = await runObserver({
		model: resolved.model as any,
		apiKey: resolved.apiKey,
		headers: resolved.headers,
		priorReflections,
		priorObservations,
		chunk,
		allowedSourceEntryIds: sourceEntryIds,
		maxTurns: runtime.config.agentMaxTurns,
		thinkingLevel: runtime.config.model?.thinking ?? "low",
	});
	if (!observations || observations.length === 0) {
		// The observer ran over this chunk and judged there was nothing worth
		// recording. Persist a coverage-only marker so the watermark advances and
		// the same span is not re-observed on every subsequent turn (which would
		// otherwise spam the user and burn observer calls until something
		// incidental finally sticks). Raw entries remain available to the
		// reflector and until compaction, so no memory is lost.
		const noneData = buildObservationsNoneData(coversUpToId);
		if (noneData) appendEntry(pi, OM_OBSERVATIONS_NONE, noneData);
		debugLog("observer.empty", { coversUpToId, coverageAdvanced: noneData !== undefined });
		if (ctx.hasUI) ctx.ui?.notify(
			"Observational memory: observer found nothing new to record",
			"info",
		);
		return "continue";
	}

	const data = buildObservationsRecordedData(observations, coversUpToId);
	if (!data) return "continue";
	debugLog("observer.records", {
		count: observations.length,
		observationTokens: observations.reduce((sum, observation) => sum + observation.tokenCount, 0),
		coversUpToId,
	});
	appendEntry(pi, OM_OBSERVATIONS_RECORDED, data);
	debugLog("observer.appended", { count: observations.length, coversUpToId });
	if (ctx.hasUI) ctx.ui?.notify(
		`Observational memory: ${observations.length} observation${observations.length === 1 ? "" : "s"} recorded`,
		"info",
	);
	return "continue";
}

async function runReflectorStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "reflector") => Promise<ResolvedModel | undefined>,
): Promise<ReflectorStageResult> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const reflectionTokens = rawTokensSinceReflectionCoverage(entries);
	if (reflectionTokens < runtime.config.reflectAfterTokens) return { outcome: "continue", sameRunReflections: [] };

	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!observationCoverageId) return { outcome: "continue", sameRunReflections: [] };

	if (ctx.hasUI) ctx.ui?.notify(
		`Observational memory: reflector running (~${reflectionTokens.toLocaleString()} tokens)`,
		"info",
	);
	const resolved = await resolveModel("reflector");
	if (!resolved) return { outcome: "abort", sameRunReflections: [] };

	const folded = foldLedger(entries);
	const reflections = await runReflector({
		model: resolved.model as any,
		apiKey: resolved.apiKey,
		headers: resolved.headers,
		reflections: folded.reflections,
		observations: folded.activeObservations,
		maxTurns: runtime.config.agentMaxTurns,
		thinkingLevel: runtime.config.model?.thinking ?? "low",
	});
	if (!reflections) return { outcome: "continue", sameRunReflections: [] };

	const data = buildReflectionsRecordedData(reflections, observationCoverageId);
	if (!data) return { outcome: "continue", sameRunReflections: [] };
	appendEntry(pi, OM_REFLECTIONS_RECORDED, data);
	return {
		outcome: "continue",
		sameRunReflections: reflections,
		effectiveReflectionCoverageId: data.coversUpToId,
	};
}

async function runDropperStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "dropper") => Promise<ResolvedModel | undefined>,
	sameRunReflections: Reflection[],
	sameRunReflectionCoverageId: string | undefined,
): Promise<StageOutcome> {
	if (!sameRunReflectionCoverageId || sameRunReflections.length === 0) {
		debugLog("dropper.waiting_for_reflection", { sameRunReflections: sameRunReflections.length });
		return "continue";
	}

	const entries = ctx.sessionManager.getBranch() as Entry[];
	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!observationCoverageId) return "continue";

	const folded = foldLedger(entries);
	const metrics = observationPoolMetrics(folded.activeObservations, runtime.config.observationsPoolTargetTokens);
	if (!metrics.ready) {
		debugLog("dropper.not_ready", {
			observationTokens: metrics.observationTokens,
			targetTokens: metrics.targetTokens,
			tokensOverTarget: metrics.tokensOverTarget,
			fullness: metrics.fullness,
			activeObservationCount: metrics.activeObservationCount,
			droppableCount: metrics.droppableCount,
			maxDropsAllowed: metrics.maxDropsAllowed,
		});
		return "continue";
	}
	debugLog("dropper.stage_start", {
		observationCoverageId,
		sameRunReflectionCoverageId,
		sameRunReflectionCount: sameRunReflections.length,
		activeObservationCount: metrics.activeObservationCount,
		observationTokens: metrics.observationTokens,
		targetTokens: metrics.targetTokens,
		tokensOverTarget: metrics.tokensOverTarget,
		fullness: metrics.fullness,
		maxDropsAllowed: metrics.maxDropsAllowed,
	});

	if (ctx.hasUI) ctx.ui?.notify(
		`Observational memory: dropper running after reflection — active observation pool ~${metrics.observationTokens.toLocaleString()} / ${metrics.targetTokens.toLocaleString()} target tokens (${Math.round(metrics.fullness * 100).toLocaleString()}%)`,
		"info",
	);
	const resolved = await resolveModel("dropper");
	if (!resolved) return "abort";

	const reflectionsForDropper = mergeReflections(folded.reflections, sameRunReflections);
	const droppedIds = await runDropper({
		model: resolved.model as any,
		apiKey: resolved.apiKey,
		headers: resolved.headers,
		reflections: reflectionsForDropper,
		observations: folded.activeObservations,
		targetTokens: runtime.config.observationsPoolTargetTokens,
		maxTurns: runtime.config.agentMaxTurns,
		thinkingLevel: runtime.config.model?.thinking ?? "low",
	});
	const coversUpToId = earlierCoverageMarkerId(entries, observationCoverageId, sameRunReflectionCoverageId);
	const data = coversUpToId && droppedIds ? buildObservationsDroppedData(droppedIds, coversUpToId) : undefined;
	debugLog("dropper.append", {
		droppedIdsCount: droppedIds?.length ?? 0,
		coversUpToId,
		dataBuilt: data !== undefined,
		appended: data !== undefined,
	});
	if (data) appendEntry(pi, OM_OBSERVATIONS_DROPPED, data);
	return "continue";
}
