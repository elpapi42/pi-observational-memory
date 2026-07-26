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
});
