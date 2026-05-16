import {
	OBSERVATION_CUSTOM_TYPE,
	isObservationEntryData,
	isReflectionRecord,
	isSupportedMemoryDetails,
	type MemoryReflection,
	type ObservationEntryData,
	type ObservationRecord,
	type ReflectionRecord,
	type SupportedMemoryDetails,
} from "./types.js";
import { estimateEntryTokens } from "./tokens.js";

export type Entry = {
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

export function isSourceEntry(entry: Entry): boolean {
	return RAW_TYPES.has(entry.type);
}

function isObservationEntry(entry: Entry): boolean {
	return entry.type === "custom" && entry.customType === OBSERVATION_CUSTOM_TYPE;
}

export type RecallObservationMatch =
	| {
			status: "ok";
			observation: ObservationRecord;
			observationEntryId: string;
			sourceEntryIds: string[];
			sourceEntries: Entry[];
		}
	| {
			status: "no_source";
			observation: ObservationRecord;
			observationEntryId: string;
		}
	| {
			status: "source_unavailable";
			observation: ObservationRecord;
			observationEntryId: string;
			sourceEntryIds: string[];
			missingSourceEntryIds: string[];
			nonSourceEntryIds: string[];
		};

export type RecallObservationSourcesResult =
	| {
			status: "not_found";
			observationId: string;
			matches: [];
			collision: false;
		}
	| {
			status: "found";
			observationId: string;
			matches: RecallObservationMatch[];
			collision: boolean;
		};

export type RecallMemoryObservation =
	| {
			status: "ok";
			observation: ObservationRecord;
			observationEntryId: string;
			observationRecordIndex: number;
			sourceEntryIds: string[];
			sourceEntries: Entry[];
		}
	| {
			status: "no_source";
			observation: ObservationRecord;
			observationEntryId: string;
			observationRecordIndex: number;
		}
	| {
			status: "source_unavailable";
			observation: ObservationRecord;
			observationEntryId: string;
			observationRecordIndex: number;
			sourceEntryIds: string[];
			sourceEntries: Entry[];
			missingSourceEntryIds: string[];
			nonSourceEntryIds: string[];
		};

export type RecallMemoryReflectionMatch = {
	reflection: ReflectionRecord;
	reflectionIndex: number;
};

export type RecallUnavailableSupportingObservation = {
	reflection: ReflectionRecord;
	reflectionIndex: number;
	observationId: string;
};

export type RecallUnavailableReflectionProvenance = {
	reflection: ReflectionRecord;
	reflectionIndex: number;
	reason: "legacy";
};

export type RecallMemorySourcesResult =
	| {
			status: "not_found";
			memoryId: string;
			reflectionMatches: [];
			directObservationMatches: [];
			observations: [];
			sourceEntries: [];
			unavailableSupportingObservations: [];
			unavailableReflectionProvenance: [];
			missingSourceEntryIds: [];
			nonSourceEntryIds: [];
			collision: false;
			partial: false;
		}
	| {
			status: "found";
			memoryId: string;
			reflectionMatches: RecallMemoryReflectionMatch[];
			directObservationMatches: RecallMemoryObservation[];
			observations: RecallMemoryObservation[];
			sourceEntries: Entry[];
			unavailableSupportingObservations: RecallUnavailableSupportingObservation[];
			unavailableReflectionProvenance: RecallUnavailableReflectionProvenance[];
			missingSourceEntryIds: string[];
			nonSourceEntryIds: string[];
			collision: boolean;
			partial: boolean;
		};

type IndexedObservation = {
	observation: ObservationRecord;
	observationEntryId: string;
	observationRecordIndex: number;
	branchIndex: number;
};

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

function rawTokensFromIndex(entries: Entry[], startIndex: number): number {
	let total = 0;
	for (let i = Math.max(0, startIndex); i < entries.length; i++) {
		if (RAW_TYPES.has(entries[i].type)) total += estimateEntryTokens(entries[i]);
	}
	return total;
}

export function rawTokensSinceLastBound(entries: Entry[]): number {
	return rawTokensFromIndex(entries, lastObservationCoverEndIdx(entries) + 1);
}

export function rawTokensSinceLastCompaction(entries: Entry[]): number {
	const compactionIdx = findLastCompactionIndex(entries);
	if (compactionIdx === -1) return rawTokensFromIndex(entries, 0);
	return rawTokensFromIndex(entries, liveTailStartIndex(entries));
}

function liveTailStartIndex(entries: Entry[]): number {
	const compactionIdx = findLastCompactionIndex(entries);
	if (compactionIdx === -1) return 0;
	const firstKept = entries[compactionIdx].firstKeptEntryId;
	if (!firstKept) throw new Error("compaction entry missing firstKeptEntryId");
	const firstKeptIdx = entries.findIndex((e) => e.id === firstKept);
	if (firstKeptIdx === -1) throw new Error(`firstKeptEntryId "${firstKept}" not found in entries`);
	return firstKeptIdx;
}

export function firstRawIdAfter(entries: Entry[], afterIndex: number): string | undefined {
	for (let i = Math.max(0, afterIndex + 1); i < entries.length; i++) {
		if (RAW_TYPES.has(entries[i].type)) return entries[i].id;
	}
	return undefined;
}

export function gapRawEntries(entries: Entry[], newFirstKeptEntryId: string): Entry[] {
	let lastBoundIdx = lastObservationCoverEndIdx(entries);
	// Clamp the start boundary to at least the last compaction entry.
	// Observation entries from before the last compaction may have coversUpToId values
	// pointing to entries that were compacted away, or to entries before the compaction
	// boundary whose content is already represented in the compaction details.
	// Including them in the gap would cause the sync catch-up observer to re-process
	// already-compact content and potentially produce a gap too large for a single LLM call.
	const lastCompactionIdx = findLastCompactionIndex(entries);
	if (lastBoundIdx < lastCompactionIdx) {
		lastBoundIdx = lastCompactionIdx;
	}
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
		if (isSourceEntry(entries[i])) result.push(entries[i]);
	}
	return result;
}

