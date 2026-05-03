import { describe, expect, it } from "vitest";

import { isSourceEntry, recallMemorySources, recallObservationSources, type Entry } from "../src/branch.js";
import { OBSERVATION_CUSTOM_TYPE, type MemoryDetailsV4, type ObservationRecord, type ReflectionRecord } from "../src/types.js";
import { branchSummaryEntry, compactionEntry, customMessageEntry, messageEntry, observationEntry } from "./fixtures/session.js";

const baseObservation = {
	id: "abc123def456",
	content: "User confirmed exact source ids are required.",
	timestamp: "2026-05-02 10:00",
	relevance: "high",
} satisfies ObservationRecord;

const userSource = messageEntry({
	id: "source-user",
	message: { role: "user", timestamp: "2026-05-02 10:00", content: "Please preserve exact sources." },
});
const customSource = customMessageEntry({ id: "source-custom", content: "custom source" });
const summarySource = branchSummaryEntry({ id: "source-summary", summary: "branch source" });

function obsEntry(id: string, records: ObservationRecord[], overrides: Partial<Entry> = {}): Entry {
	return observationEntry({
		id,
		data: {
			records,
			coversFromId: "source-user",
			coversUpToId: "source-summary",
			tokenCount: 12,
		},
		...overrides,
	});
}

describe("recallObservationSources", () => {
	it("resolves valid sourceEntryIds to source entries in current branch order", () => {
		const entries = [
			userSource,
			customSource,
			summarySource,
			obsEntry("obs-entry", [
				{
					...baseObservation,
					sourceEntryIds: ["source-summary", "source-user", "source-user"],
				},
			]),
		] satisfies Entry[];

		const result = recallObservationSources(entries, baseObservation.id);

		expect(result.status).toBe("found");
		if (result.status !== "found") throw new Error("expected found");
		expect(result.collision).toBe(false);
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0]).toMatchObject({ status: "ok", observationEntryId: "obs-entry" });
		if (result.matches[0].status !== "ok") throw new Error("expected ok");
		expect(result.matches[0].sourceEntryIds).toEqual(["source-user", "source-summary"]);
		expect(result.matches[0].sourceEntries.map((entry) => entry.id)).toEqual(["source-user", "source-summary"]);
	});

	it("returns not_found when no current-branch om.observation record has the id", () => {
		const result = recallObservationSources([
			userSource,
			obsEntry("obs-entry", [{ ...baseObservation, id: "fedcba654321", sourceEntryIds: ["source-user"] }]),
		], baseObservation.id);

		expect(result).toEqual({ status: "not_found", observationId: baseObservation.id, matches: [], collision: false });
	});

	it("returns no_source for legacy observations and does not use batch coverage fallback", () => {
		const result = recallObservationSources([
			userSource,
			customSource,
			obsEntry("legacy-obs-entry", [baseObservation]),
		], baseObservation.id);

		expect(result.status).toBe("found");
		if (result.status !== "found") throw new Error("expected found");
		expect(result.matches).toEqual([
			{ status: "no_source", observation: baseObservation, observationEntryId: "legacy-obs-entry" },
		]);
	});

	it("returns source_unavailable for missing/off-branch and non-source source ids", () => {
		const metadataEntry = obsEntry("metadata-entry", [
			{ ...baseObservation, id: "fedcba654321", sourceEntryIds: ["source-user"] },
		]);
		const result = recallObservationSources([
			userSource,
			metadataEntry,
			obsEntry("obs-entry", [
				{
					...baseObservation,
					sourceEntryIds: ["source-user", "missing-source", "metadata-entry"],
				},
			]),
		], baseObservation.id);

		expect(result.status).toBe("found");
		if (result.status !== "found") throw new Error("expected found");
		expect(result.matches).toHaveLength(1);
		const match = result.matches[0];
		expect(match.status).toBe("source_unavailable");
		if (match.status !== "source_unavailable") throw new Error("expected source_unavailable");
		expect(match.sourceEntryIds).toEqual(["source-user", "missing-source", "metadata-entry"]);
		expect(match.missingSourceEntryIds).toEqual(["missing-source"]);
		expect(match.nonSourceEntryIds).toEqual(["metadata-entry"]);
	});

	it("returns all duplicate id matches with per-match statuses", () => {
		const legacyObservation = { ...baseObservation, content: "Legacy duplicate observation." } satisfies ObservationRecord;
		const result = recallObservationSources([
			userSource,
			obsEntry("source-attributed-entry", [{ ...baseObservation, sourceEntryIds: ["source-user"] }]),
			obsEntry("legacy-entry", [legacyObservation]),
		], baseObservation.id);

		expect(result.status).toBe("found");
		if (result.status !== "found") throw new Error("expected found");
		expect(result.collision).toBe(true);
		expect(result.matches).toHaveLength(2);
		expect(result.matches.map((match) => match.status)).toEqual(["ok", "no_source"]);
		expect(result.matches.map((match) => match.observationEntryId)).toEqual(["source-attributed-entry", "legacy-entry"]);
	});

	it("ignores malformed observation entries without throwing", () => {
		const malformedObservationEntry = {
			type: "custom",
			id: "malformed-entry",
			parentId: null,
			timestamp: "2026-05-02T10:01:00.000Z",
			customType: OBSERVATION_CUSTOM_TYPE,
			data: {
				records: [{ ...baseObservation, sourceEntryIds: [] }],
				coversFromId: "source-user",
				coversUpToId: "source-user",
				tokenCount: 12,
			},
		} satisfies Entry;
		const result = recallObservationSources([
			malformedObservationEntry,
			userSource,
			obsEntry("valid-entry", [{ ...baseObservation, sourceEntryIds: ["source-user"] }]),
		], baseObservation.id);

		expect(result.status).toBe("found");
		if (result.status !== "found") throw new Error("expected found");
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0]).toMatchObject({ status: "ok", observationEntryId: "valid-entry" });
	});
});

