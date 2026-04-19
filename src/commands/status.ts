import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SettingsManager } from "@mariozechner/pi-coding-agent";
import {
	getMemoryState,
	rawTokensSinceLastBound,
	rawTokensSinceLastCompaction,
} from "../branch.js";
import { countByRelevance, formatRelevanceHistogram } from "../relevance.js";
import type { Runtime } from "../runtime.js";
import { estimateStringTokens } from "../tokens.js";

export function registerStatusCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om-status", {
		description: "Show observational memory status",
		handler: async (_args, ctx) => {
			runtime.ensureConfig(ctx.cwd);
			const entries = ctx.sessionManager.getBranch() as Parameters<typeof rawTokensSinceLastBound>[0];
			const sinceBound = rawTokensSinceLastBound(entries);
			const sinceCompaction = rawTokensSinceLastCompaction(entries);

			const { reflections: committedRefs, committedObs, pendingObs } = getMemoryState(entries);
			const committedObsTokens = committedObs.reduce((s, r) => s + estimateStringTokens(r.content), 0);
			const committedObsCount = committedObs.length;
			const committedRefsTokens = committedRefs.reduce((s, r) => s + estimateStringTokens(r), 0);
			const committedRefsCount = committedRefs.length;

			const pendingObsTokens = pendingObs.reduce((s, r) => s + estimateStringTokens(r.content), 0);
			const pendingObsCount = pendingObs.length;

			const relevanceHistogram = countByRelevance([...committedObs, ...pendingObs]);

			const keepRecentTokens = SettingsManager.create(ctx.cwd).getCompactionKeepRecentTokens();

			const obsThreshold = runtime.config.observationThresholdTokens;
			const compThreshold = runtime.config.compactionThresholdTokens;
			const refThreshold = runtime.config.reflectionThresholdTokens;
			const observationPoolTokens = committedObsTokens + pendingObsTokens;
			const obsPct = Math.min(100, Math.round((sinceBound / obsThreshold) * 100));
			const compPct = Math.min(100, Math.round((sinceCompaction / compThreshold) * 100));
			const refPct = Math.min(100, Math.round((observationPoolTokens / refThreshold) * 100));

			const refLabel = committedRefsCount === 1 ? "entry" : "entries";
			const cObsLabel = committedObsCount === 1 ? "observation" : "observations";
			const pObsLabel = pendingObsCount === 1 ? "observation" : "observations";

			const lines = [
				"── Memory ──",
				`Reflections:   ~${committedRefsTokens.toLocaleString()} tokens (${committedRefsCount} ${refLabel})      — durable insights`,
				`Observations:`,
				`  committed    ~${committedObsTokens.toLocaleString()} tokens (${committedObsCount} ${cObsLabel}) — folded into last compaction`,
				`  pending      ~${pendingObsTokens.toLocaleString()} tokens (${pendingObsCount} ${pObsLabel}) — waiting for next compaction`,
				`  relevance    ${formatRelevanceHistogram(relevanceHistogram)}`,
				"",
				"── Activity ──",
				`Next observation: ~${sinceBound.toLocaleString()} / ${obsThreshold.toLocaleString()} tokens (${obsPct}%)`,
				`  → at ${obsThreshold.toLocaleString()} tokens, recent conversation is compressed into new observations`,
				`Next compaction:  ~${sinceCompaction.toLocaleString()} / ${compThreshold.toLocaleString()} tokens (${compPct}%)`,
				`  → at ${compThreshold.toLocaleString()} tokens, raw history is replaced by the updated reflections and`,
				`    observations, keeping only the last ${keepRecentTokens.toLocaleString()} tokens of conversation verbatim`,
				`Next reflection:  ~${observationPoolTokens.toLocaleString()} / ${refThreshold.toLocaleString()} tokens (${refPct}%)`,
				`  → if observations exceed ${refThreshold.toLocaleString()} tokens when compaction runs, reflections are`,
				`    distilled from them and redundant observations are pruned away`,
			];

			if (runtime.observerInFlight || runtime.compactInFlight) {
				lines.push("");
				lines.push("── In flight ──");
				if (runtime.observerInFlight) lines.push("Observer: running");
				if (runtime.compactInFlight) lines.push("Compaction: running");
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
