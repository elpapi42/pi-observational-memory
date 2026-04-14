import { complete } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TomConfig } from "./config.js";
import { estimateTokensFromText, type TomState } from "./state.js";

const REFLECTOR_SYSTEM = `You are a long-term memory curator. You maintain a stable "reflections" document that captures durable context about a session.

You are given:
1. The current reflections (may be empty).
2. A list of observations accumulated since the last reflection.

Your job:
- Update the reflections to absorb any durable information from the observations.
- Decide which observations to KEEP (still active, recent, or uniquely useful) vs DROP (absorbed into reflections, or low-priority noise).
- Reflections should be dense, well-organized markdown. Stable identity: goals, constraints, architectural decisions, user preferences, environment facts.
- Do NOT include transient tool traces, failed attempts, or step-by-step progress in reflections.

Output STRICTLY in this format, no prose outside the tags:

<reflections>
{updated reflections markdown}
</reflections>
<keep-ids>
{comma-separated observation ids to keep, or empty}
</keep-ids>`;

export interface ReflectorResult {
	reflections: string;
	keepIds: Set<string>;
}

function parseReflectorOutput(raw: string): ReflectorResult | undefined {
	const refMatch = raw.match(/<reflections>([\s\S]*?)<\/reflections>/);
	const keepMatch = raw.match(/<keep-ids>([\s\S]*?)<\/keep-ids>/);
	if (!refMatch) return undefined;
	const reflections = refMatch[1].trim();
	const keepIds = new Set<string>(
		(keepMatch ? keepMatch[1] : "")
			.split(/[,\s]+/)
			.map((s) => s.trim())
			.filter((s) => s.length > 0),
	);
	return { reflections, keepIds };
}

export async function runReflector(
	state: TomState,
	cfg: TomConfig,
	ctx: ExtensionContext,
	signal: AbortSignal,
): Promise<TomState | undefined> {
	const model = ctx.modelRegistry.find(cfg.reflectorModel.provider, cfg.reflectorModel.id);
	if (!model) {
		if (ctx.hasUI) ctx.ui.notify(`TOM: reflector model ${cfg.reflectorModel.provider}/${cfg.reflectorModel.id} not found`, "warning");
		return undefined;
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		if (ctx.hasUI) ctx.ui.notify("TOM: reflector auth unavailable", "warning");
		return undefined;
	}

	const obsBlock = state.observations.map((o) => `[id=${o.id} priority=${o.priority}]\n${o.text}`).join("\n\n");
	const userText = [
		REFLECTOR_SYSTEM,
		"",
		"<current-reflections>",
		state.reflections || "(empty)",
		"</current-reflections>",
		"",
		"<observations>",
		obsBlock,
		"</observations>",
		"",
		"Produce the updated reflections and keep-ids now.",
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
		{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: cfg.reflectorMaxTokens, signal },
	);

	const raw = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	const parsed = parseReflectorOutput(raw);
	if (!parsed) return undefined;

	const keptObservations = state.observations
		.filter((o) => parsed.keepIds.has(o.id))
		.map((o) => ({ ...o, tokenCount: estimateTokensFromText(o.text) }));

	return {
		version: 1,
		reflections: parsed.reflections,
		observations: keptObservations,
	};
}
