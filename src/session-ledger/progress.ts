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

// Session branches grow by appending at the tip and never rewrite history, so
// the entry index only changes when (tip id, length) changes: an append moves
// both, and a branch switch lands on a different tip (or the same prefix, which
// serializes to an identical index). Caching the Map here removes a full-branch
// rebuild from every progress/coverage helper on the per-turn trigger path.
let cachedBranchTip: string | undefined;
let cachedBranchLength = -1;
let cachedEntryIndex: Map<string, number> | undefined;

export function entryIndexById(entries: Entry[]): Map<string, number> {
	const tipId = entries.length > 0 ? entries[entries.length - 1].id : undefined;
	if (
		cachedEntryIndex !== undefined
		&& cachedBranchTip === tipId
		&& cachedBranchLength === entries.length
	) {
		return cachedEntryIndex;
	}
	const idToIndex = new Map<string, number>();
	for (let i = 0; i < entries.length; i++) idToIndex.set(entries[i].id, i);
	cachedBranchTip = tipId;
	cachedBranchLength = entries.length;
	cachedEntryIndex = idToIndex;
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

export function rawTokensSinceLastCompaction(entries: Entry[]): number {
	const compactionIndex = findLastCompactionIndex(entries);
	if (compactionIndex === -1) return rawTokensAfterIndex(entries, -1);

	const firstKeptEntryId = entries[compactionIndex].firstKeptEntryId;
	const firstKeptIndex = entryIndexForId(entries, firstKeptEntryId);

	if (firstKeptIndex === -1) return rawTokensAfterIndex(entries, compactionIndex);
	return rawTokensAfterIndex(entries, firstKeptIndex - 1);
}
