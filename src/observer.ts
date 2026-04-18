import { completeSimple } from "@mariozechner/pi-ai";
import { OBSERVER_SYSTEM } from "./prompts.js";
import { nowTimestamp } from "./serialize.js";
import { extractText } from "./tokens.js";
import type { Observation } from "./types.js";

interface RunObserverArgs {
	model: Parameters<typeof completeSimple>[0];
	apiKey: string;
	headers?: Record<string, string>;
	priorReflections: string[];
	priorObservations: string[];
	chunk: string;
	signal?: AbortSignal;
}

function joinOrEmpty(items: string[]): string {
	return items.length ? items.join("\n") : "(none yet)";
}

export async function runObserver(args: RunObserverArgs): Promise<string | undefined> {
	const { model, apiKey, headers, priorReflections, priorObservations, chunk, signal } = args;
	const conversation = chunk.trim();
	if (!conversation) return undefined;

	const now = nowTimestamp();
	const userText = `Current local time: ${now}

<current-reflections>
${joinOrEmpty(priorReflections)}
</current-reflections>

<current-observations>
${joinOrEmpty(priorObservations)}
</current-observations>

Compress the following new conversation chunk into observations. Do not restate facts already in current reflections or observations. Prefer the inline conversation timestamps when assigning times; fall back to the current local time above only if no message timestamp applies.

<conversation>
${conversation}
</conversation>`;

	const reasoning = (model as { reasoning?: unknown }).reasoning;
	const opts = reasoning
		? { apiKey, headers, maxTokens: 4096, signal, reasoning: "high" as const }
		: { apiKey, headers, maxTokens: 4096, signal };

	const response = await completeSimple(
		model,
		{
			systemPrompt: OBSERVER_SYSTEM,
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: userText }],
					timestamp: Date.now(),
				},
			],
		},
		opts,
	);

	const out = extractText(response).trim();
	return out || undefined;
}

export function observationsToContent(observations: Observation[]): string[] {
	return observations.map((o) => o.content);
}
