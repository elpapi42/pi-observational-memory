import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
export const OM_REFLECTIONS_RECORDED = "om.reflections.recorded";
export const OM_OBSERVATIONS_DROPPED = "om.observations.dropped";
export const OM_FOLDED = "om.folded";

export const RELEVANCE_VALUES = ["low", "medium", "high", "critical"] as const;
export type Relevance = (typeof RELEVANCE_VALUES)[number];

export const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/;

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

const RELEVANCE_SCHEMA = Type.Union([
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("critical"),
]);
const MEMORY_ID_SCHEMA = Type.String({ pattern: MEMORY_ID_PATTERN.source });
const NONEMPTY_STRING_SCHEMA = Type.String({ minLength: 1 });
const NONEMPTY_STRING_ARRAY_SCHEMA = Type.Array(NONEMPTY_STRING_SCHEMA, { minItems: 1 });
const TOKEN_COUNT_SCHEMA = Type.Number({ minimum: 0 });

const OBSERVATION_SCHEMA = Type.Object({
	id: MEMORY_ID_SCHEMA,
	content: NONEMPTY_STRING_SCHEMA,
	timestamp: NONEMPTY_STRING_SCHEMA,
	relevance: RELEVANCE_SCHEMA,
	sourceEntryIds: NONEMPTY_STRING_ARRAY_SCHEMA,
	tokenCount: TOKEN_COUNT_SCHEMA,
});

const REFLECTION_SCHEMA = Type.Object({
	id: MEMORY_ID_SCHEMA,
	content: Type.String({ minLength: 1, pattern: "^[^\\r\\n]+$" }),
	supportingObservationIds: NONEMPTY_STRING_ARRAY_SCHEMA,
	tokenCount: TOKEN_COUNT_SCHEMA,
});

/** Source-backed observation retained independently of its worker's completion status. */
export type Observation = Static<typeof OBSERVATION_SCHEMA>;
/** Durable memory whose support ids preserve links to the original observations. */
export type Reflection = Static<typeof REFLECTION_SCHEMA>;

const OBSERVATION_LIST_SCHEMA = Type.Array(OBSERVATION_SCHEMA);
const NONEMPTY_OBSERVATION_LIST_SCHEMA = Type.Array(OBSERVATION_SCHEMA, { minItems: 1 });
const REFLECTION_LIST_SCHEMA = Type.Array(REFLECTION_SCHEMA);
const NONEMPTY_REFLECTION_LIST_SCHEMA = Type.Array(REFLECTION_SCHEMA, { minItems: 1 });

const LEGACY_OBSERVATIONS_RECORDED_DATA_SCHEMA = Type.Object({
	observations: NONEMPTY_OBSERVATION_LIST_SCHEMA,
	coversUpToId: NONEMPTY_STRING_SCHEMA,
});
const COMPLETED_OBSERVATIONS_RECORDED_DATA_SCHEMA = Type.Object({
	completion: Type.Literal("completed"),
	observations: OBSERVATION_LIST_SCHEMA,
	coversUpToId: NONEMPTY_STRING_SCHEMA,
	inputUpToId: Type.Optional(Type.Never()),
});
const INCOMPLETE_OBSERVATIONS_RECORDED_DATA_SCHEMA = Type.Object({
	completion: Type.Literal("incomplete"),
	observations: NONEMPTY_OBSERVATION_LIST_SCHEMA,
	inputUpToId: NONEMPTY_STRING_SCHEMA,
	coversUpToId: Type.Optional(Type.Never()),
});
const NEW_OBSERVATIONS_RECORDED_DATA_SCHEMA = Type.Union([
	COMPLETED_OBSERVATIONS_RECORDED_DATA_SCHEMA,
	INCOMPLETE_OBSERVATIONS_RECORDED_DATA_SCHEMA,
]);
const OBSERVATIONS_RECORDED_DATA_SCHEMA = Type.Union([
	LEGACY_OBSERVATIONS_RECORDED_DATA_SCHEMA,
	COMPLETED_OBSERVATIONS_RECORDED_DATA_SCHEMA,
	INCOMPLETE_OBSERVATIONS_RECORDED_DATA_SCHEMA,
]);

