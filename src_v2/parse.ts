import { estimateStringTokens } from "./tokens.js";
import type { Observation, Reflection } from "./types.js";

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} /;

function stripFences(text: string): string {
	const trimmed = text.trim();
	if (trimmed.startsWith("```")) {
		const lines = trimmed.split("\n");
		if (lines[0].startsWith("```")) lines.shift();
		if (lines.length && lines[lines.length - 1].startsWith("```")) lines.pop();
		return lines.join("\n");
	}
	return trimmed;
}

export function parseBlocks(text: string): string[] {
	const cleaned = stripFences(text);
	if (!cleaned) return [];

	const lines = cleaned.split("\n");
	const blocks: string[] = [];
	let current: string[] = [];

	for (const line of lines) {
		if (TIMESTAMP_RE.test(line)) {
			if (current.length) blocks.push(current.join("\n").trimEnd());
			current = [line];
		} else if (current.length) {
			current.push(line);
		}
	}
	if (current.length) blocks.push(current.join("\n").trimEnd());

	return blocks.filter((b) => b.trim().length > 0);
}

export function parseObservations(text: string): Observation[] {
	return parseBlocks(text).map((content) => ({ content, tokenCount: estimateStringTokens(content) }));
}

export function parseReflections(text: string): Reflection[] {
	return parseBlocks(text).map((content) => ({ content, tokenCount: estimateStringTokens(content) }));
}
