import type { TomState } from "./state.js";

export const REFLECTIONS_HEADER = "## Reflections";
export const OBSERVATIONS_HEADER = "## Observations";

export function buildSummary(state: TomState): string {
	const reflections = state.reflections.trim();
	const parts: string[] = [REFLECTIONS_HEADER, reflections.length > 0 ? reflections : "(none yet)"];
	parts.push("", OBSERVATIONS_HEADER);
	for (const obs of state.observations) {
		parts.push("", obs.text.trimEnd());
	}
	return parts.join("\n");
}
