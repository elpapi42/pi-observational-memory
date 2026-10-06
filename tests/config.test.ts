import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ agentDir: "" }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => mock.agentDir,
}));

import { DEFAULTS, loadConfig, parseMatchSelector, readEnvConfig, resolveCompactAfterTokens, resolveConfiguredModel, resolveModelString, resolveWarnAt } from "../src/config.js";

function writeJson(path: string, value: unknown) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value), "utf-8");
}

describe("V3 config", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		root = `${tmpdir()}/om-v3-config-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mock.agentDir = agentDir;
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("uses V3 defaults", () => {
		expect(DEFAULTS).toEqual({
			observeAfterTokens: 10000,
			reflectAfterTokens: 20000,
			compactAfterTokens: 81000,
			observationsPoolMaxTokens: 20000,
			observationsPoolTargetTokens: 10000,
			reflectionsPoolTargetTokens: 8000,
			agentMaxTurns: 16,
			agentMaxTokens: 32000,
			showWorkerNotifications: true,
			modelMap: [],
			selfCompact: { enabled: false, warnAt: [] },
			recallEmbeddings: {
				enabled: false,
				model: "Xenova/bge-small-en-v1.5",
				pooling: "cls",
				queryPrefix: "Represent this sentence for searching relevant passages: ",
			},
			passive: false,
			debugLog: false,
			modelMap: [],
		});
		expect(loadConfig(cwd, {})).toEqual(DEFAULTS);
	});

	it("parses selfCompact warning rules and drops malformed ones", () => {
		writeJson(join(agentDir, "settings.json"), {
			"observational-memory": {
				selfCompact: {
					enabled: true,
					warnAt: [
						{ match: "*", warnAt: [{ type: "ratio", value: 0.2 }, 50_000, "bad", { type: "ratio", value: 2 }] },
						"nope",
						{ warnAt: [{ type: "ratio", value: 0.3 }] },
						{ match: "other/*", warnAt: "nope" },
					],
				},
			},
		});

		expect(loadConfig(cwd, {}).selfCompact).toEqual({
			enabled: true,
			warnAt: [{ match: "*", warnAt: [{ type: "ratio", value: 0.2 }, 50_000] }],
		});
	});

	it("merges global, project, and env V3 settings in order", () => {
		writeJson(join(agentDir, "settings.json"), {
			"observational-memory": {
				observeAfterTokens: 10,
				reflectAfterTokens: 20,
				compactAfterTokens: 30,
				observationsPoolMaxTokens: 40,
				observationsPoolTargetTokens: 15,
				agentMaxTurns: 5,
				agentMaxTokens: 8192,
				model: { provider: "anthropic", id: "global", thinking: "medium" },
				showWorkerNotifications: true,
				passive: false,
				debugLog: true,
			},
		});
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observeAfterTokens: 100,
				model: { provider: "openai", id: "project", thinking: "low" },
				showWorkerNotifications: false,
			},
		});

		expect(loadConfig(cwd, { PI_OBSERVATIONAL_MEMORY_PASSIVE: "true" })).toMatchObject({
			observeAfterTokens: 100,
			reflectAfterTokens: 20,
			compactAfterTokens: 30,
			observationsPoolMaxTokens: 40,
			observationsPoolTargetTokens: 15,
			agentMaxTurns: 5,
			agentMaxTokens: 8192,
			model: { provider: "openai", id: "project", thinking: "low" },
			showWorkerNotifications: false,
			passive: true,
			debugLog: true,
		});
	});

	it("accepts max as a valid model thinking level", () => {
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				model: { provider: "anthropic", id: "claude", thinking: "max" },
			},
		});

		expect(loadConfig(cwd, {})).toMatchObject({
			model: { provider: "anthropic", id: "claude", thinking: "max" },
		});
	});

	it("parses a fallback model and ignores invalid fallback values", () => {
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				model: { provider: "anthropic", id: "claude-haiku-4-5-20251001", thinking: "low" },
				fallbackModel: { provider: "opencode-go", id: "deepseek-v4.1-flash", thinking: "low" },
			},
		});

		expect(loadConfig(cwd, {})).toMatchObject({
			model: { provider: "anthropic", id: "claude-haiku-4-5-20251001", thinking: "low" },
			fallbackModel: { provider: "opencode-go", id: "deepseek-v4.1-flash", thinking: "low" },
		});

		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				fallbackModel: { provider: "opencode-go", id: "deepseek-v4.1-flash", thinking: "huge" },
			},
		});
		expect(loadConfig(cwd, {})).toMatchObject({
			fallbackModel: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
		});

		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": { fallbackModel: { provider: "", id: "deepseek-v4.1-flash" } },
		});
		expect(loadConfig(cwd, {})).toEqual(DEFAULTS);
	});

	it("ignores invalid V3 values", () => {
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observeAfterTokens: -1,
				reflectAfterTokens: 0,
				compactAfterTokens: 1.5,
				observationsPoolMaxTokens: "20000",
				observationsPoolTargetTokens: "10000",
				agentMaxTurns: null,
				model: { provider: "anthropic", id: "", thinking: "huge" },
				showWorkerNotifications: "no",
				passive: "yes",
				debugLog: "true",
			},
		});

		expect(loadConfig(cwd, {})).toEqual(DEFAULTS);
	});

	it("derives observation pool target from the final max when omitted", () => {
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observationsPoolMaxTokens: 40,
			},
		});

		expect(loadConfig(cwd, {})).toMatchObject({
			observationsPoolMaxTokens: 40,
			observationsPoolTargetTokens: 20,
		});
	});

	it("falls back to derived target when explicit target is invalid for the final max", () => {
		writeJson(join(agentDir, "settings.json"), {
			"observational-memory": {
				observationsPoolMaxTokens: 100,
				observationsPoolTargetTokens: 80,
			},
		});
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observationsPoolMaxTokens: 40,
			},
		});

		expect(loadConfig(cwd, {})).toMatchObject({
			observationsPoolMaxTokens: 40,
			observationsPoolTargetTokens: 20,
		});
	});

	it("ignores old V2 settings without warnings or aliases", () => {
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observationThresholdTokens: 10,
				compactionThresholdTokens: 20,
				reflectionThresholdTokens: 30,
				compactionModel: { provider: "anthropic", id: "old" },
				thinkingLevel: "high",
				observerMaxTurnsPerRun: 2,
				reflectorMaxTurnsPerPass: 3,
				prunerMaxTurnsPerPass: 4,
				compactionMaxToolCalls: 5,
			},
		});

		expect(loadConfig(cwd, {})).toEqual(DEFAULTS);
	});

	it("parses passive env override", () => {
		expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: "on" })).toEqual({ passive: true });
		expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: "0" })).toEqual({ passive: false });
		expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: "maybe" })).toEqual({});
	});

	describe("threshold object form", () => {
		it("accepts the object form for compactAfterTokens", () => {
			writeJson(join(cwd, ".pi", "settings.json"), {
				"observational-memory": {
					compactAfterTokens: { type: "ratio", value: 0.5 },
				},
			});

			expect(loadConfig(cwd, {})).toMatchObject({
				compactAfterTokens: { type: "ratio", value: 0.5 },
			});
		});

		it("maps legacy flat ratio keys onto the object form", () => {
			writeJson(join(cwd, ".pi", "settings.json"), {
				"observational-memory": {
					compactAfterTokensMode: "ratio",
					compactAfterTokensRatio: 0.5,
				},
			});

			expect(loadConfig(cwd, {})).toMatchObject({
				compactAfterTokens: { type: "ratio", value: 0.5 },
			});
		});

		it("legacy ratio keys win over a plain-number compactAfterTokens", () => {
			writeJson(join(cwd, ".pi", "settings.json"), {
				"observational-memory": {
					compactAfterTokens: 81000,
					compactAfterTokensMode: "ratio",
					compactAfterTokensRatio: 0.5,
				},
			});

			expect(loadConfig(cwd, {})).toMatchObject({
				compactAfterTokens: { type: "ratio", value: 0.5 },
			});
		});

		it("rejects invalid threshold objects and falls back to defaults", () => {
			const invalid = [
				{ type: "auto", value: 0.5 },
				{ type: "ratio", value: 0 },
				{ type: "ratio", value: 1 },
				{ type: "ratio", value: 1.5 },
				{ type: "ratio", value: -0.2 },
				{ type: "ratio", value: "0.5" },
				{ type: "calibrated", value: 0 },
				{ type: "calibrated", value: -1 },
				{ type: "calibrated", value: "81000" },
				{},
				"ratio",
			];
			for (const compactAfterTokens of invalid) {
				writeJson(join(cwd, ".pi", "settings.json"), {
					"observational-memory": { compactAfterTokens },
				});
				expect(loadConfig(cwd, {})).toMatchObject({ compactAfterTokens: 81000 });
			}
		});
	});

	describe("resolveCompactAfterTokens", () => {
		it("returns the calibrated value in calibrated form", () => {
			const config = { ...DEFAULTS, compactAfterTokens: { type: "calibrated", value: 81000 } } as any;
			expect(resolveCompactAfterTokens(config, 1_000_000)).toBe(81000);
		});

		it("returns calibrated value regardless of context window in calibrated form", () => {
			const config = { ...DEFAULTS, compactAfterTokens: { type: "calibrated", value: 81000 } } as any;
			expect(resolveCompactAfterTokens(config, undefined)).toBe(81000);
			expect(resolveCompactAfterTokens(config, 0)).toBe(81000);
		});

		it("scales by context window in ratio form", () => {
			const config = { ...DEFAULTS, compactAfterTokens: { type: "ratio", value: 0.5 } } as any;
			expect(resolveCompactAfterTokens(config, 1_000_000)).toBe(500_000);
			expect(resolveCompactAfterTokens(config, 200_000)).toBe(100_000);
		});

		it("floors fractional results to an integer >= 1", () => {
			const config = { ...DEFAULTS, compactAfterTokens: { type: "ratio", value: 0.5 } } as any;
			expect(resolveCompactAfterTokens(config, 3)).toBe(1);
			expect(resolveCompactAfterTokens(config, 1)).toBe(1);
		});

		it("falls back to the default token value when context window is unavailable in ratio form", () => {
			const config = { ...DEFAULTS, compactAfterTokens: { type: "ratio", value: 0.5 } } as any;
			expect(resolveCompactAfterTokens(config, undefined)).toBe(81000);
			expect(resolveCompactAfterTokens(config, 0)).toBe(81000);
			expect(resolveCompactAfterTokens(config, -1)).toBe(81000);
		});
	});

	describe("resolveConfiguredModel", () => {
		const withMap = (modelMap: any[], model?: any) => ({ ...DEFAULTS, modelMap, model }) as any;

		it("routes by glob against the active model's provider/id key", () => {
			const config = withMap([
				{ match: "claude-bridge/*", model: "claude-bridge/sonnet" },
				{ match: "*", model: "synthetic/small" },
			]);
			expect(resolveConfiguredModel(config, { provider: "claude-bridge", id: "opus-5" })).toEqual({
				provider: "claude-bridge",
				id: "sonnet",
			});
			expect(resolveConfiguredModel(config, { provider: "openai", id: "gpt" })).toEqual({
				provider: "synthetic",
				id: "small",
			});
		});

		it("falls back to the static model config when nothing matches", () => {
			const fallback = { provider: "anthropic", id: "memory" };
			const config = withMap([{ match: "claude-bridge/*", model: "x/y" }], fallback);
			expect(resolveConfiguredModel(config, { provider: "openai", id: "gpt" })).toBe(fallback);
			expect(resolveConfiguredModel(config, undefined)).toBe(fallback);
		});

		it("routes stages independently and lets unrestricted entries serve any stage", () => {
			const config = withMap([
				{ match: "*", stages: ["reflector"], model: "anthropic/big:high" },
				{ match: "*", model: "synthetic/small" },
			]);
			const active = { provider: "claude-bridge", id: "opus-5" };
			expect(resolveConfiguredModel(config, active, "reflector")).toEqual({
				provider: "anthropic",
				id: "big",
				thinking: "high",
			});
			for (const stage of ["observer", "reflection-dropper", "dropper"] as const) {
				expect(resolveConfiguredModel(config, active, stage)).toEqual({
					provider: "synthetic",
					id: "small",
				});
			}
		});

		it("substitutes session model fields into an entry's model reference", () => {
			const config = withMap([{ match: "claude-bridge/*", model: "$provider/z-ai/glm-5.3-flash:$thinking" }]);
			expect(
				resolveConfiguredModel(config, { provider: "claude-bridge", id: "opus-5" }, undefined, "high"),
			).toEqual({ provider: "claude-bridge", id: "z-ai/glm-5.3-flash", thinking: "high" });

			const keepModel = withMap([{ match: "claude-bridge/*", stages: ["observer"], model: "$model:low" }]);
			expect(
				resolveConfiguredModel(keepModel, { provider: "claude-bridge", id: "opus-5" }, "observer", "max"),
			).toEqual({ provider: "claude-bridge", id: "opus-5", thinking: "low" });
		});

		it("skips stage-restricted entries when no stage is given", () => {
			const config = withMap([{ match: "*", stages: ["reflector"], model: "anthropic/big" }]);
			expect(resolveConfiguredModel(config, { provider: "openai", id: "gpt" })).toBeUndefined();
		});

		it("rejects an entry whose stages are all unknown rather than widening it to every stage", () => {
			writeJson(join(agentDir, "settings.json"), {
				"observational-memory": {
					modelMap: [
						{ match: "*", stages: ["bogus"], model: "anthropic/big" },
						{ match: "*", stages: ["observer", "bogus", "observer"], model: "synthetic/small" },
					],
				},
			});
			expect(loadConfig(cwd, {}).modelMap).toEqual([
				{ match: "*", stages: ["observer"], model: "synthetic/small" },
			]);
		});
		it("routes the reflection dropper as its own stage", () => {
			writeJson(join(agentDir, "settings.json"), {
				"observational-memory": {
					modelMap: [
						{ match: "*", stages: ["reflection-dropper"], model: "anthropic/big" },
						{ match: "*", model: "synthetic/small" },
					],
				},
			});
			const config = loadConfig(cwd, {});
			const active = { provider: "claude-bridge", id: "opus-5" };

			expect(resolveConfiguredModel(config, active, "reflection-dropper")).toEqual({
				provider: "anthropic",
				id: "big",
			});
			expect(resolveConfiguredModel(config, active, "dropper")).toEqual({
				provider: "synthetic",
				id: "small",
			});
		});
	});

	describe("parseMatchSelector", () => {
		it("keeps non-level suffixes and strips only a trailing thinking level", () => {
			expect(parseMatchSelector("synthetic/syn:large:text")).toEqual({ glob: "synthetic/syn:large:text" });
			expect(parseMatchSelector("synthetic/syn:free")).toEqual({ glob: "synthetic/syn:free" });
			expect(parseMatchSelector("synthetic/syn:large:high")).toEqual({ glob: "synthetic/syn:large", thinking: "high" });
			expect(parseMatchSelector("*:high")).toEqual({ glob: "*", thinking: "high" });
		});
	});

	describe("resolveModelString", () => {
		it("parses a literal provider/id/thinking reference", () => {
			expect(resolveModelString("openai/gpt-5:low", {})).toEqual({ provider: "openai", id: "gpt-5", thinking: "low" });
			expect(resolveModelString("opencode-go/deepseek-v4.1-flash", {})).toEqual({
				provider: "opencode-go",
				id: "deepseek-v4.1-flash",
			});
		});

		it("drops an unresolved $thinking separator and rejects other leftovers", () => {
			expect(resolveModelString("$model:$thinking", { provider: "p", id: "m" })).toEqual({ provider: "p", id: "m" });
			expect(resolveModelString("$provider/m:high", {})).toBeUndefined();
			expect(resolveModelString("nope", {})).toBeUndefined();
		});
	});

	describe("resolveWarnAt", () => {
		const config = {
			...DEFAULTS,
			selfCompact: {
				enabled: true,
				warnAt: [
					{ match: "anthropic/claude-opus-*:high", warnAt: [{ type: "ratio", value: 0.1 }] },
					{ match: "anthropic/*", warnAt: [{ type: "ratio", value: 0.3 }] },
				],
			},
		} as any;

		it("selects the first rule matching model and thinking level", () => {
			expect(resolveWarnAt(config, { provider: "anthropic", id: "claude-opus-5" }, "high")).toEqual([
				{ type: "ratio", value: 0.1 },
			]);
			expect(resolveWarnAt(config, { provider: "anthropic", id: "claude-opus-5" }, "low")).toEqual([
				{ type: "ratio", value: 0.3 },
			]);
		});

		it("returns no rules when nothing matches", () => {
			expect(resolveWarnAt(config, { provider: "openai", id: "gpt" }, "high")).toEqual([]);
			expect(resolveWarnAt(config, undefined)).toEqual([]);
		});
	});

	it("reads reflectionsPoolTargetTokens from settings and rejects invalid values", () => {
		writeJson(join(agentDir, "settings.json"), {
			"observational-memory": { reflectionsPoolTargetTokens: 3000 },
		});
		expect(loadConfig(cwd, {}).reflectionsPoolTargetTokens).toBe(3000);

		writeJson(join(agentDir, "settings.json"), {
			"observational-memory": { reflectionsPoolTargetTokens: 0 },
		});
		expect(loadConfig(cwd, {}).reflectionsPoolTargetTokens).toBe(8000);

		writeJson(join(agentDir, "settings.json"), {
			"observational-memory": { reflectionsPoolTargetTokens: "many" },
		});
		expect(loadConfig(cwd, {}).reflectionsPoolTargetTokens).toBe(8000);
	});
});
