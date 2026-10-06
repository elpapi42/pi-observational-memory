import { describe, expect, it, vi } from "vitest";

import { SYSTEM_ONE_DROPPER_DEFAULTS, normalizeSystemOneDropper } from "../src/config.js";
import { chunkObservations, runSystemOneDropper, scoreObservations } from "../src/agents/dropper/system-one/agent.js";
import type { ClassifierAnswer } from "../src/agents/dropper/system-one/classifier.js";
import {
	SIGNAL_KEYS,
	buildQuestions,
	buildState,
	collectSignals,
	dropProbability,
	parseQuestionKey,
	questionKey,
	rankCandidates,
} from "../src/agents/dropper/system-one/questions.js";
import { reflectionCoverageMap } from "../src/agents/dropper/coverage.js";
import { observation, reflection } from "./fixtures/session.js";

type Signals = { floor: number; redundant: number; superseded: number; lowSignal: number; safety: number };

const SAFE: Signals = { floor: 0.02, redundant: 0.95, superseded: 0.1, lowSignal: 0.1, safety: 1 };

function answersFor(signalsById: Record<string, Partial<Signals>>): Record<string, ClassifierAnswer> {
	const answers: Record<string, ClassifierAnswer> = {};
	for (const [id, signals] of Object.entries(signalsById)) {
		for (const key of SIGNAL_KEYS) {
			const value = signals[key];
			if (value === undefined) continue;
			answers[questionKey(id, key)] = key === "safety"
				? { type: "score", score: value * 2 }
				: { type: "bool", probability: value };
		}
	}
	return answers;
}

/** A classifier registry whose one model answers with `answers`. */
function fakeRegistry(answers: Record<string, ClassifierAnswer>, usage?: { input?: number }) {
	const model = { provider: "local-jev", id: "test-model" };
	const classify = vi.fn(async () => ({ answers, usage, stopReason: "stop" }));
	return {
		model,
		classify,
		getModelsOfType: (type: string, provider?: string) =>
			type === "classifier" && provider === "local-jev" ? [model] : [],
		findOfType: (type: string, provider: string, id: string) =>
			type === "classifier" && provider === "local-jev" && id === model.id ? model : undefined,
	};
}

describe("system one dropper config", () => {
	it("ignores a non-object block so the LLM dropper stays in place", () => {
		expect(normalizeSystemOneDropper(undefined)).toBeUndefined();
		expect(normalizeSystemOneDropper("local-jev")).toBeUndefined();
	});

	it("fills every field from defaults and takes a configured provider", () => {
		expect(normalizeSystemOneDropper({ provider: "other" })).toEqual({
			...SYSTEM_ONE_DROPPER_DEFAULTS,
			provider: "other",
		});
	});

	it("scores every observation without deciding", async () => {
		const obsA = observation("aaaaaaaaaaaa", { relevance: "medium" });
		const registry = fakeRegistry(answersFor({ aaaaaaaaaaaa: SAFE }));

		const result = await scoreObservations({
			config: { ...SYSTEM_ONE_DROPPER_DEFAULTS },
			registry: registry as any,
			reflections: [],
			observations: [obsA],
			targetTokens: 1,
		});

		expect(result.signalsById.get("aaaaaaaaaaaa")?.redundant).toBe(SAFE.redundant);
		expect(result.requestCount).toBe(1);
		expect(registry.classify).toHaveBeenCalledOnce();
	});

	it("keeps a configured provider when a threshold is malformed", () => {
		const config = normalizeSystemOneDropper({
			provider: "other",
			vetoThreshold: 1.7,
			dropThreshold: "high",
		});

		expect(config?.provider).toBe("other");
		expect(config?.vetoThreshold).toBe(SYSTEM_ONE_DROPPER_DEFAULTS.vetoThreshold);
		expect(config?.dropThreshold).toBe(SYSTEM_ONE_DROPPER_DEFAULTS.dropThreshold);
	});

	it("accepts the boundary probabilities", () => {
		expect(normalizeSystemOneDropper({ vetoThreshold: 0, dropThreshold: 1 })).toMatchObject({
			vetoThreshold: 0,
			dropThreshold: 1,
		});
	});

	it("defaults to shadow so a new classifier scores without changing any drop", () => {
		expect(normalizeSystemOneDropper({ provider: "other" })?.mode).toBe("shadow");
		expect(normalizeSystemOneDropper({ mode: "primary" })?.mode).toBe("primary");
		expect(normalizeSystemOneDropper({ mode: "off" })?.mode).toBe("off");
		expect(normalizeSystemOneDropper({ mode: "enabled" })?.mode).toBe("shadow");
	});
});

