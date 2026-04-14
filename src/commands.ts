import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { TomConfig } from "./config.js";
import { loadState, observationsTokenTotal } from "./state.js";

interface TomRuntime {
	cfg: TomConfig;
	forceReflect: () => void;
	cycleCount: () => number;
	lastRawTokens: () => number | null;
}

export function registerCommands(pi: ExtensionAPI, rt: TomRuntime): void {
	pi.registerCommand("tom-status", {
		description: "Show TOM memory tier sizes and cycle count",
		handler: async (_args, ctx) => {
			const branch = ctx.sessionManager.getBranch();
			const state = loadState(branch);
			const obsTokens = observationsTokenTotal(state);
			const reflectionTokens = Math.ceil(state.reflections.length / 4);
			const raw = rt.lastRawTokens();
			const rawStr = raw === null ? "unknown" : raw.toLocaleString();
			const lines = [
				`TOM status:`,
				`  T=${rt.cfg.T.toLocaleString()}  R=${rt.cfg.R.toLocaleString()}  keepRecentTokens=${rt.cfg.keepRecentTokens.toLocaleString()}`,
				`  raw tokens:        ${rawStr}`,
				`  observations:      ${state.observations.length} (${obsTokens.toLocaleString()} tokens)`,
				`  reflections:       ${reflectionTokens.toLocaleString()} tokens`,
				`  cycles this session: ${rt.cycleCount()}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("tom-reflect", {
		description: "Force a reflection cycle on the next compaction",
		handler: async (_args, ctx) => {
			rt.forceReflect();
			ctx.ui.notify("TOM: reflection will run on next compaction", "info");
			ctx.compact({ customInstructions: "tom-force-reflect" });
		},
	});

	pi.registerCommand("tom-dump", {
		description: "Dump current TOM state as JSON",
		handler: async (_args, ctx) => {
			const branch = ctx.sessionManager.getBranch();
			const state = loadState(branch);
			ctx.ui.notify(JSON.stringify(state, null, 2), "info");
		},
	});
}