const LEGACY_REFLECTIONS_RECORDED_DATA_SCHEMA = Type.Object({
	reflections: NONEMPTY_REFLECTION_LIST_SCHEMA,
	coversUpToId: NONEMPTY_STRING_SCHEMA,
});
const COMPLETED_REFLECTIONS_RECORDED_DATA_SCHEMA = Type.Object({
	completion: Type.Literal("completed"),
	reflections: REFLECTION_LIST_SCHEMA,
	coversUpToId: NONEMPTY_STRING_SCHEMA,
	inputUpToId: Type.Optional(Type.Never()),
});
const INCOMPLETE_REFLECTIONS_RECORDED_DATA_SCHEMA = Type.Object({
	completion: Type.Literal("incomplete"),
	reflections: NONEMPTY_REFLECTION_LIST_SCHEMA,
	inputUpToId: NONEMPTY_STRING_SCHEMA,
	coversUpToId: Type.Optional(Type.Never()),
});
const NEW_REFLECTIONS_RECORDED_DATA_SCHEMA = Type.Union([
	COMPLETED_REFLECTIONS_RECORDED_DATA_SCHEMA,
	INCOMPLETE_REFLECTIONS_RECORDED_DATA_SCHEMA,
]);
const REFLECTIONS_RECORDED_DATA_SCHEMA = Type.Union([
	LEGACY_REFLECTIONS_RECORDED_DATA_SCHEMA,
	COMPLETED_REFLECTIONS_RECORDED_DATA_SCHEMA,
	INCOMPLETE_REFLECTIONS_RECORDED_DATA_SCHEMA,
]);

/** Accepts legacy coverage and completion-aware observation entries at the ledger boundary. */
export type ObservationsRecordedEntryData = Static<typeof OBSERVATIONS_RECORDED_DATA_SCHEMA>;
/** Accepts legacy coverage and completion-aware reflection entries at the ledger boundary. */
export type ReflectionsRecordedEntryData = Static<typeof REFLECTIONS_RECORDED_DATA_SCHEMA>;

export type ObservationsDroppedEntryData = {
	observationIds: string[];
	coversUpToId: string;
};

export type MemoryDetails = {
	type: typeof OM_FOLDED;
	version: 1;
	fullFold: boolean;
	observations: Observation[];
	reflections: Reflection[];
	/**
	 * Entry through which this summary folded the ledger. Differs from the
	 * compaction's `firstKeptEntryId` when the hook moved the cut to retain
	 * unobserved source. A later compaction uses it as the maintenance boundary
	 * for drops and reflections, so it applies exactly what this fold applied.
	 */
	foldThroughEntryId?: string;
};

export type V3MemoryCustomType =
	| typeof OM_OBSERVATIONS_RECORDED
	| typeof OM_REFLECTIONS_RECORDED
	| typeof OM_OBSERVATIONS_DROPPED;

/** Stores the submitted input boundary only after the worker certifies the whole review. */
export interface CompletedRecordBoundary {
	kind: "completed";
	coversUpToId: string;
}

/** Bounds partial records for projection without certifying input coverage. */
export interface IncompleteRecordBoundary {
	kind: "incomplete";
	inputUpToId: string;
}

/** Couples each new ledger append to exactly one completed or unfinished input boundary. */
export type RecordBoundary = CompletedRecordBoundary | IncompleteRecordBoundary;

const NEW_RECORD_BOUNDARY_MARKER_SCHEMA = Type.Object({
	completion: Type.Optional(Type.Unknown()),
	inputUpToId: Type.Optional(Type.Unknown()),
});

/** Checks whether raw ledger data uses the new completion or input-boundary fields. */
export function hasNewRecordBoundary(value: unknown): boolean {
	if (!Value.Check(NEW_RECORD_BOUNDARY_MARKER_SCHEMA, value)) {
		return false;
	}
	return Object.hasOwn(value, "completion") || Object.hasOwn(value, "inputUpToId");
}

/** Returns the input boundary for completed, incomplete, and legacy record envelopes. */
export function recordedInputBoundaryId(
	data: ObservationsRecordedEntryData | ReflectionsRecordedEntryData,
): string {
	if ("completion" in data && data.completion === "incomplete") {
		return data.inputUpToId;
	}
	return data.coversUpToId;
}

/** Checks whether a value is one of the supported observation relevance values. */
export function isRelevance(value: unknown): value is Relevance {
	return Value.Check(RELEVANCE_SCHEMA, value);
}

/** Checks whether a value is a nonempty string. */
export function isNonEmptyString(value: unknown): value is string {
	return Value.Check(NONEMPTY_STRING_SCHEMA, value);
}

/** Checks whether a value is a nonempty string list. */
export function isNonEmptyStringArray(value: unknown): value is string[] {
	return Value.Check(NONEMPTY_STRING_ARRAY_SCHEMA, value);
}

/** Checks whether a value is a memory record id. */
export function isMemoryId(value: unknown): value is string {
	return Value.Check(MEMORY_ID_SCHEMA, value);
}

/** Checks whether a value is a valid stored observation. */
export function isObservation(value: unknown): value is Observation {
	return Value.Check(OBSERVATION_SCHEMA, value);
}

/** Checks whether a value is a valid stored reflection. */
export function isReflection(value: unknown): value is Reflection {
	return Value.Check(REFLECTION_SCHEMA, value);
}

