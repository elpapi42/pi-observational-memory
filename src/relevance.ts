import { type ObservationRecord, type Relevance, RELEVANCE_VALUES } from "./types.js";

export function countByRelevance(records: ObservationRecord[]): Record<Relevance, number> {
	const counts: Record<Relevance, number> = { low: 0, medium: 0, high: 0, critical: 0 };
	for (const r of records) counts[r.relevance]++;
	return counts;
}

export function formatRelevanceHistogram(counts: Record<Relevance, number>): string {
	return RELEVANCE_VALUES
		.slice()
		.reverse()
		.map((r) => `${r}: ${counts[r]}`)
		.join(" · ");
}
