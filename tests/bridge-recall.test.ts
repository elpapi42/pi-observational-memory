/**
 * Cross-session recall via bridge surface (U5).
 *
 * Validates loadSessionEntries + recallSourcesFromSessionFile against
 * synthetic JSONL fixtures. The underlying recallMemorySources logic is
 * already exercised by branch-recall.test.ts; these tests focus on the
 * file-loading / unavailable-reason boundary and the public API the
 * pi-mem global_recall tool will call.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	loadSessionEntries,
	recallSourcesFromSessionFile,
} from "../src/bridge.js";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "om-bridge-recall-"));
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

function writeSession(name: string, lines: unknown[]): string {
	const path = join(tmpRoot, name);
	writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
	return path;
}

describe("loadSessionEntries", () => {
	test("returns null for non-existent file", () => {
		expect(loadSessionEntries(join(tmpRoot, "missing.jsonl"))).toBeNull();
	});

	test("returns null for empty path", () => {
		expect(loadSessionEntries("")).toBeNull();
	});

	test("parses JSONL into Entry[]", () => {
		const path = writeSession("a.jsonl", [
			{ type: "message", id: "m1", message: { role: "user", content: "hi" } },
			{ type: "message", id: "m2", message: { role: "assistant", content: "hello" } },
		]);
		const entries = loadSessionEntries(path);
		expect(entries).not.toBeNull();
		expect(entries).toHaveLength(2);
		expect(entries?.[0]?.id).toBe("m1");
	});

	test("skips malformed lines and entries missing required fields", () => {
		const path = writeSession("b.jsonl", [
			{ type: "message", id: "m1" },
			{ no_type: true, id: "m2" }, // missing 'type'
		]);
		// append a non-JSON line
		const fs = require("node:fs") as typeof import("node:fs");
		fs.appendFileSync(path, "\nnot-json\n{\"type\":\"message\",\"id\":\"m3\"}\n");
		const entries = loadSessionEntries(path);
		const ids = entries?.map((e) => e.id) ?? [];
		expect(ids).toEqual(["m1", "m3"]);
	});

	test("handles trailing/blank lines gracefully", () => {
		const path = join(tmpRoot, "c.jsonl");
		writeFileSync(path, "\n\n\n");
		const entries = loadSessionEntries(path);
		expect(entries).toEqual([]);
	});
});

describe("recallSourcesFromSessionFile", () => {
	test("reports missing-session-file when path does not exist", () => {
		const result = recallSourcesFromSessionFile(
			join(tmpRoot, "no-such-file.jsonl"),
			"a".repeat(12),
		);
		expect(result.unavailableReason).toBe("missing-session-file");
		expect(result.recall).toBeNull();
	});

	test("reports missing-session-file when path is empty", () => {
		const result = recallSourcesFromSessionFile("", "a".repeat(12));
		expect(result.unavailableReason).toBe("missing-session-file");
	});

	test("reports empty-session-file when file is empty", () => {
		const path = join(tmpRoot, "empty.jsonl");
		writeFileSync(path, "");
		const result = recallSourcesFromSessionFile(path, "a".repeat(12));
		expect(result.unavailableReason).toBe("empty-session-file");
	});

	test("returns recall result with no matches when memory id is unknown", () => {
		const path = writeSession("e.jsonl", [
			{ type: "message", id: "m1" },
			{ type: "message", id: "m2" },
		]);
		const result = recallSourcesFromSessionFile(path, "f".repeat(12));
		expect(result.unavailableReason).toBeUndefined();
		expect(result.recall).not.toBeNull();
	});
});