/** Checks whether raw ledger data is a valid legacy or completion-aware observation envelope. */
export function isObservationsRecordedData(value: unknown): value is ObservationsRecordedEntryData {
	if (hasNewRecordBoundary(value)) {
		return Value.Check(NEW_OBSERVATIONS_RECORDED_DATA_SCHEMA, value);
	}
	return Value.Check(LEGACY_OBSERVATIONS_RECORDED_DATA_SCHEMA, value);
}

/** Checks whether raw ledger data is a valid legacy or completion-aware reflection envelope. */
export function isReflectionsRecordedData(value: unknown): value is ReflectionsRecordedEntryData {
	if (hasNewRecordBoundary(value)) {
		return Value.Check(NEW_REFLECTIONS_RECORDED_DATA_SCHEMA, value);
	}
	return Value.Check(LEGACY_REFLECTIONS_RECORDED_DATA_SCHEMA, value);
}

/** Checks whether raw ledger data is a valid observation drop envelope. */
export function isObservationsDroppedData(value: unknown): value is ObservationsDroppedEntryData {
	if (!isPlainRecord(value)) return false;
	return isNonEmptyStringArray(value.observationIds) && isNonEmptyString(value.coversUpToId);
}

/** Checks whether raw compaction details contain a supported folded-memory snapshot. */
export function isMemoryDetails(value: unknown): value is MemoryDetails {
	if (!isPlainRecord(value)) return false;
	return (
		value.type === OM_FOLDED &&
		value.version === 1 &&
		typeof value.fullFold === "boolean" &&
		Array.isArray(value.observations) &&
		value.observations.every(isObservation) &&
		Array.isArray(value.reflections) &&
		value.reflections.every(isReflection) &&
		(value.foldThroughEntryId === undefined || typeof value.foldThroughEntryId === "string")
	);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

/** Checks whether an entry stores valid observation records. */
export function isObservationsRecordedEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_OBSERVATIONS_RECORDED;
	data: ObservationsRecordedEntryData;
} {
	return entry.type === "custom" && entry.customType === OM_OBSERVATIONS_RECORDED && isObservationsRecordedData(entry.data);
}

/** Checks whether an entry stores valid reflection records. */
export function isReflectionsRecordedEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_REFLECTIONS_RECORDED;
	data: ReflectionsRecordedEntryData;
} {
	return entry.type === "custom" && entry.customType === OM_REFLECTIONS_RECORDED && isReflectionsRecordedData(entry.data);
}

/** Checks whether an entry stores valid observation tombstones. */
export function isObservationsDroppedEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_OBSERVATIONS_DROPPED;
	data: ObservationsDroppedEntryData;
} {
	return entry.type === "custom" && entry.customType === OM_OBSERVATIONS_DROPPED && isObservationsDroppedData(entry.data);
}

/** Builds a completion-aware observation envelope; empty records are allowed only for completed reviews. */
export function buildObservationsRecordedData(
	observations: Observation[],
	boundary: RecordBoundary,
): ObservationsRecordedEntryData | undefined {
	switch (boundary.kind) {
		case "completed": {
			if (!isNonEmptyString(boundary.coversUpToId)) {
				return undefined;
			}
			return { completion: "completed", observations, coversUpToId: boundary.coversUpToId };
		}
		case "incomplete": {
			if (observations.length === 0 || !isNonEmptyString(boundary.inputUpToId)) {
				return undefined;
			}
			return { completion: "incomplete", observations, inputUpToId: boundary.inputUpToId };
		}
		default: {
			const exhaustive: never = boundary;
			return exhaustive;
		}
	}
}

/** Builds a completion-aware reflection envelope; empty records are allowed only for completed reviews. */
export function buildReflectionsRecordedData(
	reflections: Reflection[],
	boundary: RecordBoundary,
): ReflectionsRecordedEntryData | undefined {
	switch (boundary.kind) {
		case "completed": {
			if (!isNonEmptyString(boundary.coversUpToId)) {
				return undefined;
			}
			return { completion: "completed", reflections, coversUpToId: boundary.coversUpToId };
		}
		case "incomplete": {
			if (reflections.length === 0 || !isNonEmptyString(boundary.inputUpToId)) {
				return undefined;
			}
			return { completion: "incomplete", reflections, inputUpToId: boundary.inputUpToId };
		}
		default: {
			const exhaustive: never = boundary;
			return exhaustive;
		}
	}
}

/** Builds a valid observation tombstone envelope. */
export function buildObservationsDroppedData(
	observationIds: string[],
	coversUpToId: string,
): ObservationsDroppedEntryData | undefined {
	if (observationIds.length === 0 || !isNonEmptyString(coversUpToId)) return undefined;
	return { observationIds, coversUpToId };
}
