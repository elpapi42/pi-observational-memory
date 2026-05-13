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

		const events = readFileSync(logPath, "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
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
});
