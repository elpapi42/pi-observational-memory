import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgents = vi.hoisted(() => ({ runObserver: vi.fn() }));

vi.mock("../src/agents/observer/agent.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/agents/observer/agent.js")>()),
	runObserver: mockAgents.runObserver,
}));

import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { OM_OBSERVATIONS_RECORDED } from "../src/session-ledger/index.js";
import { observation, observationsRecordedEntry, rawMessage, type TestEntry } from "./fixtures/session.js";

function userMessage(id: string, text = `user ${id}`): TestEntry {
	return rawMessage(id, text);
}

function assistantMessage(id: string, text = `assistant ${id}`): TestEntry {
	return rawMessage(id, text, {
		message: { role: "assistant", content: [{ type: "text", text }], stopReason: "end_turn" },
	});
}

function toolResultMessage(id: string, text = `tool result ${id}`): TestEntry {
	return rawMessage(id, text, {
		message: { role: "toolResult", toolCallId: `call-${id}`, toolName: "bash", content: [{ type: "text", text }] },
	});
}

function coverage(id: string, coversUpToId: string, observationId: string): TestEntry {
	return observationsRecordedEntry(id, {
		observations: [observation(observationId, { sourceEntryIds: [coversUpToId], tokenCount: 10 })],
		coversUpToId,
	});
}

/** 0 u0  1 a0  2 u1  3 a1  4 t1  5 a2  6 u2  7 om(a0)  8 om(a1); Pi proposes to keep from u2. */
function laggingBranch(t1Text?: string): TestEntry[] {
	return [
		userMessage("u0"),
		assistantMessage("a0"),
		userMessage("u1"),
		assistantMessage("a1"),
		toolResultMessage("t1", t1Text),
		assistantMessage("a2"),
		userMessage("u2"),
		coverage("om-a0", "a0", "aaaaaaaaaaaa"),
		coverage("om-a1", "a1", "bbbbbbbbbbbb"),
	];
}

function setup(args: {
	entries: TestEntry[];
	maxChunks?: number;
	observerChunkMaxTokens?: number;
	consolidationInFlight?: boolean;
	resolveOk?: boolean;
}) {
	let entries = [...args.entries];
	let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
	const pi = {
		on: vi.fn((_eventName: string, cb: typeof handler) => {
			handler = cb;
		}),
		appendEntry: vi.fn((customType: string, data: unknown) => {
			entries = [...entries, {
				type: "custom",
				id: `appended-${pi.appendEntry.mock.calls.length}`,
				parentId: entries.at(-1)?.id ?? null,
				timestamp: "2026-05-02T10:00:00.000Z",
				customType,
				data,
			}];
		}),
	};
	const runtime = {
		config: {
			observationsPoolMaxTokens: 20_000,
			compactionCatchUpMaxChunks: args.maxChunks ?? 2,
			observerChunkMaxTokens: args.observerChunkMaxTokens,
			agentMaxTurns: 4,
			agentMaxTokens: 8192,
			showWorkerNotifications: true,
			model: { provider: "gtr7", id: "memory", thinking: "off" },
		},
		compactHookInFlight: false,
		consolidationInFlight: args.consolidationInFlight ?? false,
		resolveModel: vi.fn(async () => (args.resolveOk === false
			? { ok: false, reason: "no model" }
			: { ok: true, model: { provider: "gtr7", id: "memory", contextWindow: 65536 }, apiKey: "key" })),
		ensureConfig: vi.fn(),
	};
	registerCompactionHook(pi as any, runtime as any);
	if (!handler) throw new Error("compaction handler was not registered");
	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: { notify: vi.fn() },
		model: { contextWindow: 65536 },
		modelRegistry: {},
		sessionManager: { getBranch: vi.fn(() => entries) },
	};
	const run = (firstKeptEntryId: string) => handler!({
		preparation: { firstKeptEntryId, tokensBefore: 123 },
		branchEntries: args.entries,
		reason: "threshold",
		willRetry: false,
		signal: new AbortController().signal,
	}, ctx);
	return { pi, runtime, ctx, run, getEntries: () => entries };
}

