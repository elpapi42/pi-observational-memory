import type { Observation, Priority } from "./types.js";

const EMOJI_TO_PRIORITY: Record<string, Priority> = {
	"🔴": "important",
	"🟡": "maybe",
	"🟢": "info",
	"✅": "completed",
};

/**
 * Normalize various full-timestamp forms to "YYYY-MM-DDTHH:MMZ".
 * Unrecognized strings are returned unchanged.
 */
export function normalizeTimestamp(ts: string): string {
	// "2026-04-16 14:30" → "2026-04-16T14:30Z"
	let m = ts.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/);
	if (m) return `${m[1]}T${m[2]}Z`;

	// "2026-04-16T14:30:00Z" → "2026-04-16T14:30Z" (strip seconds)
	m = ts.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):\d{2}Z$/);
	if (m) return `${m[1]}Z`;

	// "2026-04-16T14:30Z" → pass through
	if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(ts)) return ts;

	return ts;
}

const OBSERVATION_LINE_RE = /^- (🔴|🟡|🟢|✅) (\S+) (.+)$/;

/**
 * Parse the canonical flat timestamped log format into Observation structs.
 * Lines that don't match the expected pattern become fallback observations
 * with `raw` set to the original line.
 */
export function parseObservations(text: string): Observation[] {
	const observations: Observation[] = [];
	const now = new Date().toISOString().slice(0, 16) + "Z";

	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		const match = trimmed.match(OBSERVATION_LINE_RE);
		if (match) {
			const [, emoji, rawTs, obsText] = match;
			const priority = EMOJI_TO_PRIORITY[emoji];
			if (priority) {
				observations.push({
					timestamp: normalizeTimestamp(rawTs),
					priority,
					text: obsText,
				});
				continue;
			}
		}

		// Fallback: couldn't parse — store as info with raw preserved
		observations.push({
			timestamp: now,
			priority: "info",
			text: trimmed,
			raw: line,
		});
	}

	return observations;
}

/**
 * Parse reflections text (dash-prefixed lines) into a string array.
 */
export function parseReflections(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => line.replace(/^-\s*/, ""));
}

/**
 * Parse reflector output containing <reflections> and <observations> XML tags.
 */
export function parseReflectorOutput(text: string): { reflections: string[]; observations: Observation[] } {
	const reflectionsMatch = text.match(/<reflections>\n?([\s\S]*?)\n?<\/reflections>/);
	const observationsMatch = text.match(/<observations>\n?([\s\S]*?)\n?<\/observations>/);

	return {
		reflections: reflectionsMatch ? parseReflections(reflectionsMatch[1].trim()) : [],
		observations: observationsMatch ? parseObservations(observationsMatch[1].trim()) : [],
	};
}
