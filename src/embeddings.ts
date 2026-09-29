import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { RecallEmbeddingsConfig } from "./config.js";
import { safeDebugLogSessionId } from "./debug-log.js";
import {
	buildSearchCorpus,
	entryIndexById,
	findLastCompactionIndex,
	isEmbeddingsIndexedEntry,
	isObservationsRecordedEntry,
	isReflectionsRecordedEntry,
	type EmbeddingsIndexedEntryData,
	type Entry,
	type SearchDocument,
} from "./session-ledger/index.js";

export const EMBEDDINGS_RELATIVE_DIR = join("observational-memory", "embeddings");
export const MODELS_RELATIVE_DIR = join("observational-memory", "models");

const BATCH_SIZE = 16;
/** Persist partial progress so an exit mid-index keeps most of the work. */
const SAVE_EVERY_BATCHES = 20;

/** `pruned` counts orphaned vectors a full run removed before embedding. */
export type IndexProgress = { done: number; total: number; pruned: number };
/**
 * `budgetMs` bounds a run's embedding time, checked between batches; a run that hits it ends
 * `aborted` and leaves the rest for the next one.
 */
export type IndexOptions = { signal?: AbortSignal; onProgress?: (progress: IndexProgress) => void; budgetMs?: number };
/** How a run ended: every document embedded, stopped early, or failed (the reason is in `failure`). */
export type IndexOutcome = "complete" | "aborted" | "failed";

export type IndexStatus =
	| { state: "failed"; failure: string }
	/**
	 * No completed run on this branch; `autoBuild` when nothing is compacted, so the next settle
	 * builds one. `documents` counts vectors other branches of the session already embedded.
	 */
	| { state: "absent"; autoBuild: boolean; documents: number; orphaned: number; indexing: boolean }
	/**
	 * `orphaned` counts vectors whose entry or memory is not on this branch; /om:index prunes them.
	 * `missing` counts branch documents without a vector, which settles do not reach when they
	 * precede the cursor (pruned by /om:index on another branch); /om:index re-embeds them.
	 * `pending` counts those past the cursor, which later runs or the next recall query embed.
	 */
	| { state: "present"; documents: number; orphaned: number; missing: number; pending: number; recentEmbedded: number; recentTotal: number; indexing: boolean };

type RunSummary = { embedded: number; missing: number; pruned: number; through?: string };

/**
 * Whether a stored vector belongs to this branch: its entry or memory id is on it. A transcript
 * entry still visible here counts too, since a compaction on this branch will hide it.
 */
function onBranch(entries: Entry[]): (key: string) => boolean {
	const ids = new Set<string>();
	for (const entry of entries) {
		ids.add(entry.id);
		if (isObservationsRecordedEntry(entry)) entry.data.observations.forEach((observation) => ids.add(observation.id));
		else if (isReflectionsRecordedEntry(entry)) entry.data.reflections.forEach((reflection) => ids.add(reflection.id));
	}
	return (key) => ids.has(key.split(":")[1] ?? "");
}

/**
 * Branch index of the entry the latest completed run on this branch embedded through, or -1.
 * The cursor lives on the branch rather than in the store, which every branch of a session
 * shares, so tree navigation lands on the cursor of the branch it lands on. A run that ended
 * after navigating away records a cursor from the other branch; earlier runs stand in for it.
 */
function branchCursor(entries: Entry[]): number {
	const indexById = entryIndexById(entries);
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!isEmbeddingsIndexedEntry(entry) || entry.data.outcome !== "complete" || !entry.data.throughEntryId) continue;
		const cursor = indexById.get(entry.data.throughEntryId);
		if (cursor !== undefined) return cursor;
	}
	return -1;
}

export type Embedder = { embed(texts: string[]): Promise<Float32Array[]> };
export type EmbedderLoader = (config: RecallEmbeddingsConfig) => Promise<Embedder>;

type WorkerReply = { ready: boolean; error?: string } | { id: number; vectors?: Float32Array[]; error?: string };

/**
 * Runs the model in a worker thread (`embedder-worker.mjs`). Inference blocks the thread that
 * runs it for the whole batch, so on the main thread every batch froze Pi's TUI.
 */
