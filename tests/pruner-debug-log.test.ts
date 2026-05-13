import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ agentDir: "" }));

vi.mock("@mariozechner/pi-coding-agent", () => ({
	getAgentDir: () => mock.agentDir,
}));

import { runPruner } from "../src/compaction.js";
import { DEBUG_LOG_RELATIVE_PATH, withDebugLogContext } from "../src/debug-log.js";
import type { ObservationRecord } from "../src/types.js";

function eventLoop(events: unknown[]): any {
	return (() => ({
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
		},
		result: async () => [],
	})) as any;
}

function readEvents(): any[] {
	return readFileSync(logPath, "utf-8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}

const observation: ObservationRecord = {
	id: "111111111111",
	timestamp: "2026-05-13 10:00",
	relevance: "medium",
	content: "A debug logging observation with enough content to exceed a tiny pruning budget.",
	sourceEntryIds: ["entry-a"],
};

let rootDir = "";
let logPath = "";

beforeEach(() => {
	rootDir = join(tmpdir(), `om-pruner-debug-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mock.agentDir = join(rootDir, "agent");
	logPath = join(mock.agentDir, DEBUG_LOG_RELATIVE_PATH);
	mkdirSync(mock.agentDir, { recursive: true });
});

afterEach(() => {
	if (rootDir) rmSync(rootDir, { recursive: true, force: true });
});

describe("pruner debug logging", () => {
	it("records pruner agent-loop failure evidence without changing runPruner results", async () => {
		const throwingLoop = (() => {
			throw new Error("provider setup failed before request");
		}) as any;

		const result = await withDebugLogContext({ enabled: true, cwd: "/tmp/project", runId: "run-pruner" }, () =>
			runPruner({ model: {} as any, apiKey: "test", agentLoop: throwingLoop }, [], [observation], 1),
		);

		expect(result).toMatchObject({
			observations: [observation],
			droppedIds: [],
			fellBack: true,
			stopReason: "fell_back",
		});

		const events = readEvents();
		expect(events.map((event) => event.event)).toContain("pruner.agent_loop.before_call");
		expect(events.map((event) => event.event)).toContain("pruner.agent_loop.error");
		expect(events.map((event) => event.event)).toContain("pruner.result");
		const errorEvent = events.find((event) => event.event === "pruner.agent_loop.error");
		expect(errorEvent).toMatchObject({
			cwd: "/tmp/project",
			runId: "run-pruner",
			data: {
				pass: 1,
				agentLoopCalled: true,
				streamCreated: false,
				firstEventSeen: false,
				errorMessage: "provider setup failed before request",
			},
		});
	});

	it("records assistant error event summaries without logging raw message text", async () => {
		const assistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "sensitive provider error text that should not be logged as content" }],
			stopReason: "error",
			errorMessage: "context length exceeded before provider request",
			api: "openai-completions",
			provider: "openrouter",
			model: "deepseek/deepseek-chat",
			timestamp: Date.now(),
		};
		const loop = eventLoop([
			{ type: "agent_start" },
			{ type: "turn_start" },
			{ type: "message_end", message: assistantMessage },
			{ type: "turn_end", message: assistantMessage, toolResults: [] },
			{ type: "agent_end", messages: [assistantMessage] },
		]);

		const result = await withDebugLogContext({ enabled: true, cwd: "/tmp/project", runId: "run-pruner-error" }, () =>
			runPruner({ model: {} as any, apiKey: "test", agentLoop: loop }, [], [observation], 1),
		);

		expect(result.stopReason).toBe("zero_drops");
		expect(result.fellBack).toBe(false);
		const events = readEvents();
		const messageEnd = events.find((event) => event.event === "pruner.agent_loop.message_end");
		expect(messageEnd).toMatchObject({
			data: {
				pass: 1,
				message: {
					role: "assistant",
					api: "openai-completions",
					provider: "openrouter",
					model: "deepseek/deepseek-chat",
					stopReason: "error",
					errorMessage: "context length exceeded before provider request",
					contentTypes: ["text"],
				},
			},
		});
		const turnEnd = events.find((event) => event.event === "pruner.agent_loop.turn_end");
		expect(turnEnd).toMatchObject({
			data: {
				pass: 1,
				toolResultCount: 0,
				message: { role: "assistant", stopReason: "error", errorMessage: "context length exceeded before provider request" },
			},
		});
		const agentEnd = events.find((event) => event.event === "pruner.agent_loop.agent_end");
		expect(agentEnd).toMatchObject({
			data: {
				pass: 1,
				messageCount: 1,
				finalAssistant: { role: "assistant", stopReason: "error", errorMessage: "context length exceeded before provider request" },
			},
		});
		expect(JSON.stringify(events)).not.toContain("sensitive provider error text");
	});

	it("records clean no-tool assistant responses as zero-drop event summaries", async () => {
		const assistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "no observations should be dropped" }],
			stopReason: "stop",
			api: "openai-completions",
			provider: "openrouter",
			model: "deepseek/deepseek-chat",
			timestamp: Date.now(),
		};
		const loop = eventLoop([
			{ type: "agent_start" },
			{ type: "turn_start" },
			{ type: "message_end", message: assistantMessage },
			{ type: "turn_end", message: assistantMessage, toolResults: [] },
			{ type: "agent_end", messages: [assistantMessage] },
		]);

		const result = await withDebugLogContext({ enabled: true, cwd: "/tmp/project", runId: "run-pruner-clean" }, () =>
			runPruner({ model: {} as any, apiKey: "test", agentLoop: loop }, [], [observation], 1),
		);

		expect(result).toMatchObject({ droppedIds: [], fellBack: false, stopReason: "zero_drops" });
		const events = readEvents();
		expect(events.find((event) => event.event === "pruner.agent_loop.message_end")).toMatchObject({
			data: { message: { role: "assistant", stopReason: "stop", contentTypes: ["text"] } },
		});
		expect(events.find((event) => event.event === "pruner.agent_loop.turn_end")).toMatchObject({
			data: { toolResultCount: 0, message: { role: "assistant", stopReason: "stop" } },
		});
		expect(events.find((event) => event.event === "pruner.agent_loop.agent_end")).toMatchObject({
			data: { messageCount: 1, finalAssistant: { role: "assistant", stopReason: "stop" } },
		});
		expect(JSON.stringify(events)).not.toContain("no observations should be dropped");
	});
});
