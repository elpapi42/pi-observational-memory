import { describe, expect, it } from "vitest";

import {
	compactionRangeStartIndex,
	observedTokensSinceLastCompaction,
	rawTokensSinceLastCompaction,
	unobservedSourceSpanBefore,
} from "../src/session-ledger/index.js";
import {
	compactionEntry,
	observation,
	observationsRecordedEntry,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
} from "./fixtures/session.js";

function coverage(id: string, coversUpToId: string) {
	return observationsRecordedEntry(id, { observations: [observation("aaaaaaaaaaaa")], coversUpToId });
}

describe("compaction range start", () => {
	it("starts at the branch root before any compaction", () => {
		expect(compactionRangeStartIndex([textCustomMessage("raw-1", "aaaa")])).toBe(0);
	});

	it("starts at the latest compaction's first kept entry", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-2" }),
			textCustomMessage("raw-2", "aaaa"),
			textCustomMessage("raw-3", "aaaa"),
		];

		expect(compactionRangeStartIndex(entries)).toBe(2);
		expect(rawTokensSinceLastCompaction(entries)).toBe(2);
	});

	it("starts after the compaction entry when its first kept id is missing", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			compactionEntry("cmp-1", { firstKeptEntryId: "gone" }),
			textCustomMessage("raw-2", "aaaa"),
		];

		expect(compactionRangeStartIndex(entries)).toBe(2);
		expect(rawTokensSinceLastCompaction(entries)).toBe(1);
	});
});

describe("observed tokens since the latest compaction", () => {
	it("is zero without observation coverage", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaaaaaa")];

		expect(observedTokensSinceLastCompaction(entries)).toBe(0);
	});

	it("counts only source tokens through the observation frontier", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaaaaaa"), // 3
			textCustomMessage("raw-2", "aaaaaaaa"), // 2
			coverage("om-1", "raw-1"),
			textCustomMessage("raw-3", "aaaa"), // 1
			reflectionsRecordedEntry("om-ref", { reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])], coversUpToId: "raw-3" }),
		];

		expect(observedTokensSinceLastCompaction(entries)).toBe(3);
		expect(rawTokensSinceLastCompaction(entries)).toBe(6);
	});

	it("ignores coverage that precedes the compaction boundary", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaaaaaa"),
			coverage("om-1", "raw-1"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-2" }),
			textCustomMessage("raw-2", "aaaaaaaa"),
		];

		expect(observedTokensSinceLastCompaction(entries)).toBe(0);
	});

	it("counts from the compaction boundary once coverage passes it", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaaaaaa"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-2" }),
			textCustomMessage("raw-2", "aaaaaaaa"), // 2
			textCustomMessage("raw-3", "aaaa"), // 1
			coverage("om-1", "raw-3"),
			textCustomMessage("raw-4", "aaaaaaaaaaaa"),
		];

		expect(observedTokensSinceLastCompaction(entries)).toBe(3);
	});
});

describe("unobserved source span before a cut", () => {
	const entries = [
		textCustomMessage("raw-1", "aaaaaaaaaaaa"), // 0
		coverage("om-1", "raw-1"), // 1
		textCustomMessage("raw-2", "aaaaaaaa"), // 2, 2 tokens
		textCustomMessage("raw-3", "aaaa"), // 3, 1 token
		textCustomMessage("raw-4", "aaaa"), // 4
	];

	it("is undefined when coverage reaches the cut", () => {
		expect(unobservedSourceSpanBefore(entries, 2)).toBeUndefined();
		expect(unobservedSourceSpanBefore(entries, 1)).toBeUndefined();
	});

	it("describes the source entries between the frontier and the cut", () => {
		expect(unobservedSourceSpanBefore(entries, 4)).toEqual({ firstIndex: 2, lastIndex: 3, entryCount: 2, tokens: 3 });
	});

	it("treats the whole range as unobserved without coverage", () => {
		const uncovered = [textCustomMessage("raw-1", "aaaa"), textCustomMessage("raw-2", "aaaa")];

		expect(unobservedSourceSpanBefore(uncovered, 2)).toEqual({ firstIndex: 0, lastIndex: 1, entryCount: 2, tokens: 2 });
	});

	it("does not look before the latest compaction boundary", () => {
		const compacted = [
			textCustomMessage("raw-1", "aaaa"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-2" }),
			textCustomMessage("raw-2", "aaaa"),
			textCustomMessage("raw-3", "aaaa"),
		];

		expect(unobservedSourceSpanBefore(compacted, 3)).toEqual({ firstIndex: 2, lastIndex: 2, entryCount: 1, tokens: 1 });
	});
});
