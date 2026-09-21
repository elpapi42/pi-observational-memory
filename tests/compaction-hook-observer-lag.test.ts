import { describe, expect, it, vi } from "vitest";

import { registerCompactionHook, resolveCompactionCut } from "../src/hooks/compaction-hook.js";
import {
	compactionEntry,
	observation,
	observationsRecordedEntry,
	rawMessage,
	type TestEntry,
} from "./fixtures/session.js";

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

/**
 * Two full turns, then a third turn whose tail the observer has not reached:
 *
 *   0 u0  1 a0  2 u1  3 a1  4 t1  5 a2  6 u2  7 om(covers a0)  8 om(covers a1)
 *
 * Pi proposes to keep from u2; entries t1 and a2 are unobserved.
 */
function laggingBranch(): TestEntry[] {
	return [
		userMessage("u0"),
		assistantMessage("a0"),
		userMessage("u1"),
		assistantMessage("a1"),
		toolResultMessage("t1"),
		assistantMessage("a2"),
		userMessage("u2"),
		coverage("om-a0", "a0", "aaaaaaaaaaaa"),
		coverage("om-a1", "a1", "bbbbbbbbbbbb"),
	];
}

function setup(args: {
	entries: TestEntry[];
	compactionMaxRetainedTokens?: number;
	model?: unknown;
}) {
	let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
	const pi = {
		on: vi.fn((eventName: string, cb: typeof handler) => {
			expect(eventName).toBe("session_before_compact");
			handler = cb;
		}),
		appendEntry: vi.fn(),
	};
	const runtime = {
		config: {
			observationsPoolMaxTokens: 20_000,
			compactionMaxRetainedTokens: args.compactionMaxRetainedTokens,
		},
		compactHookInFlight: false,
		resolveModel: vi.fn(() => {
			throw new Error("resolveModel must not be called");
		}),
		ensureConfig: vi.fn(),
	};
	registerCompactionHook(pi as any, runtime as any);
	if (!handler) throw new Error("compaction handler was not registered");
	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: { notify: vi.fn() },
		model: args.model,
		sessionManager: { getBranch: vi.fn(() => args.entries) },
	};
	const run = (firstKeptEntryId: string, reason: "manual" | "threshold" | "overflow" = "threshold") => handler!({
		preparation: { firstKeptEntryId, tokensBefore: 123 },
		branchEntries: args.entries,
		reason,
		willRetry: false,
		signal: undefined,
	}, ctx);
	return { pi, runtime, ctx, run };
}

