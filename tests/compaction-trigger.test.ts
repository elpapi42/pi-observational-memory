import { describe, expect, it, vi } from "vitest";

import { registerCompactionTrigger } from "../src/hooks/compaction-trigger.js";

/**
 * Helper: capture the event handler registered by registerCompactionTrigger.
 */
function captureHandler() {
	let handler: ((event: unknown, ctx: unknown) => void) | undefined;
	const pi = {
		on: vi.fn((name: string, cb: typeof handler) => {
			expect(name).toBe("agent_end");
			handler = cb;
		}),
	};
	const runtime = {
		ensureConfig: vi.fn(),
		config: {
			observationThresholdTokens: 1,
			compactionThresholdTokens: 50_000,
			reflectionThresholdTokens: 1,
			passive: false,
		},
		observerInFlight: false,
		compactInFlight: false,
		observerPromise: null as Promise<void> | null,
		launchObserverTask: vi.fn(),
	};
	registerCompactionTrigger(pi as never, runtime as never);
	if (!handler) throw new Error("agent_end handler was not registered");
	return { handler, runtime };
}

/**
 * Build a fake ExtensionContext for the compaction trigger.
 * getBranch returns entries whose token count exceeds the threshold.
 */
function fakeCtx(overrides?: Record<string, unknown>) {
	// estimateStringTokens = ceil(length/4), threshold = 50_000
	// Need >200k chars total across message entries to exceed threshold
	return {
		cwd: "/tmp/project",
		sessionManager: {
			getBranch: vi.fn(() =>
				Array.from({ length: 300 }, (_, i) => ({
					id: `entry-${i}`,
					type: "message",
					message: { role: "user", content: "x".repeat(1000) },
					timestamp: i,
				})),
			),
		},
		hasUI: true,
		ui: { notify: vi.fn() },
		isIdle: vi.fn(() => true),
		compact: vi.fn(),
		...overrides,
	};
}

describe("compaction trigger retry guard", () => {
	it("triggers compaction on normal agent_end (no error)", () => {
		const { handler, runtime } = captureHandler();
		const ctx = fakeCtx();

		handler(
			{
				type: "agent_end",
				messages: [
					{ role: "user", content: "hello" },
					{ role: "assistant", content: "done", stopReason: "end_turn" },
				],
			},
			ctx,
		);

		expect(runtime.compactInFlight).toBe(true);
	});

	it("skips compaction when last assistant has retryable network error", () => {
		const { handler, runtime } = captureHandler();
		const ctx = fakeCtx();

		handler(
			{
				type: "agent_end",
				messages: [
					{ role: "user", content: "hello" },
					{ role: "assistant", content: [], stopReason: "error", errorMessage: "fetch failed: connection lost" },
				],
			},
			ctx,
		);

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
	});

	it("skips compaction on 502 Bad Gateway", () => {
		const { handler, runtime } = captureHandler();
		const ctx = fakeCtx();

		handler(
			{
				type: "agent_end",
				messages: [
					{ role: "user", content: "hello" },
					{ role: "assistant", content: [], stopReason: "error", errorMessage: "502 Bad Gateway" },
				],
			},
			ctx,
		);

		expect(runtime.compactInFlight).toBe(false);
	});

	it("skips compaction on overloaded error", () => {
		const { handler, runtime } = captureHandler();
		const ctx = fakeCtx();

		handler(
			{
				type: "agent_end",
				messages: [
					{ role: "user", content: "hello" },
					{ role: "assistant", content: [], stopReason: "error", errorMessage: "overloaded_error: server is overloaded" },
				],
			},
			ctx,
		);

		expect(runtime.compactInFlight).toBe(false);
	});

	it("skips compaction on rate limit error", () => {
		const { handler, runtime } = captureHandler();
		const ctx = fakeCtx();

		handler(
			{
				type: "agent_end",
				messages: [
					{ role: "user", content: "hello" },
					{ role: "assistant", content: [], stopReason: "error", errorMessage: "rate limit exceeded: too many requests" },
				],
			},
			ctx,
		);

		expect(runtime.compactInFlight).toBe(false);
	});

	it("triggers compaction when error is NOT retryable (e.g. context overflow)", () => {
		const { handler, runtime } = captureHandler();
		const ctx = fakeCtx();

		// Context overflow is NOT retryable — Pi won't retry, so compaction should proceed
		handler(
			{
				type: "agent_end",
				messages: [
					{ role: "user", content: "hello" },
					{ role: "assistant", content: [], stopReason: "error", errorMessage: "context window exceeded" },
				],
			},
			ctx,
		);

		expect(runtime.compactInFlight).toBe(true);
	});

	it("triggers compaction when assistant stopReason is not error", () => {
		const { handler, runtime } = captureHandler();
		const ctx = fakeCtx();

		handler(
			{
				type: "agent_end",
				messages: [
					{ role: "user", content: "hello" },
					{ role: "assistant", content: "done", stopReason: "tool_use" },
				],
			},
			ctx,
		);

		expect(runtime.compactInFlight).toBe(true);
	});

	it("triggers compaction when no assistant message exists", () => {
		const { handler, runtime } = captureHandler();
		const ctx = fakeCtx();

		handler(
			{
				type: "agent_end",
				messages: [{ role: "user", content: "hello" }],
			},
			ctx,
		);

		expect(runtime.compactInFlight).toBe(true);
	});

	it("finds last assistant among multiple messages", () => {
		const { handler, runtime } = captureHandler();
		const ctx = fakeCtx();

		// Earlier assistant succeeded, last one failed with retryable error
		handler(
			{
				type: "agent_end",
				messages: [
					{ role: "user", content: "hello" },
					{ role: "assistant", content: "ok", stopReason: "end_turn" },
					{ role: "toolResult", content: "result" },
					{ role: "assistant", content: [], stopReason: "error", errorMessage: "503 Service Unavailable" },
				],
			},
			ctx,
		);

		expect(runtime.compactInFlight).toBe(false);
	});
});
