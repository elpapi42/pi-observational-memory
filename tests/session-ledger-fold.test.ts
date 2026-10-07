import { describe, expect, it } from "vitest";

import { foldLedger, latestCoverageMarkerId, observationsAtOrBeforeCoverage, OM_OBSERVATIONS_RECORDED } from "../src/session-ledger/index.js";
import {
	branchSummary,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	oldV2ObservationEntry,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
} from "./fixtures/session.js";

describe("session-ledger V3 folding", () => {
	it("folds observations and reflections from branch root through the target entry", () => {
		const obs1 = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"] });
		const obs2 = observation("bbbbbbbbbbbb", { sourceEntryIds: ["raw-2"] });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbb"),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-2" }),
			observationsRecordedEntry("om-bbbbbbbbbbbb", { observations: [obs2], coversUpToId: "raw-2" }),
		];

		const folded = foldLedger(entries, { upToEntryId: "om-eeeeeeeeeeee" });

		expect(folded.observations.map((obs) => obs.id)).toEqual(["aaaaaaaaaaaa"]);
		expect(folded.activeObservations.map((obs) => obs.id)).toEqual(["aaaaaaaaaaaa"]);
		expect(folded.reflections.map((ref) => ref.id)).toEqual(["eeeeeeeeeeee"]);
		expect(folded.observationsById.get("bbbbbbbbbbbb")).toBeUndefined();
	});

	it("limits reflector input to completed observer coverage and preserves first-record boundaries", () => {
		const covered = observation("aaaaaaaaaaaa", { content: "covered", sourceEntryIds: ["raw-1"] });
		const partial = observation("bbbbbbbbbbbb", { content: "partial first record", sourceEntryIds: ["raw-2"] });
		const duplicate = observation("bbbbbbbbbbbb", { content: "duplicate with an earlier boundary", sourceEntryIds: ["raw-1"] });
		const entries = [
			textCustomMessage("raw-1", "first chunk"),
			{
				type: "custom",
				id: "complete-first-chunk",
				customType: OM_OBSERVATIONS_RECORDED,
				data: { completion: "completed", observations: [covered], coversUpToId: "raw-1" },
			},
			textCustomMessage("raw-2", "second chunk"),
			{
				type: "custom",
				id: "partial-second-chunk",
				customType: OM_OBSERVATIONS_RECORDED,
				data: { completion: "incomplete", observations: [partial], inputUpToId: "raw-2" },
			},
			{
				type: "custom",
				id: "duplicate-earlier-boundary",
				customType: OM_OBSERVATIONS_RECORDED,
				data: { completion: "incomplete", observations: [duplicate], inputUpToId: "raw-1" },
			},
		];
		const coverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
		const folded = foldLedger(entries);

		expect(coverageId).toBe("raw-1");
		expect(folded.observationsById.get("bbbbbbbbbbbb")?.content).toBe("partial first record");
		expect(observationsAtOrBeforeCoverage(entries, folded, coverageId ?? "").map((item) => item.id)).toEqual([
			"aaaaaaaaaaaa",
		]);
	});

	it("applies drops as tombstones while preserving observation history", () => {
		const obs1 = observation("aaaaaaaaaaaa");
		const obs2 = observation("bbbbbbbbbbbb");
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1, obs2], coversUpToId: "raw-1" }),
			observationsDroppedEntry("om-drop-1", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-1" }),
		];

		const folded = foldLedger(entries);

		expect(folded.observations.map((obs) => obs.id)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
		expect(folded.activeObservations.map((obs) => obs.id)).toEqual(["bbbbbbbbbbbb"]);
		expect(folded.droppedObservationIds.has("aaaaaaaaaaaa")).toBe(true);
		expect(folded.observationsById.get("aaaaaaaaaaaa")).toEqual(obs1);
	});

	it("keeps first valid observation and reflection when duplicate ids appear", () => {
		const firstObs = observation("aaaaaaaaaaaa", { content: "first observation" });
		const duplicateObs = observation("aaaaaaaaaaaa", { content: "duplicate observation" });
		const firstRef = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: "first reflection" });
		const duplicateRef = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: "duplicate reflection" });
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [firstObs], coversUpToId: "raw-1" }),
			observationsRecordedEntry("om-bbbbbbbbbbbb", { observations: [duplicateObs], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [firstRef], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ffffffffffff", { reflections: [duplicateRef], coversUpToId: "raw-1" }),
		];

		const folded = foldLedger(entries);

		expect(folded.observationsById.get("aaaaaaaaaaaa")?.content).toBe("first observation");
		expect(folded.reflectionsById.get("eeeeeeeeeeee")?.content).toBe("first reflection");
		expect(folded.observations).toHaveLength(1);
		expect(folded.reflections).toHaveLength(1);
	});

	it("retains tombstones for unknown drop ids without throwing", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsDroppedEntry("om-drop-1", { observationIds: ["deadbeef0000"], coversUpToId: "raw-1" }),
		];

		const folded = foldLedger(entries);

		expect(folded.droppedObservationIds.has("deadbeef0000")).toBe(true);
		expect(folded.activeObservations).toEqual([]);
	});

	it("ignores old V2 entries and unknown custom entries", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			oldV2ObservationEntry("v2-obs"),
			{ type: "custom", id: "unknown", parentId: null, timestamp: "2026-05-02T10:00:00.000Z", customType: "other.memory", data: { any: true } },
		];

		const folded = foldLedger(entries);

		expect(folded.observations).toEqual([]);
		expect(folded.reflections).toEqual([]);
		expect(folded.activeObservations).toEqual([]);
	});

	it("folds only the branch path supplied by the caller", () => {
		const mainObs = observation("aaaa00000000", { sourceEntryIds: ["raw-main"] });
		const forkObs = observation("bbbb00000000", { sourceEntryIds: ["raw-fork"] });
		const mainBranch = [
			branchSummary("root", "root summary"),
			textCustomMessage("raw-main", "main"),
			observationsRecordedEntry("main-ledger", { observations: [mainObs], coversUpToId: "raw-main" }),
		];
		const forkBranch = [
			branchSummary("root", "root summary"),
			textCustomMessage("raw-fork", "fork"),
			observationsRecordedEntry("fork-ledger", { observations: [forkObs], coversUpToId: "raw-fork" }),
		];

		expect(foldLedger(mainBranch).observations.map((obs) => obs.id)).toEqual(["aaaa00000000"]);
		expect(foldLedger(forkBranch).observations.map((obs) => obs.id)).toEqual(["bbbb00000000"]);
	});
});
