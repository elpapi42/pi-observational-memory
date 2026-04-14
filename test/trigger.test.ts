import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, batchSize } from "../src/config.js";
import { newTriggerState, shouldFire } from "../src/trigger.js";

describe("trigger", () => {
	it("fires when raw exceeds T and debounce passed", () => {
		const s = newTriggerState();
		const now = 10_000;
		expect(shouldFire(DEFAULT_CONFIG.T + 1, DEFAULT_CONFIG, s, now)).toBe(true);
	});

	it("does not fire below T", () => {
		const s = newTriggerState();
		expect(shouldFire(DEFAULT_CONFIG.T - 1, DEFAULT_CONFIG, s, 10_000)).toBe(false);
	});

	it("does not fire during debounce window", () => {
		const s = newTriggerState();
		s.lastToolCallAt = 10_000;
		expect(shouldFire(DEFAULT_CONFIG.T + 1, DEFAULT_CONFIG, s, 10_500)).toBe(false);
	});

	it("does not fire when a cycle is already in flight", () => {
		const s = newTriggerState();
		s.inFlight = true;
		expect(shouldFire(DEFAULT_CONFIG.T + 1, DEFAULT_CONFIG, s, 10_000)).toBe(false);
	});

	it("batchSize = T - S", () => {
		expect(batchSize(DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.T - DEFAULT_CONFIG.S);
	});
});
