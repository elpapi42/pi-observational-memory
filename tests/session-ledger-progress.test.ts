import { describe, expect, it } from "vitest";

import {
	earlierCoverageMarkerId,
	entryIndexById,
	isSourceEntry,
	latestCoverageIndex,
	latestCoverageMarkerId,
	rawTokensAfterIndex,
	rawTokensSinceDropCoverage,
	rawTokensSinceLastCompaction,
	rawTokensSinceObservationCoverage,
	rawTokensSinceReflectionCoverage,
} from "../src/session-ledger/index.js";
import {
	V3_OBSERVATIONS_DROPPED,
	V3_OBSERVATIONS_RECORDED,
	V3_REFLECTIONS_RECORDED,
	branchSummary,
	compactionEntry,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	oldV2ObservationEntry,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
} from "./fixtures/session.js";

describe("session-ledger V3 progress helpers", () => {
	it("detects only raw/source entries as source entries", () => {
		expect(isSourceEntry(textCustomMessage("raw-1", "abcd"))).toBe(true);
		expect(isSourceEntry(branchSummary("sum-1", "abcd"))).toBe(true);
		expect(isSourceEntry(observationsRecordedEntry("om-1", {
			observations: [observation("aaaaaaaaaaaa")],
			coversUpToId: "raw-1",
		}))).toBe(false);
		expect(isSourceEntry(compactionEntry("cmp-1"))).toBe(false);
	});

	it("builds a branch id to index map", () => {
		const entries = [textCustomMessage("raw-1", "abcd"), textCustomMessage("raw-2", "efgh")];
		expect(entryIndexById(entries).get("raw-1")).toBe(0);
		expect(entryIndexById(entries).get("raw-2")).toBe(1);
	});

	it("caches the branch index and invalidates it when entries are appended or the branch changes", () => {
		const branch = [textCustomMessage("raw-1", "abcd"), textCustomMessage("raw-2", "efgh")];
		const first = entryIndexById(branch);
		// Same branch (same tip + length): the cached Map is reused.
		expect(entryIndexById(branch)).toBe(first);

		// Append a new entry (new tip + length): the cache must invalidate and rebuild.
		const appended = [...branch, textCustomMessage("raw-3", "ijkl")];
		const rebuilt = entryIndexById(appended);
		expect(rebuilt).not.toBe(first);
		expect(rebuilt.get("raw-1")).toBe(0);
		expect(rebuilt.get("raw-3")).toBe(2);

		// A branch switch to a different tip rebuilds as well.
		const switched = [textCustomMessage("x-1", "zz"), textCustomMessage("x-2", "zz")];
		expect(entryIndexById(switched)).not.toBe(rebuilt);
		expect(entryIndexById(switched).get("x-2")).toBe(1);
	});

	it("counts raw tokens after a branch index and ignores memory/compaction entries", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-1", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-2" }),
			branchSummary("sum-1", "cccccccccccc"),
		];

		expect(rawTokensAfterIndex(entries, 0)).toBe(5); // raw-2: 2 + sum-1: 3
		expect(rawTokensAfterIndex(entries, 1)).toBe(5);
		expect(rawTokensAfterIndex(entries, 2)).toBe(3);
	});

	it("uses independent coverage clocks for observations, reflections, and drops", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])], coversUpToId: "raw-2" }),
			textCustomMessage("raw-3", "cccccccccccc"),
			observationsDroppedEntry("om-drop-1", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "om-eeeeeeeeeeee" }),
			textCustomMessage("raw-4", "dddddddddddddddd"),
		];

		expect(rawTokensSinceObservationCoverage(entries)).toBe(9); // raw-2 + raw-3 + raw-4
		expect(rawTokensSinceReflectionCoverage(entries)).toBe(7); // raw-3 + raw-4
		expect(rawTokensSinceDropCoverage(entries)).toBe(7); // covers ledger entry om-eeeeeeeeeeee, raw after it
	});

	it("lets coversUpToId point to a memory ledger entry", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])], coversUpToId: "raw-1" }),
			observationsDroppedEntry("om-drop-1", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "om-eeeeeeeeeeee" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];

		expect(latestCoverageIndex(entries, V3_OBSERVATIONS_DROPPED)).toBe(1);
		expect(rawTokensSinceDropCoverage(entries)).toBe(2);
	});

	it("chooses the max covered branch position, not merely latest ledger entry order", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "raw-2" }),
			observationsRecordedEntry("om-bbbbbbbbbbbb", { observations: [observation("bbbbbbbbbbbb")], coversUpToId: "raw-1" }),
			textCustomMessage("raw-3", "cccccccccccc"),
		];

		expect(latestCoverageIndex(entries, V3_OBSERVATIONS_RECORDED)).toBe(1);
		expect(latestCoverageMarkerId(entries, V3_OBSERVATIONS_RECORDED)).toBe("raw-2");
		expect(rawTokensSinceObservationCoverage(entries)).toBe(3);
	});

	it("returns latest inner coverage marker and earlier marker by branch index", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			textCustomMessage("raw-2", "bbbbbbbb"),
			textCustomMessage("raw-3", "cccccccccccc"),
			observationsRecordedEntry("om-obs", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "raw-3" }),
			reflectionsRecordedEntry("om-ref", { reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])], coversUpToId: "raw-2" }),
		];

		expect(latestCoverageMarkerId(entries, V3_OBSERVATIONS_RECORDED)).toBe("raw-3");
		expect(latestCoverageMarkerId(entries, V3_REFLECTIONS_RECORDED)).toBe("raw-2");
		expect(earlierCoverageMarkerId(entries, "raw-3", "raw-2")).toBe("raw-2");
		expect(earlierCoverageMarkerId(entries, "raw-1", undefined)).toBe("raw-1");
		expect(earlierCoverageMarkerId(entries, "missing", "raw-2")).toBe("raw-2");
		expect(earlierCoverageMarkerId(entries, "missing-a", "missing-b")).toBeUndefined();
	});

	it("ignores invalid coverage markers and old V2 markers without throwing", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			oldV2ObservationEntry("v2-obs"),
			observationsRecordedEntry("om-obs-invalid", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "missing" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];

		expect(() => rawTokensSinceObservationCoverage(entries)).not.toThrow();
		expect(rawTokensSinceObservationCoverage(entries)).toBe(3);
		expect(latestCoverageIndex(entries, V3_REFLECTIONS_RECORDED)).toBe(-1);
	});

	it("counts raw tokens since the latest Pi compaction without throwing on old memory details", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-1" }),
			oldV2ObservationEntry("v2-obs"),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];

		expect(rawTokensSinceLastCompaction(entries)).toBe(3); // raw-1 + raw-2 from live tail starting at firstKeptEntryId
	});
});
