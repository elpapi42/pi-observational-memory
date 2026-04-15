import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export interface Config {
	observationThreshold: number;
	reflectionThreshold: number;
	compactionModel?: { provider: string; id: string };
}

export const DEFAULTS: Config = {
	observationThreshold: 50_000,
	reflectionThreshold: 30_000,
};

export function loadConfig(cwd: string): Config {
	const globalPath = join(getAgentDir(), "observational-memory.json");
	const projectPath = join(cwd, ".pi", "observational-memory.json");

	let globalConfig: Partial<Config> = {};
	let projectConfig: Partial<Config> = {};

	if (existsSync(globalPath)) {
		try {
			globalConfig = JSON.parse(readFileSync(globalPath, "utf-8"));
		} catch {}
	}

	if (existsSync(projectPath)) {
		try {
			projectConfig = JSON.parse(readFileSync(projectPath, "utf-8"));
		} catch {}
	}

	return { ...DEFAULTS, ...globalConfig, ...projectConfig };
}
