import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerCommands } from "./commands.js";
import { DEFAULT_CONFIG, type TomConfig } from "./config.js";
import { runObserver } from "./observer.js";
import { runReflector } from "./reflector.js";
import { loadState, observationsTokenTotal, serializeState, type TomState } from "./state.js";
import { buildSummary } from "./summary.js";
import { newTriggerState, selectChunk, shouldFire } from "./trigger.js";

export default function tomExtension(pi: ExtensionAPI, overrides?: Partial<TomConfig>): void {
	const cfg: TomConfig = { ...DEFAULT_CONFIG, ...(overrides ?? {}) };
	const trig = newTriggerState();

	let forceReflectNext = false;
	let cycleCount = 0;
	let lastRawTokens: number | null = null;

	pi.on("tool_execution_start", () => {
		trig.lastToolCallAt = Date.now();
	});
	pi.on("tool_execution_end", () => {
		trig.lastToolCallAt = Date.now();
	});

	pi.on("turn_end", async (_event, ctx) => {
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null) return;
		const branch = ctx.sessionManager.getBranch();
		const state = loadState(branch);
		const nonRaw = observationsTokenTotal(state) + Math.ceil(state.reflections.length / 4);
		const rawTokens = Math.max(0, usage.tokens - nonRaw);
		lastRawTokens = rawTokens;
		if (!shouldFire(rawTokens, cfg, trig, Date.now())) return;
		trig.inFlight = true;
		ctx.compact({
			customInstructions: "tom-observe",
			onComplete: () => {
				trig.inFlight = false;
			},
			onError: () => {
				trig.inFlight = false;
			},
		});
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, branchEntries, signal } = event;
		const prior = loadState(branchEntries);
		const wantReflect = forceReflectNext;
		forceReflectNext = false;

		const allMessages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
		if (allMessages.length === 0) return;

		const { chunk } = selectChunk(allMessages, cfg);
		if (chunk.length === 0) return;

		try {
			const observation = await runObserver(chunk, prior, cfg, ctx, signal);
			if (!observation) {
				if (ctx.hasUI) ctx.ui.notify("TOM: observer produced no output; skipping cycle", "warning");
				return { cancel: true };
			}

			let next: TomState = {
				version: 1,
				reflections: prior.reflections,
				observations: [...prior.observations, observation],
			};

			const shouldReflect = wantReflect || observationsTokenTotal(next) > cfg.R;
			if (shouldReflect) {
				const reflected = await runReflector(next, cfg, ctx, signal);
				if (reflected) next = reflected;
				else if (ctx.hasUI) ctx.ui.notify("TOM: reflector failed, keeping observations", "warning");
			}

			const summary = buildSummary(next);
			cycleCount += 1;
			if (ctx.hasUI) {
				ctx.ui.notify(
					`TOM cycle #${cycleCount}: +1 observation (${observation.priority}), total=${next.observations.length}${shouldReflect ? ", reflected" : ""}`,
					"info",
				);
			}

			return {
				compaction: {
					summary,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					details: serializeState(next),
				},
			};
		} catch (err) {
			if (signal.aborted) return { cancel: true };
			const msg = err instanceof Error ? err.message : String(err);
			if (ctx.hasUI) ctx.ui.notify(`TOM cycle failed: ${msg}`, "error");
			return { cancel: true };
		}
	});

	registerCommands(pi, {
		cfg,
		forceReflect: () => {
			forceReflectNext = true;
		},
		cycleCount: () => cycleCount,
		lastRawTokens: () => lastRawTokens,
	});
}
