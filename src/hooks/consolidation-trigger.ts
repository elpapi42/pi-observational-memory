import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { runDropper } from "../agents/dropper/agent.js";
import { runSystemOneDropper, scoreObservations } from "../agents/dropper/system-one/agent.js";
import type { ClassifierRegistry } from "../agents/dropper/system-one/classifier.js";
import { dropProbability, type ObservationSignals } from "../agents/dropper/system-one/questions.js";
import { observationPoolMetrics } from "../agents/dropper/pool.js";
import { appendDropScores, appendReflectionDropScores, type DropScoreRow, type ReflectionDropRow } from "../drop-scores.js";
import { coverageTierForObservation, reflectionCoverageMap } from "../agents/dropper/coverage.js";
import { selectDropCandidates } from "../agents/dropper/agent.js";
import { ObserverStreamError, runObserver } from "../agents/observer/agent.js";
import { reflectionEvidenceMap, runReflectionDropper, selectReflectionDropCandidates } from "../agents/reflection-dropper/agent.js";
import { reflectionPoolMetrics } from "../agents/reflection-dropper/pool.js";
import { runReflector } from "../agents/reflector/agent.js";
import { debugLog, withDebugLogContext } from "../debug-log.js";
import { resolveObserveAfterTokens, resolveObserverChunkMaxTokens, resolveReflectAfterTokens, resolveWorkerMemoryMaxTokens } from "../config.js";
import type { ConsolidationPhase, ResolveCtx, ResolveResult, Runtime } from "../runtime.js";
import { serializeSourceAddressedBranchEntries } from "../serialize.js";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_DROPPED,
	OM_REFLECTIONS_RECORDED,
	OM_WORKER_COST,
	buildObservationsDroppedData,
	buildObservationsRecordedData,
	buildReflectionsDroppedData,
	boundWorkerMemory,
	buildReflectionsRecordedData,
	earlierCoverageMarkerId,
	foldLedger,
	fullProjection,
	isSourceEntry,
	latestCoverageIndex,
	latestCoverageMarkerId,
	observationToSummaryLine,
	realTokensSinceAnchor,
	observedTokensSinceReflectionCoverage,
	rawTokensSinceObservationCoverage,
	rawTokensSinceReflectionDropCoverage,
	reflectionToSummaryLine,
	type Entry,
	type Observation,
	type Reflection,
	type V3MemoryCustomType,
	type WorkerCostReport,
} from "../session-ledger/index.js";
import { EMPTY_WORKER_USAGE, deltaWorkerUsage, type WorkerUsageTotals } from "../worker-usage.js";

type ResolvedModel = Extract<ResolveResult, { ok: true }>;

export type ConsolidationOptions = {
	/**
	 * Ignore stage cadence clocks and run every stage that has work.
	 *
	 * Used by `/om:consolidate`. Force overrides scheduling only: pool targets,
	 * coverage requirements, and drop caps still apply, because those are safety
	 * bounds rather than timers.
	 */
	force?: boolean;
};

