import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerCompactionTrigger } from "../src/hooks/compaction-trigger.js";
import { compactionEntry, textCustomMessage, type TestEntry } from "./fixtures/session.js";

function captureHandler(args: { compactAfterTokens?: number; compactAfterTokensMode?: "calibrated" | "ratio"; compactAfterTokensRatio?: number; passive?: boolean; compactInFlight?: boolean } = {}) {
	let handler: ((event: unknown, ctx: unknown) => void) | undefined;
	let shutdown: ((event: unknown, ctx: unknown) => void) | undefined;
	const pi = {
		on: vi.fn((name: string, cb: typeof handler) => {
			if (name === "agent_end") handler = cb;
			if (name === "session_shutdown") shutdown = cb;
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
		observerPromise: new Promise(() => {}),
		reflectDropPromise: new Promise(() => {}),
	};
	registerCompactionTrigger(pi as any, runtime as any);
	if (!handler) throw new Error("agent_end handler was not registered");
	if (!shutdown) throw new Error("session_shutdown handler was not registered");
	return { handler, shutdown, runtime };
}

function agentEnd(errorMessage?: string) {
	return {
		type: "agent_end",
		messages: [
			{ role: "user", content: "hello" },
			errorMessage
				? { role: "assistant", content: [], stopReason: "error", errorMessage }
				: { role: "assistant", content: "done", stopReason: "end_turn" },
		],
	};
}

function fakeCtx(branches: TestEntry[][], overrides: Record<string, unknown> = {}) {
	let branchIndex = 0;
	const getBranch = vi.fn(() => branches[Math.min(branchIndex++, branches.length - 1)]);
	return {
		cwd: "/tmp/project",
		sessionManager: { getBranch },
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

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("calls compact when compactAfterTokens is reached", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		expect(runtime.compactInFlight).toBe(true);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction threshold reached (~3 tokens); triggering compaction",
			"info",
		);
	});

	it("skips passive mode", async () => {
		const { handler, runtime } = captureHandler({ passive: true });
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("skips when compaction is already in flight", async () => {
		const { handler } = captureHandler({ compactInFlight: true });
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("skips retryable assistant errors", async () => {
		const { handler, runtime } = captureHandler();
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd("fetch failed: connection lost"), ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("does not await observer or reflect/drop promises before compacting", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("defers compaction if context is no longer idle", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch], { isIdle: vi.fn(() => false) });

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction deferred — agent became busy before compaction",
			"info",
		);
	});

	it("cancels deferred compaction when the session shuts down", async () => {
		const { handler, shutdown, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		expect(runtime.compactInFlight).toBe(true);
		shutdown({ type: "session_shutdown", reason: "new" }, ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.isIdle).not.toHaveBeenCalled();
		expect(ctx.sessionManager.getBranch).toHaveBeenCalledTimes(1);
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("re-checks threshold after deferral and skips if another compaction already reduced pressure", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch, belowBranch]);

		handler(agentEnd(), ctx);
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

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
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

			handler(agentEnd(), ctx);
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

			handler(agentEnd(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
		});

		it("falls back to calibrated value when model.contextWindow is unavailable", async () => {
			// ratio mode but no model -> falls back to compactAfterTokens=81000, so 3 tokens won't fire.
			const { handler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch], { model: undefined });

			handler(agentEnd(), ctx);
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

			handler(agentEnd(), ctx);
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

			handler(agentEnd(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
			expect(runtime.compactInFlight).toBe(false);
		});
	});
});
