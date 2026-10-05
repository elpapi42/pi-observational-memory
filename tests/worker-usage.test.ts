import { describe, expect, it } from "vitest";

import { OM_WORKER_COST } from "../src/session-ledger/types.js";
import {
	WorkerUsageAccumulator,
	addWorkerUsage,
	deltaWorkerUsage,
	workerCostFromEntries,
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

describe("workerCostFromEntries", () => {
	it("sums cost from worker cost entries across the given entries", () => {
		const total = workerCostFromEntries([
			{ type: "custom", customType: OM_WORKER_COST, data: { cost: 0.25 } },
			{ type: "custom", customType: OM_WORKER_COST, data: { cost: 1.5 } },
			{ type: "custom", customType: "om.observations.recorded", data: { cost: 99 } },
			{ type: "message", message: message(99) },
			null,
			"x",
		]);
		expect(total).toBeCloseTo(1.75);
	});

	it("ignores entries without a numeric cost", () => {
		expect(workerCostFromEntries([{ customType: OM_WORKER_COST, data: {} }])).toBe(0);
	});
});
