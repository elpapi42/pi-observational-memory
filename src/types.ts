export const OBSERVATION_CUSTOM_TYPE = "om.observation";

export interface Observation {
	content: string;
	tokenCount: number;
}

export interface Reflection {
	content: string;
	tokenCount: number;
}

export interface MemoryDetails {
	type: "observational-memory";
	version: 2;
	observations: Observation[];
	reflections: Reflection[];
}

export interface ObservationEntryData {
	content: string;
	coversFromId: string;
	coversUpToId: string;
	tokenCount: number;
}

export function isMemoryDetails(d: unknown): d is MemoryDetails {
	if (!d || typeof d !== "object") return false;
	const o = d as Record<string, unknown>;
	return o.type === "observational-memory" && o.version === 2 && Array.isArray(o.observations) && Array.isArray(o.reflections);
}

export function isObservationEntryData(d: unknown): d is ObservationEntryData {
	if (!d || typeof d !== "object") return false;
	const o = d as Record<string, unknown>;
	return typeof o.content === "string" && typeof o.coversFromId === "string" && typeof o.coversUpToId === "string" && typeof o.tokenCount === "number";
}