function uniqueIds(ids: string[]): string[] {
	return Array.from(new Set(ids));
}

function collectIndexedObservations(entries: Entry[]): IndexedObservation[] {
	const observations: IndexedObservation[] = [];
	for (let branchIndex = 0; branchIndex < entries.length; branchIndex++) {
		const entry = entries[branchIndex];
		if (!isObservationEntry(entry)) continue;
		if (!isObservationEntryData(entry.data)) continue;
		entry.data.records.forEach((observation, observationRecordIndex) => {
			observations.push({ observation, observationEntryId: entry.id, observationRecordIndex, branchIndex });
		});
	}
	return observations;
}

function observationKey(observation: Pick<IndexedObservation, "observationEntryId" | "observationRecordIndex">): string {
	return `${observation.observationEntryId}:${observation.observationRecordIndex}`;
}

function resolveSourceEntries(entries: Entry[], sourceEntryIds: string[]): {
	status: "ok" | "source_unavailable";
	sourceEntryIds: string[];
	sourceEntries: Entry[];
	missingSourceEntryIds: string[];
	nonSourceEntryIds: string[];
} {
	const requested = uniqueIds(sourceEntryIds);
	const requestedSet = new Set(requested);
	const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
	const missingSourceEntryIds = requested.filter((id) => !entriesById.has(id));
	const nonSourceEntryIds = requested.filter((id) => {
		const entry = entriesById.get(id);
		return entry !== undefined && !isSourceEntry(entry);
	});
	if (missingSourceEntryIds.length > 0 || nonSourceEntryIds.length > 0) {
		return {
			status: "source_unavailable",
			sourceEntryIds: requested,
			sourceEntries: [],
			missingSourceEntryIds,
			nonSourceEntryIds,
		};
	}

	const sourceEntries = entries.filter((entry) => requestedSet.has(entry.id));
	return {
		status: "ok",
		sourceEntryIds: sourceEntries.map((entry) => entry.id),
		sourceEntries,
		missingSourceEntryIds: [],
		nonSourceEntryIds: [],
	};
}

function resolveSourceEntriesPartial(entries: Entry[], sourceEntryIds: string[]): {
	status: "ok" | "source_unavailable";
	sourceEntryIds: string[];
	sourceEntries: Entry[];
	missingSourceEntryIds: string[];
	nonSourceEntryIds: string[];
} {
	const requested = uniqueIds(sourceEntryIds);
	const requestedSet = new Set(requested);
	const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
	const missingSourceEntryIds = requested.filter((id) => !entriesById.has(id));
	const nonSourceEntryIds = requested.filter((id) => {
		const entry = entriesById.get(id);
		return entry !== undefined && !isSourceEntry(entry);
	});
	const sourceEntries = entries.filter((entry) => requestedSet.has(entry.id) && isSourceEntry(entry));
	return {
		status: missingSourceEntryIds.length > 0 || nonSourceEntryIds.length > 0 ? "source_unavailable" : "ok",
		sourceEntryIds: requested,
		sourceEntries,
		missingSourceEntryIds,
		nonSourceEntryIds,
	};
}

