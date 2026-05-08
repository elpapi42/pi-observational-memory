/**
 * Bridge export surface tests (U4).
 *
 * Validates the stable API published by src/bridge.ts. Includes:
 *   - snapshotFromMemoryDetails: V4 + V3 + invalid input
 *   - exportFromSnapshot: relevance filter, reflection toggle,
 *     pending-observation opt-in, content-shape correctness
 *   - exportFromMemoryDetails: combined helper end-to-end
 *   - getMemoryStateFromBranch: thin wrapper round-trip with synthetic
 *     compaction entries (anchored to the same fixture shape OM uses)
 */

import { describe, expect, test } from "vitest";

import {
	exportFromMemoryDetails,
	exportFromSnapshot,
	getMemoryStateFromBranch,
	snapshotFromMemoryDetails,
	type BridgeRecord,
} from "../src/bridge.js";
import type {
	MemoryDetailsV3,
	MemoryDetailsV4,
	ObservationRecord,
	ReflectionRecord,
} from "../src/types.js";

/** Pad a short tag into a 12-char hex OM id so type guards accept it. */
function id12(tag: string): string {
	const hex = (tag + "0").replace(/[^0-9a-f]/g, "0").toLowerCase();
	if (hex.length >= 12) return hex.slice(0, 12);
	return hex.padEnd(12, "0");
}

function obs(over: Partial<ObservationRecord> & { id: string; relevance: ObservationRecord["relevance"] }): ObservationRecord {
	return {
		id: over.id,
		content: over.content ?? `c-${over.id}`,
		timestamp: over.timestamp ?? "2026-05-08 03:00",
		relevance: over.relevance,
		sourceEntryIds: over.sourceEntryIds,
	};
}

/**
 * Creates a structured reflection. Defaults to one synthesized supporting
 * observation id because OM's type guard rejects empty supports for
 * non-legacy reflections.
 */
function refl(id: string, content: string, supports: string[] = [id12("sup0001")]): ReflectionRecord {
	return { id, content, supportingObservationIds: supports };
}

function v4(observations: ObservationRecord[], reflections: MemoryDetailsV4["reflections"] = []): MemoryDetailsV4 {
	return {
		type: "observational-memory",
		version: 4,
		observations,
		reflections,
	};
}

function v3(observations: ObservationRecord[], reflections: string[] = []): MemoryDetailsV3 {
	return {
		type: "observational-memory",
		version: 3,
		observations,
		reflections,
	};
}

describe("snapshotFromMemoryDetails", () => {
	test("converts V4 details into a snapshot", () => {
		const details = v4(
			[obs({ id: "111111111111", relevance: "high" })],
			[refl("aaaaaaaaaaaa", "structured reflection")],
		);
		const snap = snapshotFromMemoryDetails(details);
		expect(snap?.observations).toHaveLength(1);
		expect(snap?.reflections).toHaveLength(1);
		expect(snap?.pendingObservations).toEqual([]);
	});

	test("converts V3 details with legacy string reflections", () => {
		const details = v3(
			[obs({ id: "222222222222", relevance: "low" })],
			["legacy reflection text"],
		);
		const snap = snapshotFromMemoryDetails(details);
		expect(snap?.reflections).toEqual(["legacy reflection text"]);
	});

	test("returns null for unsupported / malformed input", () => {
		expect(snapshotFromMemoryDetails(null)).toBeNull();
		expect(snapshotFromMemoryDetails({})).toBeNull();
		expect(
			snapshotFromMemoryDetails({ type: "observational-memory", version: 99 }),
		).toBeNull();
		expect(snapshotFromMemoryDetails("string")).toBeNull();
	});

	test("does not alias the input arrays (defensive copy)", () => {
		const observations = [obs({ id: "333333333333", relevance: "high" })];
		const details = v4(observations, []);
		const snap = snapshotFromMemoryDetails(details);
		expect(snap?.observations).not.toBe(observations);
	});
});

