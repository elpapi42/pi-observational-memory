import { describe, expect, it } from "vitest";

import { normalizeSourceEntryIds, OBSERVATION_TIMESTAMP_PATTERN, ObserverStreamError, runObserver } from "../src/agents/observer/agent.js";
import { AGENT_LOOP_MAX_TOKENS } from "../src/model-budget.js";

function fakeAgentLoop(handler: (prompts: any[], context: any, config: any) => Promise<void> | void, events: any[] = []): any {
	return ((prompts: any[], context: any, config: any) => ({
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
		},
		result: async () => {
			await handler(prompts, context, config);
			return {};
		},
	})) as any;
}

interface CapturedToolResult {
	terminate?: boolean;
	details: Record<string, number>;
}

function assistantEndEvent(stopReason: string, errorMessage?: string): any {
	return { type: "message_end", message: { role: "assistant", stopReason, errorMessage } };
}

describe("runObserver maxTokens clamping", () => {
	function captureLoopConfig() {
		let loopConfig: any;
		const loop = fakeAgentLoop((_prompts, _context, config) => {
			loopConfig = config;
		});
		return { loop, config: () => loopConfig };
	}

	const args = {
		apiKey: "test",
		priorReflections: [],
		priorObservations: [],
		chunk: "[Source entry id: entry-a]\nUser asked for a memory update.",
		allowedSourceEntryIds: ["entry-a"],
	};

	it("clamps the loop maxTokens to a model whose maxTokens is below the configured budget", async () => {
		const { loop, config } = captureLoopConfig();

		await runObserver({
			...args,
			model: { maxTokens: 8_192 } as any,
			maxOutputTokens: 32_000,
			agentLoop: loop,
		});

		expect(config().maxTokens).toBe(8_192);
	});

	it("passes the configured maxOutputTokens through when the model advertises no maxTokens", async () => {
		const { loop, config } = captureLoopConfig();

		await runObserver({
			...args,
			model: {} as any,
			maxOutputTokens: 8_192,
			agentLoop: loop,
		});

		expect(config().maxTokens).toBe(8_192);
	});

	it("defaults the loop maxTokens to AGENT_LOOP_MAX_TOKENS", async () => {
		const { loop, config } = captureLoopConfig();

		await runObserver({ ...args, model: {} as any, agentLoop: loop });

		expect(config().maxTokens).toBe(AGENT_LOOP_MAX_TOKENS);
	});

	it("forwards sessionId to the agent loop config", async () => {
		const { loop, config } = captureLoopConfig();

		await runObserver({ ...args, model: {} as any, sessionId: "session-abc", agentLoop: loop });

		expect(config().sessionId).toBe("session-abc");
	});
});

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
	const baseArgs = {
		model: {} as any,
		apiKey: "test",
		priorReflections: [],
		priorObservations: [],
		chunk: "[Source entry id: entry-a]\nUser asked for a memory update.",
		allowedSourceEntryIds: ["entry-a"],
	};

	it("keeps core observer prompt rules", async () => {
		let systemPrompt = "";
		const loop = fakeAgentLoop((_prompts, context) => {
			systemPrompt = context.systemPrompt;
		});

		await runObserver({ ...baseArgs, agentLoop: loop });

		expect(systemPrompt).toContain("Preserve user assertions exactly");
		expect(systemPrompt).toContain("Detail preservation");
		expect(systemPrompt).toContain("Frame state changes as supersession");
		expect(systemPrompt).toContain("sourceEntryIds");
		expect(systemPrompt).toContain("zero observations");
		expect(systemPrompt).toContain("final valid record_observations call with complete=true");
		expect(systemPrompt).toContain("without a separate plain-text confirmation");
		expect(systemPrompt).toContain("Use complete=false for partial batches or corrections");
		expect(systemPrompt).toContain("simply do not call the tool and end with a plain-text confirmation");
		expect(systemPrompt).not.toContain("STOP calling the tool and reply with a brief plain-text confirmation");
		expect(systemPrompt).toContain("The dropper will drop these first");
		expect(systemPrompt).toContain("highest-resistance, load-bearing observations");
		expect(systemPrompt).not.toContain("will NEVER be dropped");
		expect(systemPrompt).not.toContain("pruner");
	});

	it("keeps prior memory before per-run time in the observer prompt", async () => {
		let userText = "";
		const priorReflection = "Reflection prefix value";
		const priorObservation = "Observation prefix value";
		const loop = fakeAgentLoop((prompts) => {
			userText = prompts[0].content[0].text;
		});

		await runObserver({
			...baseArgs,
			priorReflections: [priorReflection],
			priorObservations: [priorObservation],
			agentLoop: loop,
		});

		const reflectionsIndex = userText.indexOf("CURRENT REFLECTIONS:");
		const observationsIndex = userText.indexOf("CURRENT OBSERVATIONS:");
		const timeIndex = userText.indexOf("Current local time:");
		const chunkIndex = userText.indexOf("NEW CONVERSATION CHUNK:");
		const prefixBeforeTime = userText.slice(0, timeIndex);
		expect(reflectionsIndex).toBeGreaterThanOrEqual(0);
		expect(reflectionsIndex).toBeLessThan(observationsIndex);
		expect(observationsIndex).toBeLessThan(timeIndex);
		expect(timeIndex).toBeLessThan(chunkIndex);
		expect(prefixBeforeTime).toContain(priorReflection);
		expect(prefixBeforeTime).toContain(priorObservation);
		expect(userText).toContain("Use complete=false for partial batches or corrections, and use complete=true only on the final valid batch after the chunk is fully covered.");
		expect(userText).toContain("If no observations are warranted, do not call the tool and reply with a short plain-text confirmation.");
	});

	it("records V3 observations with source ids and code-computed tokenCount", async () => {
		const content = "User asked for a memory update.";
		let toolResult: CapturedToolResult | undefined;
		const loop = fakeAgentLoop(async (_prompts, context) => {
			toolResult = await context.tools[0].execute("tool-1", {
				observations: [{ timestamp: "2026-05-02 10:30", content, relevance: "high", sourceEntryIds: ["entry-a"] }],
				complete: true,
			});
		});

		const observations = await runObserver({ ...baseArgs, agentLoop: loop });

		expect(observations).toHaveLength(1);
		expect(toolResult?.terminate).toBe(true);
		expect(observations?.[0]).toMatchObject({
			content,
			timestamp: "2026-05-02 10:30",
			relevance: "high",
			sourceEntryIds: ["entry-a"],
			// tokenCount is code-computed from the full rendered line (id + timestamp + relevance + content).
			tokenCount: 18,
		});
		expect(observations?.[0].id).toMatch(/^[a-f0-9]{12}$/);
	});

	it("keeps an incomplete valid observation batch open", async () => {
		let toolResult: CapturedToolResult | undefined;
		const loop = fakeAgentLoop(async (_prompts, context) => {
			toolResult = await context.tools[0].execute("tool-1", {
				observations: [{ timestamp: "2026-05-02 10:30", content: "Partial observation", relevance: "medium", sourceEntryIds: ["entry-a"] }],
				complete: false,
			});
		});

		const observations = await runObserver({ ...baseArgs, agentLoop: loop });

		expect(observations?.map((observation) => observation.content)).toEqual(["Partial observation"]);
		expect(toolResult?.terminate).toBe(false);
	});

	it("rejects invented source ids and keeps the batch open", async () => {
		let toolResult: CapturedToolResult | undefined;
		const loop = fakeAgentLoop(async (_prompts, context) => {
			toolResult = await context.tools[0].execute("tool-1", {
				observations: [{ timestamp: "2026-05-02 10:30", content: "Bad source", relevance: "medium", sourceEntryIds: ["missing"] }],
				complete: true,
			});
		});

		await expect(runObserver({ ...baseArgs, agentLoop: loop })).resolves.toBeUndefined();
		expect(toolResult?.terminate).toBe(false);
		expect(toolResult?.details).toMatchObject({ added: 0, rejected: 1 });
	});

	it("dedupes deterministic ids", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				observations: [
					{ timestamp: "2026-05-02 10:30", content: "Same content", relevance: "medium", sourceEntryIds: ["entry-a"] },
					{ timestamp: "2026-05-02 10:31", content: "Same content", relevance: "high", sourceEntryIds: ["entry-a"] },
				],
				complete: true,
			});
		});

		const observations = await runObserver({ ...baseArgs, agentLoop: loop });

		expect(observations).toHaveLength(1);
		expect(observations?.[0].content).toBe("Same content");
	});

	it("keeps multi-batch observation coverage open until the final valid batch", async () => {
		const toolResults: CapturedToolResult[] = [];
		const loop = fakeAgentLoop(async (_prompts, context) => {
			toolResults.push(await context.tools[0].execute("tool-1", {
				observations: [{ timestamp: "2026-05-02 10:30", content: "First observation", relevance: "medium", sourceEntryIds: ["entry-a"] }],
				complete: false,
			}));
			toolResults.push(await context.tools[0].execute("tool-2", {
				observations: [{ timestamp: "2026-05-02 10:31", content: "Second observation", relevance: "high", sourceEntryIds: ["entry-a"] }],
				complete: true,
			}));
		});

		const observations = await runObserver({ ...baseArgs, agentLoop: loop });

		expect(observations?.map((observation) => observation.content)).toEqual(["First observation", "Second observation"]);
		expect(toolResults.map((result) => result.terminate)).toEqual([false, true]);
	});

	it("returns undefined when no tool call records observations", async () => {
		const loop = fakeAgentLoop(() => {});
		await expect(runObserver({ ...baseArgs, agentLoop: loop })).resolves.toBeUndefined();
	});

	it("throws ObserverStreamError when the stream errors with nothing recorded", async () => {
		for (const stopReason of ["error", "aborted"]) {
			const loop = fakeAgentLoop(() => {}, [assistantEndEvent(stopReason, "prompt is too long")]);
			const error = await runObserver({ ...baseArgs, agentLoop: loop }).catch((e) => e);
			expect(error).toBeInstanceOf(ObserverStreamError);
			expect(error.stopReason).toBe(stopReason);
			expect(error.message).toContain("prompt is too long");
		}
	});

	it("keeps partial observations when the stream errors after recording", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				observations: [{ timestamp: "2026-05-02 10:30", content: "Kept despite later error", relevance: "high", sourceEntryIds: ["entry-a"] }],
				complete: true,
			});
		}, [assistantEndEvent("error", "gateway timeout")]);

		const observations = await runObserver({ ...baseArgs, agentLoop: loop });

		expect(observations).toHaveLength(1);
		expect(observations?.[0].content).toBe("Kept despite later error");
	});

	it("uses maxTurns as an observer turn cap", async () => {
		let shouldStopAfterTurn: any;
		const loop = fakeAgentLoop((_prompts, _context, config) => {
			shouldStopAfterTurn = config.shouldStopAfterTurn;
		});

		await runObserver({ ...baseArgs, agentLoop: loop, maxTurns: 2 });

		expect(shouldStopAfterTurn).toBeTypeOf("function");
		expect(shouldStopAfterTurn({})).toBe(false);
		expect(shouldStopAfterTurn({})).toBe(true);
	});

	it("uses configured observer thinking level for reasoning models", async () => {
		let seenReasoning: unknown;
		const loop = fakeAgentLoop((_prompts, _context, config) => {
			seenReasoning = config.reasoning;
		});

		await runObserver({ ...baseArgs, model: { reasoning: true } as any, agentLoop: loop, thinkingLevel: "minimal" });

		expect(seenReasoning).toBe("minimal");
	});

	it("omits observer reasoning when thinkingLevel is off", async () => {
		let seenReasoning: unknown = "unset";
		const loop = fakeAgentLoop((_prompts, _context, config) => {
			seenReasoning = config.reasoning;
		});

		await runObserver({ ...baseArgs, model: { reasoning: true } as any, agentLoop: loop, thinkingLevel: "off" });

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

	it("rejects missing, empty, or hallucinated source ids", () => {
		expect(normalizeSourceEntryIds(undefined, allowed)).toBeUndefined();
		expect(normalizeSourceEntryIds([], allowed)).toBeUndefined();
		expect(normalizeSourceEntryIds(["entry-a", "not-in-the-chunk"], allowed)).toBeUndefined();
		expect(normalizeSourceEntryIds(["entry-a"], [])).toBeUndefined();
	});
});