export type ConsolidationCtx = {
	cwd: string;
	hasUI: boolean;
	ui?: { notify: (message: string, type?: "warning" | "info" | "error") => void };
	model: unknown;
	modelRegistry: any;
	/** Active session thinking level, used for `$thinking` substitution in `modelMap`. */
	thinkingLevel?: ModelThinkingLevel;
	getContextUsage?: () => { tokens?: number | null; contextWindow?: number } | undefined;
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

/**
 * The reflection dropper has no abort outcome: a skipped, failed, or
 * model-less run must not stop the observation dropper, which resolves its own
 * model and reads post-drop ledger state either way.
 */
type ReflectionDropperStageResult = {
	sameRunDroppedReflectionIds: string[];
};

function sourceEntriesAfter(entries: Entry[], index: number): Entry[] {
	return entries.slice(index + 1).filter(isSourceEntry);
}

function appendEntry(pi: ExtensionAPI, customType: string, data: unknown): void {
	pi.appendEntry(customType, data);
}

/**
 * Persist one worker cost snapshot per consolidation run.
 *
 * pi tracks the main conversation's cost; the observer/reflector/dropper agent
 * loops are billed separately and only this records them. Only runs that made
 * worker calls append an entry. Best-effort: a reporting failure must not fail
 * the run.
 */
function appendWorkerCostReport(
	pi: ExtensionAPI,
	runtime: Runtime,
	usageBefore: WorkerUsageTotals,
): void {
	try {
		const workerAfter = runtime.workerUsage?.snapshot() ?? EMPTY_WORKER_USAGE;
		const run = deltaWorkerUsage(workerAfter, usageBefore);
		if (run.cost === 0 && run.totalTokens === 0) return;
		const report: WorkerCostReport = {
			at: new Date().toISOString(),
			cost: run.cost,
			input: run.input,
			output: run.output,
			cacheRead: run.cacheRead,
			cacheWrite: run.cacheWrite,
			totalTokens: run.totalTokens,
		};
		appendEntry(pi, OM_WORKER_COST, report);
		debugLog("worker_cost.appended", { cost: report.cost, totalTokens: report.totalTokens });
	} catch (error) {
		debugLog("worker_cost.error", {
			errorMessage: error instanceof Error ? error.message : String(error),
		});
	}
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

/**
 * Real current context tokens from the session (provider-reported usage, the
 * same basis the footer percentage uses). Falls back to undefined when the
 * host pi lacks getContextUsage or the count is unknown (e.g. right after a
 * compaction, before the next valid assistant response).
 */
function realContextTokens(ctx: ConsolidationCtx): number | undefined {
	const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
	const tokens = usage?.tokens;
	return typeof tokens === "number" && Number.isFinite(tokens) ? tokens : undefined;
}

function stageDue(
	entries: Entry[],
	runtime: Runtime,
	currentTokens: number | undefined,
	customType: V3MemoryCustomType,
	rawEstimateFn: (entries: Entry[]) => number,
	threshold: number,
): boolean {
	// The raw estimate counts every source entry this stage has not covered yet,
	// including entries a compaction has already removed from context. When coverage lags behind
	// the latest compaction, the provider delta only measures growth since that
	// compaction and would starve the stage forever (a small window that Pi
	// compacts every few thousand tokens never accumulates a threshold's worth
	// of growth), so a due raw backlog always counts.
	if (rawEstimateFn(entries) >= threshold) return true;
	if (currentTokens !== undefined) {
		const real = realTokensSinceAnchor(entries, customType, currentTokens);
		if (real !== undefined) return real >= threshold;
	}
	// Real delta unmeasurable (no usage baseline, or accounting basis changed) or
	// old pi host without getContextUsage — the raw estimate above already
	// decided, and it cannot over-fire or starve.
	return false;
}

/** Stage progress: the larger of the raw uncovered backlog and the provider-reported growth. */
function stageTokens(entries: Entry[], customType: V3MemoryCustomType, currentTokens: number | undefined, rawEstimateFn: (entries: Entry[]) => number): number {
	const raw = rawEstimateFn(entries);
	const real = currentTokens !== undefined ? realTokensSinceAnchor(entries, customType, currentTokens) : undefined;
	return real !== undefined ? Math.max(raw, real) : raw;
}

function sessionContextWindow(ctx: ConsolidationCtx): number | undefined {
	const contextWindow = (ctx.model as { contextWindow?: number } | undefined)?.contextWindow;
	return typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : undefined;
}

function anyStageDue(entries: Entry[], runtime: Runtime, currentTokens: number | undefined, contextWindow: number | undefined): boolean {
	return stageDue(entries, runtime, currentTokens, OM_OBSERVATIONS_RECORDED, rawTokensSinceObservationCoverage, resolveObserveAfterTokens(runtime.config, contextWindow))
		|| stageDue(entries, runtime, currentTokens, OM_REFLECTIONS_RECORDED, observedTokensSinceReflectionCoverage, resolveReflectAfterTokens(runtime.config, contextWindow))
		|| reflectionDropperDue(entries, runtime, currentTokens, contextWindow);
}

/**
 * The reflection dropper's own clock, independent of the reflector: the active
 * reflection pool is over target and enough source has accumulated since the
 * last maintenance pass. Tying maintenance to the reflector clock either
 * over-fires the reflector while the observer drains a backlog, or starves the
 * pool while the reflector has nothing new to record.
 */
function reflectionDropperDue(
	entries: Entry[],
	runtime: Runtime,
	currentTokens: number | undefined,
	contextWindow: number | undefined,
): boolean {
	const folded = foldLedger(entries);
	const metrics = reflectionPoolMetrics(folded.activeReflections, runtime.config.reflectionsPoolTargetTokens);
	if (!metrics.ready) return false;
	return stageDue(entries, runtime, currentTokens, OM_REFLECTIONS_DROPPED, rawTokensSinceReflectionDropCoverage, resolveReflectAfterTokens(runtime.config, contextWindow));
}

function shouldNotifyWorker(runtime: Runtime, ctx: ConsolidationCtx): boolean {
	return runtime.config.showWorkerNotifications && ctx.hasUI;
}

function workerHeadersFor(ctx: ConsolidationCtx, resolved: ResolvedModel): ResolvedModel {
	// Console Go (opencode.ai) rejects requests without x-opencode-session
	// (400 MissingSessionID). Mirror pi's own session headers on worker calls.
	const model = (resolved.model ?? {}) as { provider?: string; baseUrl?: string };
	if (
		model.provider !== "opencode"
		&& model.provider !== "opencode-go"
		&& !(typeof model.baseUrl === "string" && model.baseUrl.includes("opencode.ai"))
	) {
		return resolved;
	}
	const sessionId = ctx.sessionManager.getSessionId?.();
	if (!sessionId) return resolved;
	return {
		...resolved,
		headers: {
			...(resolved.headers ?? {}),
			"x-opencode-session": sessionId,
			"x-opencode-client": "pi",
		},
	};
}

/** Thinking level for the worker call: the fallback's own setting wins when the fallback is active. */
function workerThinkingLevel(runtime: Runtime, resolved: ResolvedModel) {
	if (resolved.fallbackUsed === true) {
		return runtime.config.fallbackModel?.thinking ?? runtime.config.model?.thinking ?? "low";
	}
	return resolved.thinking ?? runtime.config.model?.thinking ?? "low";
}

/**
 * Context window the observer chunk is sized against. The chunk is serialized
 * once and reused verbatim if the run falls back mid-call, so cap it to the
 * smaller of the primary and fallback windows: otherwise a large-context primary
 * plus a small-context fallback would send the fallback an over-context chunk and
 * make the retry fail for a reason the fallback cannot fix. When no fallback is
 * configured this is exactly the primary model's window.
 */
function observerChunkContextWindow(runtime: Runtime, ctx: ConsolidationCtx, resolved: ResolvedModel): number | undefined {
	const primary = (resolved.model as { contextWindow?: number } | undefined)?.contextWindow;
	const fallback = runtime.config.fallbackModel;
	if (!fallback) return primary;
	const fallbackModel = ctx.modelRegistry.find?.(fallback.provider, fallback.id) as { contextWindow?: number } | undefined;
	const usablePrimary = typeof primary === "number" && primary > 0 ? primary : undefined;
	const fallbackWindow = fallbackModel?.contextWindow;
	const usableFallback = typeof fallbackWindow === "number" && fallbackWindow > 0 ? fallbackWindow : undefined;
	if (usablePrimary === undefined) return usableFallback;
	if (usableFallback === undefined) return usablePrimary;
	return Math.min(usablePrimary, usableFallback);
}

type ModelResolver = {
	resolve: (stage: ConsolidationPhase) => Promise<ResolvedModel | undefined>;
	/** Resolve the configured fallback, caching it for the rest of the pass. */
	resolveFallback: (stage: ConsolidationPhase) => Promise<ResolvedModel | undefined>;
};

function makeModelResolver(runtime: Runtime, ctx: ConsolidationCtx): ModelResolver {
	// Cached per stage, not once per pass: modelMap entries can route each stage
	// to a different model.
	const cache = new Map<ConsolidationPhase, ResolveResult>();
	// Once the fallback proves usable, keep it for the rest of the pass so later
	// stages do not re-pay a known-broken primary.
	let fallbackActive: ResolvedModel | undefined;

	const resolve = async (stage: ConsolidationPhase): Promise<ResolvedModel | undefined> => {
		if (fallbackActive) {
			runtime.resolveFailureNotified = false;
			return fallbackActive;
		}
		let resolved = cache.get(stage);
		if (!resolved) {
			resolved = await runtime.resolveModel({
				model: ctx.model,
				modelRegistry: ctx.modelRegistry,
				hasUI: ctx.hasUI,
				ui: ctx.ui,
				stage,
				thinkingLevel: ctx.thinkingLevel,
			});
			cache.set(stage, resolved);
		}
		if (resolved.ok) {
			runtime.resolveFailureNotified = false;
			return workerHeadersFor(ctx, resolved);
		}
		debugLog(`${stage}.model_unavailable`, { reason: resolved.reason });
		if (!runtime.resolveFailureNotified && ctx.hasUI && ctx.ui) {
			ctx.ui.notify(`Observational memory: ${stage} skipped — ${resolved.reason}`, "warning");
			runtime.resolveFailureNotified = true;
		}
		return undefined;
	};

	const resolveFallback = async (stage: ConsolidationPhase): Promise<ResolvedModel | undefined> => {
		if (fallbackActive) return fallbackActive;
		const resolveFallbackModel = runtime.resolveFallbackModel;
		if (typeof resolveFallbackModel !== "function") {
			debugLog(`${stage}.fallback_unavailable`, { reason: "runtime exposes no resolveFallbackModel" });
			return undefined;
		}
		const resolvedCtx: ResolveCtx = {
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			hasUI: ctx.hasUI,
			ui: ctx.ui,
			stage,
			thinkingLevel: ctx.thinkingLevel,
		};
		const result = await resolveFallbackModel.call(runtime, resolvedCtx);
		if (!result.ok) {
			debugLog(`${stage}.fallback_unavailable`, { reason: result.reason });
			return undefined;
		}
		const resolved = workerHeadersFor(ctx, { ...result, fallbackUsed: true });
		fallbackActive = resolved;
		debugLog(`${stage}.fallback_active`, {
			provider: (resolved.model as { provider?: string })?.provider,
			id: (resolved.model as { id?: string })?.id,
		});
		return resolved;
	};

	return { resolve, resolveFallback };
}

/**
 * Run one worker stage against the resolved primary model, retrying once with the
 * configured fallback model when the call throws. A stage that already resolved
 * through the fallback (resolution-time fallback) is not retried again — its error
 * is final. The last error thrown is what the caller sees, so the existing
 * stream-error classification and failure recording stay intact.
 */
async function runStageWithFallback<T>(
	ctx: ConsolidationCtx,
	stage: ConsolidationPhase,
	resolved: ResolvedModel,
	resolver: ModelResolver,
	work: (model: ResolvedModel) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	try {
		return await work(resolved);
	} catch (primaryError) {
		// An aborted run (consolidateWhenIdle yielding to the session) is not a
		// model failure: retrying with the fallback would defeat the abort.
		if (signal?.aborted) throw primaryError;
		if (resolved.fallbackUsed === true) throw primaryError;
		const fallback = await resolver.resolveFallback(stage);
		if (!fallback) throw primaryError;
		const message = primaryError instanceof Error ? primaryError.message : String(primaryError);
		debugLog(`${stage}.fallback_retry`, {
			primaryError: message,
			provider: (fallback.model as { provider?: string })?.provider,
			id: (fallback.model as { id?: string })?.id,
		});
		if (ctx.hasUI && ctx.ui) {
			ctx.ui.notify(
				`Observational memory: ${stage} failed (${message}); retrying with fallback model`,
				"warning",
			);
		}
		return await work(fallback);
	}
}

export type ConsolidationTriggerHooks = {
	/**
	 * Called after an idle-mode consolidation run finishes (or is skipped) with
	 * the `agent_settled` extension context that launched it, so work that shares
	 * the settled event (proactive compaction) gets its turn afterwards.
	 */
	afterIdleConsolidation?: (ctx: unknown) => void;
};

export function registerConsolidationTrigger(pi: ExtensionAPI, runtime: Runtime, hooks: ConsolidationTriggerHooks = {}): void {
	const idleMode = (ctx: ConsolidationCtx): boolean => {
		runtime.ensureConfig(ctx.cwd);
		return runtime.config.consolidateWhenIdle === true;
	};

	pi.on("agent_start", (_event: unknown, ctx: ConsolidationCtx) => {
		if (!idleMode(ctx)) {
			maybeLaunchConsolidation(pi, runtime, ctx);
			return;
		}
		// The session model is about to be called: get memory workers off the
		// shared server. Coverage markers are only appended on success, so an
		// aborted run simply retries after the next settled event.
		if (runtime.abortConsolidation?.()) {
			debugLog("consolidation.aborted", { reason: "agent_start" });
			if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
				"Observational memory: memory workers paused while the agent runs (consolidateWhenIdle)",
				"info",
			);
		}
	});
	pi.on("turn_end", (_event: unknown, ctx: ConsolidationCtx) => {
		if (idleMode(ctx)) return;
		maybeLaunchConsolidation(pi, runtime, ctx);
	});
	pi.on("agent_settled", (_event: unknown, ctx: ConsolidationCtx) => {
		if (!idleMode(ctx)) return;
		const launched = maybeLaunchConsolidation(pi, runtime, ctx);
		if (!hooks.afterIdleConsolidation) return;
		if (!launched) {
			hooks.afterIdleConsolidation(ctx);
			return;
		}
		void launched.finally(() => hooks.afterIdleConsolidation?.(ctx));
	});
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

/**
 * Write one row per scored observation, pairing the endpoint's signals with the
 * decision that was actually applied.
 *
 * In shadow mode the applied decision is the LLM dropper's, which is the label a
 * calibration map is fitted against. Rows are also written for observations the
 * endpoint could not score, so the log records the whole pool rather than only
 * the candidates, and a map fitted from it sees both tails.
 */
function recordDropScores(args: {
	ctx: ConsolidationCtx;
	config: NonNullable<Runtime["config"]["systemOneDropper"]>;
	observations: Observation[];
	reflections: Reflection[];
	signalsById: Map<string, ObservationSignals> | undefined;
	droppedIds: string[] | undefined;
	proposedIds: readonly string[] | undefined;
	llmDecided: boolean;
}): void {
	const { ctx, config, observations, reflections, signalsById, droppedIds, proposedIds, llmDecided } = args;
	if (observations.length === 0) return;

	const coverageById = reflectionCoverageMap(observations, reflections);
	const dropped = new Set(droppedIds ?? []);
	const proposed = proposedIds ? new Set(proposedIds) : undefined;
	// Rank the whole pool by the existing heuristic so the model can be compared
	// against it later on the same labels.
	const heuristicOrder = selectDropCandidates(
		observations.map((observation) => observation.id),
		observations,
		observations.length,
		reflections,
	);
	const heuristicRank = new Map(heuristicOrder.map((id, index) => [id, index]));
	const ts = new Date().toISOString();
	const { sessionId } = debugSessionMetadata(ctx);

	const rows: DropScoreRow[] = observations.map((observation) => {
		const signals = signalsById?.get(observation.id);
		const probability = signals ? dropProbability(signals) : undefined;
		const systemOneDecision = !signals
			? "unscored" as const
			: signals.floor >= config.vetoThreshold
				? "vetoed" as const
				: (probability ?? 0) >= config.dropThreshold
					? "drop" as const
					: "keep" as const;
		return {
			ts,
			sessionId,
			observationId: observation.id,
			relevance: observation.relevance,
			coverage: coverageTierForObservation(observation, coverageById),
			...(signals ? { signals, dropProbability: probability } : {}),
			systemOneDecision,
			...(llmDecided ? { llmDecision: dropped.has(observation.id) ? "drop" as const : "keep" as const } : {}),
			...(proposed ? { llmProposed: proposed.has(observation.id) } : {}),
			heuristicRank: heuristicRank.get(observation.id) ?? observations.length,
		};
	});

	const written = appendDropScores(sessionId, rows);
	debugLog("dropper.scores_recorded", {
		written,
		rowCount: rows.length,
		scoredCount: rows.filter((row) => row.signals !== undefined).length,
		llmDecided,
	});
}

/**
 * Write one row per active reflection, pairing what the reflection dropper
 * proposed with what the budget let through. Rows cover the whole pool, kept
 * reflections included, so a run with no drops is still recorded.
 */
function recordReflectionDropScores(args: {
	ctx: ConsolidationCtx;
	folded: ReturnType<typeof foldLedger>;
	droppedIds: string[] | undefined;
	proposedIds: readonly string[] | undefined;
}): void {
	const { ctx, folded, droppedIds, proposedIds } = args;
	const reflections = folded.activeReflections;
	if (reflections.length === 0) return;

	const evidenceById = reflectionEvidenceMap(reflections, {
		observationsById: folded.observationsById,
		droppedObservationIds: folded.droppedObservationIds,
	});
	const sortOrder = selectReflectionDropCandidates(
		reflections.map((reflection) => reflection.id),
		reflections,
		reflections.length,
		evidenceById,
	);
	const sortRank = new Map(sortOrder.map((id, index) => [id, index]));
	const dropped = new Set(droppedIds ?? []);
	const proposed = new Set(proposedIds ?? []);
	const ts = new Date().toISOString();
	const { sessionId } = debugSessionMetadata(ctx);

	const rows: ReflectionDropRow[] = reflections.map((reflection) => {
		const evidence = evidenceById.get(reflection.id);
		return {
			ts,
			sessionId,
			reflectionId: reflection.id,
			proposed: proposed.has(reflection.id),
			decision: dropped.has(reflection.id) ? "drop" as const : "keep" as const,
			sortRank: sortRank.get(reflection.id) ?? reflections.length,
			orphanCount: evidence?.orphanCount ?? 0,
			activeSupportCount: evidence?.activeSupportCount ?? 0,
			droppedSupportCount: evidence?.droppedSupportCount ?? 0,
			...(evidence?.lastEvidenceTimestamp ? { lastEvidenceTimestamp: evidence.lastEvidenceTimestamp } : {}),
		};
	});

	const written = appendReflectionDropScores(sessionId, rows);
	debugLog("reflection_dropper.scores_recorded", { written, rowCount: rows.length });
}

/** Launch a consolidation run when any stage is due. Returns its promise, or undefined when nothing launched. */
function maybeLaunchConsolidation(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx): Promise<void> | undefined {
	runtime.ensureConfig(ctx.cwd);
	if (runtime.config.passive === true) return undefined;
	if (runtime.consolidationInFlight) return undefined;

	const entries = ctx.sessionManager.getBranch() as Entry[];
	if (!anyStageDue(entries, runtime, realContextTokens(ctx), sessionContextWindow(ctx))) return undefined;

	const runId = `consolidation-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
	const consolidationCtx: ConsolidationCtx = {
		cwd: ctx.cwd,
		hasUI: ctx.hasUI,
		ui: ctx.ui,
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
		thinkingLevel: ctx.thinkingLevel,
		getContextUsage: ctx.getContextUsage,
		sessionManager: ctx.sessionManager,
	};

	const sessionMetadata = debugSessionMetadata(ctx);
	return runtime.launchConsolidationTask(ctx, async () => withDebugLogContext({
		enabled: runtime.config.debugLog === true,
		cwd: ctx.cwd,
		...sessionMetadata,
		runId,
	}, async () => {
		await runConsolidationPipeline(pi, runtime, consolidationCtx);
	}));
}

function consolidationSignal(runtime: Runtime): AbortSignal | undefined {
	return runtime.consolidationAbortController?.signal;
}

function wasAborted(runtime: Runtime): boolean {
	return consolidationSignal(runtime)?.aborted === true;
}

export async function runConsolidationPipeline(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	options: ConsolidationOptions = {},
): Promise<void> {
	const usageBefore = runtime.workerUsage?.snapshot() ?? EMPTY_WORKER_USAGE;
	try {
		await runConsolidationStages(pi, runtime, ctx, options);
	} finally {
		// Runs on every exit, including aborts, so a run's cost is never lost.
		appendWorkerCostReport(pi, runtime, usageBefore);
	}
}

async function runConsolidationStages(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	options: ConsolidationOptions = {},
): Promise<void> {
	const resolver = makeModelResolver(runtime, ctx);
	const force = options.force === true;

	runtime.consolidationPhase = "observer";
	try {
		const observerOutcome = await runObserverStage(pi, runtime, ctx, resolver, force);
		if (observerOutcome === "abort") return;
	} catch (error) {
		if (wasAborted(runtime)) return;
		debugLog("observer.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "observer", error) });
		return;
	}
	if (wasAborted(runtime)) return;

	runtime.consolidationPhase = "reflector";
	let reflectorResult: ReflectorStageResult;
	try {
		reflectorResult = await runReflectorStage(pi, runtime, ctx, resolver, force);
		if (reflectorResult.outcome === "abort") return;
	} catch (error) {
		if (wasAborted(runtime)) return;
		debugLog("reflector.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "reflector", error) });
		return;
	}
	if (wasAborted(runtime)) return;

	// Reflection drops must land before the observation dropper reads reflection
	// coverage: an observation dropped against a reflection that died this same
	// run would lose its durable meaning in both layers at once.
	runtime.consolidationPhase = "reflection-dropper";
	let reflectionDropResult: ReflectionDropperStageResult = { sameRunDroppedReflectionIds: [] };
	try {
		reflectionDropResult = await runReflectionDropperStage(pi, runtime, ctx, resolver, reflectorResult.sameRunReflections, force);
	} catch (error) {
		debugLog("reflection_dropper.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "reflection-dropper", error) });
	}

	runtime.consolidationPhase = "dropper";
	try {
		await runDropperStage(
			pi,
			runtime,
			ctx,
			resolver,
			reflectorResult.sameRunReflections,
			reflectorResult.effectiveReflectionCoverageId,
			reflectionDropResult.sameRunDroppedReflectionIds,
			force,
		);
	} catch (error) {
		if (wasAborted(runtime)) return;
		debugLog("dropper.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "dropper", error) });
	}
}

async function runObserverStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolver: ModelResolver,
	force: boolean,
): Promise<StageOutcome> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const tokens = stageTokens(entries, OM_OBSERVATIONS_RECORDED, realContextTokens(ctx), rawTokensSinceObservationCoverage);
	const observeThreshold = resolveObserveAfterTokens(runtime.config, sessionContextWindow(ctx));
	if (!force && tokens < observeThreshold) return "continue";

	const sessionMetadata = debugSessionMetadata(ctx);
	const sessionIdentity = sessionMetadata.sessionId ?? sessionMetadata.sessionFile;
	const coverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);

	// Deliberate-empty backoff (#23): an intentional "nothing to record" verdict
	// must not re-fire the observer every turn over the same span. Retry only
	// after another observeAfterTokens worth of new source tokens arrives, and
	// drop the backoff as soon as coverage advances.
	// A forced run is explicit user intent, so it clears the backoff instead of
	// honoring it.
	const backoff = force ? undefined : runtime.observerEmptyBackoff;
	if (force) runtime.observerEmptyBackoff = undefined;
	if (backoff) {
		if (
			sessionIdentity !== backoff.sessionIdentity
			|| coverageId !== backoff.coverageId
			|| tokens >= backoff.tokensAtEmpty + observeThreshold
		) {
			runtime.observerEmptyBackoff = undefined;
		} else {
			debugLog("observer.empty_backoff", { tokens, resumeAtTokens: backoff.tokensAtEmpty + observeThreshold });
			return "continue";
		}
	}

	// Resolve the model before building the chunk: the default chunk cap
	// derives from the resolved model's context window.
	const resolved = await resolver.resolve("observer");
	if (!resolved) return "abort";
	if (wasAborted(runtime)) {
		debugLog("observer.aborted", {});
		return "abort";
	}

	const lastCoverageIdx = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	const backlogEntries = sourceEntriesAfter(entries, lastCoverageIdx);

	// Budget the text that is actually sent to the observer, including source
	// labels and rendered message content. Complete entries are kept intact.
	// Only a first entry that cannot fit by itself is represented by a clearly
	// marked head/tail excerpt; the original ledger entry remains untouched.
	const contextWindow = observerChunkContextWindow(runtime, ctx, resolved);
	const maxChunkTokens = resolveObserverChunkMaxTokens(runtime.config, contextWindow);
	const {
		text: chunk,
		sourceEntryIds,
		estimatedTokens: chunkTokens,
		truncatedSourceEntryIds,
	} = serializeSourceAddressedBranchEntries(backlogEntries, { maxTokens: maxChunkTokens });
	if (!chunk.trim() || sourceEntryIds.length === 0) return "continue";
	const coversUpToId = sourceEntryIds.at(-1);
	if (!coversUpToId) return "continue";

	if (sourceEntryIds.length < backlogEntries.length || truncatedSourceEntryIds.length > 0) {
		debugLog("observer.chunk_capped", {
			maxChunkTokens,
			backlogEntries: backlogEntries.length,
			backlogTokens: tokens,
			chunkEntries: sourceEntryIds.length,
			chunkTokens,
			truncatedSourceEntryIds,
		});
	}

	const fullMemory = fullProjection(entries);
	const memory = boundWorkerMemory(fullMemory.reflections, fullMemory.observations, resolveWorkerMemoryMaxTokens(runtime.config, contextWindow));
	const priorReflections = memory.reflections.map(reflectionToSummaryLine);
	const priorObservations = memory.observations.map(observationToSummaryLine);

	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: observer running on ~${chunkTokens.toLocaleString()}-token chunk`,
		"info",
	);
	debugLog("observer.start", {
		tokens,
		chunkTokens,
		coversUpToId,
		sourceEntryIds,
		sourceEntryCount: sourceEntryIds.length,
		priorReflections: priorReflections.length,
		priorObservations: priorObservations.length,
		omittedReflections: memory.omittedReflections,
		omittedObservations: memory.omittedObservations,
	});

	let observations: Observation[] | undefined;
	try {
		observations = await runStageWithFallback(ctx, "observer", resolved, resolver, (worker) => runObserver({
			model: worker.model as any,
			apiKey: worker.apiKey,
			headers: worker.headers,
			env: worker.env,
			priorReflections,
			priorObservations,
			chunk,
			allowedSourceEntryIds: sourceEntryIds,
			usage: runtime.workerUsage,
			maxTurns: runtime.config.agentMaxTurns,
			maxOutputTokens: runtime.config.agentMaxTokens,
			signal: consolidationSignal(runtime),
			thinkingLevel: workerThinkingLevel(runtime, worker),
			modelRegistry: ctx.modelRegistry,
		}), consolidationSignal(runtime));
	} catch (error) {
		if (wasAborted(runtime)) {
			debugLog("observer.aborted", { coversUpToId });
			return "abort";
		}
		if (error instanceof ObserverStreamError) {
			// API/stream failure is not a clean empty (#32): surface it as a real
			// failure instead of the "no observations" path. Coverage stays put.
			runtime.recordConsolidationStageError(ctx, "observer", error);
			return "abort";
		}
		throw error;
	}
	if (wasAborted(runtime)) {
		debugLog("observer.aborted", { coversUpToId });
		return "abort";
	}
	if (!observations || observations.length === 0) {
		// Deliberate empty: routine info, not a warning, and back off re-fires
		// over the same span (#23).
		debugLog("observer.empty", { coversUpToId });
		runtime.observerEmptyBackoff = { sessionIdentity, coverageId, tokensAtEmpty: tokens };
		if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
			"Observational memory: observer found nothing new in this chunk (coverage unchanged; will retry later)",
			"info",
		);
		return "continue";
	}
	runtime.observerEmptyBackoff = undefined;

	const data = buildObservationsRecordedData(observations, coversUpToId);
	if (!data) return "continue";
	debugLog("observer.records", {
		count: observations.length,
		observationTokens: observations.reduce((sum, observation) => sum + observation.tokenCount, 0),
		coversUpToId,
	});
	appendEntry(pi, OM_OBSERVATIONS_RECORDED, data);
	debugLog("observer.appended", { count: observations.length, coversUpToId });
	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: ${observations.length} observation${observations.length === 1 ? "" : "s"} recorded`,
		"info",
	);
	return "continue";
}

async function runReflectorStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolver: ModelResolver,
	force: boolean,
): Promise<ReflectorStageResult> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const reflectionTokens = stageTokens(entries, OM_REFLECTIONS_RECORDED, realContextTokens(ctx), observedTokensSinceReflectionCoverage);
	if (!force && reflectionTokens < resolveReflectAfterTokens(runtime.config, sessionContextWindow(ctx))) return { outcome: "continue", sameRunReflections: [] };

	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!observationCoverageId) return { outcome: "continue", sameRunReflections: [] };

	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: reflector running (~${reflectionTokens.toLocaleString()} tokens)`,
		"info",
	);
	const resolved = await resolver.resolve("reflector");
	if (!resolved) return { outcome: "abort", sameRunReflections: [] };
	if (wasAborted(runtime)) {
		debugLog("reflector.aborted", {});
		return { outcome: "abort", sameRunReflections: [] };
	}

	const folded = foldLedger(entries);
	const reflections = await runStageWithFallback(ctx, "reflector", resolved, resolver, (worker) => {
		const reflectorMemory = boundWorkerMemory(
			folded.activeReflections,
			folded.activeObservations,
			resolveWorkerMemoryMaxTokens(runtime.config, (worker.model as { contextWindow?: number }).contextWindow),
		);
		return runReflector({
			model: worker.model as any,
			apiKey: worker.apiKey,
			headers: worker.headers,
			env: worker.env,
			reflections: reflectorMemory.reflections,
			droppedReflectionIds: folded.droppedReflectionIds,
			usage: runtime.workerUsage,
			observations: reflectorMemory.observations,
			maxTurns: runtime.config.agentMaxTurns,
			maxOutputTokens: runtime.config.agentMaxTokens,
			signal: consolidationSignal(runtime),
			thinkingLevel: workerThinkingLevel(runtime, worker),
			modelRegistry: ctx.modelRegistry,
		});
	}, consolidationSignal(runtime));
	if (wasAborted(runtime)) {
		debugLog("reflector.aborted", {});
		return { outcome: "abort", sameRunReflections: [] };
	}
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

