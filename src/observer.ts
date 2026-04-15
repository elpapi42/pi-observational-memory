import { complete } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TomConfig } from "./config.js";
import { estimateTokensFromText, newObservationId, type Observation, type TomState } from "./state.js";

const OBSERVER_SYSTEM = `You are a memory compression agent. You receive a chunk of conversation history and produce a single dense observation.

Rules:
- Write in third person, past tense, objective voice.
- Capture goals, decisions, tool outcomes, file changes, blockers, and unresolved questions.
- Do NOT repeat content already covered by prior observations or reflections.
- Do NOT narrate ("the user asked..."); state facts.
- Output between 80 and 250 words. Be information-dense, not prosey.
- End the observation with a single line: PRIORITY: high | med | low
  - high = load-bearing context for the rest of the session (architectural decisions, blockers, user preferences).
  - med  = useful context that may be referenced later (file edits, intermediate findings).
  - low  = trivia unlikely to matter (failed attempts, verbose tool noise).`;

function buildContextBlock(state: TomState): string {
	const parts: string[] = [];
	if (state.reflections.trim().length > 0) {
		parts.push("<existing-reflections>", state.reflections.trim(), "</existing-reflections>");
	}
	if (state.observations.length > 0) {
		parts.push(
			"<existing-observations>",
			state.observations.map((o) => `- ${o.text.split("\n")[0]}`).join("\n"),
			"</existing-observations>",
		);
	}
	return parts.join("\n");
}

function parseObservation(raw: string): { text: string; priority: Observation["priority"] } {
	const trimmed = raw.trim();
	const match = trimmed.match(/PRIORITY:\s*(high|med|low)\s*$/i);
	if (!match) {
		return { text: trimmed, priority: "med" };
	}
	const priority = match[1].toLowerCase() as Observation["priority"];
	const text = trimmed.slice(0, match.index).trimEnd();
	return { text, priority };
}

export async function runObserver(
	chunk: AgentMessage[],
	state: TomState,
	cfg: TomConfig,
	ctx: ExtensionContext,
	signal: AbortSignal,
): Promise<Observation | undefined> {
	const model = ctx.modelRegistry.find(cfg.observerModel.provider, cfg.observerModel.id);
	if (!model) {
		if (ctx.hasUI) ctx.ui.notify(`TOM: observer model ${cfg.observerModel.provider}/${cfg.observerModel.id} not found`, "warning");
		return undefined;
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		if (ctx.hasUI) ctx.ui.notify("TOM: observer auth unavailable", "warning");
		return undefined;
	}

	const conversationText = serializeConversation(convertToLlm(chunk));
	const contextBlock = buildContextBlock(state);

	const userText = [
		OBSERVER_SYSTEM,
		"",
		contextBlock,
		"",
		"<chunk-to-observe>",
		conversationText,
		"</chunk-to-observe>",
		"",
		"Emit the observation now.",
	].join("\n");

	const response = await complete(
		model,
		{
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: userText }],
					timestamp: Date.now(),
				},
			],
		},
		{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: cfg.observerMaxTokens, signal },
	);

	if (ctx.hasUI) {
		ctx.ui.notify(`TOM debug model: ${model.provider}/${model.id}`, "info");
		ctx.ui.notify(`TOM debug input length: ${userText.length} chars`, "info");
		const { content, ...responseMeta } = response;
		ctx.ui.notify(`TOM debug response meta: ${JSON.stringify(responseMeta).slice(0, 1000)}`, "info");
		ctx.ui.notify(`TOM debug content: ${JSON.stringify(content).slice(0, 2000)}`, "info");
	}

	const raw = response.content
		.map((c) => ("text" in c ? c.text : ""))
		.join("\n")
		.trim();
	if (!raw) return undefined;

	const { text, priority } = parseObservation(raw);
	return {
		id: newObservationId(),
		text,
		tokenCount: estimateTokensFromText(text),
		priority,
		createdAt: Date.now(),
	};
}
