export interface MemoryState {
	observations: string;
	reflections: string;
}

export interface MemoryDetails {
	type: "observational-memory";
	version: 1;
	observations: string;
	reflections: string;
}

export function isMemoryDetails(d: unknown): d is MemoryDetails {
	return !!d && typeof d === "object" && (d as Record<string, unknown>).type === "observational-memory";
}
