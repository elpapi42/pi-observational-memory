import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerCompactionTrigger } from "../src/hooks/compaction-trigger.js";
import { compactionEntry, rawMessage, textCustomMessage, type TestEntry } from "./fixtures/session.js";

function captureHandler(args: { compactAfterTokens?: number; compactAfterTokensMode?: "calibrated" | "ratio"; compactAfterTokensRatio?: number; passive?: boolean; compactInFlight?: boolean; compactInFlightSession?: string } = {}) {
	let handler: ((event: unknown, ctx: unknown) => void) | undefined;
	const pi = {
		on: vi.fn((name: string, cb: typeof handler) => {
			expect(name).toBe("agent_settled");
			handler = cb;
		}),
	};
	const runtime = {
		ensureConfig: vi.fn(),
		config: {
			compactAfterTokens: args.compactAfterTokens ?? 3,
			compactAfterTokensMode: args.compactAfterTokensMode ?? "calibrated",
			compactAfterTokensRatio: args.compactAfterTokensRatio ?? 0.68,
			passive: args.passive ?? false,
		},
		compactInFlight: args.compactInFlight ?? false,
		compactInFlightSession: args.compactInFlightSession,
		observerPromise: new Promise(() => {}),
		reflectDropPromise: new Promise(() => {}),
	};
	registerCompactionTrigger(pi as any, runtime as any);
	if (!handler) throw new Error("agent_settled handler was not registered");
	return { handler, runtime };
}

function agentSettled() {
	return { type: "agent_settled" };
}

function fakeCtx(branches: TestEntry[][], overrides: Record<string, unknown> = {}, sessionId?: string) {
	let branchIndex = 0;
	const getBranch = vi.fn(() => branches[Math.min(branchIndex++, branches.length - 1)]);
	return {
		cwd: "/tmp/project",
		sessionManager: {
			getBranch,
			...(sessionId === undefined ? {} : { getSessionId: () => sessionId }),
		},
		hasUI: true,
		ui: { notify: vi.fn() },
		isIdle: vi.fn(() => true),
		compact: vi.fn(),
		model: undefined,
		...overrides,
	};
}

const dueBranch = [textCustomMessage("raw-1", "aaaaaaaaaaaa")]; // 3 tokens
const belowBranch = [textCustomMessage("raw-1", "aaaa")]; // 1 token

