export const OBSERVATION_CUSTOM_TYPE = "om.observation";

export type Relevance = "low" | "medium" | "high" | "critical";

export const RELEVANCE_VALUES: readonly Relevance[] = ["low", "medium", "high", "critical"] as const;

export interface ObservationRecord {
	id: string;
	content: string;
	timestamp: string;
	relevance: Relevance;
}

export type Reflection = string;

export interface MemoryDetails {
	type: "observational-memory";
	version: 3;
	observations: ObservationRecord[];
	reflections: Reflection[];
}

export interface ObservationEntryData {
	records: ObservationRecord[];
	coversFromId: string;
	coversUpToId: string;
	tokenCount: number;
}

function isRelevance(v: unknown): v is Relevance {
	return typeof v === "string" && (RELEVANCE_VALUES as readonly string[]).includes(v);
}

function isObservationRecord(v: unknown): v is ObservationRecord {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.id === "string" &&
		typeof o.content === "string" &&
		typeof o.timestamp === "string" &&
		isRelevance(o.relevance)
	);
}

export function isMemoryDetails(d: unknown): d is MemoryDetails {
	if (!d || typeof d !== "object") return false;
	const o = d as Record<string, unknown>;
	if (o.type !== "observational-memory" || o.version !== 3) return false;
	if (!Array.isArray(o.observations) || !Array.isArray(o.reflections)) return false;
	if (!o.observations.every(isObservationRecord)) return false;
	return o.reflections.every((r) => typeof r === "string");
}

export function isObservationEntryData(d: unknown): d is ObservationEntryData {
	if (!d || typeof d !== "object") return false;
	const o = d as Record<string, unknown>;
	return (
		Array.isArray(o.records) &&
		o.records.every(isObservationRecord) &&
		typeof o.coversFromId === "string" &&
		typeof o.coversUpToId === "string" &&
		typeof o.tokenCount === "number"
	);
}
