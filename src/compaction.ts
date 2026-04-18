import { completeSimple } from "@mariozechner/pi-ai";
import { parseObservations, parseReflections } from "./parse.js";
import { CONTEXT_USAGE_INSTRUCTIONS, PRUNER_SYSTEM, REFLECTOR_SYSTEM } from "./prompts.js";
import { nowTimestamp } from "./serialize.js";
import { extractText } from "./tokens.js";
import type { Observation, Reflection } from "./types.js";

interface LlmArgs {
	model: Parameters<typeof completeSimple>[0];
	apiKey: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

function joinOrEmpty(items: { content: string }[]): string {
	return items.length ? items.map((i) => i.content).join("\n") : "(none yet)";
}

function llmOptions(args: LlmArgs, maxTokens: number) {
	const reasoning = (args.model as { reasoning?: unknown }).reasoning;
	return reasoning
		? { apiKey: args.apiKey, headers: args.headers, maxTokens, signal: args.signal, reasoning: "high" as const }
		: { apiKey: args.apiKey, headers: args.headers, maxTokens, signal: args.signal };
}

export async function runReflector(
	args: LlmArgs,
	reflections: Reflection[],
	observations: Observation[],
): Promise<Reflection[]> {
	const now = nowTimestamp();
	const userText = `Current local time: ${now}

<current-reflections>
${joinOrEmpty(reflections)}
</current-reflections>

<current-observations>
${joinOrEmpty(observations)}
</current-observations>

Crystallize new long-lived reflections from the observation pool. Output ONLY new reflections (do not restate existing ones). Use the current local time above as the timestamp for each new reflection. Empty output is valid if nothing new is stable enough to crystallize.`;

	const response = await completeSimple(
		args.model,
		{
			systemPrompt: REFLECTOR_SYSTEM,
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: userText }],
					timestamp: Date.now(),
				},
			],
		},
		llmOptions(args, 8192),
	);

	const out = extractText(response).trim();
	return out ? parseReflections(out) : [];
}

export interface PrunerResult {
	observations: Observation[];
	fellBack: boolean;
}

export async function runPruner(
	args: LlmArgs,
	reflections: Reflection[],
	observations: Observation[],
): Promise<PrunerResult> {
	const userText = `<current-reflections>
${joinOrEmpty(reflections)}
</current-reflections>

<current-observations>
${joinOrEmpty(observations)}
</current-observations>

Output the COMPLETE kept observation set. Drop redundant, contradicted, or trivial observations. Merge closely-related observations where it improves clarity. Preserve user assertions and concrete completions aggressively.`;

	const response = await completeSimple(
		args.model,
		{
			systemPrompt: PRUNER_SYSTEM,
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: userText }],
					timestamp: Date.now(),
				},
			],
		},
		llmOptions(args, 16384),
	);

	const out = extractText(response).trim();
	const parsed = out ? parseObservations(out) : [];
	if (parsed.length > 0) return { observations: parsed, fellBack: false };
	return { observations, fellBack: true };
}

export function renderSummary(reflections: Reflection[], observations: Observation[]): string {
	if (reflections.length === 0 && observations.length === 0) return "";

	const parts: string[] = [CONTEXT_USAGE_INSTRUCTIONS];

	if (reflections.length > 0) {
		parts.push(`<reflections>\n${reflections.map((r) => r.content).join("\n")}\n</reflections>`);
	}
	if (observations.length > 0) {
		parts.push(`<observations>\n${observations.map((o) => o.content).join("\n")}\n</observations>`);
	}

	return parts.join("\n\n");
}
