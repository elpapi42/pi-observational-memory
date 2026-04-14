import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export interface TomConfig {
	T: number;
	R: number;
	keepRecentTokens: number;
	observerModel: { provider: string; id: string };
	reflectorModel: { provider: string; id: string };
	debounceMs: number;
	observerMaxTokens: number;
	reflectorMaxTokens: number;
}

const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

export const DEFAULT_CONFIG: Omit<TomConfig, "keepRecentTokens"> = {
	T: 50_000,
	R: 30_000,
	observerModel: { provider: "google", id: "gemini-2.5-flash" },
	reflectorModel: { provider: "google", id: "gemini-2.5-flash" },
	debounceMs: 2_000,
	observerMaxTokens: 2_048,
	reflectorMaxTokens: 4_096,
};

function readJsonFile(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function readPiKeepRecentTokens(cwd: string): number {
	const globalSettings = readJsonFile(join(getAgentDir(), "settings.json"));
	const projectSettings = readJsonFile(join(cwd, ".pi", "settings.json"));
	const globalVal = (globalSettings.compaction as Record<string, unknown> | undefined)?.keepRecentTokens;
	const projectVal = (projectSettings.compaction as Record<string, unknown> | undefined)?.keepRecentTokens;
	if (typeof projectVal === "number") return projectVal;
	if (typeof globalVal === "number") return globalVal;
	return DEFAULT_KEEP_RECENT_TOKENS;
}

export function loadConfig(cwd: string, overrides?: Partial<TomConfig>): TomConfig {
	const keepRecentTokens = overrides?.keepRecentTokens ?? readPiKeepRecentTokens(cwd);
	const globalTom = readJsonFile(join(getAgentDir(), "extensions", "tom.json")) as Partial<TomConfig>;
	const projectTom = readJsonFile(join(cwd, ".pi", "tom.json")) as Partial<TomConfig>;
	const { keepRecentTokens: _g, ...globalConfig } = globalTom;
	const { keepRecentTokens: _p, ...projectConfig } = projectTom;
	return {
		...DEFAULT_CONFIG,
		...globalConfig,
		...projectConfig,
		...(overrides ?? {}),
		keepRecentTokens,
	};
}