/**
 * Prune the active reflection pool back toward `reflectionsPoolTargetTokens`.
 *
 * Runs on its own clock rather than the reflector's: reflections go stale
 * exactly when the session moves on, which is when the reflector has nothing
 * new to record. The gate is pool pressure plus source tokens since the last
 * maintenance pass, or a reflective run that just added to the pool.
 */
async function runReflectionDropperStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolver: ModelResolver,
	sameRunReflections: Reflection[],
	force: boolean,
): Promise<ReflectionDropperStageResult> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const folded = foldLedger(entries);
	const metrics = reflectionPoolMetrics(folded.activeReflections, runtime.config.reflectionsPoolTargetTokens);
	if (!metrics.ready) {
		debugLog("reflection_dropper.not_ready", {
			reflectionTokens: metrics.reflectionTokens,
			targetTokens: metrics.targetTokens,
			tokensOverTarget: metrics.tokensOverTarget,
			fullness: metrics.fullness,
			activeReflectionCount: metrics.activeReflectionCount,
			maxDropsAllowed: metrics.maxDropsAllowed,
		});
		return { sameRunDroppedReflectionIds: [] };
	}
	const reflectionDropTokens = rawTokensSinceReflectionDropCoverage(entries);
	if (
		!force
		&& sameRunReflections.length === 0
		&& !stageDue(
			entries,
			runtime,
			realContextTokens(ctx),
			OM_REFLECTIONS_DROPPED,
			rawTokensSinceReflectionDropCoverage,
			resolveReflectAfterTokens(runtime.config, sessionContextWindow(ctx)),
		)
	) {
		debugLog("reflection_dropper.not_due", { reflectionDropTokens });
		return { sameRunDroppedReflectionIds: [] };
	}

	// Reflection drops are a function of reflection-pool state, so they carry the
	// same watermark as the reflections they prune: a drop enters a bounded
	// projection exactly when its reflections do.
	const coversUpToId = latestCoverageMarkerId(entries, OM_REFLECTIONS_RECORDED);
	if (!coversUpToId) return { sameRunDroppedReflectionIds: [] };

	debugLog("reflection_dropper.stage_start", {
		coversUpToId,
		activeReflectionCount: metrics.activeReflectionCount,
		reflectionTokens: metrics.reflectionTokens,
		targetTokens: metrics.targetTokens,
		tokensOverTarget: metrics.tokensOverTarget,
		fullness: metrics.fullness,
		maxDropsAllowed: metrics.maxDropsAllowed,
	});

	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: reflection dropper running — reflection pool ~${metrics.reflectionTokens.toLocaleString()} / ${metrics.targetTokens.toLocaleString()} target tokens (${Math.round(metrics.fullness * 100).toLocaleString()}%)`,
		"info",
	);
	const resolved = await resolver.resolve("reflection-dropper");
	if (!resolved) return { sameRunDroppedReflectionIds: [] };

	let proposedIds: readonly string[] | undefined;
	const droppedIds = await runStageWithFallback(ctx, "reflection-dropper", resolved, resolver, (worker) => runReflectionDropper({
		model: worker.model as any,
		apiKey: worker.apiKey,
		headers: worker.headers,
		env: worker.env,
		reflections: folded.activeReflections,
		observations: folded.activeObservations,
		observationsById: folded.observationsById,
		droppedObservationIds: folded.droppedObservationIds,
		targetTokens: runtime.config.reflectionsPoolTargetTokens,
		usage: runtime.workerUsage,
		maxTurns: runtime.config.agentMaxTurns,
		maxOutputTokens: runtime.config.agentMaxTokens,
		thinkingLevel: workerThinkingLevel(runtime, worker),
		modelRegistry: ctx.modelRegistry,
		onProposedIds: (ids) => { proposedIds = ids; },
	}));
	// Recorded under the same switch as the observation score log, so drop
	// evaluation data is either collected for both droppers or for neither.
	if ((runtime.config.systemOneDropper?.mode ?? "off") !== "off") {
		recordReflectionDropScores({ ctx, folded, droppedIds, proposedIds });
	}
	const data = droppedIds ? buildReflectionsDroppedData(droppedIds, coversUpToId) : undefined;
	debugLog("reflection_dropper.append", {
		droppedIdsCount: droppedIds?.length ?? 0,
		coversUpToId,
		dataBuilt: data !== undefined,
		appended: data !== undefined,
	});
	if (data) appendEntry(pi, OM_REFLECTIONS_DROPPED, data);
	if (data && shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: ${data.reflectionIds.length} reflection${data.reflectionIds.length === 1 ? "" : "s"} dropped`,
		"info",
	);
	return { sameRunDroppedReflectionIds: data ? data.reflectionIds : [] };
}

