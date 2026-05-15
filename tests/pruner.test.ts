import { describe, expect, it } from "vitest";

import {
	deriveObservationCoverageTags,
	observationPoolTokens,
	renderObservationsForPrunerPrompt,
	renderSummary,
	runPruner,
	runReflector,
} from "../src/compaction.js";
import { observationsToPromptLines } from "../src/observer.js";
import { hashId } from "../src/ids.js";
import { buildPrunerPassGuidance, PRUNER_SYSTEM } from "../src/prompts.js";
import { estimateStringTokens } from "../src/tokens.js";
import type { MemoryReflection, ObservationRecord, ReflectionRecord } from "../src/types.js";

const obsA: ObservationRecord = {
	id: "111111111111",
	timestamp: "2026-05-03 10:00",
	relevance: "high",
	content: "User prefers coverage-aware pruning tags.",
	sourceEntryIds: ["entry-a"],
};

const obsB: ObservationRecord = {
	id: "222222222222",
	timestamp: "2026-05-03 10:01",
	relevance: "medium",
	content: "User likes the reinforced coverage tag name.",
	sourceEntryIds: ["entry-b"],
};

const obsC: ObservationRecord = {
	id: "333333333333",
	timestamp: "2026-05-03 10:02",
	relevance: "low",
	content: "Routine status update.",
	sourceEntryIds: ["entry-c"],
};

const observations = [obsA, obsB, obsC];

function reflection(content: string, supportingObservationIds: string[]): ReflectionRecord {
	return {
		id: hashId(content),
		content,
		supportingObservationIds,
	};
}

function legacyReflection(content: string, supportingObservationIds: string[] = []): ReflectionRecord {
	return {
		id: hashId(content),
		content,
		supportingObservationIds,
		legacy: true,
	};
}

function fakeAgentLoop(handler: (prompts: any[], context: any, config: any) => Promise<void> | void): any {
	return ((prompts: any[], context: any, config: any) => ({
		async *[Symbol.asyncIterator]() {
			// No streaming events needed for these tests.
		},
		result: async () => {
			await handler(prompts, context, config);
			return {};
		},
	})) as any;
}

function promptText(prompts: any[]): string {
	return prompts[0].content[0].text;
}

describe("observation coverage tags", () => {
	it("derives uncited, cited, and reinforced tags from native reflection provenance", () => {
		const reflections: MemoryReflection[] = [
			reflection("A is cited once.", [obsA.id]),
			reflection("B is cited first.", [obsB.id]),
			reflection("B is cited second.", [obsB.id]),
			reflection("B is cited third.", [obsB.id]),
			reflection("C is cited first.", [obsC.id]),
			reflection("C is cited second.", [obsC.id]),
			reflection("C is cited third.", [obsC.id]),
			reflection("C is cited fourth.", [obsC.id]),
		];

		const tags = deriveObservationCoverageTags(reflections, observations);

		expect(tags.get(obsA.id)).toBe("cited");
		expect(tags.get(obsB.id)).toBe("cited");
		expect(tags.get(obsC.id)).toBe("reinforced");
	});

	it("ignores legacy/no-provenance reflections, plain strings, and support ids outside the active pool", () => {
		const reflections: MemoryReflection[] = [
			legacyReflection("Legacy support does not count.", [obsA.id]),
			"Plain legacy reflection cannot cite active observations.",
			reflection("Out-of-pool support is ignored.", ["aaaaaaaaaaaa"]),
			reflection("Current support counts.", [obsB.id, "aaaaaaaaaaaa"]),
		];

		const tags = deriveObservationCoverageTags(reflections, observations);

		expect(tags.get(obsA.id)).toBe("uncited");
		expect(tags.get(obsB.id)).toBe("cited");
		expect(tags.get(obsC.id)).toBe("uncited");
		expect(tags.has("aaaaaaaaaaaa")).toBe(false);
	});

	it("renders coverage tags only in pruner observation prompts", () => {
		const tags = new Map([
			[obsA.id, "uncited" as const],
			[obsB.id, "cited" as const],
			[obsC.id, "reinforced" as const],
		]);

		const rendered = renderObservationsForPrunerPrompt(observations, tags);

		expect(rendered).toContain(`[${obsA.id}] ${obsA.timestamp} [high] [coverage: uncited] ${obsA.content}`);
		expect(rendered).toContain(`[${obsB.id}] ${obsB.timestamp} [medium] [coverage: cited] ${obsB.content}`);
		expect(rendered).toContain(`[${obsC.id}] ${obsC.timestamp} [low] [coverage: reinforced] ${obsC.content}`);
		expect(renderSummary([], observations)).not.toContain("[coverage:");
	});
});

