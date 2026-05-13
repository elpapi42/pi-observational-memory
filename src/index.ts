import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerNativeCompactCommand } from "./commands/native-compact.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerViewCommand } from "./commands/view.js";
import { registerCompactionHook } from "./hooks/compaction-hook.js";
import { registerCompactionTrigger } from "./hooks/compaction-trigger.js";
import { registerObserverTrigger } from "./hooks/observer-trigger.js";
import { Runtime } from "./runtime.js";
import { registerRecallTool } from "./tools/recall-observation.js";

export default function observationalMemory(pi: ExtensionAPI) {
	const runtime = new Runtime();

	registerObserverTrigger(pi, runtime);
	registerCompactionTrigger(pi, runtime);
	registerCompactionHook(pi, runtime);

	registerStatusCommand(pi, runtime);
	registerViewCommand(pi, runtime);
	registerNativeCompactCommand(pi, runtime);
	registerRecallTool(pi);
}
