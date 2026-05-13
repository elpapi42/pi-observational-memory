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

function fakeAgentLoop(handler: (prompts: any[], context: any) => Promise<void> | void): any {
	return ((prompts: any[], context: any) => ({
		async *[Symbol.asyncIterator]() {
			// No streaming events needed for these tests.
		},
		result: async () => {
			await handler(prompts, context);
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
		expect(PRUNER_SYSTEM).toContain("\"critical\": NEVER drop");
		expect(buildPrunerPassGuidance(1, 5)).toContain("old low/medium [coverage: cited]");
		expect(buildPrunerPassGuidance(2, 5)).toContain("old [coverage: reinforced] low/medium observations as default drops");
		expect(buildPrunerPassGuidance(3, 5)).toContain("Drop old [coverage: cited] or [coverage: reinforced] \"high\" observations");
		expect(buildPrunerPassGuidance(3, 5)).toContain("[coverage: uncited]");
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

		expect(result).toEqual({ observations, droppedIds: [], fellBack: false });
	});

	it("does not add coverage tags to reflector prompts", async () => {
		const loop = fakeAgentLoop((prompts) => {
			const text = promptText(prompts);
			expect(text).not.toContain("[coverage:");
		});

		await runReflector({ model: {} as any, apiKey: "test", agentLoop: loop }, [], observations);
	});
});