describe("system one questions", () => {
	const obsA = observation("aaaaaaaaaaaa", { relevance: "medium" });
	const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);

	it("asks one question per signal and round-trips the key", () => {
		const questions = buildQuestions("aaaaaaaaaaaa");

		expect(Object.keys(questions)).toHaveLength(SIGNAL_KEYS.length);
		expect(parseQuestionKey(questionKey("aaaaaaaaaaaa", "floor")))
			.toEqual({ observationId: "aaaaaaaaaaaa", signal: "floor" });
		expect(parseQuestionKey("aaaaaaaaaaaa:unknown")).toBeUndefined();
	});

	it("carries the preservation floor and the coverage tier into the request", () => {
		const floor = buildQuestions("aaaaaaaaaaaa")[questionKey("aaaaaaaaaaaa", "floor")];
		expect(JSON.stringify(floor.instructions)).toContain("exact error messages");

		const state = buildState([obsA], [ref], reflectionCoverageMap([obsA], [ref]));
		expect(state.observations[0]).toMatchObject({ id: "aaaaaaaaaaaa", reflectionCoverage: "partial" });
		expect(state.reflections[0].id).toBe("eeeeeeeeeeee");
	});

	it("normalizes a score answer onto [0, 1] and drops observations with a missing signal", () => {
		const complete = collectSignals(answersFor({ aaaaaaaaaaaa: SAFE }));
		expect(complete.get("aaaaaaaaaaaa")?.safety).toBe(1);

		const { safety, ...withoutSafety } = SAFE;
		expect(collectSignals(answersFor({ aaaaaaaaaaaa: withoutSafety })).size).toBe(0);
	});

	it("multiplies drop evidence by the safety rubric so one signal cannot carry a drop", () => {
		expect(dropProbability({ ...SAFE, redundant: 1, safety: 0.2 })).toBeCloseTo(0.2);
		expect(dropProbability({ ...SAFE, redundant: 0.2, safety: 1 })).toBeCloseTo(0.2);
	});
});

describe("system one candidate ranking", () => {
	const obsA = observation("aaaaaaaaaaaa", { relevance: "medium" });
	const obsB = observation("bbbbbbbbbbbb", { relevance: "low" });

	it("vetoes on the preservation floor even when every drop signal is certain", () => {
		const signals = collectSignals(answersFor({
			aaaaaaaaaaaa: { floor: 0.2, redundant: 1, superseded: 1, lowSignal: 1, safety: 1 },
		}));

		const ranked = rankCandidates([obsA], signals, 0.15, 0.75);

		expect(ranked.candidates).toEqual([]);
		expect(ranked.vetoedCount).toBe(1);
	});

	it("ranks by drop probability and excludes anything below the threshold", () => {
		const signals = collectSignals(answersFor({
			aaaaaaaaaaaa: { ...SAFE, redundant: 0.8, safety: 1 },
			bbbbbbbbbbbb: { ...SAFE, redundant: 1, safety: 1 },
		}));

		const ranked = rankCandidates([obsA, obsB], signals, 0.15, 0.85);

		expect(ranked.candidates.map((candidate) => candidate.id)).toEqual(["bbbbbbbbbbbb"]);
		expect(ranked.belowThresholdCount).toBe(1);
	});

	it("counts observations the classifier never scored instead of dropping them", () => {
		const ranked = rankCandidates([obsA, obsB], collectSignals(answersFor({ aaaaaaaaaaaa: SAFE })), 0.15, 0.75);

		expect(ranked.missingSignalsCount).toBe(1);
		expect(ranked.candidates.map((candidate) => candidate.id)).toEqual(["aaaaaaaaaaaa"]);
	});
});

