import { observationToSummaryLine, reflectionToSummaryLine } from "./render-summary.js";
import type { Observation, Reflection } from "./types.js";

export type WorkerMemorySlice = {
	reflections: Reflection[];
	observations: Observation[];
	omittedReflections: number;
	omittedObservations: number;
};

function lineTokens(line: string): number {
	return Math.ceil(line.length / 4) + 1;
}

/**
 * Pick records whose rendered lines fit `budget`, starting from the newest
 * (default) or the oldest end, and return them in original order.
 */
function pick<T>(records: T[], line: (record: T) => string, budget: number, from: "newest" | "oldest"): { kept: T[]; tokens: number } {
	const indexes: number[] = [];
	let tokens = 0;
	const order = from === "newest" ? records.map((_, i) => records.length - 1 - i) : records.map((_, i) => i);
	for (const i of order) {
		const cost = lineTokens(line(records[i]));
		// Skip a record that does not fit instead of stopping: a single long
		// newest record must not hide shorter older ones that still fit.
		if (tokens + cost > budget) continue;
		tokens += cost;
		indexes.push(i);
	}
	indexes.sort((a, b) => a - b);
	return { kept: indexes.map((i) => records[i]), tokens };
}

/**
 * Bound the prior memory a worker prompt carries. The ledger grows without
 * limit on long sessions; sending all of it with every observer, reflector,
 * or dropper call eventually exceeds the memory model's context window.
 * Observations get at least half the budget, reflections the rest (newest
 * first), and each side reclaims what the other leaves unused.
 *
 * `observationsFrom: "oldest"` serves the dropper, whose job is pruning old
 * observations. A non-positive or non-finite budget returns everything.
 */
export function boundWorkerMemory(
	reflections: Reflection[],
	observations: Observation[],
	maxTokens: number,
	options: { observationsFrom?: "newest" | "oldest" } = {},
): WorkerMemorySlice {
	if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
		return { reflections, observations, omittedReflections: 0, omittedObservations: 0 };
	}
	const from = options.observationsFrom ?? "newest";
	const reserved = pick(observations, observationToSummaryLine, Math.floor(maxTokens / 2), from);
	const keptReflections = pick(reflections, reflectionToSummaryLine, maxTokens - reserved.tokens, "newest");
	const keptObservations = pick(observations, observationToSummaryLine, maxTokens - keptReflections.tokens, from);
	return {
		reflections: keptReflections.kept,
		observations: keptObservations.kept,
		omittedReflections: reflections.length - keptReflections.kept.length,
		omittedObservations: observations.length - keptObservations.kept.length,
	};
}
