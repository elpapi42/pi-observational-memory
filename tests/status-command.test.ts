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

function setup(args: { entries: TestEntry[]; runtime?: Partial<any>; model?: unknown; contextUsage?: unknown }) {
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
			passive: false,
		},
		consolidationInFlight: false,
		consolidationPhase: undefined,
		compactInFlight: false,
		compactHookInFlight: false,
		lastObserverError: undefined,
		lastReflectorError: undefined,
		lastDropperError: undefined,
		...args.runtime,
	};
	registerStatusCommand(pi as any, runtime as any);
	if (!handler) throw new Error("status handler not registered");
	const notify = vi.fn();
	const ctx = {
		cwd: "/tmp/project",
		ui: { notify },
		sessionManager: { getBranch: () => args.entries },
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
		expect(output).toContain("Reflections:  0 recorded / 0 visible");
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
		expect(output).toContain("Reflections:  1 recorded / 0 visible +1");
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
		expect(output).toContain("/ 20 observed tokens");
		expect(output).toContain("Next compaction:");
		expect(output).toContain("/ 30 observed source tokens");
		expect(output).toContain("Visible observation pool: ~5 / 40 tokens (13%)");
		// Active pool counts the full rendered line, unlike the visible pool's stored tokenCount.
		expect(output).toContain("Active observation pool: ~19 / 20 target tokens (95%)");
		expect(output).toContain("Reflection pool:         ~3 tokens");
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
			observationsRecordedEntry("om-cov", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "raw-1" }),
		];

		const output = await setup({
			entries,
			contextUsage: { tokens: 135636, contextWindow: 200000 },
		}).run();

		expect(output).toContain("Next compaction:  ~3 / 30 observed source tokens");
		expect(output).toContain("Observer backlog: ~0 unobserved source tokens since the compaction boundary");
	});

	it("counts only observed source tokens toward the next compaction and reports the unobserved backlog", async () => {
		const entries = [
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-1" }),
			textCustomMessage("raw-1", "aaaaaaaaaaaa"),
			observationsRecordedEntry("om-cov", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbbbbbbbbbb"),
		];

		const output = await setup({ entries }).run();

		expect(output).toContain("Next compaction:  ~3 / 30 observed source tokens (10%)");
		expect(output).toContain("Observer backlog: ~4 unobserved source tokens since the compaction boundary");
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
				config: { observeAfterTokens: 10, reflectAfterTokens: 20, compactAfterTokens: 30, observationsPoolMaxTokens: 40, observationsPoolTargetTokens: 20, passive: true },
				consolidationInFlight: true,
				consolidationPhase: "reflector",
				compactInFlight: true,
				compactHookInFlight: true,
				lastObserverError: "observer failed",
				lastReflectorError: "reflect failed",
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
						compactAfterTokensMode: "ratio",
						compactAfterTokensRatio: 0.5,
						observationsPoolMaxTokens: 40,
						observationsPoolTargetTokens: 20,
						passive: false,
					},
				},
				model: { contextWindow: 1_000_000 },
				contextUsage: { tokens: null, contextWindow: 1_000_000 },
			}).run();

			expect(output).toContain("Next compaction:  ~0 / 500,000 observed source tokens (0%)");
		});

		it("uses model contextWindow in ratio mode", async () => {
			const output = await setup({
				entries: [],
				runtime: {
					config: {
						observeAfterTokens: 10,
						reflectAfterTokens: 20,
						compactAfterTokens: 30,
						compactAfterTokensMode: "ratio",
						compactAfterTokensRatio: 0.5,
						observationsPoolMaxTokens: 40,
						observationsPoolTargetTokens: 20,
						passive: false,
					},
				},
				model: { contextWindow: 100_000 },
				contextUsage: { tokens: null, contextWindow: 200_000 },
			}).run();

			expect(output).toContain("Next compaction:  ~0 / 50,000 observed source tokens (0%)");
		});

		it("falls back to calibrated threshold when model is unavailable in ratio mode", async () => {
			const output = await setup({
				entries: [],
				runtime: {
					config: {
						observeAfterTokens: 10,
						reflectAfterTokens: 20,
						compactAfterTokens: 30,
						compactAfterTokensMode: "ratio",
						compactAfterTokensRatio: 0.5,
						observationsPoolMaxTokens: 40,
						observationsPoolTargetTokens: 20,
						passive: false,
					},
				},
				model: undefined,
			}).run();

			expect(output).toContain("Next compaction:  ~0 / 30 observed source tokens (0%)");
		});

		it("falls back to calibrated threshold when contextWindow is zero in ratio mode", async () => {
			const output = await setup({
				entries: [],
				runtime: {
					config: {
						observeAfterTokens: 10,
						reflectAfterTokens: 20,
						compactAfterTokens: 30,
						compactAfterTokensMode: "ratio",
						compactAfterTokensRatio: 0.5,
						observationsPoolMaxTokens: 40,
						observationsPoolTargetTokens: 20,
						passive: false,
					},
				},
				model: { contextWindow: 0 },
			}).run();

			expect(output).toContain("Next compaction:  ~0 / 30 observed source tokens (0%)");
		});
	});
});
