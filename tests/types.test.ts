import { describe, expect, it } from "vitest";

import { compactionEntry } from "./fixtures/session.js";
import {
	isMemoryDetails,
	isMemoryDetailsV4,
	isObservationEntryData,
	isReflectionRecord,
	isSupportedMemoryDetails,
	reflectionContent,
	reflectionId,
	reflectionToPromptLine,
	type MemoryDetailsV4,
	type ObservationRecord,
	type ReflectionRecord,
} from "../src/types.js";

const baseRecord = {
	id: "abc123def456",
	content: "User confirmed exact source ids are required.",
	timestamp: "2026-05-02 10:00",
	relevance: "high",
} satisfies ObservationRecord;

describe("observation source attribution data shape", () => {
	it("accepts legacy observation records without sourceEntryIds", () => {
		expect(
			isObservationEntryData({
				records: [baseRecord],
				coversFromId: "entry-a",
				coversUpToId: "entry-b",
				tokenCount: 12,
			}),
		).toBe(true);
	});

	it("accepts source-attributed observation records with non-empty sourceEntryIds", () => {
		expect(
			isMemoryDetails({
				type: "observational-memory",
				version: 3,
				observations: [{ ...baseRecord, sourceEntryIds: ["entry-a", "entry-b"] }],
				reflections: [],
			}),
		).toBe(true);
	});

	it("rejects malformed sourceEntryIds when present", () => {
		for (const sourceEntryIds of [[], ["entry-a", ""], ["entry-a", 42], "entry-a"] as unknown[]) {
			expect(
				isObservationEntryData({
					records: [{ ...baseRecord, sourceEntryIds }],
					coversFromId: "entry-a",
					coversUpToId: "entry-b",
					tokenCount: 12,
				}),
			).toBe(false);
		}
	});
});

const reflectionRecord = {
	id: "def456abc123",
	content: "User prefers compact source recall rows.",
	supportingObservationIds: ["abc123def456"],
} satisfies ReflectionRecord;

function memoryDetailsV4(overrides: Partial<MemoryDetailsV4> = {}): MemoryDetailsV4 {
	return {
		type: "observational-memory",
		version: 4,
		observations: [baseRecord],
		reflections: ["Legacy reflection remains plain.", reflectionRecord],
		...overrides,
	};
}

describe("reflection memory detail compatibility", () => {
	it("accepts v3 legacy memory details with string reflections", () => {
		const details = {
			type: "observational-memory",
			version: 3,
			observations: [baseRecord],
			reflections: ["Legacy reflection remains valid memory."],
		};

		expect(isMemoryDetails(details)).toBe(true);
		expect(isSupportedMemoryDetails(details)).toBe(true);
	});

	it("accepts v4 memory details with mixed legacy and id-bearing reflection records", () => {
		const details = memoryDetailsV4();

		expect(isMemoryDetailsV4(details)).toBe(true);
		expect(isSupportedMemoryDetails(details)).toBe(true);
	});

	it("keeps legacy reflections plain and exposes record helpers for id-bearing reflections", () => {
		const legacy = "Legacy reflection remains plain.";

		expect(reflectionContent(legacy)).toBe("Legacy reflection remains plain.");
		expect(reflectionId(legacy)).toBeUndefined();
		expect(reflectionToPromptLine(legacy)).toBe("Legacy reflection remains plain.");
		expect(reflectionContent(reflectionRecord)).toBe("User prefers compact source recall rows.");
		expect(reflectionId(reflectionRecord)).toBe("def456abc123");
		expect(reflectionToPromptLine(reflectionRecord)).toBe(
			"[def456abc123] User prefers compact source recall rows.",
		);
	});

	it("rejects malformed reflection records", () => {
		for (const malformed of [
			{ ...reflectionRecord, id: "not-hex" },
			{ ...reflectionRecord, id: "DEF456ABC123" },
			{ ...reflectionRecord, id: "def456abc12" },
			{ ...reflectionRecord, content: "" },
			{ ...reflectionRecord, content: "\n" },
			{ ...reflectionRecord, content: "line one\nline two" },
			{ ...reflectionRecord, supportingObservationIds: undefined },
			{ ...reflectionRecord, supportingObservationIds: [] },
			{ ...reflectionRecord, supportingObservationIds: [""] },
			{ ...reflectionRecord, supportingObservationIds: ["abc123def456", 42] },
		] as unknown[]) {
			expect(isReflectionRecord(malformed)).toBe(false);
			expect(isMemoryDetailsV4(memoryDetailsV4({ reflections: [malformed as ReflectionRecord] }))).toBe(
				false,
			);
		}
	});

	it("keeps unknown memory detail versions unsupported", () => {
		for (const version of [1, 2, 999]) {
			expect(
				isSupportedMemoryDetails({
					type: "observational-memory",
					version,
					observations: [baseRecord],
					reflections: [],
				}),
			).toBe(false);
		}
	});

	it("can model compaction entries with memory details in test fixtures", () => {
		const entry = compactionEntry({ id: "compact-a", details: memoryDetailsV4(), firstKeptEntryId: "entry-a" });

		expect(entry.type).toBe("compaction");
		expect(entry.details).toEqual(memoryDetailsV4());
		expect(entry.firstKeptEntryId).toBe("entry-a");
	});
});