export const loadTransformersEmbedder: EmbedderLoader = (config) => new Promise((resolve, reject) => {
	const worker = new Worker(new URL("./embedder-worker.mjs", import.meta.url), {
		workerData: { model: config.model, pooling: config.pooling, cacheDir: join(getAgentDir(), MODELS_RELATIVE_DIR) },
	});
	const pending = new Map<number, { resolve: (vectors: Float32Array[]) => void; reject: (error: Error) => void }>();
	let nextId = 0;
	let dead: Error | undefined;
	// Pending work keeps the process alive; an idle embedder must not keep Pi from exiting.
	const settleRef = () => (pending.size === 0 ? worker.unref() : worker.ref());
	const fail = (error: Error) => {
		dead ??= error;
		reject(dead);
		pending.forEach((call) => call.reject(dead!));
		pending.clear();
	};
	worker.on("error", fail);
	worker.on("exit", (code) => fail(new Error(`embedding worker exited with code ${code}`)));
	worker.on("message", (reply: WorkerReply) => {
		if ("ready" in reply) {
			if (!reply.ready) {
				fail(new Error(reply.error ?? "embedding worker failed to load"));
				void worker.terminate();
				return;
			}
			resolve({
				embed: (texts) => new Promise((resolveEmbed, rejectEmbed) => {
					if (dead) return rejectEmbed(dead);
					const id = nextId++;
					pending.set(id, { resolve: resolveEmbed, reject: rejectEmbed });
					settleRef();
					worker.postMessage({ id, texts });
				}),
			});
			settleRef();
			return;
		}
		const call = pending.get(reply.id);
		pending.delete(reply.id);
		settleRef();
		if (reply.vectors) call?.resolve(reply.vectors);
		else call?.reject(new Error(reply.error ?? "embedding failed"));
	});
});

export function docKey(doc: SearchDocument): string {
	return doc.kind === "entry" ? `entry:${doc.id}:${doc.chunk}` : `${doc.kind}:${doc.id}`;
}

/** Normalized vectors keyed by document, persisted as a JSON header plus a flat Float32 file. */
class VectorStore {
	private readonly index = new Map<string, number>();
	private keys: string[] = [];
	private vectors: Float32Array[] = [];
	dims = 0;
	/** Vectors added since the last save. */
	unsaved = 0;

	constructor(private readonly basePath: string, private readonly model: string) {
		try {
			const header = JSON.parse(readFileSync(`${basePath}.json`, "utf-8")) as { model?: unknown; dims?: unknown; keys?: unknown };
			if (header.model !== model || typeof header.dims !== "number" || !Array.isArray(header.keys)) return;
			const buffer = readFileSync(`${basePath}.f32`);
			const flat = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
			if (flat.length !== header.keys.length * header.dims) return;
			this.dims = header.dims;
			header.keys.forEach((key, i) => this.add(String(key), flat.slice(i * this.dims, (i + 1) * this.dims)));
			this.unsaved = 0;
		} catch {
			// Missing or unreadable stores rebuild from scratch.
		}
	}

	get size(): number {
		return this.keys.length;
	}

	has(key: string): boolean {
		return this.index.has(key);
	}

	get(key: string): Float32Array | undefined {
		const i = this.index.get(key);
		return i === undefined ? undefined : this.vectors[i];
	}

	get allKeys(): readonly string[] {
		return this.keys;
	}

	/** Drop every vector whose key fails `keep`; returns how many were dropped. */
	prune(keep: (key: string) => boolean): number {
		const keys = this.keys;
		const vectors = this.vectors;
		this.index.clear();
		this.keys = [];
		this.vectors = [];
		keys.forEach((key, i) => keep(key) && this.add(key, vectors[i]));
		return keys.length - this.keys.length;
	}

	add(key: string, vector: Float32Array): void {
		if (this.index.has(key)) return;
		this.dims = vector.length;
		this.index.set(key, this.keys.length);
		this.keys.push(key);
		this.vectors.push(vector);
		this.unsaved++;
	}

	save(): void {
		const dir = join(this.basePath, "..");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const flat = new Float32Array(this.keys.length * this.dims);
		this.vectors.forEach((vector, i) => flat.set(vector, i * this.dims));
		writeFileSync(`${this.basePath}.f32.tmp`, Buffer.from(flat.buffer));
		writeFileSync(`${this.basePath}.json.tmp`, JSON.stringify({ model: this.model, dims: this.dims, keys: this.keys }));
		renameSync(`${this.basePath}.f32.tmp`, `${this.basePath}.f32`);
		renameSync(`${this.basePath}.json.tmp`, `${this.basePath}.json`);
		this.unsaved = 0;
	}
}

function dot(a: Float32Array, b: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
	return sum;
}

/**
 * Per-session semantic index for recall. Indexing runs in the background and
 * queries score only documents already embedded, so search never waits on it.
 */
export class SessionEmbeddings {
	private embedder: Promise<Embedder> | undefined;
	private store: { sessionId: string; store: VectorStore } | undefined;
	private indexing: Promise<IndexOutcome> | undefined;
	/** Stops the incremental run in flight; full runs stop only through their own signal. */
	private incremental: AbortController | undefined;
	failure: string | undefined;
	failureNotified = false;

