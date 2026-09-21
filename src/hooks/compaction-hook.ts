import {
	findTurnStartIndex,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { resolveCompactionMaxRetainedTokens } from "../config.js";
import { debugLog } from "../debug-log.js";
import type { Runtime } from "../runtime.js";
import {
	OM_OBSERVATIONS_RECORDED,
	buildCompactionProjection,
	compactionRangeStartIndex,
	entryIndexForId,
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

export type CompactionCut = {
	/** First entry Pi keeps in context. */
	firstKeptEntryId: string;
	/** Entry through which the memory ledger is folded into the rendered summary. */
	foldThroughEntryId: string;
};

export type CompactionCutResolution =
	| { kind: "cut"; cut: CompactionCut; gap?: UnobservedSourceSpan }
	| { kind: "delegate"; reason: string; gap: UnobservedSourceSpan };

/**
 * Decide where this compaction cuts.
 *
 * Pi proposes `firstKeptEntryId` from its own `keepRecentTokens` budget. The
 * observer may not have reached that point yet: every source entry between the
 * observation frontier and Pi's cut would then be discarded with no memory
 * describing it. When that happens, retain those entries by moving the
 * boundary back to the turn that contains the first unobserved entry, and fold
 * every recorded observation into the summary (a retained source that is also
 * described by an observation is redundant, never lost). If retaining is not
 * possible, or exceeds the retained-tail budget, delegate to Pi's native
 * summarizer so the pre-cut context is summarized instead of dropped.
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

	const rangeStart = compactionRangeStartIndex(entries);
	const safeCutIndex = findTurnStartIndex(entries as unknown as SessionEntry[], gap.firstIndex, rangeStart);
	if (safeCutIndex <= rangeStart) return { kind: "delegate", reason: "nothing observed can be compacted", gap };

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
	};
}

function gapLabel(gap: UnobservedSourceSpan): string {
	return `${gap.entryCount} source entr${gap.entryCount === 1 ? "y" : "ies"} (~${gap.tokens.toLocaleString()} tokens)`;
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
			const { preparation, branchEntries } = event;
			const { firstKeptEntryId, tokensBefore } = preparation;
			const entries = branchEntries as Entry[];
			const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
			const resolution = resolveCompactionCut(entries, firstKeptEntryId, {
				maxRetainedTokens: resolveCompactionMaxRetainedTokens(runtime.config, contextWindow),
				reason: (event as { reason?: string }).reason,
			});

			if (resolution.gap) {
				debugLog("compaction.observer_behind", {
					proposedFirstKeptEntryId: firstKeptEntryId,
					unobservedEntries: resolution.gap.entryCount,
					unobservedTokens: resolution.gap.tokens,
					outcome: resolution.kind,
					...(resolution.kind === "cut"
						? { firstKeptEntryId: resolution.cut.firstKeptEntryId, foldThroughEntryId: resolution.cut.foldThroughEntryId }
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
				return;
			}

			const projection = buildCompactionProjection(
				entries,
				resolution.cut.foldThroughEntryId,
				{ observationsPoolMaxTokens: observationsPoolMaxTokens(runtime) },
			);
			const summary = renderSummary(projection.reflections, projection.observations);
			if (summary.length === 0) {
				// Decline ownership so Pi's native summarizer preserves the pre-cut context.
				return;
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
		} finally {
			runtime.compactHookInFlight = false;
		}
	});
}
