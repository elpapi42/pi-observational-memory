import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { EMPTY_STATE, isTomDetails, loadState, observationsTokenTotal, serializeState, TOM_MARKER } from "../src/state.js";

function fakeCompactionEntry(details: unknown): SessionEntry {
	return {
		type: "compaction",
		id: "c1",
		parentId: "p1",
		timestamp: new Date().toISOString(),
		summary: "",
		firstKeptEntryId: "k1",
		tokensBefore: 0,
		details,
	} as unknown as SessionEntry;
}

describe("state serialization & loading", () => {
	it("round-trips through serializeState/loadState", () => {
		const base = {
			version: 1 as const,
			reflections: "R",
			observations: [{ id: "x", text: "t", tokenCount: 1, priority: "med" as const, createdAt: 1 }],
		};
		const serialized = serializeState(base);
		expect(isTomDetails(serialized)).toBe(true);
		const entries: SessionEntry[] = [fakeCompactionEntry(serialized)];
		const loaded = loadState(entries);
		expect(loaded.reflections).toBe("R");
		expect(loaded.observations).toHaveLength(1);
	});

	it("returns EMPTY_STATE when no TOM entry is present", () => {
		expect(loadState([])).toEqual(EMPTY_STATE);
	});

	it("ignores non-TOM compaction entries (foreign details shape)", () => {
		const entries: SessionEntry[] = [fakeCompactionEntry({ readFiles: [], modifiedFiles: [] })];
		expect(loadState(entries)).toEqual(EMPTY_STATE);
	});

	it("picks the latest TOM entry", () => {
		const older = serializeState({ version: 1, reflections: "old", observations: [] });
		const newer = serializeState({ version: 1, reflections: "new", observations: [] });
		const loaded = loadState([fakeCompactionEntry(older), fakeCompactionEntry(newer)]);
		expect(loaded.reflections).toBe("new");
	});

	it("observationsTokenTotal sums tokenCount", () => {
		const s = {
			version: 1 as const,
			reflections: "",
			observations: [
				{ id: "a", text: "", tokenCount: 10, priority: "med" as const, createdAt: 0 },
				{ id: "b", text: "", tokenCount: 25, priority: "low" as const, createdAt: 0 },
			],
		};
		expect(observationsTokenTotal(s)).toBe(35);
	});

	it("TOM_MARKER is stable", () => {
		expect(TOM_MARKER).toBe("tom-v1");
	});
});
