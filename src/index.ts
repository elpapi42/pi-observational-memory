import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerIndexCommand } from "./commands/index-embeddings.js";
import { registerConsolidateCommand } from "./commands/consolidate.js";
import { registerExportDropsCommand } from "./commands/export-drops.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerViewCommand } from "./commands/view.js";
import { registerCompactionHook } from "./hooks/compaction-hook.js";
import { maybeTriggerCompaction, registerCompactionTrigger } from "./hooks/compaction-trigger.js";
import { registerConsolidationTrigger } from "./hooks/consolidation-trigger.js";
import { registerRecallIndexing } from "./hooks/recall-indexing.js";
import { registerSelfCompact } from "./hooks/self-compact.js";
import { SessionEmbeddings } from "./embeddings.js";
import { Runtime } from "./runtime.js";
import { OM_EMBEDDINGS_INDEXED, OM_WORKER_COST, type WorkerCostReport } from "./session-ledger/index.js";
import { registerRecallTool } from "./tools/recall-observation.js";
import { Text } from "@earendil-works/pi-tui";

/** One line per consolidation run: what that run's worker calls cost. */
function formatWorkerCost(
	report: WorkerCostReport,
	theme: { fg: (color: any, text: string) => string },
): string {
	return theme.fg("dim", `Worker run cost: $${report.cost.toFixed(4)}`);
}

export default function observationalMemory(pi: ExtensionAPI) {
	const runtime = new Runtime();

	registerConsolidationTrigger(pi, runtime, {
		afterIdleConsolidation: (ctx) => maybeTriggerCompaction(runtime, ctx as Parameters<typeof maybeTriggerCompaction>[1]),
	});
	pi.registerEntryRenderer<WorkerCostReport>(OM_WORKER_COST, (entry, _options, theme) =>
		entry.data === undefined ? undefined : new Text(formatWorkerCost(entry.data, theme), 0, 0),
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
