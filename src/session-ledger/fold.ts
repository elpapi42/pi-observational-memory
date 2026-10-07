import {
	isObservationsDroppedData,
	isObservationsRecordedData,
	isReflectionsRecordedData,
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	recordedInputBoundaryId,
	type Entry,
	type Observation,
	type Reflection,
} from "./types.js";
import { entryIndexById } from "./progress.js";

export type FoldLedgerOptions = {
	/** Fold entries from branch root through this entry id, inclusive. Omit to fold through branch tip. */
	upToEntryId?: string;
};

export type FoldedLedger = {
	/** All first-valid observation records encountered through the fold boundary, including dropped observations. */
	observations: Observation[];
	/** Observation records not tombstoned by a folded drop entry. */
	activeObservations: Observation[];
	/** Tombstoned observation ids, including ids that may not have a corresponding folded observation. */
	droppedObservationIds: Set<string>;
	/** All first-valid reflection records encountered through the fold boundary. */
	reflections: Reflection[];
	/** All first-valid observation records by id, including dropped observations. */
	observationsById: Map<string, Observation>;
	/** Input boundary stored with each first-valid observation record. */
	observationInputBoundariesById: Map<string, string>;
	/** All first-valid reflection records by id. */
	reflectionsById: Map<string, Reflection>;
};

function foldEndIndex(entries: Entry[], upToEntryId: string | undefined): number {
	if (!upToEntryId) return entries.length - 1;
	const idx = entries.findIndex((entry) => entry.id === upToEntryId);
	return idx === -1 ? entries.length - 1 : idx;
}

function isCustomEntry(entry: Entry, customType: string): boolean {
	return entry.type === "custom" && entry.customType === customType;
}

/**
 * Fold valid V3 memory ledger entries from the branch root through the target entry.
 *
 * Unknown custom entries, old V2 entries, invalid V3-shaped data, and compaction details are ignored.
 * Observations and reflections use first-valid-record-wins semantics. Drops are tombstones and are
 * retained even when the dropped id is unknown at the time of folding.
 */
export function foldLedger(entries: Entry[], options: FoldLedgerOptions = {}): FoldedLedger {
	const observationsById = new Map<string, Observation>();
	const observationInputBoundariesById = new Map<string, string>();
	const reflectionsById = new Map<string, Reflection>();
	const droppedObservationIds = new Set<string>();
	const endIdx = foldEndIndex(entries, options.upToEntryId);

	for (let i = 0; i <= endIdx; i++) {
		const entry = entries[i];
		if (!entry) continue;

		if (isCustomEntry(entry, OM_OBSERVATIONS_RECORDED)) {
			if (!isObservationsRecordedData(entry.data)) continue;
			for (const observation of entry.data.observations) {
				if (observationsById.has(observation.id)) {
					continue;
				}
				observationsById.set(observation.id, observation);
				observationInputBoundariesById.set(observation.id, recordedInputBoundaryId(entry.data));
			}
			continue;
		}

		if (isCustomEntry(entry, OM_REFLECTIONS_RECORDED)) {
			if (!isReflectionsRecordedData(entry.data)) continue;
			for (const reflection of entry.data.reflections) {
				if (!reflectionsById.has(reflection.id)) {
					reflectionsById.set(reflection.id, reflection);
				}
			}
			continue;
		}

		if (isCustomEntry(entry, OM_OBSERVATIONS_DROPPED)) {
			if (!isObservationsDroppedData(entry.data)) continue;
			for (const observationId of entry.data.observationIds) {
				droppedObservationIds.add(observationId);
			}
		}
	}

	const observations = Array.from(observationsById.values());
	const activeObservations = observations.filter((observation) => !droppedObservationIds.has(observation.id));
	const reflections = Array.from(reflectionsById.values());

	return {
		observations,
		activeObservations,
		droppedObservationIds,
		reflections,
		observationInputBoundariesById,
		observationsById,
		reflectionsById,
	};
}

/** Keeps active observations whose stored input boundary falls within completed observer coverage. */
export function observationsAtOrBeforeCoverage(
	entries: Entry[],
	folded: FoldedLedger,
	coverageId: string,
): Observation[] {
	const indexes = entryIndexById(entries);
	const coverageIndex = indexes.get(coverageId);
	if (coverageIndex === undefined) {
		return [];
	}

	return folded.activeObservations.filter((observation) => {
		const inputBoundaryId = folded.observationInputBoundariesById.get(observation.id);
		if (inputBoundaryId === undefined) {
			return false;
		}
		const inputBoundaryIndex = indexes.get(inputBoundaryId);
		return inputBoundaryIndex !== undefined && inputBoundaryIndex <= coverageIndex;
	});
}
