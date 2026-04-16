import type { Observation, Priority } from "./types.js";

export const PRIORITY_EMOJI: Record<Priority, string> = {
	important: "🔴",
	maybe: "🟡",
	info: "🟢",
	completed: "✅",
};

/**
 * Render a single observation as "- {emoji} {timestamp} {text}".
 */
export function renderObservation(obs: Observation): string {
	const emoji = PRIORITY_EMOJI[obs.priority];
	return `- ${emoji} ${obs.timestamp} ${obs.text}`;
}

/**
 * Render an array of observations sorted by timestamp, joined by newlines.
 */
export function renderObservations(observations: Observation[]): string {
	if (observations.length === 0) return "";
	return [...observations]
		.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
		.map(renderObservation)
		.join("\n");
}

/**
 * Render reflections as dash-prefixed lines.
 */
export function renderReflections(reflections: string[]): string {
	if (reflections.length === 0) return "";
	return reflections.map((r) => `- ${r}`).join("\n");
}