describe("runSystemOneDropper", () => {
	const obsA = observation("aaaaaaaaaaaa", { relevance: "medium", tokenCount: 40 });
	const obsB = observation("bbbbbbbbbbbb", { relevance: "low", tokenCount: 40 });
	const baseArgs = {
		config: { ...SYSTEM_ONE_DROPPER_DEFAULTS },
		reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])],
		observations: [obsA, obsB],
		targetTokens: 20,
	};

	it("returns undefined without classifying when the pool is under target", async () => {
		const registry = fakeRegistry({});

		await expect(runSystemOneDropper({
			...baseArgs,
			targetTokens: 1_000_000,
			registry: registry as any,
		})).resolves.toBeUndefined();
		expect(registry.classify).not.toHaveBeenCalled();
	});

	it("drops the highest-probability candidate within the pool budget", async () => {
		const registry = fakeRegistry(answersFor({
			aaaaaaaaaaaa: { ...SAFE, redundant: 1, safety: 1 },
			bbbbbbbbbbbb: { ...SAFE, redundant: 0.1, superseded: 0.1, lowSignal: 0.1, safety: 0.1 },
		}), { input: 500 });

		await expect(runSystemOneDropper({ ...baseArgs, registry: registry as any }))
			.resolves.toEqual(["aaaaaaaaaaaa"]);
	});

	it("returns undefined when every observation is vetoed by the preservation floor", async () => {
		const registry = fakeRegistry(answersFor({
			aaaaaaaaaaaa: { ...SAFE, floor: 0.9 },
			bbbbbbbbbbbb: { ...SAFE, floor: 0.9 },
		}));

		await expect(runSystemOneDropper({ ...baseArgs, registry: registry as any }))
			.resolves.toBeUndefined();
	});

	it("fans questions across requests while sending the whole pool as state each time", async () => {
		const states: unknown[] = [];
		const model = { provider: "local-jev", id: "test-model" };
		const classify = vi.fn(async (_model: unknown, context: { state: unknown }) => {
			states.push(context.state);
			return { answers: answersFor({ aaaaaaaaaaaa: SAFE }), stopReason: "stop" };
		});
		const registry = { model, classify, getModelsOfType: () => [model] };

		await runSystemOneDropper({
			...baseArgs,
			config: { ...baseArgs.config, maxQuestionsPerRequest: SIGNAL_KEYS.length },
			registry: registry as any,
		});

		expect(classify).toHaveBeenCalledTimes(2);
		expect((states[0] as any).observations).toHaveLength(2);
		expect(states[0]).toEqual(states[1]);
	});

	it("throws a clear error when no classifier model is registered", async () => {
		await expect(runSystemOneDropper({ ...baseArgs, registry: { getModelsOfType: () => [] } as any }))
			.rejects.toThrow(/no classifier model registered/);
	});

	it("packs as many observations per request as the question budget allows", () => {
		const observations = Array.from({ length: 7 }, (_, index) =>
			observation(`${index}`.padStart(12, "a"), { relevance: "low" }));

		expect(chunkObservations(observations, SIGNAL_KEYS.length * 3).map((chunk) => chunk.length)).toEqual([3, 3, 1]);
		expect(chunkObservations(observations, 1).map((chunk) => chunk.length)).toEqual([1, 1, 1, 1, 1, 1, 1]);
	});
});
