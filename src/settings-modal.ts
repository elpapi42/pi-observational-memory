import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { SettingsList, type SettingItem, type Component, truncateToWidth } from "@mariozechner/pi-tui";
import type { Config } from "./config.js";
import { estimateRawTailTokens, estimateTokens, formatK } from "./tokens.js";
import type { MemoryState } from "./types.js";

const OBSERVATION_THRESHOLDS = ["20,000", "30,000", "50,000", "80,000", "100,000"];
const REFLECTION_THRESHOLDS = ["15,000", "20,000", "30,000", "50,000", "80,000"];
const MODEL_DEFAULT = "Session default";

function parseThreshold(value: string): number | undefined {
	const num = Number.parseInt(value.replace(/,/g, ""), 10);
	if (!Number.isFinite(num) || num <= 0) return undefined;
	return num;
}

function buildModelList(ctx: ExtensionCommandContext): string[] {
	const models = ctx.modelRegistry.getAvailable();
	const entries: string[] = [MODEL_DEFAULT];
	for (const model of models) {
		entries.push(`${model.provider}/${model.id}`);
	}
	return entries;
}

function currentModelDisplay(config: Config, ctx: ExtensionCommandContext): string {
	if (!config.compactionModel) return MODEL_DEFAULT;
	const match = ctx.modelRegistry.find(config.compactionModel.provider, config.compactionModel.id);
	if (match) return `${match.provider}/${match.id}`;
	return `${config.compactionModel.provider}/${config.compactionModel.id}`;
}

function buildSettingItems(
	config: Config,
	ctx: ExtensionCommandContext,
	theme: Theme,
	rawTokens: number,
	obsTokens: number,
	refTokens: number,
): SettingItem[] {
	const headroom = config.observationThreshold - rawTokens;
	const headroomDesc = headroom > 0 ? `~${formatK(headroom)} headroom` : "threshold exceeded — compaction imminent";

	return [
		{
			id: "observationThreshold",
			label: "Observation threshold",
			description: `Triggers observer + compaction when raw messages exceed this. Currently ~${formatK(rawTokens)} tokens (${headroomDesc}).`,
			currentValue: config.observationThreshold.toLocaleString(),
			values: OBSERVATION_THRESHOLDS,
		},
		{
			id: "reflectionThreshold",
			label: "Reflection threshold",
			description: `Triggers reflector (promote facts → reflections, prune dead observations) when accumulated observations exceed this. Currently ~${formatK(obsTokens)} tokens.`,
			currentValue: config.reflectionThreshold.toLocaleString(),
			values: REFLECTION_THRESHOLDS,
		},
		{
			id: "compactionModel",
			label: "Compaction model",
			description: "Model used for observer + reflector LLM passes. Cheaper models work well here.",
			currentValue: currentModelDisplay(config, ctx),
			submenu: (currentValue, done) => createModelPicker(currentValue, buildModelList(ctx), theme, done),
		},
	];
}

function applySetting(config: Config, id: string, value: string): Config {
	switch (id) {
		case "observationThreshold": {
			const parsed = parseThreshold(value);
			return parsed ? { ...config, observationThreshold: parsed } : config;
		}
		case "reflectionThreshold": {
			const parsed = parseThreshold(value);
			return parsed ? { ...config, reflectionThreshold: parsed } : config;
		}
		case "compactionModel": {
			if (value === MODEL_DEFAULT) {
				const { compactionModel: _, ...rest } = config;
				return rest;
			}
			const slashIdx = value.indexOf("/");
			if (slashIdx !== -1) {
				return { ...config, compactionModel: { provider: value.slice(0, slashIdx), id: value.slice(slashIdx + 1) } };
			}
			return config;
		}
		default:
			return config;
	}
}

function createModelPicker(
	currentValue: string,
	models: string[],
	theme: Theme,
	done: (selectedValue?: string) => void,
): Component {
	let selectedIndex = models.indexOf(currentValue);
	if (selectedIndex === -1) selectedIndex = 0;

	return {
		render(width: number): string[] {
			const lines: string[] = [];
			for (let i = 0; i < models.length; i++) {
				const marker = i === selectedIndex ? "● " : "  ";
				const label = models[i]!;
				const isSelected = i === selectedIndex;
				const styled = isSelected ? theme.bold(label) : label;
				lines.push(truncateToWidth(`${marker}${styled}`, width));
			}
			return lines;
		},
		invalidate(): void {},
		handleInput(data: string): void {
			if (data === "\x1b[A" || data === "k") {
				// Up
				selectedIndex = Math.max(0, selectedIndex - 1);
			} else if (data === "\x1b[B" || data === "j") {
				// Down
				selectedIndex = Math.min(models.length - 1, selectedIndex + 1);
			} else if (data === "\r" || data === "\n" || data === " ") {
				// Enter / Space — select
				done(models[selectedIndex]);
			} else if (data === "\x1b" || data === "q") {
				// Escape — cancel
				done();
			}
		},
	};
}

export async function openSettingsModal(
	ctx: ExtensionCommandContext,
	config: Config,
	state: MemoryState,
	onConfigChange: (newConfig: Config) => void,
): Promise<void> {
	const entries = ctx.sessionManager.getBranch();
	const rawTokens = estimateRawTailTokens(entries);
	const obsTokens = estimateTokens(state.observations);
	const refTokens = estimateTokens(state.reflections);

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		let currentConfig = config;

		const settingsList = new SettingsList(
			buildSettingItems(currentConfig, ctx, theme, rawTokens, obsTokens, refTokens),
			10,
			getSettingsListTheme(),
			(id: string, value: string) => {
				currentConfig = applySetting(currentConfig, id, value);
				onConfigChange(currentConfig);
			},
			() => {
				done();
			},
			{ enableSearch: false },
		);

		return {
			render(width: number): string[] {
				return settingsList.render(width);
			},
			invalidate(): void {
				settingsList.invalidate();
			},
			handleInput(data: string): void {
				settingsList.handleInput(data);
				tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { anchor: "center", width: 72, maxHeight: "70%" } });
}