function memoryObservationFromIndexed(entries: Entry[], indexed: IndexedObservation): RecallMemoryObservation {
	const { observation, observationEntryId, observationRecordIndex } = indexed;
	if (!observation.sourceEntryIds || observation.sourceEntryIds.length === 0) {
		return { status: "no_source", observation, observationEntryId, observationRecordIndex };
	}
	const resolved = resolveSourceEntriesPartial(entries, observation.sourceEntryIds);
	if (resolved.status === "source_unavailable") {
		return {
			status: "source_unavailable",
			observation,
			observationEntryId,
			observationRecordIndex,
			sourceEntryIds: resolved.sourceEntryIds,
			sourceEntries: resolved.sourceEntries,
			missingSourceEntryIds: resolved.missingSourceEntryIds,
			nonSourceEntryIds: resolved.nonSourceEntryIds,
		};
	}
	return {
		status: "ok",
		observation,
		observationEntryId,
		observationRecordIndex,
		sourceEntryIds: resolved.sourceEntryIds,
		sourceEntries: resolved.sourceEntries,
	};
}

function uniqueSourceEntriesInBranchOrder(entries: Entry[], observations: RecallMemoryObservation[]): Entry[] {
	const requested = new Set<string>();
	for (const observation of observations) {
		if (observation.status === "ok" || observation.status === "source_unavailable") {
			for (const entry of observation.sourceEntries) requested.add(entry.id);
		}
	}
	return entries.filter((entry) => requested.has(entry.id) && isSourceEntry(entry));
}

function uniqueUnavailableSourceIds(
	observations: RecallMemoryObservation[],
	field: "missingSourceEntryIds" | "nonSourceEntryIds",
): string[] {
	const ids: string[] = [];
	for (const observation of observations) {
		if (observation.status !== "source_unavailable") continue;
		ids.push(...observation[field]);
	}
	return uniqueIds(ids);
}

export function recallObservationSources(entries: Entry[], observationId: string): RecallObservationSourcesResult {
	const matches: RecallObservationMatch[] = [];
	for (const entry of entries) {
		if (!isObservationEntry(entry)) continue;
		if (!isObservationEntryData(entry.data)) continue;
		for (const observation of entry.data.records) {
			if (observation.id !== observationId) continue;
			if (!observation.sourceEntryIds || observation.sourceEntryIds.length === 0) {
				matches.push({ status: "no_source", observation, observationEntryId: entry.id });
				continue;
			}

			const resolved = resolveSourceEntries(entries, observation.sourceEntryIds);
			if (resolved.status === "source_unavailable") {
				matches.push({
					status: "source_unavailable",
					observation,
					observationEntryId: entry.id,
					sourceEntryIds: resolved.sourceEntryIds,
					missingSourceEntryIds: resolved.missingSourceEntryIds,
					nonSourceEntryIds: resolved.nonSourceEntryIds,
				});
				continue;
			}

			matches.push({
				status: "ok",
				observation,
				observationEntryId: entry.id,
				sourceEntryIds: resolved.sourceEntryIds,
				sourceEntries: resolved.sourceEntries,
			});
		}
	}

	if (matches.length === 0) return { status: "not_found", observationId, matches: [], collision: false };
	return { status: "found", observationId, matches, collision: matches.length > 1 };
}

function getPriorMemoryDetails(entries: Entry[]): SupportedMemoryDetails | undefined {
	const idx = findLastCompactionIndex(entries);
	if (idx === -1) return undefined;
	const details = entries[idx].details;
	return isSupportedMemoryDetails(details) ? details : undefined;
}

