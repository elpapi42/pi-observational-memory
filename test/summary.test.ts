import { describe, expect, it } from "vitest";
import { buildSummary } from "../src/summary.js";
import type { Observation, TomState } from "../src/state.js";

function obs(id: string, text: string, priority: Observation["priority"] = "med"): Observation {
	return { id, text, tokenCount: Math.ceil(text.length / 4), priority, createdAt: 0 };
}

function state(reflections: string, observations: Observation[]): TomState {
	return { version: 1, reflections, observations };
}

describe("buildSummary cache-stability invariant", () => {
	it("v2 (appended obs) has v1 as a byte-exact prefix (up to last obs of v1)", () => {
		const v1 = buildSummary(state("Reflections body.", [obs("a", "Observation A text.")]));
		const v2 = buildSummary(state("Reflections body.", [obs("a", "Observation A text."), obs("b", "Observation B text.")]));
		expect(v2.startsWith(v1)).toBe(true);
	});

	it("appending multiple observations stays prefix-stable", () => {
		const base: Observation[] = [];
		let prev = buildSummary(state("R", base));
		for (let i = 0; i < 5; i++) {
			base.push(obs(`o${i}`, `Content ${i} line.`));
			const next = buildSummary(state("R", base));
			expect(next.startsWith(prev)).toBe(true);
			prev = next;
		}
	});

	it("changing reflections breaks the prefix (full cache miss on reflection)", () => {
		const v1 = buildSummary(state("Old reflections.", [obs("a", "A.")]));
		const v2 = buildSummary(state("New reflections.", [obs("a", "A.")]));
		expect(v2.startsWith(v1)).toBe(false);
	});

	it("reordering observations breaks the prefix", () => {
		const v1 = buildSummary(state("R", [obs("a", "A."), obs("b", "B.")]));
		const v2 = buildSummary(state("R", [obs("b", "B."), obs("a", "A.")]));
		expect(v2.startsWith(v1)).toBe(false);
	});

	it("handles empty state without throwing", () => {
		const out = buildSummary(state("", []));
		expect(out).toContain("## Reflections");
		expect(out).toContain("## Observations");
	});
});
