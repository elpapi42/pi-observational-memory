import { Component, truncateToWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Config } from "./config.js";
import type { MemoryState } from "./types.js";
import { estimateRawTailTokens, estimateTokens, formatK } from "./tokens.js";

const BAR_WIDTH = 12;

function renderProgressLine(
	theme: Theme,
	rawTokens: number,
	obsTokens: number,
	refTokens: number,
	config: Config,
	width: number,
): string {
	const threshold = config.observationThreshold;
	const pct = Math.min(rawTokens / threshold, 1);
	const filled = Math.round(pct * BAR_WIDTH);
	const empty = BAR_WIDTH - filled;

	const barColor: "accent" | "warning" | "error" = pct >= 0.95 ? "error" : pct >= 0.8 ? "warning" : "accent";
	const bar = theme.fg(barColor, "█".repeat(filled)) + theme.fg("borderMuted", "░".repeat(empty));

	const brand = theme.fg("accent", "🧠 OM");
	const progress = theme.fg("text", `${formatK(rawTokens)}/${formatK(threshold)}`);
	const obs = theme.fg("dim", `obs ${formatK(obsTokens)}`);
	const ref = theme.fg("dim", `ref ${formatK(refTokens)}`);
	const hint = theme.fg("muted", "⚙ /om-settings");

	const line = ` ${brand}  ${bar}  ${progress}  │  ${obs}  ${ref}  │  ${hint}`;
	return truncateToWidth(line, width);
}

export interface OmWidgetDeps {
	getState(): MemoryState;
	getConfig(): Config;
	getEntries(): Array<{ type: string; message?: unknown; content?: unknown; firstKeptEntryId?: string; id?: string }>;
}

export function createOmWidget(theme: Theme, deps: OmWidgetDeps): Component & { dispose?(): void } {
	return {
		render(width: number): string[] {
			const { getState, getConfig, getEntries } = deps;
			const state = getState();
			const config = getConfig();
			const entries = getEntries();
			const rawTokens = estimateRawTailTokens(entries);
			const obsTokens = estimateTokens(state.observations);
			const refTokens = estimateTokens(state.reflections);
			return [renderProgressLine(theme, rawTokens, obsTokens, refTokens, config, width)];
		},
		invalidate(): void {},
		dispose(): void {},
	};
}
