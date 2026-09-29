import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerIndexCommand } from "./commands/index-embeddings.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerViewCommand } from "./commands/view.js";
import { registerCompactionHook } from "./hooks/compaction-hook.js";
import { registerCompactionTrigger } from "./hooks/compaction-trigger.js";
import { registerConsolidationTrigger } from "./hooks/consolidation-trigger.js";
import { registerRecallIndexing } from "./hooks/recall-indexing.js";
import { SessionEmbeddings } from "./embeddings.js";
import { Runtime } from "./runtime.js";
import { OM_EMBEDDINGS_INDEXED } from "./session-ledger/index.js";
import { registerRecallTool } from "./tools/recall-observation.js";

export default function observationalMemory(pi: ExtensionAPI) {
	const runtime = new Runtime();

	registerConsolidationTrigger(pi, runtime);
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
	registerRecallTool(pi, async (sessionId, entries, docs, query, options) => {
		await embeddings.catchUp(sessionId, entries, options);
		return embeddings.vectorScores(sessionId, docs, query);
	});
	registerIndexCommand(pi, runtime, embeddings);
	registerRecallIndexing(pi, runtime, embeddings);
}