describe("exportFromSnapshot", () => {
	test("filters observations to high+critical by default", () => {
		const records = exportFromSnapshot({
			observations: [
				obs({ id: "lo", relevance: "low" }),
				obs({ id: "me", relevance: "medium" }),
				obs({ id: "hi", relevance: "high" }),
				obs({ id: "cr", relevance: "critical" }),
			],
			reflections: [],
			pendingObservations: [],
		});
		expect(records.map((r) => r.id).sort()).toEqual(["cr", "hi"]);
	});

	test("includes all reflections regardless of observation filter", () => {
		const supports = [id12("o1"), id12("o2")];
		const structuredId = id12("rrrr0001");
		const records = exportFromSnapshot({
			observations: [],
			reflections: [
				"legacy reflection",
				refl(structuredId, "structured reflection", supports),
			],
			pendingObservations: [],
		});
		expect(records).toHaveLength(2);
		const structured = records.find((r) => r.id === structuredId);
		expect(structured?.supportingObservationIds).toEqual(supports);
	});

	test("skips empty / whitespace reflections", () => {
		const records = exportFromSnapshot({
			observations: [],
			reflections: ["", "   ", refl(id12("e0"), "")],
			pendingObservations: [],
		});
		expect(records).toEqual([]);
	});

	test("exportAllObservations bypasses the filter", () => {
		const records = exportFromSnapshot(
			{
				observations: [obs({ id: "lo", relevance: "low" })],
				reflections: [],
				pendingObservations: [],
			},
			{ exportAllObservations: true },
		);
		expect(records).toHaveLength(1);
	});

	test("exportReflections=false suppresses reflections", () => {
		const records = exportFromSnapshot(
			{
				observations: [obs({ id: "hi", relevance: "high" })],
				reflections: ["should not appear"],
				pendingObservations: [],
			},
			{ exportReflections: false },
		);
		expect(records.map((r) => r.kind)).toEqual(["observation"]);
	});

	test("includePending opts in to pendingObservations", () => {
		const records = exportFromSnapshot(
			{
				observations: [obs({ id: "co", relevance: "high" })],
				reflections: [],
				pendingObservations: [obs({ id: "pe", relevance: "high" })],
			},
			{ includePending: true },
		);
		expect(records.map((r) => r.id).sort()).toEqual(["co", "pe"]);
	});

	test("preserves observation provenance fields on the bridge record", () => {
		const records = exportFromSnapshot({
			observations: [
				obs({
					id: id12("ffff0001"),
					relevance: "high",
					timestamp: "2026-05-08 04:30",
					sourceEntryIds: ["entry-1", "entry-2"],
				}),
			],
			reflections: [],
			pendingObservations: [],
		});
		expect(records[0]).toMatchObject<Partial<BridgeRecord>>({
			kind: "observation",
			id: id12("ffff0001"),
			relevance: "high",
			timestamp: "2026-05-08 04:30",
			sourceEntryIds: ["entry-1", "entry-2"],
		});
	});

	test("custom highSignalRelevance overrides default", () => {
		const records = exportFromSnapshot(
			{
				observations: [
					obs({ id: "lo", relevance: "low" }),
					obs({ id: "me", relevance: "medium" }),
					obs({ id: "hi", relevance: "high" }),
				],
				reflections: [],
				pendingObservations: [],
			},
			{ highSignalRelevance: new Set(["medium", "high"]) },
		);
		expect(records.map((r) => r.id).sort()).toEqual(["hi", "me"]);
	});
});

describe("exportFromMemoryDetails", () => {
	test("returns [] for unsupported input", () => {
		expect(exportFromMemoryDetails({})).toEqual([]);
		expect(exportFromMemoryDetails(null)).toEqual([]);
	});

	test("V4 input round-trips through default filter", () => {
		const records = exportFromMemoryDetails(
			v4(
				[
					obs({ id: id12("a1"), relevance: "high" }),
					obs({ id: id12("a2"), relevance: "low" }),
				],
				[refl(id12("r1"), "a reflection", [id12("a1")])],
			),
		);
		expect(records).toHaveLength(2);
		expect(records.map((r) => r.kind).sort()).toEqual(["observation", "reflection"]);
	});

	test("V3 reflections export with no id (legacy strings)", () => {
		const records = exportFromMemoryDetails(
			v3([obs({ id: id12("a1"), relevance: "high" })], ["legacy reflection text"]),
		);
		const legacy = records.find((r) => r.kind === "reflection");
		expect(legacy?.id).toBeUndefined();
		expect(legacy?.content).toBe("legacy reflection text");
	});
});

describe("getMemoryStateFromBranch", () => {
	test("returns empty snapshot when branch has no compaction entries", () => {
		const snap = getMemoryStateFromBranch([]);
		expect(snap.observations).toEqual([]);
		expect(snap.reflections).toEqual([]);
		expect(snap.pendingObservations).toEqual([]);
	});
});
