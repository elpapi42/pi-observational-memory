import { describe, expect, it } from "vitest";

import {
	OM_FOLDED,
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	buildObservationsDroppedData,
	buildObservationsRecordedData,
	buildReflectionsRecordedData,
	isMemoryDetails,
	isObservationsDroppedData,
	isObservationsDroppedEntry,
	isObservationsRecordedData,
	isObservationsRecordedEntry,
	isObservation,
	isReflection,
	isReflectionsRecordedData,
	isReflectionsRecordedEntry,
} from "../src/session-ledger/index.js";
import {
	memoryDetails,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	oldV2CompactionDetails,
	oldV2ObservationEntry,
	reflection,
	reflectionsRecordedEntry,
} from "./fixtures/session.js";

describe("session-ledger V3 type guards and builders", () => {
	it("exports the V3 custom type constants", () => {
		expect(OM_OBSERVATIONS_RECORDED).toBe("om.observations.recorded");
		expect(OM_REFLECTIONS_RECORDED).toBe("om.reflections.recorded");
		expect(OM_OBSERVATIONS_DROPPED).toBe("om.observations.dropped");
		expect(OM_FOLDED).toBe("om.folded");
	});

	it("accepts valid V3 observation records and rejects observations without source ids", () => {
		expect(isObservation(observation("aaaaaaaaaaaa"))).toBe(true);
		expect(isObservation({ ...observation("bbbbbbbbbbbb"), sourceEntryIds: [] })).toBe(false);
		expect(isObservation({ ...observation("cccccccccccc"), sourceEntryIds: undefined })).toBe(false);
		expect(isObservation({ ...observation("dddddddddddd"), tokenCount: undefined })).toBe(false);
	});

	it("accepts valid V3 reflection records", () => {
		expect(isReflection(reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]))).toBe(true);
		expect(isReflection({ ...reflection("ffffffffffff"), supportingObservationIds: undefined })).toBe(false);
		expect(isReflection({ ...reflection("111111111111"), tokenCount: undefined })).toBe(false);
	});

	it("accepts non-empty V3 ledger entry data", () => {
		const obsData = { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "raw-1" };
		const refData = { reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])], coversUpToId: "raw-2" };
		const dropData = { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "ref-entry-1" };

		expect(isObservationsRecordedData(obsData)).toBe(true);
		expect(isReflectionsRecordedData(refData)).toBe(true);
		expect(isObservationsDroppedData(dropData)).toBe(true);
	});

	it("accepts empty records only for explicit completed coverage", () => {
		expect(isObservationsRecordedData({ completion: "completed", observations: [], coversUpToId: "raw-1" })).toBe(true);
		expect(isReflectionsRecordedData({ completion: "completed", reflections: [], coversUpToId: "raw-1" })).toBe(true);
		expect(isObservationsRecordedData({ observations: [], coversUpToId: "raw-1" })).toBe(false);
		expect(isReflectionsRecordedData({ reflections: [], coversUpToId: "raw-1" })).toBe(false);
		expect(isObservationsRecordedData({ completion: "incomplete", observations: [], inputUpToId: "raw-1" })).toBe(false);
		expect(isReflectionsRecordedData({ completion: "incomplete", reflections: [], inputUpToId: "raw-1" })).toBe(false);
		expect(isObservationsDroppedData({ observationIds: [], coversUpToId: "raw-1" })).toBe(false);
	});

	it("rejects unknown completion values and mixed completed/incomplete boundaries", () => {
		const observations = [observation("aaaaaaaaaaaa")];
		const reflections = [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])];
		expect(isObservationsRecordedData({ completion: "unknown", observations, coversUpToId: "raw-1" })).toBe(false);
		expect(isReflectionsRecordedData({ completion: "unknown", reflections, coversUpToId: "raw-1" })).toBe(false);
		expect(isObservationsRecordedData({ completion: "incomplete", observations, inputUpToId: "raw-1", coversUpToId: "raw-2" })).toBe(false);
		expect(isReflectionsRecordedData({ completion: "incomplete", reflections, inputUpToId: "raw-1", coversUpToId: "raw-2" })).toBe(false);
	});

	it("builds completed empty and incomplete non-empty record envelopes", () => {
		expect(buildObservationsRecordedData([], { kind: "completed", coversUpToId: "raw-1" })).toEqual({
			completion: "completed",
			observations: [],
			coversUpToId: "raw-1",
		});
		expect(buildReflectionsRecordedData([], { kind: "completed", coversUpToId: "raw-1" })).toEqual({
			completion: "completed",
			reflections: [],
			coversUpToId: "raw-1",
		});
		expect(buildObservationsRecordedData([], { kind: "incomplete", inputUpToId: "raw-1" })).toBeUndefined();
		expect(buildReflectionsRecordedData([], { kind: "incomplete", inputUpToId: "raw-1" })).toBeUndefined();
		expect(buildObservationsRecordedData([observation("aaaaaaaaaaaa")], { kind: "incomplete", inputUpToId: "raw-1" })).toEqual({
			completion: "incomplete",
			observations: [observation("aaaaaaaaaaaa")],
			inputUpToId: "raw-1",
		});
		expect(buildReflectionsRecordedData([reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])], { kind: "incomplete", inputUpToId: "raw-1" })).toEqual({
			completion: "incomplete",
			reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])],
			inputUpToId: "raw-1",
		});
		expect(buildObservationsDroppedData([], "raw-1")).toBeUndefined();
		expect(buildObservationsDroppedData(["aaaaaaaaaaaa"], "ref-entry-1")).toEqual({
			observationIds: ["aaaaaaaaaaaa"],
			coversUpToId: "ref-entry-1",
		});
	});

	it("recognizes V3 memory entries", () => {
		expect(isObservationsRecordedEntry(observationsRecordedEntry("om-aaaaaaaaaaaa", {
			observations: [observation("aaaaaaaaaaaa")],
			coversUpToId: "raw-1",
		}))).toBe(true);
		expect(isReflectionsRecordedEntry(reflectionsRecordedEntry("om-eeeeeeeeeeee", {
			reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])],
			coversUpToId: "raw-1",
		}))).toBe(true);
		expect(isObservationsDroppedEntry(observationsDroppedEntry("om-drop-1", {
			observationIds: ["aaaaaaaaaaaa"],
			coversUpToId: "om-eeeeeeeeeeee",
		}))).toBe(true);
	});

	it("accepts flat V3 folded memory details", () => {
		expect(isMemoryDetails(memoryDetails({
			fullFold: true,
			observations: [observation("aaaaaaaaaaaa")],
			reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])],
		}))).toBe(true);
	});

	it("ignores old V2 observation entries and old V2 compaction details", () => {
		expect(isObservationsRecordedEntry(oldV2ObservationEntry("v2-entry"))).toBe(false);
		expect(isMemoryDetails(oldV2CompactionDetails())).toBe(false);
	});
});
