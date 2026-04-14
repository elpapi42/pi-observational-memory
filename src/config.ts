import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export interface TomConfig {
	S: number;
	T: number;
	R: number;
	observerModel: { provider: string; id: string };
	reflectorModel: { provider: string; id: string };
	debounceMs: number;
	observerMaxTokens: number;
	reflectorMaxTokens: number;
}

export const DEFAULT_CONFIG: TomConfig = {
	S: 10_000,
	T: 50_000,
	R: 30_000,
	observerModel: { provider: "google", id: "gemini-2.5-flash" },
	reflectorModel: { provider: "google", id: "gemini-2.5-flash" },
	debounceMs: 2_000,
	observerMaxTokens: 2_048,
	reflectorMaxTokens: 4_096,
};

function readConfigFile(path: string): Partial<TomConfig> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Partial<TomConfig>;
	} catch {
		return {};
	}
}

export function loadConfig(cwd: string, overrides?: Partial<TomConfig>): TomConfig {
	const globalConfig = readConfigFile(join(getAgentDir(), "extensions", "tom.json"));
	const projectConfig = readConfigFile(join(cwd, ".pi", "tom.json"));
	return { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig, ...(overrides ?? {}) };
}

export function batchSize(cfg: TomConfig): number {
	return cfg.T - cfg.S;
}
