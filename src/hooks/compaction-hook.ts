import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

import type { Runtime } from "../runtime.js";
import {
	buildCompactionProjection,
	entryIndexById,
	findLastCompactionIndex,
	isObservationsRecordedEntry,
	renderSummary,
	type Entry,
} from "../session-ledger/index.js";

const DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS = 20_000;

function observationsPoolMaxTokens(runtime: Runtime): number {
	const value = (runtime.config as { observationsPoolMaxTokens?: unknown }).observationsPoolMaxTokens;
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS;
}

function matchingToolCallIndex(entries: Entry[], resultIndex: number, activeStart: number): number {
	const result = entries[resultIndex].message as { toolCallId?: string } | undefined;
	if (!result?.toolCallId) return -1;
	for (let i = resultIndex - 1; i >= activeStart; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown } | undefined;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		if (message.content.some((part) => part?.type === "toolCall" && part.id === result.toolCallId)) return i;
	}
	return -1;
}

function coverageSafeFirstKeptEntryId(entries: Entry[], firstKeptEntryId: string): string | undefined {
	const indexes = entryIndexById(entries);
	const cutIndex = indexes.get(firstKeptEntryId);
	if (cutIndex === undefined) return;

	// A previous compaction's summary cannot be recovered by moving the cut. Its
	// retained tail is the earliest source range the new summary may preserve.
	const previousCompactionIndex = findLastCompactionIndex(entries);
	const previousCutId = previousCompactionIndex >= 0 ? entries[previousCompactionIndex].firstKeptEntryId : undefined;
	const activeStart = previousCutId ? (indexes.get(previousCutId) ?? previousCompactionIndex + 1) : 0;
	let coveredIndex = activeStart - 1;
	for (const entry of entries) {
		if (!isObservationsRecordedEntry(entry)) continue;
		const index = indexes.get(entry.data.coversUpToId);
		if (index !== undefined && index <= cutIndex) coveredIndex = Math.max(coveredIndex, index);
	}

	for (let i = Math.max(activeStart, coveredIndex + 1); i < cutIndex; i++) {
		const entry = entries[i];
		if (entry.type === "message") {
			const role = (entry.message as { role?: string } | undefined)?.role;
			if (role === "system") continue;
			if (role === "toolResult") {
				const callIndex = matchingToolCallIndex(entries, i, activeStart);
				return callIndex >= 0 ? entries[callIndex].id : undefined;
			}
			return entry.id;
		}
		if (entry.type === "custom_message" || entry.type === "branch_summary") return entry.id;
	}
	return firstKeptEntryId;
}

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
		if (runtime.compactHookInFlight) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Observational memory: another compaction is already in progress; cancelling duplicate",
					"warning",
				);
			}
			return { cancel: true };
		}

		runtime.compactHookInFlight = true;
		try {
			runtime.ensureConfig(ctx.cwd);
			const { preparation, branchEntries } = event;
			const { firstKeptEntryId, tokensBefore } = preparation;
			const projection = buildCompactionProjection(
				branchEntries as Entry[],
				firstKeptEntryId,
				{ observationsPoolMaxTokens: observationsPoolMaxTokens(runtime) },
			);
			const summary = renderSummary(projection.reflections, projection.observations);
			if (summary.length === 0) {
				// Decline ownership so Pi's native summarizer preserves the pre-cut context.
				return;
			}
			const safeFirstKeptEntryId = coverageSafeFirstKeptEntryId(branchEntries as Entry[], firstKeptEntryId);
			if (!safeFirstKeptEntryId) return;

			return {
				compaction: {
					summary,
					firstKeptEntryId: safeFirstKeptEntryId,
					tokensBefore,
					details: projection.details,
				},
			};
		} finally {
			runtime.compactHookInFlight = false;
		}
	});
}
