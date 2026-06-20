import { estimateEntryTokens } from "../tokens.js";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_NONE,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	type Entry,
	type V3MemoryCustomType,
} from "./types.js";

// The observation coverage watermark advances on EITHER a recorded-observations
// marker OR a coverage-only "none" marker (observer ran, recorded nothing). Both
// mean "this span has been observed", so neither should be re-observed.
export const OBSERVATION_COVERAGE_TYPES: V3MemoryCustomType[] = [
	OM_OBSERVATIONS_RECORDED,
	OM_OBSERVATIONS_NONE,
];

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
	if (customType === OM_OBSERVATIONS_NONE) return true; // coverage-only marker, no payload
	if (customType === OM_REFLECTIONS_RECORDED) return isNonEmptyArray(entry.data.reflections);
	return isNonEmptyArray(entry.data.observationIds);
}

function coverageCustomTypes(customType: V3MemoryCustomType | V3MemoryCustomType[]): V3MemoryCustomType[] {
	return Array.isArray(customType) ? customType : [customType];
}

function matchesAnyCoverage(entry: Entry, types: V3MemoryCustomType[]): boolean {
	return types.some((type) => isValidCoverageEntry(entry, type));
}

export function latestCoverageIndex(entries: Entry[], customType: V3MemoryCustomType | V3MemoryCustomType[]): number {
	const types = coverageCustomTypes(customType);
	const idToIndex = entryIndexById(entries);
	let latest = -1;

	for (const entry of entries) {
		if (!matchesAnyCoverage(entry, types)) continue;
		const coveredIndex = idToIndex.get((entry.data as { coversUpToId: string }).coversUpToId);
		if (coveredIndex === undefined) continue;
		if (coveredIndex > latest) latest = coveredIndex;
	}

	return latest;
}

export function latestCoverageMarkerId(entries: Entry[], customType: V3MemoryCustomType | V3MemoryCustomType[]): string | undefined {
	const types = coverageCustomTypes(customType);
	const idToIndex = entryIndexById(entries);
	let latestIndex = -1;
	let latestMarkerId: string | undefined;

	for (const entry of entries) {
		if (!matchesAnyCoverage(entry, types)) continue;
		const coversUpToId = (entry.data as { coversUpToId: string }).coversUpToId;
		const coveredIndex = idToIndex.get(coversUpToId);
		if (coveredIndex === undefined) continue;
		if (coveredIndex > latestIndex) {
			latestIndex = coveredIndex;
			latestMarkerId = coversUpToId;
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

export function rawTokensSinceCoverage(entries: Entry[], customType: V3MemoryCustomType | V3MemoryCustomType[]): number {
	return rawTokensAfterIndex(entries, latestCoverageIndex(entries, customType));
}

export function rawTokensSinceObservationCoverage(entries: Entry[]): number {
	return rawTokensSinceCoverage(entries, OBSERVATION_COVERAGE_TYPES);
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

export function rawTokensSinceLastCompaction(entries: Entry[]): number {
	const compactionIndex = findLastCompactionIndex(entries);
	if (compactionIndex === -1) return rawTokensAfterIndex(entries, -1);

	const firstKeptEntryId = entries[compactionIndex].firstKeptEntryId;
	const firstKeptIndex = entryIndexForId(entries, firstKeptEntryId);

	if (firstKeptIndex === -1) return rawTokensAfterIndex(entries, compactionIndex);
	return rawTokensAfterIndex(entries, firstKeptIndex - 1);
}
