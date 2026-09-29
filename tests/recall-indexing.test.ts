import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IDLE_DELAY_MS, registerRecallIndexing, SETTLE_BUDGET_MS, TURN_BUDGET_MS } from "../src/hooks/recall-indexing.js";

function setup(outcomes: Array<"complete" | "aborted" | undefined>) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const pi = { on: vi.fn((name: string, cb: (event: unknown, ctx: unknown) => void) => handlers.set(name, cb)) };
	const runtime = { ensureConfig: vi.fn() };
	const embeddings = {
		failure: undefined,
		failureNotified: false,
		scheduleIncrementalIndex: vi.fn(() => {
			const outcome = outcomes.shift();
			return outcome === undefined ? undefined : Promise.resolve(outcome);
		}),
		stopIncremental: vi.fn(),
		whenIdle: vi.fn(async () => {}),
	};
	let idle = true;
	const ctx = {
		cwd: "/tmp/project",
		hasUI: false,
		isIdle: () => idle,
		sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
	};
	registerRecallIndexing(pi as any, runtime as any, embeddings as any);
	const fire = async (name: string) => {
		handlers.get(name)!({ type: name }, ctx);
		await vi.advanceTimersByTimeAsync(0);
	};
	const budgets = () => embeddings.scheduleIncrementalIndex.mock.calls.map((call: any[]) => call[2].budgetMs);
	return { fire, embeddings, budgets, setBusy: () => (idle = false) };
}

describe("recall indexing schedule", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("embeds a short slice per turn and a long one on settle", async () => {
		const { fire, budgets } = setup(["aborted", "complete"]);
		await fire("turn_end");
		await fire("agent_settled");
		expect(budgets()).toEqual([TURN_BUDGET_MS, SETTLE_BUDGET_MS]);

		// A settle run that completes leaves nothing for idle time.
		await vi.advanceTimersByTimeAsync(IDLE_DELAY_MS * 2);
		expect(budgets()).toHaveLength(2);
	});

	it("keeps embedding after each idle delay until a run completes", async () => {
		const { fire, budgets } = setup(["aborted", "aborted", "complete"]);
		await fire("agent_settled");
		await vi.advanceTimersByTimeAsync(IDLE_DELAY_MS - 1);
		expect(budgets()).toEqual([SETTLE_BUDGET_MS]);
		await vi.advanceTimersByTimeAsync(1);
		expect(budgets()).toEqual([SETTLE_BUDGET_MS, SETTLE_BUDGET_MS]);
		await vi.advanceTimersByTimeAsync(IDLE_DELAY_MS);
		expect(budgets()).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(IDLE_DELAY_MS * 2);
		expect(budgets()).toHaveLength(3);
	});

	it("stops the idle chain when the agent starts or Pi is busy", async () => {
		const started = setup(["aborted", "aborted"]);
		await started.fire("agent_settled");
		await started.fire("agent_start");
		expect(started.embeddings.stopIncremental).toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(IDLE_DELAY_MS * 2);
		expect(started.budgets()).toHaveLength(1);

		const busy = setup(["aborted", "aborted"]);
		await busy.fire("agent_settled");
		busy.setBusy();
		await vi.advanceTimersByTimeAsync(IDLE_DELAY_MS * 2);
		expect(busy.budgets()).toHaveLength(1);
	});

	it("does nothing when there is nothing to schedule", async () => {
		const { fire, budgets } = setup([undefined]);
		await fire("agent_settled");
		await vi.advanceTimersByTimeAsync(IDLE_DELAY_MS * 2);
		expect(budgets()).toEqual([SETTLE_BUDGET_MS]);
	});
});
