import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerActivationCommand } from "./commands/om.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerViewCommand } from "./commands/view.js";
import { registerCompactionHook } from "./hooks/compaction-hook.js";
import { registerCompactionTrigger } from "./hooks/compaction-trigger.js";
import { registerConsolidationTrigger } from "./hooks/consolidation-trigger.js";
import { registerLifecycleReset } from "./hooks/lifecycle.js";
import { gateRecallTool } from "./tool-gate.js";
import { Runtime } from "./runtime.js";
import { registerRecallTool } from "./tools/recall-observation.js";
export default function observationalMemory(pi: ExtensionAPI) {
	const runtime = new Runtime();
	runtime.sessionBoundaryReset = () => gateRecallTool(pi, runtime);
	registerLifecycleReset(pi, runtime);
	registerActivationCommand(pi, runtime);

	registerConsolidationTrigger(pi, runtime);
	registerCompactionTrigger(pi, runtime);
	registerCompactionHook(pi, runtime);

	registerStatusCommand(pi, runtime);
	registerViewCommand(pi, runtime);
	registerRecallTool(pi, runtime);
}
