import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Runtime } from "../runtime.js";

export function registerNativeCompactCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om-compact-native", {
		description: "Run one normal Pi compaction, bypassing observational memory for this compaction only",
		handler: async (args, ctx) => {
			runtime.bypassNextCompactionHook = true;
			const customInstructions = args.trim() || undefined;
			ctx.ui.notify(
				"Observational memory: bypassing the custom compaction hook once; running normal Pi compaction",
				"info",
			);
			ctx.compact({
				customInstructions,
				onComplete: () => {
					runtime.bypassNextCompactionHook = false;
					ctx.ui.notify(
						"Observational memory: normal Pi compaction completed; future compactions will use observational memory again",
						"info",
					);
				},
				onError: (error) => {
					runtime.bypassNextCompactionHook = false;
					ctx.ui.notify(`Observational memory: normal Pi compaction failed: ${error.message}`, "warning");
				},
			});
		},
	});
}
