import {
	sessionEntryToContextMessages,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { resolveCompactionMaxRetainedTokens } from "../config.js";
import { estimateStringTokens } from "../tokens.js";
import { debugLog, withDebugLogContext, type DebugLogContext } from "../debug-log.js";
import type { Runtime } from "../runtime.js";
import {
	OM_OBSERVATIONS_RECORDED,
	buildCompactionProjection,
	compactionRangeStartIndex,
	entryIndexForId,
	latestCoverageIndex,
	latestCoverageMarkerId,
	rawTokensAfterIndex,
	renderSummary,
	unobservedSourceSpanBefore,
	type Entry,
	type UnobservedSourceSpan,
} from "../session-ledger/index.js";

const DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS = 20_000;

function observationsPoolMaxTokens(runtime: Runtime): number {
	const value = (runtime.config as { observationsPoolMaxTokens?: unknown }).observationsPoolMaxTokens;
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS;
}

/**
 * Context-visible message roles Pi accepts as a compaction cut point (mirrors
 * Pi's `isCutPointMessage`): never a tool result, which must follow its call.
 * Cutting at an assistant message keeps its tool results with it.
 */
const CUT_POINT_ROLES = new Set(["user", "assistant", "bashExecution", "custom", "branchSummary", "compactionSummary"]);

function isCutPointEntry(entry: Entry): boolean {
	if (entry.type === "compaction") return false;
	try {
		return sessionEntryToContextMessages(entry as unknown as SessionEntry).some((message) => CUT_POINT_ROLES.has(message.role));
	} catch {
		return false;
	}
}

/** Nearest valid cut point at or before `index`, not before `startIndex`; -1 when none. */
function findCutPointAtOrBefore(entries: Entry[], index: number, startIndex: number): number {
	for (let i = Math.min(index, entries.length - 1); i >= startIndex && i >= 0; i--) {
		if (isCutPointEntry(entries[i])) return i;
	}
	return -1;
}

export type CompactionCut = {
	/** First entry Pi keeps in context. */
	firstKeptEntryId: string;
	/** Entry through which the memory ledger is folded into the rendered summary. */
	foldThroughEntryId: string;
};

export type CompactionCutResolution =
	| { kind: "cut"; cut: CompactionCut; gap?: UnobservedSourceSpan; retainedTokens?: number }
	| { kind: "delegate"; reason: string; gap: UnobservedSourceSpan };

/**
 * Decide where this compaction cuts.
 *
 * Pi proposes `firstKeptEntryId` from its own `keepRecentTokens` budget. The
 * observer may not have reached that point yet: every source entry between the
 * observation frontier and Pi's cut would then be discarded with no memory
 * describing it. When that happens, retain those entries by moving the
 * boundary back to the nearest valid cut point at or before the first
 * unobserved entry (the entry itself, or the assistant message whose tool
 * result it is), and fold every recorded observation into the summary (a
 * retained source that is also described by an observation is redundant,
 * never lost). If retaining is not possible, or exceeds the retained-tail
 * budget, delegate to Pi's native summarizer so the pre-cut context is
 * summarized instead of dropped.
 */
export function resolveCompactionCut(
	entries: Entry[],
	firstKeptEntryId: string,
	options: { maxRetainedTokens: number; reason?: string },
): CompactionCutResolution {
	const cutIndex = entryIndexForId(entries, firstKeptEntryId);
	if (cutIndex === -1) return { kind: "cut", cut: { firstKeptEntryId, foldThroughEntryId: firstKeptEntryId } };

	const gap = unobservedSourceSpanBefore(entries, cutIndex);
	if (!gap) return { kind: "cut", cut: { firstKeptEntryId, foldThroughEntryId: firstKeptEntryId } };

	// Overflow recovery must free context now; retaining more than Pi asked
	// for risks overflowing again on the retried turn.
	if (options.reason === "overflow") return { kind: "delegate", reason: "overflow recovery", gap };

	const coverageMarkerId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!coverageMarkerId) return { kind: "delegate", reason: "no observation coverage", gap };

	// Only source the observer has covered inside the current compaction range
	// can be folded. Compare source tokens, not indices: Pi's retention
	// boundary may sit on a metadata entry (memory ledger rows carry no context
	// tokens), and cutting one entry past it would free nothing while writing a
	// new compaction entry every time Pi's threshold fires.
	const rangeStart = compactionRangeStartIndex(entries);
	const coverageIndex = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	if (coverageIndex < rangeStart) return { kind: "delegate", reason: "nothing observed can be compacted", gap };

	const safeCutIndex = findCutPointAtOrBefore(entries, gap.firstIndex, rangeStart);
	if (safeCutIndex <= rangeStart) return { kind: "delegate", reason: "nothing observed can be compacted", gap };
	const freedTokens = rawTokensAfterIndex(entries, rangeStart - 1) - rawTokensAfterIndex(entries, safeCutIndex - 1);
	if (freedTokens <= 0) return { kind: "delegate", reason: "nothing observed can be compacted", gap };

	const retainedTokens = rawTokensAfterIndex(entries, safeCutIndex - 1);
	if (retainedTokens > options.maxRetainedTokens) {
		return {
			kind: "delegate",
			reason: `retaining ~${retainedTokens.toLocaleString()} tokens exceeds the ~${options.maxRetainedTokens.toLocaleString()}-token budget`,
			gap,
		};
	}

	return {
		kind: "cut",
		cut: { firstKeptEntryId: entries[safeCutIndex].id, foldThroughEntryId: coverageMarkerId },
		gap,
		retainedTokens,
	};
}