describe("V3 compaction trigger", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does nothing below compactAfterTokens", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([belowBranch]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("calls compact when compactAfterTokens is reached", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);

		handler(agentSettled(), ctx);
		expect(runtime.compactInFlight).toBe(true);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction threshold reached (~3 estimated source tokens); triggering compaction",
			"info",
		);
	});

	it("skips passive mode", async () => {
		const { handler, runtime } = captureHandler({ passive: true });
		const ctx = fakeCtx([dueBranch]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("skips when compaction is already in flight", async () => {
		const { handler } = captureHandler({ compactInFlight: true });
		const ctx = fakeCtx([dueBranch]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("keeps the in-flight flag when the session generation is unchanged", async () => {
		const { handler } = captureHandler({ compactInFlight: true, compactInFlightSession: "session-1" });
		const ctx = fakeCtx([dueBranch], {}, "session-1");

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("discards a stale in-flight flag after session replacement", async () => {
		const { handler, runtime } = captureHandler({ compactInFlight: true, compactInFlightSession: "session-1" });
		const ctx = fakeCtx([dueBranch], {}, "session-2");

		handler(agentSettled(), ctx);
		expect(runtime.compactInFlight).toBe(true);
		expect(runtime.compactInFlightSession).toBe("session-2");
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: discarded stale in-flight compaction from a replaced session",
			"info",
		);
	});

	it("does not await observer or reflect/drop promises before compacting", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("defers compaction if context is no longer idle", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch], { isIdle: vi.fn(() => false) });

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction deferred — agent became busy before compaction",
			"info",
		);
	});

	it("re-checks threshold after deferral and skips if another compaction already reduced pressure", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch, belowBranch]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction skipped — another compaction already ran before deferred compaction",
			"info",
		);
	});

	it("counts raw tokens since the latest Pi compaction using V3 progress helpers", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = [
			textCustomMessage("raw-1", "aaaaaaaaaaaa"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-2" }),
			textCustomMessage("raw-2", "aaaa"),
			textCustomMessage("raw-3", "bbbbbbbb"),
		];
		const ctx = fakeCtx([branch]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("does not compact when provider context and anchored growth exceed the threshold but raw progress does not", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 130000 });
		const branch = [
			compactionEntry("cmp-1", { firstKeptEntryId: "baseline" }),
			rawMessage("baseline", "baseline", {
				message: {
					role: "assistant",
					content: "baseline",
					stopReason: "end_turn",
					usage: { totalTokens: 5000 },
				},
			}),
			textCustomMessage("raw-1", "a".repeat(302_248)), // 75,562 tokens plus the 2-token baseline message
		];
		const ctx = fakeCtx([branch], {
			getContextUsage: vi.fn(() => ({ tokens: 135636, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
	});

	it("uses raw progress when provider growth is lower than the raw threshold", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = [
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-1" }),
			rawMessage("assistant-1", "done", {
				message: { role: "assistant", content: "done", stopReason: "end_turn", usage: { totalTokens: 100 } },
			}),
			textCustomMessage("raw-1", "aaaaaaaaaaaa"),
		];
		const ctx = fakeCtx([branch], {
			getContextUsage: vi.fn(() => ({ tokens: 101, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("uses raw progress from the first kept entry through the current branch", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = [
			textCustomMessage("old", "bbbbbbbbbbbb"),
			compactionEntry("cmp-1", { firstKeptEntryId: "kept" }),
			textCustomMessage("kept", "aaaaaaaa"),
			textCustomMessage("new", "bbbbbbbbbbbb"),
		];
		const ctx = fakeCtx([branch], {
			getContextUsage: vi.fn(() => ({ tokens: 1, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("uses raw progress from the branch start before the first compaction", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch], {
			getContextUsage: vi.fn(() => ({ tokens: 1, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("uses the same raw metric after deferred re-check", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch, dueBranch], {
			getContextUsage: vi.fn(() => ({ tokens: 1, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
		expect(runtime.compactInFlight).toBe(true);
	});

	it("ignores high provider context before the first compaction", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 130000 });
		const ctx = fakeCtx([dueBranch], {
			getContextUsage: vi.fn(() => ({ tokens: 130000, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("compacts when raw progress equals the threshold", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = [
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-1" }),
			rawMessage("assistant-1", "done", {
				message: { role: "assistant", content: "done", stopReason: "end_turn", usage: { totalTokens: 100 } },
			}),
			textCustomMessage("raw-1", "aaaaaaaaaaaa"),
		];
		const ctx = fakeCtx([branch], {
			getContextUsage: vi.fn(() => ({ tokens: 101, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("uses raw progress when provider usage is unknown or has no baseline", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = [compactionEntry("cmp-1"), textCustomMessage("raw-1", "aaaa")];
		const ctx = fakeCtx([branch], {
			getContextUsage: vi.fn(() => ({ tokens: null, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("rechecks raw progress after deferral", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch, belowBranch], {
			getContextUsage: vi.fn(() => ({ tokens: 1, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
	});

	it("falls back to raw progress after a model change", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = [
			compactionEntry("cmp-1"),
			rawMessage("assistant-1", "done", {
				message: { role: "assistant", content: "done", stopReason: "end_turn", usage: { totalTokens: 60000 } },
			}),
			{ type: "model_change", id: "model-1", timestamp: "2026-05-02T10:00:00.000Z" },
			textCustomMessage("raw-1", "aaaa"),
		];
		const ctx = fakeCtx([branch], {
			getContextUsage: vi.fn(() => ({ tokens: 190000, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
	});

	describe("ratio mode", () => {
		it("scales the compaction threshold by model.contextWindow", async () => {
			// 3 tokens raw; ratio 0.5 of 4-token window = 2 -> threshold 2, so 3 >= 2 fires.
			const { handler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch], { model: { contextWindow: 4 } });

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).toHaveBeenCalledTimes(1);
		});

		it("does not compact when raw tokens are below the scaled threshold", async () => {
			// 1 token raw (belowBranch); ratio 0.5 of 4 = 2 -> threshold 2, so 1 < 2 does not fire.
			const { handler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([belowBranch], { model: { contextWindow: 4 } });

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
		});

		it("uses the model context window in ratio mode", async () => {
			const { handler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch], {
				model: { contextWindow: 4 },
				getContextUsage: vi.fn(() => ({ tokens: 2, contextWindow: 10 })),
			});

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).toHaveBeenCalledTimes(1);
		});

		it("falls back to calibrated value when model.contextWindow is unavailable", async () => {
			// ratio mode but no model -> falls back to compactAfterTokens=81000, so 3 tokens won't fire.
			const { handler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch], { model: undefined });

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
		});

		it("falls back to calibrated value when contextWindow is zero", async () => {
			const { handler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch], { model: { contextWindow: 0 } });

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
		});

		it("uses the same resolved threshold on deferred re-check", async () => {
			// threshold = 0.5 * 4 = 2; first branch has 3 (fires, deferred), isIdle=false defers,
			// second branch has 1 (< 2) -> skipped because another compaction reduced pressure.
			const { handler, runtime } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch, belowBranch], {
				model: { contextWindow: 4 },
				isIdle: vi.fn(() => false),
			});

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
			expect(runtime.compactInFlight).toBe(false);
		});
	});
});