describe("observation pool token accounting", () => {
	it("counts rendered observation metadata toward the pruning budget", () => {
		const renderedObservationTokens = estimateStringTokens(observationsToPromptLines(observations).join("\n"));
		const contentOnlyTokens = observations.reduce((sum, obs) => sum + estimateStringTokens(obs.content), 0);

		expect(observationPoolTokens(observations)).toBe(renderedObservationTokens);
		expect(observationPoolTokens(observations)).toBeGreaterThan(contentOnlyTokens);
		expect(observationPoolTokens([])).toBe(0);
	});
});

describe("coverage-aware pruner prompts", () => {
	it("defines stronger coverage-aware pruning semantics in the pruner prompt and pass guidance", () => {
		expect(PRUNER_SYSTEM).toContain("[coverage: uncited]");
		expect(PRUNER_SYSTEM).toContain("Prune cautiously");
		expect(PRUNER_SYSTEM).toContain("[coverage: cited]");
		expect(PRUNER_SYSTEM).toContain("strong pruning candidate");
		expect(PRUNER_SYSTEM).toContain("[coverage: reinforced]");
		expect(PRUNER_SYSTEM).toContain("presumptive drop candidate");
		expect(PRUNER_SYSTEM).toContain("Coverage tags are strong signals, not blind commands");
		expect(PRUNER_SYSTEM).toContain("Dropping an observation removes it from active compacted memory");
		expect(PRUNER_SYSTEM).toContain("exact evidence can still be recovered later through recall of the reflection id");
		expect(PRUNER_SYSTEM).toContain("pruning is active-memory management, not source deletion");
		expect(PRUNER_SYSTEM).not.toContain("erased from the assistant's memory");
		expect(PRUNER_SYSTEM).toContain("\"critical\": NEVER drop");
		expect(PRUNER_SYSTEM).toContain("User assertions and concrete completions are never droppable");
		expect(buildPrunerPassGuidance(1, 2)).toContain("clear-cut source-backed drops only");
		expect(buildPrunerPassGuidance(1, 2)).toContain("old low/medium [coverage: cited]");
		expect(buildPrunerPassGuidance(1, 2)).toContain("Do not touch ambiguous [coverage: uncited]");
		expect(buildPrunerPassGuidance(2, 2)).toContain("final topic compression, aggressive age compression, and budget-pressure rescue");
		expect(buildPrunerPassGuidance(2, 2)).toContain("old [coverage: reinforced] observations as active-memory redundancies by default");
		expect(buildPrunerPassGuidance(2, 2)).toContain("Drop old [coverage: cited] high observations only");
		expect(buildPrunerPassGuidance(2, 2)).toContain("Prefer source-backed reinforced/cited drops over any uncited drop");
		expect(buildPrunerPassGuidance(2, 2)).toContain("Do not fabricate drops solely to hit the target");
	});

	it("passes coverage-tagged observations to the pruner loop", async () => {
		const loop = fakeAgentLoop((prompts) => {
			const text = promptText(prompts);
			expect(text).toContain(`[${obsA.id}] ${obsA.timestamp} [high] [coverage: cited] ${obsA.content}`);
			expect(text).toContain(`[${obsB.id}] ${obsB.timestamp} [medium] [coverage: reinforced] ${obsB.content}`);
			expect(text).toContain(`[${obsC.id}] ${obsC.timestamp} [low] [coverage: uncited] ${obsC.content}`);
		});
		const reflections: MemoryReflection[] = [
			reflection("A cited.", [obsA.id]),
			reflection("B cited 1.", [obsB.id]),
			reflection("B cited 2.", [obsB.id]),
			reflection("B cited 3.", [obsB.id]),
			reflection("B cited 4.", [obsB.id]),
		];

		const result = await runPruner({ model: {} as any, apiKey: "test", agentLoop: loop }, reflections, observations, 1);

		expect(result).toMatchObject({
			observations,
			droppedIds: [],
			fellBack: false,
			stopReason: "zero_drops",
			passes: [{ pass: 1, dropped: 0, remaining: observations.length, fellBack: false }],
		});
	});

	it("uses a larger model-bounded output budget for reflector and pruner passes", async () => {
		const seenMaxTokens: number[] = [];
		const loop = fakeAgentLoop((_prompts, _context, config) => {
			seenMaxTokens.push(config.maxTokens);
		});

		await runReflector(
			{ model: { maxTokens: 384_000 } as any, apiKey: "test", agentLoop: loop },
			[],
			observations,
		);
		await runPruner(
			{ model: { maxTokens: 384_000 } as any, apiKey: "test", agentLoop: loop },
			[],
			observations,
			1,
		);
		await runPruner(
			{ model: { maxTokens: 8_192 } as any, apiKey: "test", agentLoop: loop },
			[],
			observations,
			1,
		);

		expect(seenMaxTokens).toEqual([32_000, 32_000, 32_000, 8_192]);
	});

	it("reports dropped observations and under-target stop reason", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("drop-1", { ids: [obsC.id] });
		});
		const reflections: MemoryReflection[] = [
			reflection("A cited.", [obsA.id]),
			reflection("B cited.", [obsB.id]),
			reflection("C cited.", [obsC.id]),
		];
		const targetBudget = Math.ceil((observationPoolTokens([obsA, obsB]) + 1) / 0.8);

		const result = await runPruner({ model: {} as any, apiKey: "test", agentLoop: loop }, reflections, observations, targetBudget);

		expect(result.observations).toEqual([obsA, obsB]);
		expect(result.droppedIds).toEqual([obsC.id]);
		expect(result.fellBack).toBe(false);
		expect(result.stopReason).toBe("under_target");
		expect(result.passes).toMatchObject([
			{ pass: 1, dropped: 1, remaining: 2, fellBack: false },
		]);
	});

	it("does not add coverage tags to reflector prompts", async () => {
		const loop = fakeAgentLoop((prompts) => {
			const text = promptText(prompts);
			expect(text).not.toContain("[coverage:");
		});

		await runReflector({ model: {} as any, apiKey: "test", agentLoop: loop }, [], observations);
	});

	it("calls onEvent callback with agent events during pruner passes", async () => {
		const events: string[] = [];
		const loop = fakeAgentLoop((_prompts) => {
			// No drops — pruner returns immediately
		});

		const emittingLoop = ((prompts: any[], context: any) => {
			const inner = loop(prompts, context);
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "tool_execution_start", toolCallId: "tc1", toolName: "drop_observations", args: {} };
					yield { type: "turn_start" };
				},
				result: inner.result,
			};
		}) as any;

		// Need at least one reflection so some observations are prunable (cited/reinforced)
		const localReflections: MemoryReflection[] = [
			reflection("A cited.", [obsA.id]),
		];

		await runPruner(
			{ model: {} as any, apiKey: "test", agentLoop: emittingLoop, onEvent: (event) => { events.push(event.type); } },
			localReflections,
			observations,
			1,
		);

		expect(events).toContain("tool_execution_start");
		expect(events).toContain("turn_start");
	});

	it("calls onPassStart for pruner passes that run", async () => {
		const passStarts: string[] = [];
		const loop = fakeAgentLoop((_prompts) => {
			// No drops — pruner breaks after first pass with 0 drops
		});
		const localReflections: MemoryReflection[] = [
			reflection("A cited.", [obsA.id]),
		];

		await runPruner(
			{ model: {} as any, apiKey: "test", agentLoop: loop },
			localReflections,
			observations,
			1,
			(pass, max) => { passStarts.push(`${pass}/${max}`); },
		);

		// Only pass 1 runs because no drops cause early exit
		expect(passStarts).toEqual(["1/2"]);
	});

	it("passes maxTurns as a pruner turn cap", async () => {
		let shouldStopAfterTurn: any;
		const loop = fakeAgentLoop((_prompts, _context, config) => {
			shouldStopAfterTurn = config.shouldStopAfterTurn;
		});

		await runPruner(
			{ model: {} as any, apiKey: "test", agentLoop: loop, maxTurns: 3 },
			[],
			observations,
			1,
		);

		expect(shouldStopAfterTurn).toBeTypeOf("function");
		expect(shouldStopAfterTurn({})).toBe(false);
		expect(shouldStopAfterTurn({})).toBe(false);
		expect(shouldStopAfterTurn({})).toBe(true);
	});

	it("uses configured pruner thinking level for reasoning models", async () => {
		let seenReasoning: unknown;
		const loop = fakeAgentLoop((_prompts, _context, config) => {
			seenReasoning = config.reasoning;
		});

		await runPruner(
			{ model: { reasoning: true } as any, apiKey: "test", agentLoop: loop, thinkingLevel: "minimal" },
			[],
			observations,
			1,
		);

		expect(seenReasoning).toBe("minimal");
	});

	it("omits pruner reasoning when thinkingLevel is off", async () => {
		let seenReasoning: unknown = "unset";
		const loop = fakeAgentLoop((_prompts, _context, config) => {
			seenReasoning = config.reasoning;
		});

		await runPruner(
			{ model: { reasoning: true } as any, apiKey: "test", agentLoop: loop, thinkingLevel: "off" },
			[],
			observations,
			1,
		);

		expect(seenReasoning).toBeUndefined();
	});
});
