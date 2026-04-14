import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type TomConfig } from "../src/config.js";
import { newTriggerState, shouldFire } from "../src/trigger.js";

const cfg: TomConfig = { ...DEFAULT_CONFIG, keepRecentTokens: 20_000 };

describe("trigger", () => {
	it("fires when raw exceeds T and debounce passed", () => {
		const s = newTriggerState();
		const now = 10_000;
		expect(shouldFire(cfg.T + 1, cfg, s, now)).toBe(true);
	});

	it("does not fire below T", () => {
		const s = newTriggerState();
		expect(shouldFire(cfg.T - 1, cfg, s, 10_000)).toBe(false);
	});

	it("does not fire during debounce window", () => {
		const s = newTriggerState();
		s.lastToolCallAt = 10_000;
		expect(shouldFire(cfg.T + 1, cfg, s, 10_500)).toBe(false);
	});

	it("does not fire when a cycle is already in flight", () => {
		const s = newTriggerState();
		s.inFlight = true;
		expect(shouldFire(cfg.T + 1, cfg, s, 10_000)).toBe(false);
	});
});