beforeEach(() => {
	mockAgents.runObserver.mockReset();
});

describe("compaction hook synchronous catch-up", () => {
	it("observes the unobserved gap and then cuts at Pi's proposed boundary", async () => {
		const gapObs = observation("cccccccccccc", { sourceEntryIds: ["t1", "a2"], tokenCount: 12 });
		mockAgents.runObserver.mockResolvedValueOnce([gapObs]);
		const { run, pi, runtime, ctx } = setup({ entries: laggingBranch() });

		const result = await run("u2") as any;

		expect(runtime.resolveModel).toHaveBeenCalledTimes(1);
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);
		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({
			allowedSourceEntryIds: ["t1", "a2"],
			maxOutputTokens: 8192,
			thinkingLevel: "off",
		}));
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, { observations: [gapObs], coversUpToId: "a2" });
		expect(result.compaction.firstKeptEntryId).toBe("u2");
		expect(result.compaction.details.observations.map((obs: any) => obs.id)).toEqual([
			"aaaaaaaaaaaa",
			"bbbbbbbbbbbb",
			"cccccccccccc",
		]);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: observing 2 unobserved source entries (~37 tokens) before compacting",
			"info",
		);
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("keeping them in context"), "info");
	});

	it("falls back to retaining the tail when the observer records nothing", async () => {
		mockAgents.runObserver.mockResolvedValueOnce([]);
		const { run, pi } = setup({ entries: laggingBranch() });

		const result = await run("u2") as any;

		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(result.compaction.firstKeptEntryId).toBe("a1");
	});

	it("falls back to retaining the tail and warns when the observer fails", async () => {
		mockAgents.runObserver.mockRejectedValueOnce(new Error("Connection error."));
		const { run, pi, ctx } = setup({ entries: laggingBranch() });

		const result = await run("u2") as any;

		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(result.compaction.firstKeptEntryId).toBe("a1");
		expect(ctx.ui.notify).toHaveBeenCalledWith("Observational memory: catch-up observer failed: Connection error.", "warning");
	});

	it("covers one chunk when the chunk cap stops it, then retains the rest", async () => {
		const gapObs = observation("cccccccccccc", { sourceEntryIds: ["t1"], tokenCount: 12 });
		mockAgents.runObserver.mockResolvedValueOnce([gapObs]);
		// t1 alone exceeds the minimum chunk budget, so each chunk carries one entry.
		const { run, pi } = setup({ entries: laggingBranch("x".repeat(4000)), maxChunks: 1, observerChunkMaxTokens: 256 });

		const result = await run("u2") as any;

		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, expect.objectContaining({ coversUpToId: "t1" }));
		// a2 is still unobserved: the cut lands on it and it stays in context.
		expect(result.compaction.firstKeptEntryId).toBe("a2");
	});

	it("does nothing when disabled", async () => {
		const { run, runtime } = setup({ entries: laggingBranch(), maxChunks: 0 });

		const result = await run("u2") as any;

		expect(runtime.resolveModel).not.toHaveBeenCalled();
		expect(mockAgents.runObserver).not.toHaveBeenCalled();
		expect(result.compaction.firstKeptEntryId).toBe("a1");
	});

	it("does not run while a background consolidation is in flight", async () => {
		const { run, runtime } = setup({ entries: laggingBranch(), consolidationInFlight: true });

		const result = await run("u2") as any;

		expect(runtime.resolveModel).not.toHaveBeenCalled();
		expect(result.compaction.firstKeptEntryId).toBe("a1");
	});

	it("does not bootstrap memory when nothing has ever been observed", async () => {
		const entries = [userMessage("u0"), assistantMessage("a0"), userMessage("u1")];
		const { run, runtime } = setup({ entries });

		const result = await run("u1");

		expect(result).toBeUndefined();
		expect(runtime.resolveModel).not.toHaveBeenCalled();
	});

	it("falls back when the memory model is unavailable", async () => {
		const { run, pi } = setup({ entries: laggingBranch(), resolveOk: false });

		const result = await run("u2") as any;

		expect(mockAgents.runObserver).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(result.compaction.firstKeptEntryId).toBe("a1");
	});
});
