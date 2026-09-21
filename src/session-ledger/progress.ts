import { estimateEntryTokens } from "../tokens.js";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	type Entry,
	type V3MemoryCustomType,
} from "./types.js";

const SOURCE_ENTRY_TYPES = new Set(["message", "custom_message", "branch_summary"]);

export function isSourceEntry(entry: Entry): boolean {
	return SOURCE_ENTRY_TYPES.has(entry.type);
}

export function entryIndexById(entries: Entry[]): Map<string, number> {
	const idToIndex = new Map<string, number>();
	for (let i = 0; i < entries.length; i++) idToIndex.set(entries[i].id, i);
	return idToIndex;
}

export function entryIndexForId(entries: Entry[], entryId: string | undefined): number {
	if (!entryId) return -1;
	const idx = entryIndexById(entries).get(entryId);
	return idx ?? -1;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonEmptyArray(value: unknown): value is unknown[] {
	return Array.isArray(value) && value.length > 0;
}

function isValidCoverageEntry(entry: Entry, customType: V3MemoryCustomType): entry is Entry & { data: { coversUpToId: string } } {
	if (entry.type !== "custom" || entry.customType !== customType) return false;
	if (!isObject(entry.data) || typeof entry.data.coversUpToId !== "string") return false;

	if (customType === OM_OBSERVATIONS_RECORDED) return isNonEmptyArray(entry.data.observations);
	if (customType === OM_REFLECTIONS_RECORDED) return isNonEmptyArray(entry.data.reflections);
	return isNonEmptyArray(entry.data.observationIds);
}

export function latestCoverageIndex(entries: Entry[], customType: V3MemoryCustomType): number {
	const idToIndex = entryIndexById(entries);
	let latest = -1;

	for (const entry of entries) {
		if (!isValidCoverageEntry(entry, customType)) continue;
		const coveredIndex = idToIndex.get(entry.data.coversUpToId);
		if (coveredIndex === undefined) continue;
		if (coveredIndex > latest) latest = coveredIndex;
	}

	return latest;
}

export function latestCoverageMarkerId(entries: Entry[], customType: V3MemoryCustomType): string | undefined {
	const idToIndex = entryIndexById(entries);
	let latestIndex = -1;
	let latestMarkerId: string | undefined;

	for (const entry of entries) {
		if (!isValidCoverageEntry(entry, customType)) continue;
		const coveredIndex = idToIndex.get(entry.data.coversUpToId);
		if (coveredIndex === undefined) continue;
		if (coveredIndex > latestIndex) {
			latestIndex = coveredIndex;
			latestMarkerId = entry.data.coversUpToId;
		}
	}

	return latestMarkerId;
}

export function earlierCoverageMarkerId(entries: Entry[], firstId: string | undefined, secondId: string | undefined): string | undefined {
	if (!firstId) return secondId;
	if (!secondId) return firstId;

	const idToIndex = entryIndexById(entries);
	const firstIndex = idToIndex.get(firstId);
	const secondIndex = idToIndex.get(secondId);
	if (firstIndex === undefined) return secondIndex === undefined ? undefined : secondId;
	if (secondIndex === undefined) return firstId;
	return firstIndex <= secondIndex ? firstId : secondId;
}

export function rawTokensAfterIndex(entries: Entry[], index: number): number {
	let total = 0;
	for (let i = Math.max(0, index + 1); i < entries.length; i++) {
		if (isSourceEntry(entries[i])) total += estimateEntryTokens(entries[i]);
	}
	return total;
}

export function rawTokensSinceCoverage(entries: Entry[], customType: V3MemoryCustomType): number {
	return rawTokensAfterIndex(entries, latestCoverageIndex(entries, customType));
}

export function rawTokensSinceObservationCoverage(entries: Entry[]): number {
	return rawTokensSinceCoverage(entries, OM_OBSERVATIONS_RECORDED);
}

export function rawTokensSinceReflectionCoverage(entries: Entry[]): number {
	return rawTokensSinceCoverage(entries, OM_REFLECTIONS_RECORDED);
}

/**
 * Estimated source tokens the observer has covered since the latest reflection
 * coverage marker: the material new reflections could draw on. Unlike
 * {@link rawTokensSinceReflectionCoverage} it excludes source the observer has
 * not reached yet, so a large unobserved backlog does not make the reflector
 * due after every small observer chunk.
 */
export function observedTokensSinceReflectionCoverage(entries: Entry[]): number {
	const reflectionIndex = latestCoverageIndex(entries, OM_REFLECTIONS_RECORDED);
	const observationIndex = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	if (observationIndex <= reflectionIndex) return 0;

	let total = 0;
	for (let i = reflectionIndex + 1; i <= observationIndex; i++) {
		if (isSourceEntry(entries[i])) total += estimateEntryTokens(entries[i]);
	}
	return total;
}

export function rawTokensSinceDropCoverage(entries: Entry[]): number {
	return rawTokensSinceCoverage(entries, OM_OBSERVATIONS_DROPPED);
}

export function findLastCompactionIndex(entries: Entry[]): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") return i;
	}
	return -1;
}

