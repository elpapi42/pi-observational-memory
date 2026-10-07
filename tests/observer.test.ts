import { describe, expect, it } from "vitest";

import { normalizeSourceEntryIds, OBSERVATION_TIMESTAMP_PATTERN, ObserverStreamError, runObserver } from "../src/agents/observer/agent.js";
import { AGENT_LOOP_MAX_TOKENS } from "../src/model-budget.js";

function fakeAgentLoop(
	handler: (prompts: any[], context: any, config: any) => Promise<void> | void,
	events: any[] = [],
	resultError?: Error,
): any {
	return (prompts: any[], context: any, config: any) => ({
		async *[Symbol.asyncIterator]() {
			const calls: Array<{ id: string; name: string; arguments: unknown; result: any }> = [];
			const instrumentedContext = {
				...context,
				tools: context.tools.map((tool: any) => ({
					...tool,
					execute: async (id: string, toolArguments: unknown) => {
						const result = await tool.execute(id, toolArguments);
						calls.push({ id, name: tool.name, arguments: toolArguments, result });
						return result;
					},
				})),
			};
			yield { type: "turn_start" };
			await handler(prompts, instrumentedContext, config);
			for (const call of calls) {
				yield {
					type: "tool_execution_end",
					toolCallId: call.id,
					toolName: call.name,
					result: call.result,
					isError: false,
				};
			}
			yield {
				type: "turn_end",
				message: {
					role: "assistant",
					stopReason: calls.length > 0 ? "toolUse" : "stop",
					content: calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments })),
				},
				toolResults: calls.map((call) => call.result),
			};
			for (const event of events) yield event;
			yield { type: "agent_end", messages: [] };
		},
		result: async () => {
			if (resultError) throw resultError;
			return {};
		},
	});
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
			systemPrompt = context.messages[0]?.role === "system" ? context.messages[0].content : "";
		});

		await runObserver({ ...baseArgs, agentLoop: loop });

		expect(systemPrompt).toContain("Preserve user assertions exactly");
		expect(systemPrompt).toContain("Detail preservation");
		expect(systemPrompt).toContain("Frame state changes as supersession");
		expect(systemPrompt).toContain("sourceEntryIds");
		expect(systemPrompt).toContain("observations:[] and complete=true");
		expect(systemPrompt).toContain("final valid record_observations call with complete=true");
		expect(systemPrompt).toContain("plain-text response without that explicit call leaves the chunk unfinished");
		expect(systemPrompt).toContain("Use complete=false for partial batches or corrections");
		expect(systemPrompt).toContain("No tool call leaves the chunk unfinished");
		expect(systemPrompt).not.toContain("STOP calling the tool and reply with a brief plain-text confirmation");
		expect(systemPrompt).toContain("The dropper will drop these first");
		expect(systemPrompt).toContain("highest-resistance, load-bearing observations");
		expect(systemPrompt).not.toContain("will NEVER be dropped");
		expect(systemPrompt).not.toContain("pruner");
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

		expect(toolResult?.terminate).toBe(true);
		expect(observations).toMatchObject({
			kind: "completed",
			records: [{
				content,
				timestamp: "2026-05-02 10:30",
				relevance: "high",
				sourceEntryIds: ["entry-a"],
				// tokenCount is code-computed from the full rendered line (id + timestamp + relevance + content).
				tokenCount: 18,
				id: expect.stringMatching(/^[a-f0-9]{12}$/),
			}],
		});
	});

	it("keeps an incomplete valid observation batch open", async () => {
		let toolResult: CapturedToolResult | undefined;
		const loop = fakeAgentLoop(async (...[, context]) => {
			toolResult = await context.tools[0].execute("tool-1", {
				observations: [{ timestamp: "2026-05-02 10:30", content: "Partial observation", relevance: "medium", sourceEntryIds: ["entry-a"] }],
				complete: false,
			});
		});

		const observations = await runObserver({ ...baseArgs, agentLoop: loop });

		expect(observations).toMatchObject({ kind: "incomplete", records: [{ content: "Partial observation" }] });
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

		await expect(runObserver({ ...baseArgs, agentLoop: loop })).resolves.toEqual({ kind: "incomplete", records: [] });
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

		expect(observations).toMatchObject({ kind: "completed", records: [{ content: "Same content" }] });
	});

	it("does not certify a mixed sibling batch when its final call is complete", async () => {
		const toolResults: CapturedToolResult[] = [];
		const loop = fakeAgentLoop(async (...[, context]) => {
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

		expect(observations).toMatchObject({
			kind: "incomplete",
			records: [{ content: "First observation" }, { content: "Second observation" }],
		});
		expect(toolResults.map((result) => result.terminate)).toEqual([false, true]);
	});

	it("returns an incomplete empty outcome when no tool call records observations", async () => {
		const loop = fakeAgentLoop(() => {});
		await expect(runObserver({ ...baseArgs, agentLoop: loop })).resolves.toEqual({ kind: "incomplete", records: [] });
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

		expect(observations).toMatchObject({ kind: "failed", records: [{ content: "Kept despite later error" }] });
	});

	it("returns failure rather than completion when the final stream result rejects", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				observations: [{ timestamp: "2026-05-02 10:30", content: "Accepted before result failure", relevance: "high", sourceEntryIds: ["entry-a"] }],
				complete: true,
			});
		}, [], new Error("agent result failed"));

		await expect(runObserver({ ...baseArgs, agentLoop: loop })).resolves.toMatchObject({
			kind: "failed",
			error: { message: "agent result failed" },
			records: [{ content: "Accepted before result failure" }],
		});
	});

	it("uses finishTurn as an observer turn cap without overriding hard exits", async () => {
		let finishTurn: any;
		const loop = fakeAgentLoop((_prompts, _context, config) => {
			finishTurn = config.finishTurn;
		});

		await runObserver({ ...baseArgs, agentLoop: loop, maxTurns: 2 });

		expect(finishTurn).toBeTypeOf("function");
		expect(finishTurn({ message: { stopReason: "error" } })).toBeUndefined();
		expect(finishTurn({ message: { stopReason: "aborted" } })).toBeUndefined();
		expect(finishTurn({ message: { stopReason: "toolUse" } })).toBeUndefined();
		expect(finishTurn({ message: { stopReason: "stop" } })).toEqual({ action: "end" });
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
