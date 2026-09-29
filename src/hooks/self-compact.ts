import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { resolveTokenThreshold } from "../config.js";
import type { Runtime } from "../runtime.js";
import { OM_SELF_COMPACT_WARNING, type Entry } from "../session-ledger/index.js";

export const SELF_COMPACT_TOOL_NAME = "compact_context";
export const SELF_COMPACT_RESUME_TYPE = "om.self-compact.resume";
/** Debug record: a run started while a self-compaction was still running. */
export const SELF_COMPACT_OVERLAP_TYPE = "om.self-compact.overlap";

const compactContextTool = (runtime: Runtime) => defineTool({
	name: SELF_COMPACT_TOOL_NAME,
	label: "Compact context",
	description:
		"Compact context into memory at a clean breakpoint; recent turns stay verbatim. Ends this turn.",
	parameters: Type.Object({
		resume: Type.String({
			description: "Current task and next step, or what you are waiting on. Kept in context after compaction.",
		}),
	}),
	renderResult(result, options, theme, context) {
		const status = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		const resume = context.args.resume?.trim();
		let text = theme.fg("toolOutput", status);
		if (options.expanded && resume) text += `\n\n${theme.fg("muted", "Resume note:")}\n${theme.fg("toolOutput", resume)}`;
		return new Text(text, 0, 0);
	},
	async execute(_toolCallId, params) {
		const scheduled = runtime.selfCompactPending === undefined;
		if (scheduled) runtime.selfCompactPending = { resume: params.resume?.trim() ?? "" };
		return {
			content: [{ type: "text", text: scheduled ? "Compaction scheduled." : "Compaction already scheduled." }],
			details: { scheduled },
			terminate: true,
		};
	},
});

// On success the retained tail already holds the tool call and its note, so only the failure repeats it.
function sendResume(pi: ExtensionAPI, resume: string, failure?: string): void {
	const content = failure
		? `Compaction failed: ${failure}. Continue without compacting${resume ? ` from your note:\n\n${resume}` : "."}`
		: `Compaction complete. Continue from the resume note in your ${SELF_COMPACT_TOOL_NAME} call.`;
	pi.sendMessage({ customType: SELF_COMPACT_RESUME_TYPE, content, display: true }, { triggerTurn: true });
}

/** The latest compaction's entry id, or "" before the first compaction. */
function currentWarningCycle(entries: Entry[]): string {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") return entries[i].id;
	}
	return "";
}

/**
 * A warning belongs to the cycle it was sent in. Kept-tail warnings, ones queued before a
 * compaction but delivered after it, and ones without a recorded cycle are stale.
 */
function isCurrentWarning(details: unknown, cycle: string): boolean {
	return (details as { cycle?: unknown } | undefined)?.cycle === cycle;
}

/** Highest warning level already sent this cycle, read from the branch so reloads do not repeat it. */
function warnedLevelThisCycle(entries: Entry[], cycle: string): number {
	let level = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "compaction") break;
		if (entry.type !== "custom_message" || entry.customType !== OM_SELF_COMPACT_WARNING) continue;
		if (!isCurrentWarning(entry.details, cycle)) continue;
		const sent = (entry.details as { level?: unknown } | undefined)?.level;
		if (typeof sent === "number" && sent > level) level = sent;
	}
	return level;
}

