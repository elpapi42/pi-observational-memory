import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export interface Config {
	observationThresholdTokens: number;
	compactionThresholdTokens: number;
	reflectionThresholdTokens: number;
	passive: boolean;
	compactionModel?: { provider: string; id: string };
}

export const DEFAULTS: Config = {
	observationThresholdTokens: 1_000,
	compactionThresholdTokens: 50_000,
	reflectionThresholdTokens: 30_000,
	passive: false,
};

const SETTINGS_KEY = "observational-memory";
const PASSIVE_ENV = "PI_OBSERVATIONAL_MEMORY_PASSIVE";

function normalizeSettingsConfig(value: Partial<Config>): Partial<Config> {
	const normalized = { ...value };
	if ("passive" in normalized && typeof normalized.passive !== "boolean") delete normalized.passive;
	return normalized;
}

export function readEnvConfig(env: NodeJS.ProcessEnv = process.env): Partial<Config> {
	const rawPassive = env[PASSIVE_ENV];
	if (rawPassive === undefined) return {};
	const passive = rawPassive.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(passive)) return { passive: true };
	if (["0", "false", "no", "off"].includes(passive)) return { passive: false };
	return {};
}

function readNamespacedConfig(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		const nested = raw[SETTINGS_KEY];
		return nested && typeof nested === "object" ? normalizeSettingsConfig(nested as Partial<Config>) : {};
	} catch {
		return {};
	}
}

export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): Config {
	const globalPath = join(getAgentDir(), "settings.json");
	const projectPath = join(cwd, ".pi", "settings.json");

	return {
		...DEFAULTS,
		...readNamespacedConfig(globalPath),
		...readNamespacedConfig(projectPath),
		...readEnvConfig(env),
	};
}
