import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ agentDir: "" }));

vi.mock("@mariozechner/pi-coding-agent", () => ({
	getAgentDir: () => mock.agentDir,
}));

import { loadConfig, readEnvConfig } from "../src/config.js";

let rootDir = "";
let cwd = "";

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, JSON.stringify(value), "utf-8");
}

beforeEach(() => {
	rootDir = mkdtempSync(join(tmpdir(), "om-config-test-"));
	mock.agentDir = join(rootDir, "agent");
	cwd = join(rootDir, "project");
	mkdirSync(mock.agentDir, { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });
});

afterEach(() => {
	if (rootDir) rmSync(rootDir, { recursive: true, force: true });
});

describe("readEnvConfig", () => {
	it("parses passive truthy and falsy env values", () => {
		for (const value of ["1", "true", "yes", "on", " TRUE "]) {
			expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: value })).toEqual({ passive: true });
		}
		for (const value of ["0", "false", "no", "off", " OFF "]) {
			expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: value })).toEqual({ passive: false });
		}
	});

	it("ignores unset or invalid passive env values", () => {
		expect(readEnvConfig({})).toEqual({});
		expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: "maybe" })).toEqual({});
		expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: "" })).toEqual({});
	});
});

describe("loadConfig", () => {
	it("defaults passive mode to false", () => {
		expect(loadConfig(cwd, {})).toMatchObject({ passive: false });
	});

	it("loads passive from global and local settings with local precedence", () => {
		writeJson(join(mock.agentDir, "settings.json"), {
			"observational-memory": { passive: true },
		});
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": { passive: false },
		});

		expect(loadConfig(cwd, {})).toMatchObject({ passive: false });
	});

	it("env passive overrides local settings in both directions", () => {
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": { passive: false },
		});
		expect(loadConfig(cwd, { PI_OBSERVATIONAL_MEMORY_PASSIVE: "true" })).toMatchObject({ passive: true });

		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": { passive: true },
		});
		expect(loadConfig(cwd, { PI_OBSERVATIONAL_MEMORY_PASSIVE: "false" })).toMatchObject({ passive: false });
	});

	it("ignores invalid env and non-boolean settings passive values", () => {
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": { passive: "false" },
		});
		expect(loadConfig(cwd, { PI_OBSERVATIONAL_MEMORY_PASSIVE: "invalid" })).toMatchObject({ passive: false });
	});
});
