import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ agentDir: "" }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => mock.agentDir,
	estimateTokens: () => 0,
}));

import { logAgentStreamError } from "../src/agents/stream-errors.js";
import { runObserver } from "../src/agents/observer/agent.js";
import { debugLogRelativePath, withDebugLogContext } from "../src/debug-log.js";

describe("agent stream error logging", () => {
	let root: string;

	beforeEach(() => {
		root = `${tmpdir()}/om-stream-errors-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		mock.agentDir = join(root, "agent");
		mkdirSync(mock.agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function readLoggedEvents(sessionId: string): Array<{ event: string; data: Record<string, unknown> }> {
		const path = join(mock.agentDir, debugLogRelativePath({ sessionId }));
		return readFileSync(path, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	}

	it("logs assistant message_end with stopReason error, prefixed with the stage", () => {
		withDebugLogContext({ enabled: true, sessionId: "session-stream-1" }, () => {
			logAgentStreamError("observer", {
				type: "message_end",
				message: {
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "prompt is too long: 5198507 tokens > 1000000 maximum",
				} as any,
			});
		});

		const events = readLoggedEvents("session-stream-1");
		expect(events).toHaveLength(1);
		expect(events[0].event).toBe("observer.stream_error");
		expect(events[0].data).toMatchObject({
			stopReason: "error",
			errorMessage: "prompt is too long: 5198507 tokens > 1000000 maximum",
		});
	});

	it("logs aborted runs and uses the caller's stage name", () => {
		withDebugLogContext({ enabled: true, sessionId: "session-stream-2" }, () => {
			logAgentStreamError("reflector", {
				type: "message_end",
				message: { role: "assistant", content: [], stopReason: "aborted" } as any,
			});
		});

		const events = readLoggedEvents("session-stream-2");
		expect(events).toHaveLength(1);
		expect(events[0].event).toBe("reflector.stream_error");
		expect(events[0].data).toMatchObject({ stopReason: "aborted" });
	});

	it("ignores successful assistant messages, non-assistant messages, and other events", () => {
		withDebugLogContext({ enabled: true, sessionId: "session-stream-3" }, () => {
			logAgentStreamError("observer", {
				type: "message_end",
				message: { role: "assistant", content: [], stopReason: "stop" } as any,
			});
			logAgentStreamError("observer", {
				type: "message_end",
				message: { role: "user", content: [], timestamp: 0 } as any,
			});
			logAgentStreamError("observer", { type: "turn_start" });
			// One real error so the log file exists and we can assert nothing else landed.
			logAgentStreamError("observer", {
				type: "message_end",
				message: { role: "assistant", content: [], stopReason: "error", errorMessage: "marker" } as any,
			});
		});

		const events = readLoggedEvents("session-stream-3");
		expect(events).toHaveLength(1);
		expect(events[0].data).toMatchObject({ errorMessage: "marker" });
	});

	it("runObserver logs a stream_error when the loop ends with an errored assistant message", async () => {
		const failingLoop = (() => ({
			async *[Symbol.asyncIterator]() {
				yield {
					type: "message_end",
					message: { role: "assistant", content: [], stopReason: "error", errorMessage: "upstream 400" },
				};
			},
			result: async () => ({}),
		})) as any;

		await withDebugLogContext({ enabled: true, sessionId: "session-stream-4" }, async () => {
			const observations = await runObserver({
				model: {} as any,
				apiKey: "test",
				priorReflections: [],
				priorObservations: [],
				chunk: "[Source entry id: entry-a]\nSome content.",
				allowedSourceEntryIds: ["entry-a"],
				agentLoop: failingLoop,
			});
			expect(observations).toBeUndefined();
		});

		const events = readLoggedEvents("session-stream-4");
		expect(events).toHaveLength(1);
		expect(events[0].event).toBe("observer.stream_error");
		expect(events[0].data).toMatchObject({ stopReason: "error", errorMessage: "upstream 400" });
	});

	it("runObserver retries transient errors and succeeds on a later attempt", async () => {
		let calls = 0;
		const flakyLoop = ((_prompts: any[], context: any) => ({
			async *[Symbol.asyncIterator]() {
				calls++;
				if (calls < 3) {
					yield {
						type: "message_end",
						message: { role: "assistant", content: [], stopReason: "error", errorMessage: '503 {"error":{"message":"No available accounts"}}' },
					};
					return;
				}
				await context.tools[0].execute("tool-1", {
					observations: [{ timestamp: "2026-05-02 10:30", content: "Recovered after retry.", relevance: "high", sourceEntryIds: ["entry-a"] }],
				});
			},
			result: async () => ({}),
		})) as any;

		const slept: number[] = [];
		await withDebugLogContext({ enabled: true, sessionId: "session-stream-5" }, async () => {
			const observations = await runObserver({
				model: {} as any,
				apiKey: "test",
				priorReflections: [],
				priorObservations: [],
				chunk: "[Source entry id: entry-a]\nSome content.",
				allowedSourceEntryIds: ["entry-a"],
				agentLoop: flakyLoop,
				retryDelaysMs: [10, 20],
				sleep: async (ms) => { slept.push(ms); },
			});
			expect(observations).toHaveLength(1);
			expect(observations?.[0].content).toBe("Recovered after retry.");
		});

		expect(calls).toBe(3);
		expect(slept).toEqual([10, 20]);
		const events = readLoggedEvents("session-stream-5");
		const retries = events.filter((e) => e.event === "observer.transient_retry");
		expect(retries).toHaveLength(2);
		expect(retries[0].data).toMatchObject({ attempt: 1, delayMs: 10 });
	});

	it("runObserver does not retry non-transient errors", async () => {
		let calls = 0;
		const failingLoop = (() => ({
			async *[Symbol.asyncIterator]() {
				calls++;
				yield {
					type: "message_end",
					message: { role: "assistant", content: [], stopReason: "error", errorMessage: "400 prompt is too long: 5198507 tokens > 1000000 maximum" },
				};
			},
			result: async () => ({}),
		})) as any;

		await withDebugLogContext({ enabled: true, sessionId: "session-stream-6" }, async () => {
			const observations = await runObserver({
				model: {} as any,
				apiKey: "test",
				priorReflections: [],
				priorObservations: [],
				chunk: "[Source entry id: entry-a]\nSome content.",
				allowedSourceEntryIds: ["entry-a"],
				agentLoop: failingLoop,
				retryDelaysMs: [10, 20],
				sleep: async () => {},
			});
			expect(observations).toBeUndefined();
		});

		expect(calls).toBe(1);
		const events = readLoggedEvents("session-stream-6");
		expect(events.filter((e) => e.event === "observer.transient_retry")).toHaveLength(0);
	});
});