// ==== Real (provider-reported) token accounting ====
//
// These helpers measure context growth from provider-reported usage for the
// observation and reflection coverage clocks. Automatic compaction keeps its
// separate raw source-entry clock because its setting counts ledger entries.

type UsageLike = {
	totalTokens?: number;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
};

export function contextTokensFromUsage(usage: unknown): number | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const u = usage as UsageLike;
	const total = typeof u.totalTokens === "number" && Number.isFinite(u.totalTokens) && u.totalTokens > 0 ? u.totalTokens : undefined;
	if (total !== undefined) return total;
	const parts = [u.input, u.output, u.cacheRead, u.cacheWrite];
	if (parts.every((p) => typeof p === "number" && Number.isFinite(p))) {
		const sum = parts.reduce<number>((acc, p) => acc + (p ?? 0), 0);
		return sum > 0 ? sum : undefined;
	}
	return undefined;
}

function validAssistantContextTokens(entry: Entry): number | undefined {
	if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return undefined;
	const msg = entry.message as { role?: string; stopReason?: string; usage?: unknown };
	if (msg.role !== "assistant" || msg.stopReason === "aborted" || msg.stopReason === "error") return undefined;
	return contextTokensFromUsage(msg.usage);
}

/**
 * Real context tokens right after a compaction anchor.
 *
 * Only usage from an assistant that responded AFTER the compaction is a valid
 * post-compaction baseline: pi's own docs state the last assistant usage
 * before/at a compaction reflects the PRE-compaction context size. The usage
 * carried on the compaction entry itself is the summary-generation call's
 * usage (pre-compaction scale, a different LLM call), so it is deliberately
 * NOT used as a baseline.
 */
export function realContextTokensAfterCompaction(entries: Entry[], compactionIdx: number): number | undefined {
	for (let i = compactionIdx + 1; i < entries.length; i++) {
		const t = validAssistantContextTokens(entries[i]);
		if (t !== undefined) return t;
	}
	return undefined;
}

/**
 * Real context tokens at the time observation coverage ended: last valid
 * assistant usage at/before the covered entry. Returns undefined when no valid
 * usage exists (e.g. an error/abort storm) — callers must fall back to the
 * raw estimate rather than measuring from zero, which would otherwise read the
 * full context as "growth" and re-fire stages every turn.
 */
export function realContextTokensAtCoverage(entries: Entry[], coverageIdx: number): number | undefined {
	for (let i = coverageIdx; i >= 0; i--) {
		const t = validAssistantContextTokens(entries[i]);
		if (t !== undefined) return t;
	}
	return undefined;
}

