import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runDropper } from "../agents/dropper/agent.js";
import { observationPoolMetrics } from "../agents/dropper/pool.js";
import { ObserverStreamError, runObserver } from "../agents/observer/agent.js";
import { runReflector } from "../agents/reflector/agent.js";
import { debugLog, withDebugLogContext } from "../debug-log.js";
import { resolveObserverChunkMaxTokens, resolveWorkerMemoryMaxTokens } from "../config.js";
import type { ConsolidationPhase, ResolveCtx, ResolveResult, Runtime } from "../runtime.js";
import { serializeSourceAddressedBranchEntries } from "../serialize.js";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	buildObservationsDroppedData,
	buildObservationsRecordedData,
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
	rawTokensSinceObservationCoverage,
	observedTokensSinceReflectionCoverage,
	reflectionToSummaryLine,
	type Entry,
	type Observation,
	type Reflection,
	type V3MemoryCustomType,
} from "../session-ledger/index.js";

type ResolvedModel = Extract<ResolveResult, { ok: true }>;

type ConsolidationCtx = {
	cwd: string;
	hasUI: boolean;
	ui?: { notify: (message: string, type?: "warning" | "info" | "error") => void };
	model: unknown;
	modelRegistry: any;
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

function anyStageDue(entries: Entry[], runtime: Runtime, currentTokens: number | undefined): boolean {
	return stageDue(entries, runtime, currentTokens, OM_OBSERVATIONS_RECORDED, rawTokensSinceObservationCoverage, runtime.config.observeAfterTokens)
		|| stageDue(entries, runtime, currentTokens, OM_REFLECTIONS_RECORDED, observedTokensSinceReflectionCoverage, runtime.config.reflectAfterTokens);
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
	return runtime.config.model?.thinking ?? "low";
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
	let cached: ResolveResult | undefined;
	// Once the fallback proves usable, keep it for the rest of the pass so later
	// stages do not re-pay a known-broken primary.
	let fallbackActive: ResolvedModel | undefined;

	const resolve = async (stage: ConsolidationPhase): Promise<ResolvedModel | undefined> => {
		if (fallbackActive) {
			runtime.resolveFailureNotified = false;
			return fallbackActive;
		}
		cached ??= await runtime.resolveModel({
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			hasUI: ctx.hasUI,
			ui: ctx.ui,
		});
		if (cached.ok) {
			runtime.resolveFailureNotified = false;
			return workerHeadersFor(ctx, cached);
		}
		debugLog(`${stage}.model_unavailable`, { reason: cached.reason });
		if (!runtime.resolveFailureNotified && ctx.hasUI && ctx.ui) {
			ctx.ui.notify(`Observational memory: ${stage} skipped — ${cached.reason}`, "warning");
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

/** Launch a consolidation run when any stage is due. Returns its promise, or undefined when nothing launched. */
function maybeLaunchConsolidation(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx): Promise<void> | undefined {
	runtime.ensureConfig(ctx.cwd);
	if (runtime.config.passive === true) return undefined;
	if (runtime.consolidationInFlight) return undefined;

	const entries = ctx.sessionManager.getBranch() as Entry[];
	if (!anyStageDue(entries, runtime, realContextTokens(ctx))) return undefined;

	const runId = `consolidation-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
	const consolidationCtx: ConsolidationCtx = {
		cwd: ctx.cwd,
		hasUI: ctx.hasUI,
		ui: ctx.ui,
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
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
): Promise<void> {
	const resolver = makeModelResolver(runtime, ctx);

	runtime.consolidationPhase = "observer";
	try {
		const observerOutcome = await runObserverStage(pi, runtime, ctx, resolver);
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
		reflectorResult = await runReflectorStage(pi, runtime, ctx, resolver);
		if (reflectorResult.outcome === "abort") return;
	} catch (error) {
		if (wasAborted(runtime)) return;
		debugLog("reflector.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "reflector", error) });
		return;
	}
	if (wasAborted(runtime)) return;

	runtime.consolidationPhase = "dropper";
	try {
		await runDropperStage(pi, runtime, ctx, resolver, reflectorResult.sameRunReflections, reflectorResult.effectiveReflectionCoverageId);
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
): Promise<StageOutcome> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const tokens = stageTokens(entries, OM_OBSERVATIONS_RECORDED, realContextTokens(ctx), rawTokensSinceObservationCoverage);
	if (tokens < runtime.config.observeAfterTokens) return "continue";

	const sessionMetadata = debugSessionMetadata(ctx);
	const sessionIdentity = sessionMetadata.sessionId ?? sessionMetadata.sessionFile;
	const coverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);

	// Deliberate-empty backoff (#23): an intentional "nothing to record" verdict
	// must not re-fire the observer every turn over the same span. Retry only
	// after another observeAfterTokens worth of new source tokens arrives, and
	// drop the backoff as soon as coverage advances.
	const backoff = runtime.observerEmptyBackoff;
	if (backoff) {
		if (
			sessionIdentity !== backoff.sessionIdentity
			|| coverageId !== backoff.coverageId
			|| tokens >= backoff.tokensAtEmpty + runtime.config.observeAfterTokens
		) {
			runtime.observerEmptyBackoff = undefined;
		} else {
			debugLog("observer.empty_backoff", { tokens, resumeAtTokens: backoff.tokensAtEmpty + runtime.config.observeAfterTokens });
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
): Promise<ReflectorStageResult> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const reflectionTokens = stageTokens(entries, OM_REFLECTIONS_RECORDED, realContextTokens(ctx), observedTokensSinceReflectionCoverage);
	if (reflectionTokens < runtime.config.reflectAfterTokens) return { outcome: "continue", sameRunReflections: [] };

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
			folded.reflections,
			folded.activeObservations,
			resolveWorkerMemoryMaxTokens(runtime.config, (worker.model as { contextWindow?: number }).contextWindow),
		);
		return runReflector({
			model: worker.model as any,
			apiKey: worker.apiKey,
			headers: worker.headers,
			env: worker.env,
			reflections: reflectorMemory.reflections,
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

async function runDropperStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolver: ModelResolver,
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

	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: dropper running after reflection — active observation pool ~${metrics.observationTokens.toLocaleString()} / ${metrics.targetTokens.toLocaleString()} target tokens (${Math.round(metrics.fullness * 100).toLocaleString()}%)`,
		"info",
	);
	const resolved = await resolver.resolve("dropper");
	if (!resolved) return "abort";
	if (wasAborted(runtime)) {
		debugLog("dropper.aborted", {});
		return "abort";
	}

	const reflectionsForDropper = mergeReflections(folded.reflections, sameRunReflections);
	const droppedIds = await runStageWithFallback(ctx, "dropper", resolved, resolver, (worker) => {
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
			maxTurns: runtime.config.agentMaxTurns,
			maxOutputTokens: runtime.config.agentMaxTokens,
			signal: consolidationSignal(runtime),
			thinkingLevel: workerThinkingLevel(runtime, worker),
			modelRegistry: ctx.modelRegistry,
		});
	}, consolidationSignal(runtime));
	if (wasAborted(runtime)) {
		debugLog("dropper.aborted", {});
		return "abort";
	}
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
