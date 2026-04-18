import { OBSERVATION_CUSTOM_TYPE, isMemoryDetails, isObservationEntryData, type MemoryDetails, type ObservationEntryData } from "./types.js";
import { estimateEntryTokens } from "./tokens.js";

type Entry = {
	type: string;
	id: string;
	timestamp?: string;
	message?: unknown;
	content?: unknown;
	customType?: string;
	summary?: unknown;
	fromId?: string;
	data?: unknown;
	details?: unknown;
	firstKeptEntryId?: string;
};

const RAW_TYPES = new Set(["message", "custom_message", "branch_summary"]);

function isObservationEntry(entry: Entry): boolean {
	return entry.type === "custom" && entry.customType === OBSERVATION_CUSTOM_TYPE;
}

export function findLastCompactionIndex(entries: Entry[]): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") return i;
	}
	return -1;
}

export function lastObservationCoverEndIdx(entries: Entry[]): number {
	const idToIdx = new Map<string, number>();
	for (let i = 0; i < entries.length; i++) idToIdx.set(entries[i].id, i);
	let maxIdx = -1;
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!isObservationEntry(entry)) continue;
		if (!isObservationEntryData(entry.data)) continue;
		const coverIdx = idToIdx.get(entry.data.coversUpToId);
		if (coverIdx !== undefined && coverIdx > maxIdx) maxIdx = coverIdx;
	}
	return maxIdx;
}

export function findLastBoundIndex(entries: Entry[]): number {
	return lastObservationCoverEndIdx(entries);
}

export function rawTokensFromIndex(entries: Entry[], startIndex: number): number {
	let total = 0;
	for (let i = Math.max(0, startIndex); i < entries.length; i++) {
		if (RAW_TYPES.has(entries[i].type)) total += estimateEntryTokens(entries[i]);
	}
	return total;
}

export function rawTokensSinceLastBound(entries: Entry[]): number {
	return rawTokensFromIndex(entries, findLastBoundIndex(entries) + 1);
}

export function rawTokensSinceLastCompaction(entries: Entry[]): number {
	const compactionIdx = findLastCompactionIndex(entries);
	if (compactionIdx === -1) return rawTokensFromIndex(entries, 0);
	return rawTokensFromIndex(entries, liveTailStartIndex(entries));
}

export function liveTailStartIndex(entries: Entry[]): number {
	const compactionIdx = findLastCompactionIndex(entries);
	if (compactionIdx === -1) return 0;
	const firstKept = entries[compactionIdx].firstKeptEntryId;
	if (!firstKept) throw new Error("compaction entry missing firstKeptEntryId");
	const firstKeptIdx = entries.findIndex((e) => e.id === firstKept);
	if (firstKeptIdx === -1) throw new Error(`firstKeptEntryId "${firstKept}" not found in entries`);
	return firstKeptIdx;
}

export function rawLiveTokens(entries: Entry[]): number {
	return rawTokensFromIndex(entries, liveTailStartIndex(entries));
}

export function liveTailEntries(entries: Entry[]): Entry[] {
	const start = liveTailStartIndex(entries);
	const result: Entry[] = [];
	for (let i = start; i < entries.length; i++) {
		if (RAW_TYPES.has(entries[i].type)) result.push(entries[i]);
	}
	return result;
}

export function firstRawIdAfter(entries: Entry[], afterIndex: number): string | undefined {
	for (let i = Math.max(0, afterIndex + 1); i < entries.length; i++) {
		if (RAW_TYPES.has(entries[i].type)) return entries[i].id;
	}
	return undefined;
}

export function gapRawEntries(entries: Entry[], newFirstKeptEntryId: string): Entry[] {
	const lastBoundIdx = findLastBoundIndex(entries);
	const newKeptIdx = entries.findIndex((e) => e.id === newFirstKeptEntryId);
	if (newKeptIdx === -1) return [];
	const result: Entry[] = [];
	for (let i = lastBoundIdx + 1; i < newKeptIdx; i++) {
		if (RAW_TYPES.has(entries[i].type)) result.push(entries[i]);
	}
	return result;
}

