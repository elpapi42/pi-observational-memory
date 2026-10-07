import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type JsonObject,
	type Model,
	type ToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { runObserver } from "../src/agents/observer/agent.js";
import { runReflector } from "../src/agents/reflector/agent.js";
import { hashId } from "../src/ids.js";
import type { WorkerStreamSimple } from "../src/agents/worker-stream.js";
import type { Observation } from "../src/session-ledger/index.js";

const MEMORY_MODEL = {
	id: "memory",
	name: "Memory",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_000,
} satisfies Model<"anthropic-messages">;

const SUPPORTING_OBSERVATION = {
	id: "aaaaaaaaaaaa",
	content: "User prefers concise release notes.",
	timestamp: "2026-05-02 10:30",
	relevance: "high",
	sourceEntryIds: ["entry-a"],
	tokenCount: 10,
} satisfies Observation;

interface ProviderTurn {
	content: AssistantMessage["content"];
	stopReason: "stop" | "toolUse";
}

function providerStream(turns: readonly ProviderTurn[]): {
	streamSimple: WorkerStreamSimple;
	requestCount: () => number;
} {
	let requestCount = 0;
	const streamSimple: WorkerStreamSimple = () => {
		// Finish unwanted follow-ups so request-count assertions fail without hanging the agent stream.
		const turn = turns[requestCount] ?? finishTextTurn();
		requestCount++;

		const message: AssistantMessage = {
			role: "assistant",
			content: turn.content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: MEMORY_MODEL.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: turn.stopReason,
			timestamp: 1,
		};
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: turn.stopReason, message });
		return stream;
	};
	return { streamSimple, requestCount: () => requestCount };
}

function observationCall(id: string, toolArguments: JsonObject): ToolCall {
	return { type: "toolCall", id, name: "record_observations", arguments: toolArguments };
}

function reflectionCall(id: string, toolArguments: JsonObject): ToolCall {
	return { type: "toolCall", id, name: "record_reflections", arguments: toolArguments };
}

function observerArgs(streamSimple: WorkerStreamSimple) {
	return {
		model: MEMORY_MODEL,
		priorReflections: [],
		priorObservations: [],
		chunk: "[Source entry id: entry-a]\nUser asked to remember a preference.",
		allowedSourceEntryIds: ["entry-a"],
		streamSimple,
	};
}

function reflectorArgs(streamSimple: WorkerStreamSimple) {
	return {
		model: MEMORY_MODEL,
		reflections: [],
		observations: [SUPPORTING_OBSERVATION],
		streamSimple,
	};
}

function observerBatch(content: string, complete: boolean) {
	return {
		observations: [
			{
				timestamp: "2026-05-02 10:30",
				content,
				relevance: "high",
				sourceEntryIds: ["entry-a"],
			},
		],
		complete,
	};
}

function reflectionBatch(content: string, complete: boolean) {
	return {
		reflections: [{ content, supportingObservationIds: [SUPPORTING_OBSERVATION.id] }],
		complete,
	};
}

function finishTextTurn(): ProviderTurn {
	return { content: [{ type: "text", text: "Done." }], stopReason: "stop" };
}