function gapLabel(gap: UnobservedSourceSpan): string {
	return `${gap.entryCount} source entr${gap.entryCount === 1 ? "y" : "ies"} (~${gap.tokens.toLocaleString()} tokens)`;
}

function debugContext(runtime: Runtime, ctx: ExtensionContext): DebugLogContext {
	let sessionId: string | undefined;
	let sessionFile: string | undefined;
	try {
		const manager = ctx.sessionManager as { getSessionId?: () => string; getSessionFile?: () => string | undefined } | undefined;
		sessionId = manager?.getSessionId?.();
		sessionFile = manager?.getSessionFile?.();
	} catch {
		// Debug metadata is best-effort.
	}
	return {
		enabled: runtime.config.debugLog === true,
		cwd: ctx.cwd,
		sessionId,
		sessionFile,
		runId: `compaction-${Date.now().toString(36)}`,
	};
}

async function handleCompaction(event: SessionBeforeCompactEvent, ctx: ExtensionContext, runtime: Runtime) {
	const { preparation, branchEntries } = event;
	const { firstKeptEntryId, tokensBefore } = preparation;
	const entries = branchEntries as Entry[];
	const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
	const maxRetainedTokens = resolveCompactionMaxRetainedTokens(runtime.config, contextWindow);
	let resolution = resolveCompactionCut(entries, firstKeptEntryId, {
		maxRetainedTokens,
		reason: (event as { reason?: string }).reason,
	});

	let projection: ReturnType<typeof buildCompactionProjection> | undefined;
	let summary = "";
	if (resolution.kind === "cut") {
		projection = buildCompactionProjection(
			entries,
			resolution.cut.foldThroughEntryId,
			{ observationsPoolMaxTokens: observationsPoolMaxTokens(runtime) },
		);
		summary = renderSummary(projection.reflections, projection.observations);

		// A moved cut keeps the unobserved tail AND adds the rendered memory on
		// top of it. Both must fit the budget, or Pi's threshold fires again
		// right after this compaction and the next hook call can only delegate.
		if (resolution.gap && resolution.retainedTokens !== undefined) {
			const summaryTokens = estimateStringTokens(summary);
			const afterTokens = resolution.retainedTokens + summaryTokens;
			if (afterTokens > maxRetainedTokens) {
				resolution = {
					kind: "delegate",
					gap: resolution.gap,
					reason: `retaining ~${resolution.retainedTokens.toLocaleString()} tokens plus a ~${summaryTokens.toLocaleString()}-token memory summary exceeds the ~${maxRetainedTokens.toLocaleString()}-token budget`,
				};
			}
		}
	}

	if (resolution.gap) {
		debugLog("compaction.observer_behind", {
			proposedFirstKeptEntryId: firstKeptEntryId,
			unobservedEntries: resolution.gap.entryCount,
			unobservedTokens: resolution.gap.tokens,
			outcome: resolution.kind,
			...(resolution.kind === "cut"
				? {
					firstKeptEntryId: resolution.cut.firstKeptEntryId,
					foldThroughEntryId: resolution.cut.foldThroughEntryId,
					retainedTokens: resolution.retainedTokens,
					summaryTokens: estimateStringTokens(summary),
					maxRetainedTokens,
				}
				: { reason: resolution.reason }),
		});
	}

	if (resolution.kind === "delegate") {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Observational memory: observer has not reached ${gapLabel(resolution.gap)} before the compaction cut and they cannot be retained (${resolution.reason}); delegating to Pi's native summarizer`,
				"warning",
			);
		}
		// Decline ownership so Pi's native summarizer preserves the pre-cut context.
		return undefined;
	}

	if (!projection || summary.length === 0) {
		// Decline ownership so Pi's native summarizer preserves the pre-cut context.
		return undefined;
	}

	if (resolution.gap && ctx.hasUI) {
		ctx.ui.notify(
			`Observational memory: observer has not reached ${gapLabel(resolution.gap)} before the compaction cut; keeping them in context until they are observed`,
			"info",
		);
	}

	return {
		compaction: {
			summary,
			firstKeptEntryId: resolution.cut.firstKeptEntryId,
			tokensBefore,
			details: projection.details,
		},
	};
}

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
		if (runtime.compactHookInFlight) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Observational memory: another compaction is already in progress; cancelling duplicate",
					"warning",
				);
			}
			return { cancel: true };
		}

		runtime.compactHookInFlight = true;
		try {
			runtime.ensureConfig(ctx.cwd);
			return await withDebugLogContext(debugContext(runtime, ctx), () => handleCompaction(event, ctx, runtime));
		} finally {
			runtime.compactHookInFlight = false;
		}
	});
}