export function rawTailEntriesBetween(entries: Entry[], fromId: string, untilId: string): Entry[] {
	const fromIdx = entries.findIndex((e) => e.id === fromId);
	const untilIdx = entries.findIndex((e) => e.id === untilId);
	if (fromIdx === -1 || untilIdx === -1 || untilIdx < fromIdx) return [];

	const result: Entry[] = [];
	for (let i = fromIdx; i <= untilIdx; i++) {
		if (RAW_TYPES.has(entries[i].type)) result.push(entries[i]);
	}
	return result;
}

export function getPriorMemoryDetails(entries: Entry[]): MemoryDetails | undefined {
	const idx = findLastCompactionIndex(entries);
	if (idx === -1) return undefined;
	const details = entries[idx].details;
	return isMemoryDetails(details) ? details : undefined;
}

export function collectObservationsAfter(entries: Entry[], afterIndex: number): ObservationEntryData[] {
	const result: ObservationEntryData[] = [];
	for (let i = afterIndex + 1; i < entries.length; i++) {
		const entry = entries[i];
		if (!isObservationEntry(entry)) continue;
		if (isObservationEntryData(entry.data)) result.push(entry.data);
	}
	return result;
}

export function collectObservationsByCoverage(
	entries: Entry[],
	priorFirstKeptEntryId: string | undefined,
	newFirstKeptEntryId: string,
): ObservationEntryData[] {
	const idToIdx = new Map<string, number>();
	for (let i = 0; i < entries.length; i++) idToIdx.set(entries[i].id, i);

	const newFKIIdx = idToIdx.get(newFirstKeptEntryId);
	if (newFKIIdx === undefined) return [];

	let priorFKIIdx: number;
	if (priorFirstKeptEntryId === undefined) {
		priorFKIIdx = -1;
	} else {
		const idx = idToIdx.get(priorFirstKeptEntryId);
		if (idx === undefined) throw new Error(`priorFirstKeptEntryId "${priorFirstKeptEntryId}" not found in entries`);
		priorFKIIdx = idx;
	}

	const result: ObservationEntryData[] = [];
	for (const entry of entries) {
		if (!isObservationEntry(entry)) continue;
		if (!isObservationEntryData(entry.data)) continue;
		const coverIdx = idToIdx.get(entry.data.coversUpToId);
		if (coverIdx === undefined) continue;
		if (coverIdx >= priorFKIIdx && coverIdx < newFKIIdx) result.push(entry.data);
	}
	return result;
}

export function collectObservationsPendingNextCompaction(entries: Entry[]): ObservationEntryData[] {
	const idToIdx = new Map<string, number>();
	for (let i = 0; i < entries.length; i++) idToIdx.set(entries[i].id, i);

	const priorCompactionIdx = findLastCompactionIndex(entries);
	let thresholdIdx: number;
	if (priorCompactionIdx === -1) {
		thresholdIdx = -1;
	} else {
		const priorFirstKept = entries[priorCompactionIdx].firstKeptEntryId;
		if (!priorFirstKept) throw new Error("prior compaction entry missing firstKeptEntryId");
		const idx = idToIdx.get(priorFirstKept);
		if (idx === undefined) throw new Error(`prior firstKeptEntryId "${priorFirstKept}" not found in entries`);
		thresholdIdx = idx;
	}

	const result: ObservationEntryData[] = [];
	for (const entry of entries) {
		if (!isObservationEntry(entry)) continue;
		if (!isObservationEntryData(entry.data)) continue;
		const coverIdx = idToIdx.get(entry.data.coversUpToId);
		if (coverIdx === undefined) continue;
		if (coverIdx >= thresholdIdx) result.push(entry.data);
	}
	return result;
}

export function lastRawIdAtOrBefore(entries: Entry[], leafId: string): string | undefined {
	const leafIdx = entries.findIndex((e) => e.id === leafId);
	if (leafIdx === -1) return undefined;
	for (let i = leafIdx; i >= 0; i--) {
		if (RAW_TYPES.has(entries[i].type)) return entries[i].id;
	}
	return undefined;
}
