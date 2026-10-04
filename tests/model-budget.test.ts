import { describe, expect, it } from "vitest";

import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../src/model-budget.js";

describe("boundedMaxTokens", () => {
	it("defaults the requested budget to AGENT_LOOP_MAX_TOKENS", () => {
		expect(AGENT_LOOP_MAX_TOKENS).toBe(32_000);
		expect(boundedMaxTokens({} as any)).toBe(AGENT_LOOP_MAX_TOKENS);
	});

	it("uses the requested budget when the model's own maxTokens is larger", () => {
		expect(boundedMaxTokens({ maxTokens: 64_000 } as any, 8_192)).toBe(8_192);
	});

	it("clamps the requested budget down to the model's own maxTokens", () => {
		// A higher configured budget (e.g. agentMaxTokens above the model
		// limit) must never be sent as the response budget.
		expect(boundedMaxTokens({ maxTokens: 8_192 } as any, AGENT_LOOP_MAX_TOKENS)).toBe(8_192);
		expect(boundedMaxTokens({ maxTokens: 8_192 } as any, 64_000)).toBe(8_192);
	});

	it("ignores non-positive model maxTokens values", () => {
		expect(boundedMaxTokens({ maxTokens: 0 } as any, 8_192)).toBe(8_192);
		expect(boundedMaxTokens({ maxTokens: -1 } as any, 8_192)).toBe(8_192);
	});
});
