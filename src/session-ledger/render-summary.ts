import type { Observation, Reflection } from "./types.js";

const CONTEXT_USAGE_INSTRUCTIONS = `These are condensed memories from earlier in this session.

- Reflections: stable, long-lived facts about the user, project, decisions, and constraints. New reflection lines may include ids in brackets.
- Observations: timestamped events from the conversation history, in chronological order. Observation lines include ids in brackets.

Treat these as past records. When entries conflict, the most recent observation reflects the latest known state. Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.

When exact source context is needed for precision or traceability, use the recall tool with the relevant observation or reflection id. This is especially useful when a reflection materially affects a decision or is too compressed to continue confidently. Do not use recall as broad search or inject raw source unless it is needed.`;

export function observationToSummaryLine(observation: Observation): string {
	return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`;
}

export function reflectionToSummaryLine(reflection: Reflection): string {
	return `[${reflection.id}] ${reflection.content}`;
}

export type RenderSummaryOptions = {
	/**
	 * Estimated token budget for the rendered summary. Observations are
	 * guaranteed at least half of it (newest first); reflections take the rest
	 * (newest first), and whatever either side leaves unused goes to the other.
	 * Omitted records stay in the session ledger and remain visible through
	 * `/om:view full`.
	 */
	maxTokens?: number;
};

/** Share of the summary budget reserved for observations before reflections are allocated. */
export const SUMMARY_OBSERVATIONS_MIN_SHARE = 0.5;

export type RenderedSummary = {
	text: string;
	reflections: Reflection[];
	observations: Observation[];
	omittedReflections: number;
	omittedObservations: number;
};

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Newest-first selection of records whose rendered lines fit `budget`, returned in original order. */
function selectWithinBudget<T>(records: T[], line: (record: T) => string, budget: number): { kept: T[]; tokens: number } {
	const keptIndexes: number[] = [];
	let tokens = 0;
	for (let i = records.length - 1; i >= 0; i--) {
		const cost = estimateTokens(line(records[i])) + 1;
		if (tokens + cost > budget) break;
		tokens += cost;
		keptIndexes.push(i);
	}
	keptIndexes.reverse();
	return { kept: keptIndexes.map((i) => records[i]), tokens };
}

export function renderSummaryWithBudget(
	reflections: Reflection[],
	observations: Observation[],
	options: RenderSummaryOptions = {},
): RenderedSummary {
	if (reflections.length === 0 && observations.length === 0) {
		return { text: "", reflections: [], observations: [], omittedReflections: 0, omittedObservations: 0 };
	}

	let keptReflections = reflections;
	let keptObservations = observations;
	const maxTokens = options.maxTokens;
	if (maxTokens !== undefined && Number.isFinite(maxTokens) && maxTokens > 0) {
		const fixed = estimateTokens(CONTEXT_USAGE_INSTRUCTIONS) + estimateTokens("## Reflections\n## Observations\n\n\n\n") + 40;
		const budget = Math.max(0, maxTokens - fixed);
		// Observations are the chronological record and must not be crowded out
		// by verbose reflections: reserve them a share first, give reflections
		// the remainder, then let observations reclaim whatever reflections left.
		const reserved = selectWithinBudget(observations, observationToSummaryLine, Math.floor(budget * SUMMARY_OBSERVATIONS_MIN_SHARE));
		const pickedReflections = selectWithinBudget(reflections, reflectionToSummaryLine, budget - reserved.tokens);
		keptReflections = pickedReflections.kept;
		keptObservations = selectWithinBudget(observations, observationToSummaryLine, budget - pickedReflections.tokens).kept;
	}

	const omittedReflections = reflections.length - keptReflections.length;
	const omittedObservations = observations.length - keptObservations.length;
	const parts: string[] = [CONTEXT_USAGE_INSTRUCTIONS];
	if (keptReflections.length > 0) {
		parts.push(`## Reflections\n${keptReflections.map(reflectionToSummaryLine).join("\n")}`);
	}
	if (keptObservations.length > 0) {
		parts.push(`## Observations\n${keptObservations.map(observationToSummaryLine).join("\n")}`);
	}
	if (omittedReflections > 0 || omittedObservations > 0) {
		const omitted: string[] = [];
		if (omittedReflections > 0) omitted.push(`${omittedReflections} older reflection${omittedReflections === 1 ? "" : "s"}`);
		if (omittedObservations > 0) omitted.push(`${omittedObservations} older observation${omittedObservations === 1 ? "" : "s"}`);
		parts.push(`(${omitted.join(" and ")} omitted to fit the summary budget; they remain in the session memory ledger, see /om:view full.)`);
	}
	return {
		text: parts.join("\n\n"),
		reflections: keptReflections,
		observations: keptObservations,
		omittedReflections,
		omittedObservations,
	};
}

export function renderSummary(reflections: Reflection[], observations: Observation[], options: RenderSummaryOptions = {}): string {
	return renderSummaryWithBudget(reflections, observations, options).text;
}