	constructor(
		private readonly getConfig: () => RecallEmbeddingsConfig,
		private readonly loadEmbedder: EmbedderLoader = loadTransformersEmbedder,
		private readonly baseDir: () => string = () => join(getAgentDir(), EMBEDDINGS_RELATIVE_DIR),
		/**
		 * Records a run on the current branch when it ends in the session that started it, except
		 * settle runs that found nothing to embed. Incremental runs read their cursor back from these records.
		 */
		private readonly onRunEnd?: (data: EmbeddingsIndexedEntryData) => void,
	) {}

	private enabled(): boolean {
		return this.getConfig().enabled && this.failure === undefined;
	}

	private getEmbedder(): Promise<Embedder> {
		this.embedder ??= this.loadEmbedder(this.getConfig()).catch((error: unknown) => {
			this.failure = error instanceof Error ? error.message : String(error);
			throw error;
		});
		return this.embedder;
	}

	private storeFor(sessionId: string): VectorStore {
		if (this.store?.sessionId !== sessionId) {
			const safe = safeDebugLogSessionId(sessionId) ?? "unknown-session";
			this.store = { sessionId, store: new VectorStore(join(this.baseDir(), safe), this.getConfig().model) };
		}
		return this.store.store;
	}

	get isIndexing(): boolean {
		return this.indexing !== undefined;
	}

	/**
	 * Embed every document on the branch that has no vector yet. Builds the index
	 * from scratch for a session without one; a no-op while a run is active.
	 */
	scheduleIndex(sessionId: string, entries: Entry[], options: IndexOptions = {}): Promise<IndexOutcome> | undefined {
		if (!this.enabled() || this.indexing) return this.indexing;
		return this.run(sessionId, "full", (summary) => {
			// Only an explicit full run prunes: navigating back to a pruned branch needs another one to re-embed it.
			summary.pruned = this.storeFor(sessionId).prune(onBranch(entries));
			return this.index(sessionId, entries, buildSearchCorpus(entries), summary, options);
		});
	}

	/**
	 * Embed only what the branch added since the last run on it. A branch without
	 * a run gets its index built only while nothing is compacted: until then its
	 * corpus is memory alone, which is small. Past that, building it is a full pass
	 * over the session, which is left to an explicit request.
	 *
	 * Runs cut short by a budget or `stopIncremental` keep their vectors, and the
	 * next run picks up what they skipped, since the cursor advances only on completion.
	 */
	scheduleIncrementalIndex(sessionId: string, entries: Entry[], options: IndexOptions = {}): Promise<IndexOutcome> | undefined {
		if (!this.enabled() || this.indexing) return this.indexing;
		const cursor = branchCursor(entries);
		if (cursor === -1 && findLastCompactionIndex(entries) !== -1) return undefined;
		const controller = new AbortController();
		this.incremental = controller;
		const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
		const docs = buildSearchCorpus(entries, cursor + 1);
		const run = this.run(sessionId, cursor === -1 ? "auto" : "incremental", (summary) => this.index(sessionId, entries, docs, summary, { ...options, signal }));
		void run.finally(() => {
			if (this.incremental === controller) this.incremental = undefined;
		});
		return run;
	}

	/** Stop the incremental run in flight after its current batch. */
	stopIncremental(): void {
		this.incremental?.abort();
	}

	/** Resolves once no run is in flight. */
	async whenIdle(): Promise<void> {
		while (this.indexing) await this.indexing;
	}

	/**
	 * Embed everything past the branch's cursor before a query scores it. An incremental
	 * run in flight is stopped and its remainder folded into this one; a full run is awaited.
	 */
	async catchUp(sessionId: string, entries: Entry[], options: IndexOptions = {}): Promise<void> {
		this.stopIncremental();
		await this.whenIdle();
		await this.scheduleIncrementalIndex(sessionId, entries, options);
	}

	private run(sessionId: string, mode: EmbeddingsIndexedEntryData["mode"], work: (summary: RunSummary) => Promise<IndexOutcome>): Promise<IndexOutcome> {
		const summary: RunSummary = { embedded: 0, missing: 0, pruned: 0 };
		let failure: string | undefined;
		const indexing = work(summary)
			.catch((error: unknown) => {
				failure = error instanceof Error ? error.message : String(error);
				return "failed" as const;
			})
			.then((outcome) => {
				this.recordRun(sessionId, mode, outcome, summary, failure);
				return outcome;
			})
			.finally(() => { this.indexing = undefined; });
		this.indexing = indexing;
		return indexing;
	}

