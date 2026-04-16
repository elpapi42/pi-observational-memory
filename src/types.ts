export type Priority = "important" | "maybe" | "info" | "completed";

export interface Observation {
	timestamp: string; // ISO 8601 UTC: "2026-04-16T14:30Z"
	priority: Priority;
	text: string;
	raw?: string; // set only when the source line failed to parse cleanly
}

export interface MemoryState {
	observations: Observation[];
	reflections: string[];
}

export function isOurDetails(
	d: unknown,
): d is { type: "observational-memory"; observations: Observation[]; reflections: string[] } {
	return (
		!!d &&
		typeof d === "object" &&
		(d as Record<string, unknown>).type === "observational-memory" &&
		Array.isArray((d as Record<string, unknown>).observations) &&
		Array.isArray((d as Record<string, unknown>).reflections)
	);
}