describe("compaction hook when the observer is behind Pi's cut", () => {
	it("keeps Pi's cut when observation coverage reaches it", async () => {
		const entries = [...laggingBranch(), coverage("om-a2", "a2", "cccccccccccc")];
		const { run, ctx } = setup({ entries });

		const result = await run("u2") as any;

		expect(result.compaction.firstKeptEntryId).toBe("u2");
		expect(result.compaction.details.observations.map((obs: any) => obs.id)).toEqual([
			"aaaaaaaaaaaa",
			"bbbbbbbbbbbb",
			"cccccccccccc",
		]);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("moves the retention boundary back to the turn containing the first unobserved entry", async () => {
		const { run, ctx } = setup({ entries: laggingBranch() });

		const result = await run("u2") as any;

		expect(result.compaction.firstKeptEntryId).toBe("u1");
		expect(result.compaction.tokensBefore).toBe(123);
		// Every recorded observation is folded, including the one whose coverage
		// marker (a1) now sits inside the retained tail.
		expect(result.compaction.details.observations.map((obs: any) => obs.id)).toEqual([
			"aaaaaaaaaaaa",
			"bbbbbbbbbbbb",
		]);
		expect(result.compaction.summary).toContain("[bbbbbbbbbbbb]");
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: observer has not reached 2 source entries (~7 tokens) before the compaction cut; keeping them in context until they are observed",
			"info",
		);
	});

	it("delegates to Pi's native summarizer when retaining the tail exceeds the budget", async () => {
		const { run, ctx } = setup({ entries: laggingBranch(), compactionMaxRetainedTokens: 1 });

		const result = await run("u2");

		expect(result).toBeUndefined();
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		const [message, level] = ctx.ui.notify.mock.calls[0];
		expect(level).toBe("warning");
		expect(message).toContain("observer has not reached 2 source entries (~7 tokens)");
		expect(message).toContain("exceeds the ~1-token budget");
		expect(message).toContain("delegating to Pi's native summarizer");
	});

	it("derives the retained-tail budget from the session model's context window", async () => {
		// Half of a 4-token window is 2; the retained tail is larger than that.
		const tooSmall = setup({ entries: laggingBranch(), model: { contextWindow: 4 } });
		expect(await tooSmall.run("u2")).toBeUndefined();

		const roomy = setup({ entries: laggingBranch(), model: { contextWindow: 4_000 } });
		expect(((await roomy.run("u2")) as any).compaction.firstKeptEntryId).toBe("u1");
	});

	it("delegates during overflow recovery instead of retaining more context", async () => {
		const { run, ctx } = setup({ entries: laggingBranch() });

		const result = await run("u2", "overflow");

		expect(result).toBeUndefined();
		expect(ctx.ui.notify.mock.calls[0][0]).toContain("overflow recovery");
	});

	it("delegates when the unobserved entries belong to the first compactable turn", async () => {
		// Coverage stops at a0; the next turn (u1...) is the only turn Pi would
		// fold, so moving the cut back to u1 would free nothing.
		const entries = [
			userMessage("u0"),
			assistantMessage("a0"),
			userMessage("u1"),
			assistantMessage("a1"),
			toolResultMessage("t1"),
			userMessage("u2"),
			coverage("om-a0", "a0", "aaaaaaaaaaaa"),
			compactionEntry("cmp-0", { firstKeptEntryId: "u1" }),
		];
		const { run, ctx } = setup({ entries });

		const result = await run("u2");

		expect(result).toBeUndefined();
		expect(ctx.ui.notify.mock.calls[0][0]).toContain("nothing observed can be compacted");
	});

	it("delegates when nothing has been observed at all", async () => {
		const entries = [userMessage("u0"), assistantMessage("a0"), userMessage("u1")];
		const { run, ctx } = setup({ entries });

		const result = await run("u1");

		expect(result).toBeUndefined();
		expect(ctx.ui.notify.mock.calls[0][0]).toContain("no observation coverage");
	});

	it("ignores unobserved entries that precede the previous compaction boundary", async () => {
		// The observer never covered u0/a0, but they were already compacted away.
		const entries = [
			userMessage("u0"),
			assistantMessage("a0"),
			compactionEntry("cmp-0", { firstKeptEntryId: "u1" }),
			userMessage("u1"),
			assistantMessage("a1"),
			userMessage("u2"),
			coverage("om-a1", "a1", "bbbbbbbbbbbb"),
		];
		const { run, ctx } = setup({ entries });

		const result = await run("u2") as any;

		expect(result.compaction.firstKeptEntryId).toBe("u2");
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});
});

describe("resolveCompactionCut", () => {
	it("returns Pi's cut unchanged when the cut id is unknown", () => {
		const resolution = resolveCompactionCut(laggingBranch() as any, "missing", { maxRetainedTokens: 1000 });

		expect(resolution).toEqual({ kind: "cut", cut: { firstKeptEntryId: "missing", foldThroughEntryId: "missing" } });
	});

	it("reports the unobserved span it retains", () => {
		const resolution = resolveCompactionCut(laggingBranch() as any, "u2", { maxRetainedTokens: 1000 });

		expect(resolution.kind).toBe("cut");
		expect(resolution.gap).toMatchObject({ firstIndex: 4, lastIndex: 5, entryCount: 2 });
		if (resolution.kind === "cut") {
			expect(resolution.cut).toEqual({ firstKeptEntryId: "u1", foldThroughEntryId: "a1" });
		}
	});
});
