import { describe, expect, it } from "vitest";

import { normalizeSourceEntryIds, OBSERVATION_TIMESTAMP_PATTERN, runObserver } from "../src/observer.js";

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

describe("OBSERVATION_TIMESTAMP_PATTERN", () => {
	it("matches local minute timestamps without regex shorthand escapes", () => {
		expect(OBSERVATION_TIMESTAMP_PATTERN).not.toContain("\\d");

		const pattern = new RegExp(OBSERVATION_TIMESTAMP_PATTERN);
		expect(pattern.test("2026-05-02 10:30")).toBe(true);
		expect(pattern.test("2026-5-02 10:30")).toBe(false);
		expect(pattern.test("2026-05-02T10:30")).toBe(false);
		expect(pattern.test("2026-05-02 10:30:00")).toBe(false);
	});
});

describe("runObserver", () => {
	it("uses a larger model-bounded output budget", async () => {
		const seenMaxTokens: number[] = [];
		const loop = fakeAgentLoop((_prompts, _context, config) => {
			seenMaxTokens.push(config.maxTokens);
		});
		const baseArgs = {
			apiKey: "test",
			priorReflections: [],
			priorObservations: [],
			chunk: "[Source entry id: entry-a]\nUser asked for a memory update.",
			allowedSourceEntryIds: ["entry-a"],
			agentLoop: loop,
		};

		await runObserver({ ...baseArgs, model: { maxTokens: 384_000 } as any });
		await runObserver({ ...baseArgs, model: { maxTokens: 8_192 } as any });

		expect(seenMaxTokens).toEqual([32_000, 8_192]);
	});

	it("uses maxTurns as an observer turn cap", async () => {
		let shouldStopAfterTurn: any;
		const loop = fakeAgentLoop((_prompts, _context, config) => {
			shouldStopAfterTurn = config.shouldStopAfterTurn;
		});

		await runObserver({
			model: {} as any,
			apiKey: "test",
			priorReflections: [],
			priorObservations: [],
			chunk: "[Source entry id: entry-a]\nUser asked for a memory update.",
			allowedSourceEntryIds: ["entry-a"],
			agentLoop: loop,
			maxTurns: 2,
		});

		expect(shouldStopAfterTurn).toBeTypeOf("function");
		expect(shouldStopAfterTurn({})).toBe(false);
		expect(shouldStopAfterTurn({})).toBe(true);
	});

	it("uses configured observer thinking level for reasoning models", async () => {
		let seenReasoning: unknown;
		const loop = fakeAgentLoop((_prompts, _context, config) => {
			seenReasoning = config.reasoning;
		});

		await runObserver({
			model: { reasoning: true } as any,
			apiKey: "test",
			priorReflections: [],
			priorObservations: [],
			chunk: "[Source entry id: entry-a]\nUser asked for a memory update.",
			allowedSourceEntryIds: ["entry-a"],
			agentLoop: loop,
			thinkingLevel: "minimal",
		});

		expect(seenReasoning).toBe("minimal");
	});

	it("omits observer reasoning when thinkingLevel is off", async () => {
		let seenReasoning: unknown = "unset";
		const loop = fakeAgentLoop((_prompts, _context, config) => {
			seenReasoning = config.reasoning;
		});

		await runObserver({
			model: { reasoning: true } as any,
			apiKey: "test",
			priorReflections: [],
			priorObservations: [],
			chunk: "[Source entry id: entry-a]\nUser asked for a memory update.",
			allowedSourceEntryIds: ["entry-a"],
			agentLoop: loop,
			thinkingLevel: "off",
		});

		expect(seenReasoning).toBeUndefined();
	});
});

describe("normalizeSourceEntryIds", () => {
	const allowed = ["entry-a", "entry-b", "entry-c"];

	it("accepts source ids from the allowed chunk and orders them by branch order", () => {
		expect(normalizeSourceEntryIds(["entry-c", "entry-a"], allowed)).toEqual(["entry-a", "entry-c"]);
	});

	it("dedupes repeated source ids", () => {
		expect(normalizeSourceEntryIds(["entry-b", "entry-b", "entry-a"], allowed)).toEqual(["entry-a", "entry-b"]);
	});

	it("rejects missing or empty source ids", () => {
		expect(normalizeSourceEntryIds(undefined, allowed)).toBeUndefined();
		expect(normalizeSourceEntryIds([], allowed)).toBeUndefined();
	});

	it("rejects hallucinated source ids instead of partially accepting them", () => {
		expect(normalizeSourceEntryIds(["entry-a", "not-in-the-chunk"], allowed)).toBeUndefined();
	});

	it("rejects ids when the allowed chunk has no source entries", () => {
		expect(normalizeSourceEntryIds(["entry-a"], [])).toBeUndefined();
	});
});
