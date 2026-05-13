import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMemoryState } from "../branch.js";
import { observationPoolTokens as estimateObservationPoolTokens } from "../compaction.js";
import { countByRelevance, formatRelevanceHistogram } from "../relevance.js";
import type { Runtime } from "../runtime.js";
import { estimateStringTokens } from "../tokens.js";
import { reflectionContent, reflectionToPromptLine, type MemoryReflection, type ObservationRecord } from "../types.js";

export function registerViewCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om-view", {
		description: "Print observational memory details (reflections + observations)",
		handler: async (_args, ctx) => {
			runtime.ensureConfig(ctx.cwd);
			const entries = ctx.sessionManager.getBranch() as Parameters<typeof getMemoryState>[0];
			const { reflections: committedRefs, committedObs, pendingObs } = getMemoryState(entries);
			const committedRefItems = committedRefs as MemoryReflection[];

			const committedRefTokens = committedRefItems.reduce((s, r) => s + estimateStringTokens(reflectionContent(r)), 0);
			const committedRefCount = committedRefItems.length;

			const committedObsTokens = estimateObservationPoolTokens(committedObs);
			const committedObsCount = committedObs.length;

			const pendingObsTokens = estimateObservationPoolTokens(pendingObs);
			const pendingObsCount = pendingObs.length;

			const totalObsCount = committedObsCount + pendingObsCount;
			const totalObsTokens = estimateObservationPoolTokens([...committedObs, ...pendingObs]);
			const totalTokens = committedRefTokens + totalObsTokens;
			const relevanceHistogram = countByRelevance([...committedObs, ...pendingObs]);

			const plural = (n: number, singular: string, plural: string) => (n === 1 ? singular : plural);
			const renderObs = (r: ObservationRecord) =>
				`[${r.id}] ${r.timestamp} [${r.relevance}] ${r.content}`;

			const sections: string[] = [];

			sections.push(
				`Memory: ${committedRefCount} ${plural(committedRefCount, "reflection", "reflections")} · ` +
					`${totalObsCount} ${plural(totalObsCount, "observation", "observations")} ` +
					`(${committedObsCount} committed, ${pendingObsCount} pending) · ` +
					`~${totalTokens.toLocaleString()} tokens · ` +
					`relevance ${formatRelevanceHistogram(relevanceHistogram)}`,
			);
			sections.push("");

			sections.push(
				`── Reflections (${committedRefCount} ${plural(committedRefCount, "entry", "entries")}, ~${committedRefTokens.toLocaleString()} tokens) ──`,
			);
			if (committedRefItems.length > 0) {
				sections.push(committedRefItems.map(reflectionToPromptLine).join("\n\n"));
			} else {
				sections.push("(none)");
			}

			sections.push("");
			sections.push(
				`── Observations — committed (${committedObsCount} ${plural(committedObsCount, "observation", "observations")}, ~${committedObsTokens.toLocaleString()} tokens) ──`,
			);
			if (committedObs.length > 0) {
				sections.push(committedObs.map(renderObs).join("\n"));
			} else {
				sections.push("(none)");
			}

			sections.push("");
			sections.push(
				`── Observations — pending (${pendingObsCount} ${plural(pendingObsCount, "observation", "observations")}, ~${pendingObsTokens.toLocaleString()} tokens) ──`,
			);
			if (pendingObs.length > 0) {
				sections.push(pendingObs.map(renderObs).join("\n"));
			} else {
				sections.push("(none)");
			}

			sections.push("");
			sections.push("Tip: use /tree to browse the raw messages still live in the session.");

			ctx.ui.notify(sections.join("\n"), "info");
		},
	});
}
