import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { WorkerCompletionTracker } from "./worker-completion.js";

function assistantTurn(
	calls: Array<{ id: string; name?: string }>,
	stopReason: AssistantMessage["stopReason"] = "toolUse",
): AgentEvent {
	const message: AssistantMessage = {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "memory",
		timestamp: 1,
		stopReason,
		content: calls.map((call) => ({
			type: "toolCall" as const,
			id: call.id,
			name: call.name ?? "record_observations",
			arguments: {},
		})),
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	return { type: "turn_end", message, toolResults: [] };
}

function finalizedResult(
	callId: string,
	options: { toolName?: string; terminate?: boolean; isError?: boolean } = {},
): AgentEvent {
	return {
		type: "tool_execution_end",
		toolCallId: callId,
		toolName: options.toolName ?? "record_observations",
		result: { terminate: options.terminate ?? true },
		isError: options.isError ?? false,
	};
}

function agentEnd(): AgentEvent {
	return { type: "agent_end", messages: [] };
}

function trackerWithResult(callId: string, resultOptions: Parameters<typeof finalizedResult>[1] = {}) {
	const tracker = new WorkerCompletionTracker("record_observations");
	tracker.observe(finalizedResult(callId, resultOptions));
	return tracker;
}

describe("WorkerCompletionTracker", () => {
	it("certifies one fully finalized recording call", () => {
		const tracker = trackerWithResult("call-1");
		tracker.observe(assistantTurn([{ id: "call-1" }]));

		expect(tracker.isComplete()).toBe(false);
		tracker.observe(agentEnd());
		expect(tracker.isComplete()).toBe(true);
	});

	it("requires every sibling result to terminate, regardless of source order", () => {
		const tracker = new WorkerCompletionTracker("record_observations");
		tracker.observe(finalizedResult("call-2", { terminate: false }));
		tracker.observe(finalizedResult("call-1"));
		tracker.observe(assistantTurn([{ id: "call-1" }, { id: "call-2" }]));
		tracker.observe(agentEnd());

		expect(tracker.isComplete()).toBe(false);
	});

	it("rejects missing, extra, and duplicate call ids", () => {
		const missing = trackerWithResult("call-1");
		missing.observe(assistantTurn([{ id: "call-1" }, { id: "call-2" }]));
		missing.observe(agentEnd());
		expect(missing.isComplete()).toBe(false);

		const extra = trackerWithResult("call-1");
		extra.observe(finalizedResult("call-extra"));
		extra.observe(assistantTurn([{ id: "call-1" }]));
		extra.observe(agentEnd());
		expect(extra.isComplete()).toBe(false);

		const duplicate = trackerWithResult("call-1");
		duplicate.observe(finalizedResult("call-1"));
		duplicate.observe(assistantTurn([{ id: "call-1" }, { id: "call-1" }]));
		duplicate.observe(agentEnd());
		expect(duplicate.isComplete()).toBe(false);
	});

	it("rejects unknown tools, failed results, truncation, and text-only turns", () => {
		const unknownTool = trackerWithResult("call-1", { toolName: "record_reflections" });
		unknownTool.observe(assistantTurn([{ id: "call-1", name: "record_reflections" }]));
		unknownTool.observe(agentEnd());
		expect(unknownTool.isComplete()).toBe(false);

		const failedResult = trackerWithResult("call-1", { isError: true });
		failedResult.observe(assistantTurn([{ id: "call-1" }]));
		failedResult.observe(agentEnd());
		expect(failedResult.isComplete()).toBe(false);

		const truncated = trackerWithResult("call-1");
		truncated.observe(assistantTurn([{ id: "call-1" }], "length"));
		truncated.observe(agentEnd());
		expect(truncated.isComplete()).toBe(false);

		const textOnly = new WorkerCompletionTracker("record_observations");
		textOnly.observe(assistantTurn([], "stop"));
		textOnly.observe(agentEnd());
		expect(textOnly.isComplete()).toBe(false);
	});

	it("does not reuse a complete verdict after a later turn starts", () => {
		const tracker = trackerWithResult("call-1");
		tracker.observe(assistantTurn([{ id: "call-1" }]));
		tracker.observe(agentEnd());
		expect(tracker.isComplete()).toBe(true);

		tracker.observe({ type: "turn_start" });
		expect(tracker.isComplete()).toBe(false);
		tracker.observe(assistantTurn([], "stop"));
		tracker.observe(agentEnd());

		expect(tracker.isComplete()).toBe(false);
	});
});