/**
 * Real context growth since the most recent anchor (a compaction, or the given
 * coverage marker), measured from provider-reported usage.
 *
 * Returns undefined when the baseline cannot be measured reliably — no usage
 * at/after the anchor, or the current context is SMALLER than the baseline
 * (accounting basis changed, e.g. a mid-session model/provider switch that
 * counts usage differently). Callers must fall back to the raw estimate in
 * that case; clamping a stale baseline to 0 would starve the stage forever,
 * and measuring from zero would over-fire it.
 */
export function realTokensSinceAnchor(
	entries: Entry[],
	customType: V3MemoryCustomType | undefined,
	currentContextTokens: number,
): number | undefined {
	const coverageIdx = customType ? latestCoverageIndex(entries, customType) : -1;
	const compactionIdx = findLastCompactionIndex(entries);
	if (compactionIdx > coverageIdx) {
		const baseline = realContextTokensAfterCompaction(entries, compactionIdx);
		if (baseline === undefined) return undefined;
		const delta = currentContextTokens - baseline;
		return delta >= 0 ? delta : undefined;
	}
	if (coverageIdx >= 0) {
		const baseline = realContextTokensAtCoverage(entries, coverageIdx);
		if (baseline === undefined) return undefined;
		const delta = currentContextTokens - baseline;
		return delta >= 0 ? delta : undefined;
	}
	return Math.max(0, currentContextTokens);
}

/**
 * Branch index where Pi's next compaction range starts: the retained boundary
 * (`firstKeptEntryId`) of the latest compaction, the entry after that
 * compaction when the boundary id is missing, or 0 before any compaction.
 */
export function compactionRangeStartIndex(entries: Entry[]): number {
	const compactionIndex = findLastCompactionIndex(entries);
	if (compactionIndex === -1) return 0;

	const firstKeptIndex = entryIndexForId(entries, entries[compactionIndex].firstKeptEntryId);
	return firstKeptIndex === -1 ? compactionIndex + 1 : firstKeptIndex;
}

export function rawTokensSinceLastCompaction(entries: Entry[]): number {
	return rawTokensAfterIndex(entries, compactionRangeStartIndex(entries) - 1);
}

/**
 * Estimated source tokens since the latest compaction boundary that observation
 * coverage has already reached — the span a V3 compaction can fold into memory
 * without discarding anything the observer has not seen. Zero when coverage is
 * missing or still behind the compaction boundary.
 */
export function observedTokensSinceLastCompaction(entries: Entry[]): number {
	const start = compactionRangeStartIndex(entries);
	const coverageIndex = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	if (coverageIndex < start) return 0;

	let total = 0;
	for (let i = start; i <= coverageIndex; i++) {
		if (isSourceEntry(entries[i])) total += estimateEntryTokens(entries[i]);
	}
	return total;
}

export type UnobservedSourceSpan = {
	/** Branch index of the first unobserved source entry. */
	firstIndex: number;
	/** Branch index of the last unobserved source entry before the cut. */
	lastIndex: number;
	entryCount: number;
	tokens: number;
};

/**
 * Source entries inside the current compaction range, before `cutIndex`
 * (exclusive), that observation coverage has not reached yet. These are the
 * entries a compaction cutting at `cutIndex` would discard without any memory
 * representation. Returns undefined when coverage reaches the cut.
 */
export function unobservedSourceSpanBefore(entries: Entry[], cutIndex: number): UnobservedSourceSpan | undefined {
	const coverageIndex = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	const start = Math.max(coverageIndex + 1, compactionRangeStartIndex(entries));
	let firstIndex = -1;
	let lastIndex = -1;
	let entryCount = 0;
	let tokens = 0;

	for (let i = start; i < cutIndex && i < entries.length; i++) {
		if (!isSourceEntry(entries[i])) continue;
		if (firstIndex === -1) firstIndex = i;
		lastIndex = i;
		entryCount++;
		tokens += estimateEntryTokens(entries[i]);
	}

	if (firstIndex === -1) return undefined;
	return { firstIndex, lastIndex, entryCount, tokens };
}
