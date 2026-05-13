import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ agentDir: "" }));

vi.mock("@mariozechner/pi-coding-agent", () => ({
	getAgentDir: () => mock.agentDir,
}));

import { DEBUG_LOG_MAX_BYTES, DEBUG_LOG_RELATIVE_PATH, debugLog, withDebugLogContext } from "../src/debug-log.js";

let rootDir = "";
let logPath = "";

beforeEach(() => {
	rootDir = join(tmpdir(), `om-debug-log-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mock.agentDir = join(rootDir, "agent");
	logPath = join(mock.agentDir, DEBUG_LOG_RELATIVE_PATH);
	mkdirSync(mock.agentDir, { recursive: true });
});

afterEach(() => {
	if (rootDir) rmSync(rootDir, { recursive: true, force: true });
});

describe("debugLog", () => {
	it("does not create a log file when disabled", () => {
		withDebugLogContext({ enabled: false, cwd: "/tmp/project", runId: "run-1" }, () => {
			debugLog("test.disabled", { value: 1 });
		});

		expect(existsSync(logPath)).toBe(false);
	});

	it("writes JSONL events with context when enabled", () => {
		withDebugLogContext({ enabled: true, cwd: "/tmp/project", runId: "run-1" }, () => {
			debugLog("test.enabled", { value: 42 });
		});

		const lines = readFileSync(logPath, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const event = JSON.parse(lines[0]);
		expect(event).toMatchObject({
			event: "test.enabled",
			cwd: "/tmp/project",
			runId: "run-1",
			data: { value: 42 },
		});
		expect(typeof event.ts).toBe("string");
	});

	it("rotates an oversized log with one backup", () => {
		mkdirSync(join(mock.agentDir, "observational-memory"), { recursive: true });
		writeFileSync(logPath, "x".repeat(DEBUG_LOG_MAX_BYTES), "utf-8");

		withDebugLogContext({ enabled: true, cwd: "/tmp/project", runId: "run-2" }, () => {
			debugLog("test.rotate", { ok: true });
		});

		expect(existsSync(`${logPath}.1`)).toBe(true);
		const active = readFileSync(logPath, "utf-8").trim();
		expect(JSON.parse(active)).toMatchObject({ event: "test.rotate" });
	});

	it("swallows serialization or filesystem failures", () => {
		expect(() => {
			withDebugLogContext({ enabled: true, cwd: "/tmp/project", runId: "run-3" }, () => {
				debugLog("test.bigint", { value: BigInt(1) as unknown as number });
			});
		}).not.toThrow();
	});
});
