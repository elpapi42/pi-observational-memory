import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => "/unused" }));

import { SessionEmbeddings, type Embedder } from "../src/embeddings.js";
import {
	buildSearchCorpus,
	fuseScores,
	OM_EMBEDDINGS_INDEXED,
	rankLexical,
	topHits,
	type EmbeddingsIndexedEntryData,
} from "../src/session-ledger/index.js";
import { compactionEntry, rawMessage, type TestEntry } from "./fixtures/session.js";

const config = { enabled: true, model: "fake", pooling: "cls" as const, queryPrefix: "" };

// Two-dimensional "meaning": texts about storage point one way, everything else the other.
const fakeEmbedder: Embedder = {
	embed: async (texts) => texts.map((text) => /database|sqlite|storage/i.test(text) ? Float32Array.of(1, 0) : Float32Array.of(0, 1)),
};

describe("recall embeddings", () => {
	const dirs: string[] = [];
	afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

	const entries = [
		rawMessage("aaaa0001", "We picked sqlite because the tool runs offline."),
		rawMessage("aaaa0002", "Renamed the button label."),
		rawMessage("aaaa0003", "Recent turn."),
		compactionEntry("cmp-1", { firstKeptEntryId: "aaaa0003" }),
	];

	it("indexes in the background, persists vectors, and scores only embedded documents", async () => {
		const dir = mkdtempSync(join(tmpdir(), "om-emb-"));
		dirs.push(dir);
		const load = vi.fn(async () => fakeEmbedder);
		const embeddings = new SessionEmbeddings(() => config, load, () => dir);
		const docs = buildSearchCorpus(entries);

		expect(await embeddings.vectorScores("s1", docs, "database choice")).toEqual([undefined, undefined]);
		await embeddings.scheduleIndex("s1", entries);

		const reloaded = new SessionEmbeddings(() => config, async () => fakeEmbedder, () => dir);
		expect(await reloaded.vectorScores("s1", docs, "database choice")).toEqual([1, 0]);

		const failing = new SessionEmbeddings(() => config, async () => { throw new Error("no runtime"); }, () => dir);
		await failing.scheduleIndex("s2", entries);
		expect(failing.failure).toBe("no runtime");
		expect(await failing.vectorScores("s1", docs, "database choice")).toBeUndefined();
	});

	// A branch that records runs the way the extension does: appended to its end.
	function recordingBranch(initial: TestEntry[]) {
		const branch = [...initial];
		let n = 0;
		const record = vi.fn((data: EmbeddingsIndexedEntryData) => {
			branch.push({ type: "custom", id: `idx-${++n}`, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", customType: OM_EMBEDDINGS_INDEXED, data });
		});
		return { branch, record };
	}

	it("indexes incrementally from the cursor recorded on the branch", async () => {
		const dir = mkdtempSync(join(tmpdir(), "om-emb-"));
		dirs.push(dir);
		const embedder = { embed: vi.fn(fakeEmbedder.embed) };
		const { branch, record } = recordingBranch(entries);
		const embeddings = new SessionEmbeddings(() => config, async () => embedder, () => dir, record);

		// Compacted and never indexed: left to an explicit full run.
		expect(embeddings.scheduleIncrementalIndex("s1", branch)).toBeUndefined();
		expect(await embeddings.scheduleIndex("s1", branch)).toBe("complete");
		expect(embedder.embed).toHaveBeenCalledTimes(1);

		branch.push(rawMessage("aaaa0004", "Newer turn."), compactionEntry("cmp-2", { firstKeptEntryId: "aaaa0004" }));
		expect(await embeddings.scheduleIncrementalIndex("s1", branch)).toBe("complete");
		expect(embedder.embed).toHaveBeenLastCalledWith([expect.stringContaining("Recent turn.")]);

		// The cursor lives in the session, so a restart continues from where the last run stopped.
		const reloaded = new SessionEmbeddings(() => config, async () => embedder, () => dir, record);
		expect(await reloaded.scheduleIncrementalIndex("s1", branch)).toBe("complete");
		expect(embedder.embed).toHaveBeenCalledTimes(2);
	});

	it("follows tree navigation: each branch indexes from its own cursor", async () => {
		const dir = mkdtempSync(join(tmpdir(), "om-emb-"));
		dirs.push(dir);
		const embedder = { embed: vi.fn(fakeEmbedder.embed) };
		const { branch: main, record } = recordingBranch(entries);
		const embeddings = new SessionEmbeddings(() => config, async () => embedder, () => dir, record);
		await embeddings.scheduleIndex("s1", main);

		// A branch forked before the first run has no cursor, even though the store has vectors.
		const fork = [...entries.slice(0, 3), rawMessage("bbbb0001", "Forked turn."), compactionEntry("cmp-f", { firstKeptEntryId: "bbbb0001" })];
		expect(embeddings.scheduleIncrementalIndex("s1", fork)).toBeUndefined();
		expect(embeddings.status("s1", fork)).toMatchObject({ state: "absent", autoBuild: false, documents: 2 });

		// A branch forked after it inherits the cursor and embeds only what it added.
		const later = [...main, rawMessage("bbbb0002", "Later fork."), compactionEntry("cmp-g", { firstKeptEntryId: "bbbb0002" })];
		expect(await embeddings.scheduleIncrementalIndex("s1", later)).toBe("complete");
		expect(embedder.embed).toHaveBeenLastCalledWith([expect.stringContaining("Recent turn.")]);

		// A record whose cursor is off the branch (the run ended after navigating away) falls back to an earlier one.
		const stray = [...main, { ...main.at(-1)!, id: "idx-stray", data: { ...(main.at(-1) as any).data, throughEntryId: "gone" } }];
		expect(await embeddings.scheduleIncrementalIndex("s1", stray)).toBe("complete");
	});

	it("counts vectors off the branch as orphaned, and a full run prunes them", async () => {
		const dir = mkdtempSync(join(tmpdir(), "om-emb-"));
		dirs.push(dir);
		const { branch: main, record } = recordingBranch([
			...entries.slice(0, 2),
			rawMessage("bbbb0001", "Abandoned future."),
			entries[2],
			compactionEntry("cmp-1", { firstKeptEntryId: "aaaa0003" }),
		]);
		const embeddings = new SessionEmbeddings(() => config, async () => fakeEmbedder, () => dir, record);
		await embeddings.scheduleIndex("s1", main);
		expect(embeddings.status("s1", main)).toMatchObject({ documents: 3, orphaned: 0 });

		// A branch without bbbb0001: its vector stays in the store but belongs to no entry here.
		const { branch: back, record: recordBack } = recordingBranch([...entries.slice(0, 3), compactionEntry("cmp-2", { firstKeptEntryId: "aaaa0003" })]);
		expect(embeddings.status("s1", back)).toMatchObject({ state: "absent", documents: 3, orphaned: 1 });

		const pruning = new SessionEmbeddings(() => config, async () => fakeEmbedder, () => dir, recordBack);
		const progress: Array<{ pruned: number }> = [];
		expect(await pruning.scheduleIndex("s1", back, { onProgress: (p) => progress.push(p) })).toBe("complete");
		expect(progress[0]).toMatchObject({ pruned: 1 });
		expect(recordBack).toHaveBeenLastCalledWith(expect.objectContaining({ documents: 2, pruned: 1 }));
		const reloaded = new SessionEmbeddings(() => config, async () => fakeEmbedder, () => dir, recordBack);
		expect(reloaded.status("s1", back)).toMatchObject({ state: "present", documents: 2, orphaned: 0 });

		// Back on the first branch, the pruned vector sits before its cursor: settles skip it, status reports it.
		expect(await reloaded.scheduleIncrementalIndex("s1", main)).toBe("complete");
		expect(reloaded.status("s1", main)).toMatchObject({ state: "present", missing: 1 });
	});

	it("builds the index on settle for a branch nothing has compacted yet", async () => {
		const dir = mkdtempSync(join(tmpdir(), "om-emb-"));
		dirs.push(dir);
		const embedder = { embed: vi.fn(fakeEmbedder.embed) };
		const { branch, record } = recordingBranch([rawMessage("aaaa0001", "First turn.")]);
		const embeddings = new SessionEmbeddings(() => config, async () => embedder, () => dir, record);

		expect(await embeddings.scheduleIncrementalIndex("s1", branch)).toBe("complete");
		expect(embedder.embed).not.toHaveBeenCalled();
		expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "auto", embedded: 0, throughEntryId: "aaaa0001" }));

		// The empty run recorded a cursor, so the first compaction is picked up incrementally.
		branch.push(rawMessage("aaaa0002", "Second turn."), compactionEntry("cmp-1", { firstKeptEntryId: "aaaa0002" }));
		expect(await embeddings.scheduleIncrementalIndex("s1", branch)).toBe("complete");
		expect(embedder.embed).toHaveBeenLastCalledWith([expect.stringContaining("First turn.")]);
	});

	it("reports index state for status", async () => {
		const dir = mkdtempSync(join(tmpdir(), "om-emb-"));
		dirs.push(dir);
		const { branch, record } = recordingBranch(entries);
		const embeddings = new SessionEmbeddings(() => config, async () => fakeEmbedder, () => dir, record);

		expect(embeddings.status("s1", branch)).toEqual({ state: "absent", autoBuild: false, documents: 0, orphaned: 0, indexing: false });
		await embeddings.scheduleIndex("s1", branch);
		expect(embeddings.status("s1", branch)).toEqual({ state: "present", documents: 2, orphaned: 0, missing: 0, pending: 0, recentEmbedded: 2, recentTotal: 2, indexing: false });
		expect(new SessionEmbeddings(() => ({ ...config, enabled: false })).status("s1", branch)).toBeUndefined();
	});

	it("records finished runs, skipping settles that found nothing to embed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "om-emb-"));
		dirs.push(dir);
		const { branch, record } = recordingBranch(entries);
		const embeddings = new SessionEmbeddings(() => config, async () => fakeEmbedder, () => dir, record);

		await embeddings.scheduleIndex("s1", branch);
		expect(record).toHaveBeenLastCalledWith({
			mode: "full", outcome: "complete", model: "fake", embedded: 2, pending: 0, documents: 2, throughEntryId: "cmp-1",
		});

		branch.push(rawMessage("aaaa0004", "Newer turn."));
		await embeddings.scheduleIncrementalIndex("s1", branch);
		expect(record).toHaveBeenCalledTimes(1);

		await embeddings.scheduleIndex("s1", branch);
		expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "full", embedded: 0, pending: 0, throughEntryId: "aaaa0004" }));

		const failing = new SessionEmbeddings(() => config, async () => ({ embed: async () => { throw new Error("oom"); } }), () => dir, record);
		await failing.scheduleIndex("s2", entries);
		expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "full", outcome: "failed", embedded: 0, pending: 2, failure: "oom" }));
	});

	it("stops a full run on abort without recording a cursor", async () => {
		const dir = mkdtempSync(join(tmpdir(), "om-emb-"));
		dirs.push(dir);
		const controller = new AbortController();
		controller.abort();
		const { branch, record } = recordingBranch(entries);
		const embeddings = new SessionEmbeddings(() => config, async () => fakeEmbedder, () => dir, record);
		const progress: Array<{ done: number; total: number }> = [];

		expect(await embeddings.scheduleIndex("s1", branch, { signal: controller.signal, onProgress: (p) => progress.push(p) })).toBe("aborted");
		expect(progress).toEqual([{ done: 0, total: 2, pruned: 0 }]);
		expect(record).toHaveBeenLastCalledWith(expect.not.objectContaining({ throughEntryId: expect.anything() }));
		expect(embeddings.scheduleIncrementalIndex("s1", branch)).toBeUndefined();
	});

	// An uncompacted branch indexed once, so its first compaction is picked up incrementally.
	async function compactedBacklog(dir: string, embedder: Embedder, count: number) {
		const messages = Array.from({ length: count }, (_, i) => rawMessage(`cccc${String(i).padStart(4, "0")}`, `Turn ${i}.`));
		const { branch, record } = recordingBranch([...messages, rawMessage("cccc9999", "Kept turn.")]);
		const embeddings = new SessionEmbeddings(() => config, async () => embedder, () => dir, record);
		expect(await embeddings.scheduleIncrementalIndex("s1", branch)).toBe("complete");
		branch.push(compactionEntry("cmp-1", { firstKeptEntryId: "cccc9999" }));
		record.mockClear();
		return { branch, record, embeddings };
	}

	it("spreads a backlog over budgeted runs, recording only the one that completes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "om-emb-"));
		dirs.push(dir);
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		// Each batch of 16 takes 600ms, so a 1s budget fits two.
		const embedder = { embed: vi.fn(async (texts: string[]) => { now += 600; return fakeEmbedder.embed(texts); }) };
		const { branch, record, embeddings } = await compactedBacklog(dir, embedder, 40);

		expect(await embeddings.scheduleIncrementalIndex("s1", branch, { budgetMs: 1_000 })).toBe("aborted");
		expect(embedder.embed).toHaveBeenCalledTimes(2);
		expect(record).not.toHaveBeenCalled();
		expect(embeddings.status("s1", branch)).toMatchObject({ state: "present", documents: 32, missing: 0, pending: 8 });
		// A budget stop leaves the vectors in memory rather than rewriting the store every turn.
		expect(new SessionEmbeddings(() => config, async () => embedder, () => dir).status("s1", branch)).toMatchObject({ documents: 0 });

		expect(await embeddings.scheduleIncrementalIndex("s1", branch, { budgetMs: 1_000 })).toBe("complete");
		expect(embedder.embed).toHaveBeenCalledTimes(3);
		expect(record).toHaveBeenCalledTimes(1);
		expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "incremental", outcome: "complete", embedded: 8, throughEntryId: "cmp-1" }));
		expect(new SessionEmbeddings(() => config, async () => embedder, () => dir).status("s1", branch)).toMatchObject({ documents: 40 });
		vi.restoreAllMocks();
	});

	it("catches up before a query by stopping the run in flight and embedding the rest", async () => {
		const dir = mkdtempSync(join(tmpdir(), "om-emb-"));
		dirs.push(dir);
		const embedder = { embed: vi.fn(async (texts: string[]) => { await new Promise((resolve) => setTimeout(resolve, 1)); return fakeEmbedder.embed(texts); }) };
		const { branch, record, embeddings } = await compactedBacklog(dir, embedder, 40);

		const background = embeddings.scheduleIncrementalIndex("s1", branch);
		const progress: Array<{ done: number; total: number }> = [];
		await embeddings.catchUp("s1", branch, { onProgress: (p) => progress.push(p) });
		expect(await background).toBe("aborted");
		expect(embeddings.isIndexing).toBe(false);
		expect(embeddings.status("s1", branch)).toMatchObject({ documents: 40, pending: 0 });
		expect(progress.at(-1)).toMatchObject({ done: progress.at(-1)!.total });
		expect(record).toHaveBeenCalledTimes(1);
		expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "complete", throughEntryId: "cmp-1" }));

		// A compacted branch that was never indexed stays with /om:index.
		const idle = new SessionEmbeddings(() => config, async () => embedder, () => dir);
		embedder.embed.mockClear();
		await idle.catchUp("s2", entries);
		expect(embedder.embed).not.toHaveBeenCalled();
	});

	it("surfaces semantic matches that share no keywords with the query", () => {
		const docs = buildSearchCorpus(entries);
		const lexical = rankLexical(docs, "database choice");
		expect(topHits(docs, lexical, 8)).toEqual([]);

		const hits = topHits(docs, fuseScores(lexical, [1, 0]), 8);
		expect(hits[0]).toMatchObject({ id: "aaaa0001" });
	});
});
