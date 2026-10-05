import { describe, expect, it, vi } from "vitest";

import { registerStatusCommand } from "../src/commands/status.js";
import {
	compactionEntry,
	memoryDetails,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	oldV2CompactionDetails,
	oldV2ObservationEntry,
	reflection,
	reflectionsRecordedEntry,
	rawMessage,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

function setup(args: { entries: TestEntry[]; allEntries?: TestEntry[]; runtime?: Partial<any>; model?: unknown; contextUsage?: unknown; embeddings?: unknown }) {
	let handler: ((args: unknown, ctx: any) => Promise<void>) | undefined;
	const pi = {
		registerCommand: vi.fn((name: string, command: { handler: typeof handler }) => {
			expect(name).toBe("om:status");
			handler = command.handler;
		}),
	};
	const runtime = {
		ensureConfig: vi.fn(),
		config: {
			observeAfterTokens: 10,
			reflectAfterTokens: 20,
			compactAfterTokens: 30,
			observationsPoolMaxTokens: 40,
			observationsPoolTargetTokens: 20,
			reflectionsPoolTargetTokens: 20,
			passive: false,
		},
		consolidationInFlight: false,
		consolidationPhase: undefined,
		compactInFlight: false,
		compactHookInFlight: false,
		lastObserverError: undefined,
		lastReflectorError: undefined,
		lastReflectionDropperError: undefined,
		lastDropperError: undefined,
		...args.runtime,
	};
	registerStatusCommand(pi as any, runtime as any, args.embeddings as any);
	if (!handler) throw new Error("status handler not registered");
	const notify = vi.fn();
	const ctx = {
		cwd: "/tmp/project",
		ui: { notify },
		sessionManager: { getBranch: () => args.entries, getEntries: () => args.allEntries ?? args.entries, getSessionId: () => "s1" },
		model: args.model,
		getContextUsage: () => args.contextUsage,
	};
	const run = async () => {
		await handler!(undefined, ctx);
		return notify.mock.calls.at(-1)?.[0] as string;
	};
	return { run, notify };
}

describe("V3 /om:status", () => {
	it("renders concise no-memory status without V2 committed/pending language", async () => {
		const output = await setup({ entries: [] }).run();

		expect(output).toContain("── Memory ──");
		expect(output).toContain("Observations: 0 recorded / 0 dropped / 0 active / 0 visible");
		expect(output).toContain("Reflections:  0 recorded / 0 dropped / 0 active / 0 visible");
		expect(output).toContain("Next observation:");
		expect(output).toContain("Next compaction:");
		expect(output).not.toContain("Visible:");
		expect(output).not.toContain("Drift:");
		expect(output).not.toContain("committed");
		expect(output).not.toContain("pending");
	});

	it("reports V3 ledger counts, visible/full drift, and ignores old V2 memory", async () => {
		const obsA = observation("aaaaaaaaaaaa", { tokenCount: 5 });
		const obsB = observation("bbbbbbbbbbbb", { tokenCount: 7 });
		const ref = reflection("eeeeeeeeeeee", ["bbbbbbbbbbbb"], { tokenCount: 3 });
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			oldV2ObservationEntry("v2-obs"),
			compactionEntry("cmp-v2", { firstKeptEntryId: "raw-1", details: oldV2CompactionDetails() }),
			compactionEntry("cmp-visible", { firstKeptEntryId: "raw-1", details: memoryDetails({ observations: [obsA], reflections: [] }) }),
			observationsRecordedEntry("om-obs", { observations: [obsA, obsB], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [ref], coversUpToId: "om-obs" }),
			observationsDroppedEntry("om-drop", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "om-ref" }),
		];

		const output = await setup({ entries }).run();

		expect(output).toContain("Observations: 2 recorded / 1 dropped / 1 active / 1 visible +1 -1");
		expect(output).toContain("Reflections:  1 recorded / 0 dropped / 1 active / 0 visible +1");
		expect(output).toContain("Visible observation pool: ~5 / 40 tokens (13%)");
		// Active pool counts the full rendered line (id + timestamp + relevance + content).
		expect(output).toContain("Active observation pool: ~19 / 20 target tokens (95%)");
		expect(output).not.toContain("Visible:");
		expect(output).not.toContain("Drift:");
		expect(output).not.toContain("full truth");
		expect(output).not.toContain("v2-obs");
		expect(output).not.toContain("observational-memory");
	});

	it("shows separate progress clocks, visible pool, active observation pool, and reflection pool", async () => {
		const obs = observation("aaaaaaaaaaaa", { tokenCount: 5 });
		const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { tokenCount: 3 });
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [ref], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			compactionEntry("cmp", { firstKeptEntryId: "raw-2", details: memoryDetails({ observations: [obs], reflections: [ref] }) }),
		];

		const output = await setup({ entries }).run();

		expect(output).toContain("Next observation:");
		expect(output).toContain("/ 10 tokens");
		expect(output).toContain("Next reflection:");
		expect(output).toContain("/ 20 tokens");
		expect(output).toContain("Next compaction:");
		expect(output).toContain("/ 30 estimated source tokens");
		expect(output).toContain("Visible observation pool: ~5 / 40 tokens (13%)");
		// Active pool counts the full rendered line, unlike the visible pool's stored tokenCount.
		expect(output).toContain("Active observation pool: ~19 / 20 target tokens (95%)");
		expect(output).toContain("Visible reflection pool: ~3 tokens");
		// Active reflection pool counts the full rendered line (id + content).
		expect(output).toContain("Active reflection pool:  ~10 / 20 target tokens (50%)");
		expect(output).not.toContain("Observation pool:");
		expect(output).not.toContain("Full fold pool:");
		expect(output).not.toContain("visible observation tokens");
	});

	it("shows raw source progress and ignores provider context", async () => {
		const entries = [
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-1" }),
			rawMessage("assistant-1", "done", {
				message: { role: "assistant", content: "done", stopReason: "end_turn", usage: { totalTokens: 60072 } },
			}),
			textCustomMessage("raw-1", "aaaaaaaaaaaa"),
		];

		const output = await setup({
			entries,
			contextUsage: { tokens: 135636, contextWindow: 200000 },
		}).run();

		expect(output).toContain("Next compaction:  ~3 / 30 estimated source tokens");
	});

	it("shows over-target active observation pool in the Activity section", async () => {
		// Pad content so the rendered line is exactly 25 tokens (100 chars).
		const obs = observation("aaaaaaaaaaaa", { content: "x".repeat(51) });
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
		];

		const output = await setup({ entries }).run();

		expect(output).toContain("Active observation pool: ~25 / 20 target tokens (125%)");
	});

	it("shows passive mode, consolidation in flight, compaction in flight, and stage-specific last errors", async () => {
		const output = await setup({
			entries: [],
			runtime: {
				config: { observeAfterTokens: 10, reflectAfterTokens: 20, compactAfterTokens: 30, observationsPoolMaxTokens: 40, observationsPoolTargetTokens: 20, reflectionsPoolTargetTokens: 20, passive: true },
				consolidationInFlight: true,
				consolidationPhase: "reflector",
				compactInFlight: true,
				compactHookInFlight: true,
				lastObserverError: "observer failed",
				lastReflectorError: "reflect failed",
				lastReflectionDropperError: "reflection drop failed",
				lastDropperError: "drop failed",
			},
		}).run();

		expect(output).toContain("Passive: automatic memory workers and auto-compaction disabled");
		expect(output).toContain("Consolidation: running (reflector)");
		expect(output).not.toContain("Observer: running");
		expect(output).not.toContain("Reflect/drop: running");
		expect(output).toContain("Auto-compaction: running");
		expect(output).toContain("Compaction hook: running");
		expect(output).toContain("Observer: observer failed");
		expect(output).toContain("Reflector: reflect failed");
		expect(output).toContain("Reflection dropper: reflection drop failed");
		expect(output).toContain("Dropper: drop failed");
	});

	it("shows consolidation in flight without phase when phase is unavailable", async () => {
		const output = await setup({ entries: [], runtime: { consolidationInFlight: true } }).run();

		expect(output).toContain("Consolidation: running");
		expect(output).not.toContain("Consolidation: running (");
	});

	describe("ratio mode", () => {
		it("shows the context-window-scaled threshold in the Next compaction line", async () => {
			const output = await setup({
				entries: [],
				runtime: {
					config: {
						observeAfterTokens: 10,
						reflectAfterTokens: 20,
						compactAfterTokens: 30,
						compactAfterTokens: { type: "ratio", value: 0.5 },
						observationsPoolMaxTokens: 40,
						observationsPoolTargetTokens: 20,
						reflectionsPoolTargetTokens: 20,
						passive: false,
					},
				},
				model: { contextWindow: 1_000_000 },
				contextUsage: { tokens: null, contextWindow: 1_000_000 },
			}).run();

			expect(output).toContain("Next compaction:  ~0 / 500,000 estimated source tokens (0%)");
		});

		it("uses model contextWindow in ratio mode", async () => {
			const output = await setup({
				entries: [],
				runtime: {
					config: {
						observeAfterTokens: 10,
						reflectAfterTokens: 20,
						compactAfterTokens: 30,
						compactAfterTokens: { type: "ratio", value: 0.5 },
						observationsPoolMaxTokens: 40,
						observationsPoolTargetTokens: 20,
						reflectionsPoolTargetTokens: 20,
						passive: false,
					},
				},
				model: { contextWindow: 100_000 },
				contextUsage: { tokens: null, contextWindow: 200_000 },
			}).run();

			expect(output).toContain("Next compaction:  ~0 / 50,000 estimated source tokens (0%)");
		});

		it("falls back to the default threshold when model is unavailable in ratio form", async () => {
			const output = await setup({
				entries: [],
				runtime: {
					config: {
						observeAfterTokens: 10,
						reflectAfterTokens: 20,
						compactAfterTokens: 30,
						compactAfterTokens: { type: "ratio", value: 0.5 },
						observationsPoolMaxTokens: 40,
						observationsPoolTargetTokens: 20,
						reflectionsPoolTargetTokens: 20,
						passive: false,
					},
				},
				model: undefined,
			}).run();

			expect(output).toContain("Next compaction:  ~0 / 81,000 estimated source tokens (0%)");
		});

		it("falls back to the default threshold when contextWindow is zero in ratio form", async () => {
			const output = await setup({
				entries: [],
				runtime: {
					config: {
						observeAfterTokens: 10,
						reflectAfterTokens: 20,
						compactAfterTokens: 30,
						compactAfterTokens: { type: "ratio", value: 0.5 },
						observationsPoolMaxTokens: 40,
						observationsPoolTargetTokens: 20,
						reflectionsPoolTargetTokens: 20,
						passive: false,
					},
				},
				model: { contextWindow: 0 },
			}).run();

			expect(output).toContain("Next compaction:  ~0 / 81,000 estimated source tokens (0%)");
		});
	});

	it("reports the recall index when embeddings are enabled", async () => {
		const status = vi.fn();
		const embeddings = { status };
		const run = () => setup({ entries: [], embeddings }).run();

		status.mockReturnValue(undefined);
		expect(await run()).not.toContain("Recall index");

		status.mockReturnValue({ state: "absent", autoBuild: false, documents: 0, orphaned: 0, indexing: false });
		expect(await run()).toContain("Recall index: none on this branch — run /om:index to build it");

		status.mockReturnValue({ state: "absent", autoBuild: false, documents: 12, orphaned: 4, indexing: false });
		const absent = await run();
		expect(absent).toContain("Recall index: none on this branch (8 documents already embedded from other branches) — run /om:index to build it");
		expect(absent).toContain("Recall index: 4 orphaned documents not on this branch — run /om:index to prune");

		status.mockReturnValue({ state: "absent", autoBuild: true, documents: 0, orphaned: 0, indexing: false });
		expect(await run()).toContain("Recall index: none yet — builds after the next turn");

		status.mockReturnValue({ state: "present", documents: 16640, orphaned: 0, missing: 0, pending: 0, recentEmbedded: 30, recentTotal: 40, indexing: false });
		const present = await run();
		expect(present).toContain("Recall index: 16,640 documents / 30 of 40 since last compaction embedded (75%)");
		expect(present).not.toContain("orphaned");

		// Documents past the cursor are queued for later runs, not a reason to run /om:index.
		status.mockReturnValue({ state: "present", documents: 30, orphaned: 0, missing: 0, pending: 1200, recentEmbedded: 30, recentTotal: 1230, indexing: false });
		const queued = await run();
		expect(queued).toContain("Recall index: 30 documents / 30 of 1,230 since last compaction embedded (2%), 1,200 queued");
		expect(queued).not.toContain("not embedded");

		status.mockReturnValue({ state: "present", documents: 5, orphaned: 0, missing: 3, pending: 0, recentEmbedded: 0, recentTotal: 0, indexing: true });
		// Missing documents are what the running index is embedding, so they only get a line once it is idle.
		expect(await run()).toContain("(100%) — indexing");
		expect(await run()).not.toContain("not embedded");
		status.mockReturnValue({ state: "present", documents: 5, orphaned: 0, missing: 3, pending: 0, recentEmbedded: 0, recentTotal: 0, indexing: false });
		expect(await run()).toContain("Recall index: 3 documents on this branch not embedded — run /om:index to embed them");

		status.mockReturnValue({ state: "failed", failure: "no runtime" });
		expect(await run()).toContain("Recall index: unavailable, using keyword search — no runtime");
	});

	it("sums worker cost over the whole session, not just the branch", async () => {
		const workerCost = (cost: number) => ({
			type: "custom",
			customType: "om.worker.cost",
			data: { at: "", cost, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		});
		// Mirrors pi's own session totals: entries outside the current branch count.
		const output = await setup({
			entries: [],
			allEntries: [workerCost(0.5), workerCost(0.25)] as any,
		}).run();
		expect(output).toContain("Worker cost: $0.7500");
		expect(output).not.toContain("── Cost ──");
	});
});
