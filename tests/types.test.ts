import { describe, expect, it } from "vitest";

import { isMemoryDetails, isObservationEntryData, type ObservationRecord } from "../src/types.js";

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