const reflection = {
	id: "111111111111",
	content: "User prefers recallable durable reflections.",
	supportingObservationIds: [baseObservation.id],
} satisfies ReflectionRecord;

function memoryDetailsV4(reflections: MemoryDetailsV4["reflections"] = [reflection], observations: ObservationRecord[] = []): MemoryDetailsV4 {
	return {
		type: "observational-memory",
		version: 4,
		observations,
		reflections,
	};
}

describe("recallMemorySources", () => {
	it("preserves observation-only recall evidence while producing a shared source section", () => {
		const entries = [
			userSource,
			summarySource,
			obsEntry("obs-entry", [{ ...baseObservation, sourceEntryIds: ["source-summary", "source-user"] }]),
		] satisfies Entry[];

		const result = recallMemorySources(entries, baseObservation.id);

		expect(result.status).toBe("found");
		if (result.status !== "found") throw new Error("expected found");
		expect(result.reflectionMatches).toEqual([]);
		expect(result.directObservationMatches).toHaveLength(1);
		expect(result.observations).toHaveLength(1);
		expect(result.observations[0]).toMatchObject({ status: "ok", observationEntryId: "obs-entry" });
		expect(result.sourceEntries.map((entry) => entry.id)).toEqual(["source-user", "source-summary"]);
		expect(result.collision).toBe(false);
		expect(result.partial).toBe(false);
	});

	it("resolves a current reflection id through supporting observations even when they are pruned from visible memory", () => {
		const entries = [
			userSource,
			summarySource,
			obsEntry("supporting-obs-entry", [{ ...baseObservation, sourceEntryIds: ["source-user", "source-summary"] }]),
			compactionEntry({ id: "compaction-current", details: memoryDetailsV4([reflection], []) }),
		] satisfies Entry[];

		const result = recallMemorySources(entries, reflection.id);

		expect(result.status).toBe("found");
		if (result.status !== "found") throw new Error("expected found");
		expect(result.reflectionMatches).toEqual([{ reflection, reflectionIndex: 0 }]);
		expect(result.directObservationMatches).toEqual([]);
		expect(result.observations).toHaveLength(1);
		expect(result.observations[0]).toMatchObject({ status: "ok", observationEntryId: "supporting-obs-entry" });
		expect(result.sourceEntries.map((entry) => entry.id)).toEqual(["source-user", "source-summary"]);
		expect(result.collision).toBe(false);
		expect(result.partial).toBe(false);
	});

	it("returns all evidence for a mixed observation/reflection id conflict", () => {
		const matchingObservation = {
			...baseObservation,
			id: reflection.id,
			content: "Direct observation with the same id as a reflection.",
			sourceEntryIds: ["source-user"],
		} satisfies ObservationRecord;
		const supportingObservation = {
			...baseObservation,
			id: "222222222222",
			content: "Supporting observation for the reflection.",
			sourceEntryIds: ["source-user", "source-summary"],
		} satisfies ObservationRecord;
		const conflictingReflection = { ...reflection, supportingObservationIds: [supportingObservation.id] } satisfies ReflectionRecord;
		const entries = [
			userSource,
			summarySource,
			obsEntry("direct-entry", [matchingObservation]),
			obsEntry("support-entry", [supportingObservation]),
			compactionEntry({ id: "compaction-current", details: memoryDetailsV4([conflictingReflection]) }),
		] satisfies Entry[];

		const result = recallMemorySources(entries, reflection.id);

		expect(result.status).toBe("found");
		if (result.status !== "found") throw new Error("expected found");
		expect(result.collision).toBe(true);
		expect(result.reflectionMatches.map((match) => match.reflection.id)).toEqual([reflection.id]);
		expect(result.directObservationMatches.map((match) => match.observation.content)).toEqual([
			"Direct observation with the same id as a reflection.",
		]);
		expect(result.observations.map((match) => match.observationEntryId)).toEqual(["direct-entry", "support-entry"]);
		expect(result.sourceEntries.map((entry) => entry.id)).toEqual(["source-user", "source-summary"]);
	});

	it("dedupes duplicate supporting observations without hiding duplicate observation ids", () => {
		const duplicateA = { ...baseObservation, sourceEntryIds: ["source-user"] } satisfies ObservationRecord;
		const duplicateB = { ...baseObservation, content: "Duplicate id from another entry.", sourceEntryIds: ["source-summary"] } satisfies ObservationRecord;
		const entries = [
			userSource,
			summarySource,
			obsEntry("obs-entry-a", [duplicateA]),
			obsEntry("obs-entry-b", [duplicateB]),
			compactionEntry({ id: "compaction-current", details: memoryDetailsV4([reflection]) }),
		] satisfies Entry[];

		const result = recallMemorySources(entries, reflection.id);

		expect(result.status).toBe("found");
		if (result.status !== "found") throw new Error("expected found");
		expect(result.observations.map((match) => [match.observationEntryId, match.observation.content])).toEqual([
			["obs-entry-a", baseObservation.content],
			["obs-entry-b", "Duplicate id from another entry."],
		]);
		expect(result.sourceEntries.map((entry) => entry.id)).toEqual(["source-user", "source-summary"]);
	});

	it("returns partial evidence with diagnostics for missing supporting observations and unavailable source ids", () => {
		const metadataEntry = obsEntry("metadata-entry", [
			{ ...baseObservation, id: "333333333333", sourceEntryIds: ["source-user"] },
		]);
		const partiallyAvailableObservation = {
			...baseObservation,
			id: "222222222222",
			content: "Observation with one available and two unavailable sources.",
			sourceEntryIds: ["source-user", "missing-source", "metadata-entry"],
		} satisfies ObservationRecord;
		const partialReflection = {
			...reflection,
			supportingObservationIds: [partiallyAvailableObservation.id, "999999999999"],
		} satisfies ReflectionRecord;
		const entries = [
			userSource,
			metadataEntry,
			obsEntry("partial-support-entry", [partiallyAvailableObservation]),
			compactionEntry({ id: "compaction-current", details: memoryDetailsV4([partialReflection]) }),
		] satisfies Entry[];

		const result = recallMemorySources(entries, partialReflection.id);

		expect(result.status).toBe("found");
		if (result.status !== "found") throw new Error("expected found");
		expect(result.partial).toBe(true);
		expect(result.reflectionMatches).toHaveLength(1);
		expect(result.observations).toHaveLength(1);
		expect(result.observations[0]).toMatchObject({ status: "source_unavailable", observationEntryId: "partial-support-entry" });
		expect(result.sourceEntries.map((entry) => entry.id)).toEqual(["source-user"]);
		expect(result.unavailableSupportingObservations.map((item) => item.observationId)).toEqual(["999999999999"]);
		expect(result.missingSourceEntryIds).toEqual(["missing-source"]);
		expect(result.nonSourceEntryIds).toEqual(["metadata-entry"]);
	});

	it("marks reflection evidence partial when a supporting observation has no source ids", () => {
		const legacySupportingObservation = {
			...baseObservation,
			id: "222222222222",
			content: "Legacy observation without source ids supports the reflection.",
		} satisfies ObservationRecord;
		const partialReflection = {
			...reflection,
			supportingObservationIds: [legacySupportingObservation.id],
		} satisfies ReflectionRecord;
		const entries = [
			obsEntry("legacy-support-entry", [legacySupportingObservation]),
			compactionEntry({ id: "compaction-current", details: memoryDetailsV4([partialReflection]) }),
		] satisfies Entry[];

		const result = recallMemorySources(entries, partialReflection.id);

		expect(result.status).toBe("found");
		if (result.status !== "found") throw new Error("expected found");
		expect(result.partial).toBe(true);
		expect(result.observations).toHaveLength(1);
		expect(result.observations[0]).toMatchObject({ status: "no_source", observationEntryId: "legacy-support-entry" });
		expect(result.sourceEntries).toEqual([]);
	});

	it("uses only the latest/current memory details for reflection ids", () => {
		const oldReflection = { ...reflection, id: "222222222222", content: "Old reflection no longer current." } satisfies ReflectionRecord;
		const entries = [
			userSource,
			obsEntry("obs-entry", [{ ...baseObservation, sourceEntryIds: ["source-user"] }]),
			compactionEntry({ id: "compaction-old", details: memoryDetailsV4([oldReflection]) }),
			compactionEntry({ id: "compaction-current", details: memoryDetailsV4([reflection]) }),
		] satisfies Entry[];

		expect(recallMemorySources(entries, oldReflection.id)).toEqual({
			status: "not_found",
			memoryId: oldReflection.id,
			reflectionMatches: [],
			directObservationMatches: [],
			observations: [],
			sourceEntries: [],
			unavailableSupportingObservations: [],
			missingSourceEntryIds: [],
			nonSourceEntryIds: [],
			collision: false,
			partial: false,
		});
	});
});

describe("isSourceEntry", () => {
	it("matches the source-renderable entry types and excludes custom metadata", () => {
		expect(isSourceEntry(userSource)).toBe(true);
		expect(isSourceEntry(customSource)).toBe(true);
		expect(isSourceEntry(summarySource)).toBe(true);
		expect(isSourceEntry(obsEntry("obs-entry", [baseObservation]))).toBe(false);
	});
});
