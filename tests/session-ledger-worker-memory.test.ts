import { describe, expect, it } from "vitest";

import { boundWorkerMemory } from "../src/session-ledger/index.js";
import { observation, reflection } from "./fixtures/session.js";

const reflections = [1, 2, 3, 4].map((i) => reflection(`e${i}`.padEnd(12, "e"), ["aaaaaaaaaaaa"], { content: `Reflection ${i} ${"r".repeat(120)}` }));
const observations = [1, 2, 3, 4].map((i) => observation(`a${i}`.padEnd(12, "a"), { content: `Observation ${i} ${"o".repeat(120)}` }));

describe("bounded worker memory", () => {
	it("returns everything without a positive budget", () => {
		const slice = boundWorkerMemory(reflections, observations, 0);

		expect(slice.reflections).toHaveLength(4);
		expect(slice.observations).toHaveLength(4);
		expect(slice.omittedReflections + slice.omittedObservations).toBe(0);
	});

	it("keeps the newest records within the budget, observations guaranteed half", () => {
		// Observation lines ~47 tokens, reflection lines ~39: a 200-token budget holds 2 of each.
		const slice = boundWorkerMemory(reflections, observations, 200);

		expect(slice.observations.map((obs) => obs.id)).toEqual(["a3aaaaaaaaaa", "a4aaaaaaaaaa"]);
		expect(slice.reflections.map((ref) => ref.id)).toEqual(["e3eeeeeeeeee", "e4eeeeeeeeee"]);
		expect(slice.omittedObservations).toBe(2);
		expect(slice.omittedReflections).toBe(2);
	});

	it("serves the oldest observations to the dropper", () => {
		const slice = boundWorkerMemory(reflections, observations, 200, { observationsFrom: "oldest" });

		expect(slice.observations.map((obs) => obs.id)).toEqual(["a1aaaaaaaaaa", "a2aaaaaaaaaa"]);
		expect(slice.reflections.map((ref) => ref.id)).toEqual(["e3eeeeeeeeee", "e4eeeeeeeeee"]);
	});

	it("lets reflections reclaim budget observations do not use", () => {
		const slice = boundWorkerMemory(reflections, observations.slice(0, 1), 200);

		// 2 reflections would fit alone in the half not reserved; with one small
		// observation all 4 reflections fit.
		expect(slice.observations).toHaveLength(1);
		expect(slice.reflections).toHaveLength(4);
	});
});
