import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DISABLED_MESSAGE, type Runtime } from "../runtime.js";
import { copyTextToClipboard } from "../clipboard.js";
import {
	fullProjection,
	observationToSummaryLine,
	reflectionToSummaryLine,
	visibleProjection,
	type Entry,
	type Projection,
} from "../session-ledger/index.js";

function firstArg(args: unknown): string | undefined {
	if (Array.isArray(args)) return typeof args[0] === "string" ? args[0] : undefined;
	if (typeof args === "string") return args.trim().split(/\s+/)[0];
	if (args && typeof args === "object" && "mode" in args) {
		const mode = (args as { mode?: unknown }).mode;
		return typeof mode === "string" ? mode : undefined;
	}
	return undefined;
}

function renderList<T>(items: T[], render: (item: T) => string, empty: string): string {
	return items.length > 0 ? items.map(render).join("\n") : empty;
}

function renderContentOnlyProjection(projection: Projection, emptyScope: "visible" | "recorded"): string {
	return [
		"── Reflections ──",
		renderList(projection.reflections, reflectionToSummaryLine, `No ${emptyScope} reflections.`),
		"",
		"── Observations ──",
		renderList(projection.observations, observationToSummaryLine, `No ${emptyScope} observations.`),
	].join("\n");
}

interface ViewCommandOptions {
	copyToClipboard?: (text: string) => Promise<boolean>;
}

export function registerViewCommand(pi: ExtensionAPI, runtime: Runtime, options: ViewCommandOptions = {}): void {
	const copyToClipboard = options.copyToClipboard ?? copyTextToClipboard;

	pi.registerCommand("om:view", {
		description: "Print and copy observational memory content (visible by default, full for recorded memory)",
		handler: async (args, ctx) => {
			if (!runtime.enabled) {
				ctx.ui.notify(DISABLED_MESSAGE, "info");
				return;
			}
			runtime.ensureConfig(ctx.cwd);
			const entries = ctx.sessionManager.getBranch() as Entry[];
			const mode = firstArg(args);

			const notifyWithCopy = async (output: string) => {
				const copied = await copyToClipboard(output).catch(() => false);
				ctx.ui.notify(
					copied
						? `${output}\n\nCopied /om:view output to clipboard.`
						: `${output}\n\nWarning: failed to copy /om:view output to clipboard.`,
					"info",
				);
			};

			if (mode === "full") {
				await notifyWithCopy(renderContentOnlyProjection(fullProjection(entries), "recorded"));
				return;
			}

			if (mode && mode !== "visible") {
				ctx.ui.notify("Usage: /om:view [full]", "info");
				return;
			}

			await notifyWithCopy(renderContentOnlyProjection(visibleProjection(entries), "visible"));
		},
	});
}