export function registerSelfCompact(pi: ExtensionAPI, runtime: Runtime): void {
	let registered = false;
	// Only this hook's compaction; the resume turn starts after it is cleared.
	let compacting: { overlapRecorded: boolean } | undefined;
	// Queued warnings reach the branch only when delivered.
	let queued = { cycle: "", level: 0 };

	pi.on("session_start", (_event, ctx) => {
		runtime.ensureConfig(ctx.cwd);
		runtime.selfCompactPending = undefined;
		const enabled = runtime.config.selfCompact.enabled;
		const active = pi.getActiveTools();
		if (enabled && !registered) {
			pi.registerTool(compactContextTool(runtime));
			registered = true;
		} else if (enabled && !active.includes(SELF_COMPACT_TOOL_NAME)) {
			pi.setActiveTools([...active, SELF_COMPACT_TOOL_NAME]);
		} else if (!enabled && active.includes(SELF_COMPACT_TOOL_NAME)) {
			pi.setActiveTools(active.filter((name) => name !== SELF_COMPACT_TOOL_NAME));
		}
	});

	pi.on("turn_end", (event, ctx: ExtensionContext) => {
		const { enabled, warnAt } = runtime.config.selfCompact;
		if (!enabled || warnAt.length === 0 || runtime.selfCompactPending) return;
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null) return;
		const tokens = usage.tokens;
		// A ratio without a known window never fires.
		const thresholds = warnAt.map((threshold) => resolveTokenThreshold(threshold, usage.contextWindow, Infinity));
		const level = thresholds.filter((threshold) => tokens >= threshold).length;
		if (level === 0) return;

		const branch = ctx.sessionManager.getBranch() as Entry[];
		const cycle = currentWarningCycle(branch);
		const already = Math.max(warnedLevelThisCycle(branch, cycle), queued.cycle === cycle ? queued.level : 0);
		if (level <= already) return;
		queued = { cycle, level };

		const percent = usage.contextWindow > 0 ? Math.round((tokens / usage.contextWindow) * 100) : undefined;
		const used = percent === undefined ? `${tokens} tokens` : `${percent}% (${tokens} of ${usage.contextWindow} tokens)`;
		const ask = level === thresholds.length
			? "Finish the current step, then call compact_context before starting new work."
			: "If the current task is close to done, finish it first. Otherwise call compact_context at the next clean breakpoint.";
		// A turn without tool results ends the run; attach to the next prompt instead of starting a turn.
		pi.sendMessage(
			{
				customType: OM_SELF_COMPACT_WARNING,
				content: `Context used: ${used}. ${ask}`,
				display: true,
				details: { level, cycle },
			},
			{ deliverAs: event.toolResults.length > 0 ? "steer" : "nextTurn" },
		);
	});

	// Warnings from an earlier cycle stay in the session but are hidden from the model.
	pi.on("context", (event, ctx: ExtensionContext) => {
		const cycle = currentWarningCycle(ctx.sessionManager.getBranch() as Entry[]);
		const messages = event.messages.filter((message) =>
			message.role !== "custom"
			|| message.customType !== OM_SELF_COMPACT_WARNING
			|| isCurrentWarning(message.details, cycle));
		if (messages.length !== event.messages.length) return { messages };
	});

	// Compaction starts inside agent_settled, so a turn another extension defers from the same
	// agent_settled starts while it runs. Pi gives no signal for prompts it rejects then.
	pi.on("agent_start", () => {
		if (!compacting || compacting.overlapRecorded) return;
		compacting.overlapRecorded = true;
		pi.appendEntry(SELF_COMPACT_OVERLAP_TYPE, {
			message: "An agent run started while compact_context's compaction was running.",
		});
	});

	// Registered before the proactive trigger so an agent-requested compaction
	// claims compactInFlight first on the same agent_settled.
	pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
		const pending = runtime.selfCompactPending;
		if (!pending) return;
		runtime.selfCompactPending = undefined;
		const hasUI = ctx.hasUI;
		const ui = ctx.ui;

		if (runtime.compactInFlight) {
			sendResume(pi, pending.resume, "another compaction is already running");
			return;
		}
		runtime.compactInFlight = true;
		compacting = { overlapRecorded: false };
		// Started synchronously so the session reports isCompacting before it reads any
		// further RPC input; an RPC parent can then tell a pending handoff from a finished run.
		// The run has settled, so compact()'s abort-and-wait returns at once.
		try {
			ctx.compact({
				onComplete: () => {
					runtime.compactInFlight = false;
					compacting = undefined;
					sendResume(pi, pending.resume);
				},
				onError: (error: { message: string }) => {
					runtime.compactInFlight = false;
					compacting = undefined;
					if (hasUI) ui?.notify(`Observational memory: self-compaction failed: ${error.message}`, "error");
					sendResume(pi, pending.resume, error.message);
				},
			});
		} catch (error) {
			runtime.compactInFlight = false;
			compacting = undefined;
			sendResume(pi, pending.resume, error instanceof Error ? error.message : String(error));
		}
	});
}
