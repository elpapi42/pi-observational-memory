import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

/** Persist only non-default values to keep the config file clean and future-proof. */
function diffFromDefaults(config: Config): Partial<Config> {
	const result: Partial<Config> = {};
	for (const [key, value] of Object.entries(config) as [keyof Config, Config[keyof Config]][]) {
		const defaultValue = DEFAULTS[key];
		if (JSON.stringify(value) !== JSON.stringify(defaultValue)) {
			(result as Record<string, unknown>)[key] = value;
		}
	}
	return result;
}

export function saveConfig(config: Config): void {
	const path = join(getAgentDir(), "observational-memory.json");
	const data = diffFromDefaults(config);

	if (Object.keys(data).length === 0) {
		// All defaults — remove the file so project-level configs can take effect
		try {
			if (existsSync(path)) unlinkSync(path);
		} catch {}
		return;
	}

	const tmpPath = `${path}.tmp`;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
	renameSync(tmpPath, path);
}