	private recordRun(sessionId: string, mode: EmbeddingsIndexedEntryData["mode"], outcome: IndexOutcome, summary: RunSummary, failure: string | undefined): void {
		// The entry lands on whichever session is current; a run abandoned by a switch has none to land on.
		if (!this.onRunEnd || this.store?.sessionId !== sessionId) return;
		// Background runs happen every turn; one that stopped short or found nothing would only grow
		// the session. The cursor it would record lags instead, and the next run re-reads a range
		// whose embedded part it skips. A completed auto run is recorded regardless: its entry is
		// what makes later runs incremental.
		if (mode !== "full" && outcome === "aborted") return;
		if (mode === "incremental" && outcome === "complete" && summary.missing === 0) return;
		const store = this.store.store;
		try {
			this.onRunEnd({
				mode,
				outcome,
				model: this.getConfig().model,
				embedded: summary.embedded,
				pending: summary.missing - summary.embedded,
				documents: store.size,
				...(summary.pruned > 0 ? { pruned: summary.pruned } : {}),
				...(outcome === "complete" && summary.through ? { throughEntryId: summary.through } : {}),
				...(failure ? { failure } : {}),
			});
		} catch {
			// Recording is bookkeeping; a failed append leaves the index itself intact.
		}
	}

	private async index(sessionId: string, entries: Entry[], docs: SearchDocument[], summary: RunSummary, options: IndexOptions): Promise<IndexOutcome> {
		const store = this.storeFor(sessionId);
		const missing = docs.filter((doc) => !store.has(docKey(doc)));
		summary.missing = missing.length;
		options.onProgress?.({ done: 0, total: missing.length, pruned: summary.pruned });
		if (missing.length === 0) {
			summary.through = entries.at(-1)?.id;
			if (summary.pruned > 0) store.save();
			return "complete";
		}
		const embedder = await this.getEmbedder();
		// The budget starts once the model is loaded, so the first run still embeds a batch.
		const deadline = options.budgetMs === undefined ? Infinity : Date.now() + options.budgetMs;
		let outcome: IndexOutcome = "complete";
		for (let start = 0; start < missing.length; start += BATCH_SIZE) {
			// A session switch mid-run abandons the old session's remaining work.
			if (this.store?.sessionId !== sessionId || options.signal?.aborted || Date.now() >= deadline) {
				outcome = "aborted";
				break;
			}
			const docs = missing.slice(start, start + BATCH_SIZE);
			const vectors = await embedder.embed(docs.map((doc) => doc.text));
			docs.forEach((doc, i) => store.add(docKey(doc), vectors[i]));
			summary.embedded += docs.length;
			options.onProgress?.({ done: Math.min(start + BATCH_SIZE, missing.length), total: missing.length, pruned: summary.pruned });
			if (store.unsaved >= SAVE_EVERY_BATCHES * BATCH_SIZE) store.save();
		}
		// An interrupted run keeps its vectors but not the cursor: what it skipped is still missing.
		if (outcome === "complete") summary.through = entries.at(-1)?.id;
		// Budgeted runs stop every turn; saving each would rewrite the whole store that often.
		if (options.budgetMs === undefined || outcome === "complete" || store.unsaved >= SAVE_EVERY_BATCHES * BATCH_SIZE) store.save();
		return outcome;
	}

	/** Index state for /om:status; undefined when embeddings are disabled in settings. */
	status(sessionId: string, entries: Entry[]): IndexStatus | undefined {
		if (!this.getConfig().enabled) return undefined;
		if (this.failure !== undefined) return { state: "failed", failure: this.failure };
		const store = this.storeFor(sessionId);
		const compactionIndex = findLastCompactionIndex(entries);
		const belongs = onBranch(entries);
		const orphaned = store.allKeys.filter((key) => !belongs(key)).length;
		const cursor = branchCursor(entries);
		if (cursor === -1) {
			return { state: "absent", autoBuild: compactionIndex === -1, documents: store.size, orphaned, indexing: this.isIndexing };
		}
		// What the latest compaction hid plus memory recorded since; the whole corpus when nothing is compacted.
		const recent = buildSearchCorpus(entries, Math.max(0, compactionIndex));
		const unembedded = (docs: SearchDocument[]) => docs.filter((doc) => !store.has(docKey(doc))).length;
		const pending = unembedded(buildSearchCorpus(entries, cursor + 1));
		return {
			state: "present",
			documents: store.size,
			orphaned,
			missing: unembedded(buildSearchCorpus(entries)) - pending,
			pending,
			recentEmbedded: recent.filter((doc) => store.has(docKey(doc))).length,
			recentTotal: recent.length,
			indexing: this.isIndexing,
		};
	}

	/** Cosine similarity per document, undefined for documents not embedded yet; undefined overall when disabled or failing. */
	async vectorScores(sessionId: string, docs: SearchDocument[], query: string): Promise<Array<number | undefined> | undefined> {
		if (!this.enabled()) return undefined;
		try {
			const store = this.storeFor(sessionId);
			const [queryVector] = await (await this.getEmbedder()).embed([`${this.getConfig().queryPrefix}${query}`]);
			return docs.map((doc) => {
				const vector = store.get(docKey(doc));
				return vector ? dot(queryVector, vector) : undefined;
			});
		} catch {
			return undefined;
		}
	}
}