export function recallMemorySources(entries: Entry[], memoryId: string): RecallMemorySourcesResult {
	const indexedObservations = collectIndexedObservations(entries);
	const observationsById = new Map<string, IndexedObservation[]>();
	for (const observation of indexedObservations) {
		const matches = observationsById.get(observation.observation.id) ?? [];
		matches.push(observation);
		observationsById.set(observation.observation.id, matches);
	}

	const priorDetails = getPriorMemoryDetails(entries);
	const reflectionMatches: RecallMemoryReflectionMatch[] = [];
	if (priorDetails) {
		priorDetails.reflections.forEach((reflection, reflectionIndex) => {
			if (!isReflectionRecord(reflection) || reflection.id !== memoryId) return;
			reflectionMatches.push({ reflection, reflectionIndex });
		});
	}

	const directIndexedObservations = observationsById.get(memoryId) ?? [];
	const observationsByKey = new Map<string, IndexedObservation>();
	for (const observation of directIndexedObservations) {
		observationsByKey.set(observationKey(observation), observation);
	}

	const unavailableSupportingObservations: RecallUnavailableSupportingObservation[] = [];
	const unavailableReflectionProvenance: RecallUnavailableReflectionProvenance[] = [];
	for (const reflectionMatch of reflectionMatches) {
		if (reflectionMatch.reflection.legacy === true) {
			unavailableReflectionProvenance.push({ ...reflectionMatch, reason: "legacy" });
			continue;
		}
		for (const observationId of reflectionMatch.reflection.supportingObservationIds) {
			const supportingObservations = observationsById.get(observationId);
			if (!supportingObservations || supportingObservations.length === 0) {
				unavailableSupportingObservations.push({ ...reflectionMatch, observationId });
				continue;
			}
			for (const observation of supportingObservations) {
				observationsByKey.set(observationKey(observation), observation);
			}
		}
	}

	const indexedObservationBag = Array.from(observationsByKey.values()).sort((a, b) => {
		if (a.branchIndex !== b.branchIndex) return a.branchIndex - b.branchIndex;
		return a.observationRecordIndex - b.observationRecordIndex;
	});
	const observations = indexedObservationBag.map((observation) => memoryObservationFromIndexed(entries, observation));
	const directObservationKeys = new Set(directIndexedObservations.map(observationKey));
	const directObservationMatches = observations.filter((observation) => directObservationKeys.has(observationKey(observation)));
	const sourceEntries = uniqueSourceEntriesInBranchOrder(entries, observations);
	const missingSourceEntryIds = uniqueUnavailableSourceIds(observations, "missingSourceEntryIds");
	const nonSourceEntryIds = uniqueUnavailableSourceIds(observations, "nonSourceEntryIds");

	if (reflectionMatches.length === 0 && directObservationMatches.length === 0) {
		return {
			status: "not_found",
			memoryId,
			reflectionMatches: [],
			directObservationMatches: [],
			observations: [],
			sourceEntries: [],
			unavailableSupportingObservations: [],
			unavailableReflectionProvenance: [],
			missingSourceEntryIds: [],
			nonSourceEntryIds: [],
			collision: false,
			partial: false,
		};
	}

	const hasNoSourceObservationInMemoryRecall =
		reflectionMatches.length > 0 && observations.some((observation) => observation.status === "no_source");

	return {
		status: "found",
		memoryId,
		reflectionMatches,
		directObservationMatches,
		observations,
		sourceEntries,
		unavailableSupportingObservations,
		unavailableReflectionProvenance,
		missingSourceEntryIds,
		nonSourceEntryIds,
		collision: reflectionMatches.length + directObservationMatches.length > 1,
		partial:
			unavailableReflectionProvenance.length > 0 ||
			hasNoSourceObservationInMemoryRecall ||
			unavailableSupportingObservations.length > 0 ||
			missingSourceEntryIds.length > 0 ||
			nonSourceEntryIds.length > 0,
	};
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
		const fromIdx = idToIdx.get(entry.data.coversFromId);
		if (fromIdx === undefined) continue;
		if (fromIdx >= priorFKIIdx && fromIdx < newFKIIdx) result.push(entry.data);
	}
	return result;
}

function collectObservationsPendingNextCompaction(entries: Entry[]): ObservationEntryData[] {
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
		const fromIdx = idToIdx.get(entry.data.coversFromId);
		if (fromIdx === undefined) continue;
		if (fromIdx >= thresholdIdx) result.push(entry.data);
	}
	return result;
}

export interface MemoryState {
	reflections: MemoryReflection[];
	committedObs: ObservationRecord[];
	pendingObs: ObservationRecord[];
}

export function getMemoryState(entries: Entry[]): MemoryState {
	const priorDetails = getPriorMemoryDetails(entries);
	const pendingData = collectObservationsPendingNextCompaction(entries);
	return {
		reflections: priorDetails?.reflections ?? [],
		committedObs: priorDetails?.observations ?? [],
		pendingObs: pendingData.flatMap((d) => d.records),
	};
}
