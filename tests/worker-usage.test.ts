import { describe, expect, it } from "vitest";

import { sessionCostFromEntries } from "../src/session-cost.js";
import {
	WorkerUsageAccumulator,
	addWorkerUsage,
	deltaWorkerUsage,
	workerUsageFromMessage,
} from "../src/worker-usage.js";

const message = (cost: number, totalTokens = 100) => ({
	usage: {
		input: 10,
		output: 20,
		cacheRead: 30,
		cacheWrite: 40,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	},
});

describe("workerUsageFromMessage", () => {
	it("reads token and cost fields from an assistant message", () => {
		expect(workerUsageFromMessage(message(0.5))).toEqual({
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: 0.5,
		});
	});

	it("returns undefined for a message without usage", () => {
		expect(workerUsageFromMessage({ role: "assistant" })).toBeUndefined();
		expect(workerUsageFromMessage(undefined)).toBeUndefined();
	});

	it("returns undefined for an all-zero usage block", () => {
		expect(workerUsageFromMessage({ usage: { cost: { total: 0 } } })).toBeUndefined();
	});
});

describe("WorkerUsageAccumulator", () => {
	it("only records turn_end events and sums every turn", () => {
		const usage = new WorkerUsageAccumulator();
		usage.addEvent({ type: "message_start", message: message(9) });
		usage.addEvent({ type: "turn_end", message: message(1, 100) });
		usage.addEvent({ type: "turn_end", message: message(2, 50) });
		expect(usage.snapshot().cost).toBeCloseTo(3);
		expect(usage.snapshot().totalTokens).toBe(150);
	});

	it("snapshots are copies and deltas isolate a run", () => {
		const usage = new WorkerUsageAccumulator();
		usage.add(message(1));
		const before = usage.snapshot();
		usage.add(message(2));
		const after = usage.snapshot();
		const delta = deltaWorkerUsage(after, before);
		expect(delta.cost).toBeCloseTo(2);
		expect(before.cost).toBeCloseTo(1);
		expect(addWorkerUsage(before, delta).cost).toBeCloseTo(3);
	});
});

describe("sessionCostFromEntries", () => {
	it("sums assistant message usage and top-level entry usage", () => {
		const totals = sessionCostFromEntries([
			{ type: "message", message: message(1, 100) },
			{ type: "compaction", usage: { input: 5, totalTokens: 5, cost: { total: 0.25 } } },
			{ type: "custom", customType: "om.session.cost", data: {} },
		]);
		expect(totals.cost).toBeCloseTo(1.25);
		expect(totals.totalTokens).toBe(105);
	});

	it("ignores entries it cannot read", () => {
		expect(sessionCostFromEntries([null, 1, "x", {}]).cost).toBe(0);
	});
});
