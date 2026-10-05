/**
 * Session-cost accounting from session entries.
 *
 * pi tallies cost from each entry's usage and shows the total in its footer
 * but does not expose it to extensions. This reproduces the sum so the
 * consolidation pipeline can persist it next to the worker cost it tracks.
 */

import { workerUsageFromMessage, type WorkerUsageTotals } from "./worker-usage.js";

export type SessionCostSnapshot = WorkerUsageTotals;

function addSnapshot(a: SessionCostSnapshot, b: SessionCostSnapshot): SessionCostSnapshot {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		totalTokens: a.totalTokens + b.totalTokens,
		cost: a.cost + b.cost,
	};
}

/**
 * Sum usage from a session branch. Assistant messages carry usage on
 * `message.usage`; compaction and branch-summary entries carry it at the top
 * level, so both are read. Entries without usage are ignored.
 */
export function sessionCostFromEntries(entries: readonly unknown[]): SessionCostSnapshot {
	let totals: SessionCostSnapshot = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
	};
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const typed = entry as { message?: unknown; usage?: unknown };
		const fromMessage = workerUsageFromMessage(typed.message);
		if (fromMessage) totals = addSnapshot(totals, fromMessage);
		if (typed.usage !== undefined) {
			const fromEntry = workerUsageFromMessage({ usage: typed.usage });
			if (fromEntry) totals = addSnapshot(totals, fromEntry);
		}
	}
	return totals;
}