describe("recording tool termination through the real agent loop", () => {
	it("ends after one complete observer batch and saves the follow-up request", async () => {
		const provider = providerStream([
			{
				content: [observationCall("observer-1", observerBatch("First observation", true))],
				stopReason: "toolUse",
			},
		]);

		const observations = await runObserver(observerArgs(provider.streamSimple));

		expect(provider.requestCount()).toBe(1);
		expect(observations).toMatchObject({ kind: "completed", records: [{ content: "First observation" }] });
	});

	it("certifies a complete recording call finalized on a stop turn", async () => {
		const provider = providerStream([
			{
				content: [observationCall("observer-stop", observerBatch("Stop reason completion", true))],
				stopReason: "stop",
			},
		]);

		const outcome = await runObserver(observerArgs(provider.streamSimple));

		expect(provider.requestCount()).toBe(1);
		expect(outcome).toMatchObject({ kind: "completed", records: [{ content: "Stop reason completion" }] });
	});

	it("ends after one complete reflector batch and saves the follow-up request", async () => {
		const provider = providerStream([
			{
				content: [reflectionCall("reflector-1", reflectionBatch("A durable preference.", true))],
				stopReason: "toolUse",
			},
		]);

		const reflections = await runReflector(reflectorArgs(provider.streamSimple));

		expect(provider.requestCount()).toBe(1);
		expect(reflections).toMatchObject({ kind: "completed", records: [{ content: "A durable preference." }] });
	});

	it("accepts an explicit empty complete observer batch as a nothing-new verdict", async () => {
		const provider = providerStream([
			{
				content: [observationCall("observer-empty", { observations: [], complete: true })],
				stopReason: "stop",
			},
		]);

		const outcome = await runObserver(observerArgs(provider.streamSimple));

		expect(provider.requestCount()).toBe(1);
		expect(outcome).toEqual({ kind: "nothing-new" });
	});

	it("keeps partial observer batches open, then accumulates and dedupes the correction", async () => {
		const provider = providerStream([
			{
				content: [observationCall("observer-1", observerBatch("First observation", false))],
				stopReason: "toolUse",
			},
			{
				content: [
					observationCall("observer-2", {
						observations: [
							{
								timestamp: "2026-05-02 10:30",
								content: "First observation",
								relevance: "high",
								sourceEntryIds: ["entry-a"],
							},
							{
								timestamp: "2026-05-02 10:31",
								content: "Corrected observation",
								relevance: "high",
								sourceEntryIds: ["entry-a"],
							},
						],
						complete: true,
					}),
				],
				stopReason: "toolUse",
			},
		]);

		const observations = await runObserver(observerArgs(provider.streamSimple));

		expect(provider.requestCount()).toBe(2);
		expect(observations).toMatchObject({
			kind: "completed",
			records: [{ content: "First observation" }, { content: "Corrected observation" }],
		});
	});

	it("continues a mixed complete/incomplete tool-call batch", async () => {
		const provider = providerStream([
			{
				content: [
					observationCall("observer-1", observerBatch("Complete batch item", true)),
					observationCall("observer-2", observerBatch("Incomplete batch item", false)),
				],
				stopReason: "toolUse",
			},
			finishTextTurn(),
		]);

		const observations = await runObserver(observerArgs(provider.streamSimple));

		expect(provider.requestCount()).toBe(2);
		expect(observations).toMatchObject({
			kind: "incomplete",
			records: [{ content: "Complete batch item" }, { content: "Incomplete batch item" }],
		});
	});

	it("does not certify mixed sibling calls when the incomplete call comes first", async () => {
		const provider = providerStream([
			{
				content: [
					observationCall("observer-incomplete", observerBatch("Incomplete sibling", false)),
					observationCall("observer-complete", observerBatch("Complete sibling", true)),
				],
				stopReason: "toolUse",
			},
			finishTextTurn(),
		]);

		const outcome = await runObserver(observerArgs(provider.streamSimple));

		expect(provider.requestCount()).toBe(2);
		expect(outcome).toMatchObject({
			kind: "incomplete",
			records: [{ content: "Incomplete sibling" }, { content: "Complete sibling" }],
		});
	});

	it("continues after rejecting one item in an otherwise valid observer batch", async () => {
		const provider = providerStream([
			{
				content: [
					observationCall("observer-1", {
						observations: [
							{
								timestamp: "2026-05-02 10:30",
								content: "Accepted item",
								relevance: "high",
								sourceEntryIds: ["entry-a"],
							},
							{
								timestamp: "2026-05-02 10:31",
								content: "Rejected item",
								relevance: "high",
								sourceEntryIds: ["missing-entry"],
							},
						],
						complete: true,
					}),
				],
				stopReason: "toolUse",
			},
			finishTextTurn(),
		]);

		const observations = await runObserver(observerArgs(provider.streamSimple));

		expect(provider.requestCount()).toBe(2);
		expect(observations).toMatchObject({ kind: "incomplete", records: [{ content: "Accepted item" }] });
	});

	it("does not execute a schema-invalid observer call and asks the model again", async () => {
		const provider = providerStream([
			{
				content: [
					observationCall("observer-1", {
						observations: [
							{
								timestamp: "2026-05-02 10:30",
								content: "Missing the required complete field",
								relevance: "high",
								sourceEntryIds: ["entry-a"],
							},
						],
					}),
				],
				stopReason: "toolUse",
			},
			finishTextTurn(),
		]);

		const observations = await runObserver(observerArgs(provider.streamSimple));

		expect(provider.requestCount()).toBe(2);
		expect(observations).toEqual({ kind: "incomplete", records: [] });
	});

	it("rejects an empty incomplete observer batch and accepts a corrected batch", async () => {
		const provider = providerStream([
			{
				content: [observationCall("observer-1", { observations: [], complete: false })],
				stopReason: "toolUse",
			},
			{
				content: [observationCall("observer-2", observerBatch("Corrected nonempty batch", true))],
				stopReason: "toolUse",
			},
		]);

		const observations = await runObserver(observerArgs(provider.streamSimple));

		expect(provider.requestCount()).toBe(2);
		expect(observations).toMatchObject({ kind: "completed", records: [{ content: "Corrected nonempty batch" }] });
	});

	it("certifies a complete observer batch at the turn cap", async () => {
		const provider = providerStream([
			{
				content: [observationCall("observer-capped-complete", observerBatch("Complete at turn cap", true))],
				stopReason: "toolUse",
			},
		]);

		const outcome = await runObserver({ ...observerArgs(provider.streamSimple), maxTurns: 1 });

		expect(provider.requestCount()).toBe(1);
		expect(outcome).toMatchObject({ kind: "completed", records: [{ content: "Complete at turn cap" }] });
	});

	it.each([
		["both complete", true, true, "completed"],
		["first incomplete", false, true, "incomplete"],
		["last incomplete", true, false, "incomplete"],
	] as const)(
		"certifies a capped tool batch only when every sibling completes: %s",
		async (...[, firstComplete, secondComplete, expectedKind]) => {
			const provider = providerStream([
				{
					content: [
						observationCall("capped-first", observerBatch("First capped observation", firstComplete)),
						observationCall("capped-second", observerBatch("Second capped observation", secondComplete)),
					],
					stopReason: "toolUse",
				},
			]);

			const outcome = await runObserver({ ...observerArgs(provider.streamSimple), maxTurns: 1 });

			expect(provider.requestCount()).toBe(1);
			expect(outcome).toMatchObject({
				kind: expectedKind,
				records: [{ content: "First capped observation" }, { content: "Second capped observation" }],
			});
		},
	);

	it("characterizes the partial observer result returned at the turn cap", async () => {
		const provider = providerStream([
			{
				content: [observationCall("observer-1", observerBatch("Partial at turn cap", false))],
				stopReason: "toolUse",
			},
		]);

		const observations = await runObserver({ ...observerArgs(provider.streamSimple), maxTurns: 1 });

		expect(provider.requestCount()).toBe(1);
		expect(observations).toEqual({
			kind: "incomplete",
			records: [expect.objectContaining({ content: "Partial at turn cap" })],
		});
	});

	it("accepts an explicit empty complete reflector batch as a nothing-new verdict", async () => {
		const provider = providerStream([
			{
				content: [reflectionCall("reflector-empty", { reflections: [], complete: true })],
				stopReason: "stop",
			},
		]);

		const outcome = await runReflector(reflectorArgs(provider.streamSimple));

		expect(provider.requestCount()).toBe(1);
		expect(outcome).toEqual({ kind: "nothing-new" });
	});

	it("treats a duplicate-only complete reflection review as nothing-new", async () => {
		const content = "A durable preference.";
		const provider = providerStream([
			{
				content: [reflectionCall("reflector-duplicate", reflectionBatch(content, true))],
				stopReason: "toolUse",
			},
		]);

		const outcome = await runReflector({
			...reflectorArgs(provider.streamSimple),
			reflections: [
				{
					id: hashId(content),
					content,
					supportingObservationIds: [SUPPORTING_OBSERVATION.id],
					tokenCount: 5,
				},
			],
		});

		expect(provider.requestCount()).toBe(1);
		expect(outcome).toEqual({ kind: "nothing-new" });
	});

	it("keeps an incomplete reflector batch open before completing the review", async () => {
		const provider = providerStream([
			{
				content: [reflectionCall("reflector-1", reflectionBatch("First reflection", false))],
				stopReason: "toolUse",
			},
			{
				content: [reflectionCall("reflector-2", reflectionBatch("Final reflection", true))],
				stopReason: "toolUse",
			},
		]);

		const reflections = await runReflector(reflectorArgs(provider.streamSimple));

		expect(provider.requestCount()).toBe(2);
		expect(reflections).toMatchObject({
			kind: "completed",
			records: [{ content: "First reflection" }, { content: "Final reflection" }],
		});
	});

	it("continues after rejecting reflection support in an otherwise valid batch", async () => {
		const provider = providerStream([
			{
				content: [
					reflectionCall("reflector-1", {
						reflections: [
							{ content: "Accepted reflection", supportingObservationIds: [SUPPORTING_OBSERVATION.id] },
							{ content: "Rejected reflection", supportingObservationIds: ["missing-id"] },
						],
						complete: true,
					}),
				],
				stopReason: "toolUse",
			},
			finishTextTurn(),
		]);

		const reflections = await runReflector(reflectorArgs(provider.streamSimple));

		expect(provider.requestCount()).toBe(2);
		expect(reflections).toMatchObject({ kind: "incomplete", records: [{ content: "Accepted reflection" }] });
	});
});