async function runDropperStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolver: ModelResolver,
	sameRunReflections: Reflection[],
	sameRunReflectionCoverageId: string | undefined,
	sameRunDroppedReflectionIds: string[],
	force: boolean,
): Promise<StageOutcome> {
	// Automatic runs prune observations only right after fresh distillation, so
	// drops are always judged against just-updated coverage. A forced run has no
	// later opportunity to come back, so it prunes against existing reflections.
	if (!force && (!sameRunReflectionCoverageId || sameRunReflections.length === 0)) {
		debugLog("dropper.waiting_for_reflection", { sameRunReflections: sameRunReflections.length });
		return "continue";
	}

	const entries = ctx.sessionManager.getBranch() as Entry[];
	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!observationCoverageId) return "continue";
	// Without same-run reflections, fall back to the ledger's latest reflection
	// coverage so drop effects still never enter a projection ahead of the
	// reflections that justify them.
	const reflectionCoverageId = sameRunReflectionCoverageId ?? latestCoverageMarkerId(entries, OM_REFLECTIONS_RECORDED);

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
		reflectionCoverageId,
		sameRunReflectionCoverageId,
		sameRunReflectionCount: sameRunReflections.length,
		activeObservationCount: metrics.activeObservationCount,
		observationTokens: metrics.observationTokens,
		targetTokens: metrics.targetTokens,
		tokensOverTarget: metrics.tokensOverTarget,
		fullness: metrics.fullness,
		maxDropsAllowed: metrics.maxDropsAllowed,
	});

	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: dropper running after reflection — active observation pool ~${metrics.observationTokens.toLocaleString()} / ${metrics.targetTokens.toLocaleString()} target tokens (${Math.round(metrics.fullness * 100).toLocaleString()}%)`,
		"info",
	);

	// Coverage evidence must come from reflections that are still active. An
	// observation dropped against a reflection tombstoned earlier in this same
	// run would lose its durable meaning in both layers at once.
	const droppedReflectionIds = new Set([...folded.droppedReflectionIds, ...sameRunDroppedReflectionIds]);
	const reflectionsForDropper = mergeReflections(
		folded.activeReflections.filter((reflection) => !droppedReflectionIds.has(reflection.id)),
		sameRunReflections.filter((reflection) => !droppedReflectionIds.has(reflection.id)),
	);
	const systemOne = runtime.config.systemOneDropper;
	const mode = systemOne?.mode ?? "off";
	// The classifier model is resolved inside the agent, so a missing provider
	// surfaces as a clear error rather than a silently skipped stage.
	const systemOneArgs = systemOne && {
		config: systemOne,
		registry: ctx.modelRegistry as ClassifierRegistry,
		reflections: reflectionsForDropper,
		observations: folded.activeObservations,
		targetTokens: runtime.config.observationsPoolTargetTokens,
	};

	let droppedIds: string[] | undefined;
	let proposedIds: readonly string[] | undefined;
	let signalsById: Map<string, ObservationSignals> | undefined;

	if (systemOne && mode === "primary") {
		droppedIds = await runSystemOneDropper(systemOneArgs!);
	} else {
		// Shadow scoring runs first so a broken endpoint fails before the LLM
		// dropper spends tokens, and never silently changes which ids are dropped.
		if (systemOne && mode === "shadow") {
			try {
				signalsById = (await scoreObservations(systemOneArgs!)).signalsById;
			} catch (error) {
				debugLog("dropper.system_one.shadow_failed", { errorMessage: String(error) });
			}
		}
		const resolved = await resolver.resolve("dropper");
		if (!resolved) return "abort";
		if (wasAborted(runtime)) {
			debugLog("dropper.aborted", {});
			return "abort";
		}
		droppedIds = await runStageWithFallback(ctx, "dropper", resolved, resolver, (worker) => {
			// The dropper prunes old observations, so it sees the oldest ones that fit.
			const dropperMemory = boundWorkerMemory(
				reflectionsForDropper,
				folded.activeObservations,
				resolveWorkerMemoryMaxTokens(runtime.config, (worker.model as { contextWindow?: number }).contextWindow),
				{ observationsFrom: "oldest" },
			);
			return runDropper({
				model: worker.model as any,
				apiKey: worker.apiKey,
				headers: worker.headers,
				env: worker.env,
				reflections: dropperMemory.reflections,
				observations: dropperMemory.observations,
				targetTokens: runtime.config.observationsPoolTargetTokens,
				usage: runtime.workerUsage,
				maxTurns: runtime.config.agentMaxTurns,
				maxOutputTokens: runtime.config.agentMaxTokens,
				signal: consolidationSignal(runtime),
				thinkingLevel: workerThinkingLevel(runtime, worker),
				modelRegistry: ctx.modelRegistry,
				onProposedIds: (ids) => { proposedIds = ids; },
			});
		}, consolidationSignal(runtime));
		if (wasAborted(runtime)) {
			debugLog("dropper.aborted", {});
			return "abort";
		}
	}

	if (systemOne && mode !== "off") {
		recordDropScores({
			ctx,
			config: systemOne,
			observations: folded.activeObservations,
			reflections: reflectionsForDropper,
			signalsById,
			droppedIds,
			proposedIds,
			llmDecided: mode === "shadow",
		});
	}
	const coversUpToId = earlierCoverageMarkerId(entries, observationCoverageId, reflectionCoverageId);
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
