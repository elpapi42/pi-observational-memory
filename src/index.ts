import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerIndexCommand } from "./commands/index-embeddings.js";
import { registerConsolidateCommand } from "./commands/consolidate.js";
import { registerExportDropsCommand } from "./commands/export-drops.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerViewCommand } from "./commands/view.js";
import { registerCompactionHook } from "./hooks/compaction-hook.js";
import { registerCompactionTrigger } from "./hooks/compaction-trigger.js";
import { registerConsolidationTrigger } from "./hooks/consolidation-trigger.js";
import { registerRecallIndexing } from "./hooks/recall-indexing.js";
import { registerSelfCompact } from "./hooks/self-compact.js";
import { SessionEmbeddings } from "./embeddings.js";
import { Runtime } from "./runtime.js";
import { OM_EMBEDDINGS_INDEXED, OM_SESSION_COST, type SessionCostReport } from "./session-ledger/index.js";
import { registerRecallTool } from "./tools/recall-observation.js";
import { Text } from "@earendil-works/pi-tui";

/**
 * One line per consolidation run: pi's session cost, the worker cost pi does
 * not see, the running total, and what this run added.
 */
function formatSessionCost(
	report: SessionCostReport,
	theme: { fg: (color: any, text: string) => string },
): string {
	const money = (value: number) => `$${value.toFixed(4)}`;
	const parts = [
		theme.fg("muted", `session ${money(report.sessionCost)}`),
		theme.fg("warning", `workers ${money(report.workerCost)}`),
		theme.fg("accent", `total ${money(report.totalCost)}`),
	];
	if (report.runCost > 0) parts.push(theme.fg("dim", `+${money(report.runCost)} this run`));
	return `Observational memory cost: ${parts.join(" · ")}`;
}

export default function observationalMemory(pi: ExtensionAPI) {
	const runtime = new Runtime();

	registerConsolidationTrigger(pi, runtime);
	pi.registerEntryRenderer<SessionCostReport>(OM_SESSION_COST, (entry, _options, theme) =>
		entry.data === undefined ? undefined : new Text(formatSessionCost(entry.data, theme), 0, 0),
	);
	registerSelfCompact(pi, runtime);
	registerCompactionTrigger(pi, runtime);
	registerCompactionHook(pi, runtime);

	const embeddings = new SessionEmbeddings(
		() => runtime.config.recallEmbeddings,
		undefined,
		undefined,
		(data) => pi.appendEntry(OM_EMBEDDINGS_INDEXED, data),
	);
	registerStatusCommand(pi, runtime, embeddings);
	registerViewCommand(pi, runtime);
	registerConsolidateCommand(pi, runtime);
	registerRecallTool(pi, async (sessionId, entries, docs, query, options) => {
		await embeddings.catchUp(sessionId, entries, options);
		return embeddings.vectorScores(sessionId, docs, query);
	});
	registerIndexCommand(pi, runtime, embeddings);
	registerRecallIndexing(pi, runtime, embeddings);
	registerExportDropsCommand(pi, runtime);
}
