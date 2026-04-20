import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export interface Config {
	observationThresholdTokens: number;
	compactionThresholdTokens: number;
	reflectionThresholdTokens: number;
	compactionModel?: { provider: string; id: string };
}

export const DEFAULTS: Config = {
	observationThresholdTokens: 1_000,
	compactionThresholdTokens: 50_000,
	reflectionThresholdTokens: 30_000,
};

const SETTINGS_KEY = "observational-memory";

function readNamespacedConfig(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		const nested = raw[SETTINGS_KEY];
		return nested && typeof nested === "object" ? (nested as Partial<Config>) : {};
	} catch {
		return {};
	}
}

export function loadConfig(cwd: string): Config {
	const globalPath = join(getAgentDir(), "settings.json");
	const projectPath = join(cwd, ".pi", "settings.json");

	return {
		...DEFAULTS,
		...readNamespacedConfig(globalPath),
		...readNamespacedConfig(projectPath),
	};
}
