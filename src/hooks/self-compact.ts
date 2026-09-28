import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { resolveTokenThreshold } from "../config.js";
import type { Runtime } from "../runtime.js";
import { OM_SELF_COMPACT_WARNING, type Entry } from "../session-ledger/index.js";

export const SELF_COMPACT_TOOL_NAME = "compact_context";
export const SELF_COMPACT_RESUME_TYPE = "om.self-compact.resume";

const compactContextTool = (runtime: Runtime) => defineTool({
	name: SELF_COMPACT_TOOL_NAME,
	label: "Compact context",
	description:
		"Compact context into memory at a clean breakpoint; recent turns stay verbatim. Ends this turn.",
	parameters: Type.Object({
		resume: Type.Optional(Type.String({
			description: "Current task and next step, delivered to you after compaction. Omit when no work remains.",
		})),
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
		if (scheduled) runtime.selfCompactPending = params.resume?.trim() ? { resume: params.resume.trim() } : {};
		return {
			content: [{ type: "text", text: scheduled ? "Compaction scheduled." : "Compaction already scheduled." }],
			details: { scheduled },
			terminate: true,
		};
	},
});

function sendResume(pi: ExtensionAPI, resume: string | undefined, failure?: string): void {
	if (!resume) return;
	const content = failure
		? `Compaction failed: ${failure}. Continue without compacting from your note:\n\n${resume}`
		: `Continue from your note written before compaction:\n\n${resume}`;
	pi.sendMessage({ customType: SELF_COMPACT_RESUME_TYPE, content, display: true }, { triggerTurn: true });
}

/** Highest warning level already sent since the latest compaction, read from the branch so reloads do not repeat it. */
function warnedLevelSinceCompaction(entries: Entry[]): { cycle: string; level: number } {
	let level = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "compaction") return { cycle: entry.id, level };
		if (entry.type !== "custom_message" || entry.customType !== OM_SELF_COMPACT_WARNING) continue;
		const sent = (entry.details as { level?: unknown } | undefined)?.level;
		if (typeof sent === "number" && sent > level) level = sent;
	}
	return { cycle: "", level };
}

export function registerSelfCompact(pi: ExtensionAPI, runtime: Runtime): void {
	let registered = false;
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

		const sent = warnedLevelSinceCompaction(ctx.sessionManager.getBranch() as Entry[]);
		const already = Math.max(sent.level, queued.cycle === sent.cycle ? queued.level : 0);
		if (level <= already) return;
		queued = { cycle: sent.cycle, level };

		const percent = usage.contextWindow > 0 ? Math.round((tokens / usage.contextWindow) * 100) : undefined;
		const used = percent === undefined ? `${tokens} tokens` : `${percent}% (${tokens} of ${usage.contextWindow} tokens)`;
		const ask = level === thresholds.length
			? "Call compact_context before starting any new work."
			: "Call compact_context at the next clean breakpoint.";
		// A turn without tool results ends the run; attach to the next prompt instead of starting a turn.
		pi.sendMessage(
			{ customType: OM_SELF_COMPACT_WARNING, content: `Context used: ${used}. ${ask}`, display: true, details: { level } },
			{ deliverAs: event.toolResults.length > 0 ? "steer" : "nextTurn" },
		);
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
		setTimeout(() => {
			// Input that arrived since settling takes precedence over the handoff.
			if (!ctx.isIdle()) {
				runtime.compactInFlight = false;
				if (hasUI) ui?.notify("Observational memory: self-compaction skipped — agent became busy", "info");
				return;
			}
			try {
				ctx.compact({
					onComplete: () => {
						runtime.compactInFlight = false;
						sendResume(pi, pending.resume);
					},
					onError: (error: { message: string }) => {
						runtime.compactInFlight = false;
						if (hasUI) ui?.notify(`Observational memory: self-compaction failed: ${error.message}`, "error");
						sendResume(pi, pending.resume, error.message);
					},
				});
			} catch (error) {
				runtime.compactInFlight = false;
				sendResume(pi, pending.resume, error instanceof Error ? error.message : String(error));
			}
		}, 0);
	});
}
