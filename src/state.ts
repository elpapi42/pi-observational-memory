import type { CompactionEntry, SessionEntry } from "@mariozechner/pi-coding-agent";

export interface Observation {
	id: string;
	text: string;
	tokenCount: number;
	priority: "high" | "med" | "low";
	createdAt: number;
}

export interface TomState {
	version: 1;
	reflections: string;
	observations: Observation[];
}

export const EMPTY_STATE: TomState = {
	version: 1,
	reflections: "",
	observations: [],
};

export const TOM_MARKER = "tom-v1";

export function isTomDetails(details: unknown): details is TomState & { marker: string } {
	return (
		typeof details === "object" &&
		details !== null &&
		(details as { marker?: unknown }).marker === TOM_MARKER &&
		(details as { version?: unknown }).version === 1
	);
}

export function loadState(branchEntries: SessionEntry[]): TomState {
	for (let i = branchEntries.length - 1; i >= 0; i--) {
		const entry = branchEntries[i];
		if (entry.type !== "compaction") continue;
		const details = (entry as CompactionEntry).details;
		if (isTomDetails(details)) {
			return {
				version: 1,
				reflections: details.reflections,
				observations: details.observations,
			};
		}
	}
	return { ...EMPTY_STATE };
}

export function serializeState(state: TomState): TomState & { marker: string } {
	return { marker: TOM_MARKER, ...state };
}

export function observationsTokenTotal(state: TomState): number {
	return state.observations.reduce((sum, obs) => sum + obs.tokenCount, 0);
}

export function estimateTokensFromText(text: string): number {
	return Math.ceil(text.length / 4);
}

export function newObservationId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
