import { describe, expect, it } from "vitest";

import { isSourceEntry, recallObservationSources, type Entry } from "../src/branch.js";
import { OBSERVATION_CUSTOM_TYPE, type ObservationRecord } from "../src/types.js";
import { branchSummaryEntry, customMessageEntry, messageEntry, observationEntry } from "./fixtures/session.js";

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

describe("isSourceEntry", () => {
	it("matches the source-renderable entry types and excludes custom metadata", () => {
		expect(isSourceEntry(userSource)).toBe(true);
		expect(isSourceEntry(customSource)).toBe(true);
		expect(isSourceEntry(summarySource)).toBe(true);
		expect(isSourceEntry(obsEntry("obs-entry", [baseObservation]))).toBe(false);
	});
});
