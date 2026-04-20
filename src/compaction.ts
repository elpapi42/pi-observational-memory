import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Message, type Model } from "@mariozechner/pi-ai";
import type { Static } from "@sinclair/typebox";
import { observationsToPromptLines } from "./observer.js";
import { buildPrunerPassGuidance, CONTEXT_USAGE_INSTRUCTIONS, PRUNER_SYSTEM, REFLECTOR_SYSTEM } from "./prompts.js";
import { truncateRecordContent } from "./serialize.js";
import { estimateStringTokens } from "./tokens.js";
import type { ObservationRecord, Reflection } from "./types.js";

const PRUNER_MAX_PASSES = 5;
const PRUNER_TARGET_RATIO = 0.8;

function observationPoolTokens(observations: ObservationRecord[]): number {
	return observations.reduce((sum, o) => sum + estimateStringTokens(o.content), 0);
}

interface LlmArgs {
	model: Model<any>;
	apiKey: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

function joinReflectionsOrEmpty(items: Reflection[]): string {
	return items.length ? items.join("\n") : "(none yet)";
}

function joinObservationsOrEmpty(items: ObservationRecord[]): string {
	return items.length ? observationsToPromptLines(items).join("\n") : "(none yet)";
}

const RecordReflectionsSchema = Type.Object({
	reflections: Type.Array(
		Type.String({
			minLength: 1,
			description: "Single-line plain prose reflection. No markdown, no tags, no timestamp, no bullets.",
		}),
		{
			minItems: 1,
			description: "Batch of new reflections. Each string is one reflection.",
		},
	),
});

type RecordReflectionsArgs = Static<typeof RecordReflectionsSchema>;

export async function runReflector(
	args: LlmArgs,
	reflections: Reflection[],
	observations: ObservationRecord[],
): Promise<Reflection[]> {
	const existing = new Set(reflections.map((r) => r.trim()));
	const added = new Set<string>();

	const recordTool: AgentTool<typeof RecordReflectionsSchema> = {
		name: "record_reflections",
		label: "Record reflections",
		description:
			"Record a batch of new reflections crystallized from the observation pool. " +
			"May be called multiple times. Stop calling when nothing more is stable enough to crystallize, " +
			"then emit a short plain-text confirmation.",
		parameters: RecordReflectionsSchema,
		execute: async (_id, params: RecordReflectionsArgs) => {
			let accepted = 0;
			let duplicates = 0;
			for (const r of params.reflections) {
				const content = truncateRecordContent(r.trim());
				if (!content) continue;
				if (existing.has(content) || added.has(content)) {
					duplicates++;
					continue;
				}
				added.add(content);
				accepted++;
			}
			const parts: string[] = [];
			parts.push(`Recorded ${accepted} new reflection${accepted === 1 ? "" : "s"}.`);
			if (duplicates) parts.push(`${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped.`);
			parts.push(`Total new this run: ${added.size}.`);
			parts.push("Call record_reflections again if more should be crystallized; otherwise stop and emit a short plain-text confirmation.");
			return {
				content: [{ type: "text", text: parts.join(" ") }],
				details: { accepted, duplicates, total: added.size },
			};
		},
	};

	const userText = `CURRENT REFLECTIONS:
${joinReflectionsOrEmpty(reflections)}

CURRENT OBSERVATIONS:
${joinObservationsOrEmpty(observations)}

Crystallize new long-lived reflections from the observation pool. Call record_reflections with batches of new reflections. You may call the tool multiple times as you reason through the pool. Do not restate reflections already in the current reflections list. When done, stop calling the tool and emit a short plain-text confirmation.`;

	const prompts: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: userText }],
			timestamp: Date.now(),
		},
	];

	const context: AgentContext = {
		systemPrompt: REFLECTOR_SYSTEM,
		messages: [],
		tools: [recordTool as AgentTool<any>],
	};

	const reasoning = (args.model as { reasoning?: unknown }).reasoning;
	const config: AgentLoopConfig = {
		model: args.model as any,
		apiKey: args.apiKey,
		headers: args.headers,
		maxTokens: 4096,
		convertToLlm: (msgs) => msgs as Message[],
		toolExecution: "sequential",
		...(reasoning ? { reasoning: "high" as const } : {}),
	};

	try {
		const stream = agentLoop(prompts, context, config, args.signal);
		for await (const _event of stream) {
			// Drain events; the tool's execute already collects reflections.
		}
		await stream.result();
	} catch {
		// Salvage any reflections accepted before the error; downstream pruner still runs.
	}

	return Array.from(added);
}

export interface PrunerResult {
	observations: ObservationRecord[];
	droppedIds: string[];
	fellBack: boolean;
}

const DropObservationsSchema = Type.Object({
	ids: Type.Array(
		Type.String({
			pattern: "^[a-f0-9]{12}$",
			description: "12-character hex observation id from the current-observations list.",
		}),
		{
			minItems: 1,
			description: "Ids of observations to remove from the kept set.",
		},
	),
	reason: Type.Optional(
		Type.String({ description: "Optional short note explaining why these observations were dropped." }),
	),
});

type DropObservationsArgs = Static<typeof DropObservationsSchema>;

interface PrunerPassContext {
	poolTokens: number;
	targetTokens: number;
	deltaTokens: number;
	pass: number;
	maxPasses: number;
}

interface PrunerPassResult {
	kept: ObservationRecord[];
	droppedIds: string[];
	fellBack: boolean;
}

async function runPrunerPass(
	args: LlmArgs,
	reflections: Reflection[],
	observations: ObservationRecord[],
	passContext: PrunerPassContext,
): Promise<PrunerPassResult> {
	const idSet = new Set(observations.map((o) => o.id));
	const dropped = new Set<string>();

	const dropTool: AgentTool<typeof DropObservationsSchema> = {
		name: "drop_observations",
		label: "Drop observations",
		description:
			"Remove one or more observations from the kept set by id. May be called multiple times. " +
			"Stop calling when no further drops are warranted, then emit a short plain-text confirmation.",
		parameters: DropObservationsSchema,
		execute: async (_id, params: DropObservationsArgs) => {
			const valid: string[] = [];
			const unknown: string[] = [];
			const already: string[] = [];
			for (const id of params.ids) {
				if (!idSet.has(id)) {
					unknown.push(id);
					continue;
				}
				if (dropped.has(id)) {
					already.push(id);
					continue;
				}
				dropped.add(id);
				valid.push(id);
			}
			const remaining = idSet.size - dropped.size;
			const parts: string[] = [];
			parts.push(`Dropped ${valid.length} observation${valid.length === 1 ? "" : "s"}.`);
			if (unknown.length) parts.push(`Unknown ids ignored: ${unknown.join(", ")}.`);
			if (already.length) parts.push(`Already dropped: ${already.join(", ")}.`);
			parts.push(`Remaining kept: ${remaining} of ${idSet.size}.`);
			parts.push("Call drop_observations again if more should be removed; otherwise stop and emit a short plain-text confirmation.");
			return {
				content: [{ type: "text", text: parts.join(" ") }],
				details: { dropped: valid, unknown, already, remaining },
			};
		},
	};

	const pressureLine =
		passContext.deltaTokens > 0
			? `Pool ~${passContext.poolTokens.toLocaleString()} tokens, target ~${passContext.targetTokens.toLocaleString()} tokens, still need to cut at least ~${passContext.deltaTokens.toLocaleString()} tokens.`
			: `Pool ~${passContext.poolTokens.toLocaleString()} tokens, target ~${passContext.targetTokens.toLocaleString()} tokens (already under budget) — drop only clear redundancies.`;

	const passGuidance = buildPrunerPassGuidance(passContext.pass, passContext.maxPasses);

	const userText = `CURRENT REFLECTIONS:
${joinReflectionsOrEmpty(reflections)}

CURRENT OBSERVATIONS:
${joinObservationsOrEmpty(observations)}

${pressureLine}

${passGuidance}

Decide which observations to remove from the kept set. Call drop_observations with the ids you want to drop. You may call the tool multiple times as you reason through the pool. When satisfied, stop calling the tool and emit a short plain-text confirmation to end the run.`;

	const prompts: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: userText }],
			timestamp: Date.now(),
		},
	];

	const context: AgentContext = {
		systemPrompt: PRUNER_SYSTEM,
		messages: [],
		tools: [dropTool as AgentTool<any>],
	};

	const reasoning = (args.model as { reasoning?: unknown }).reasoning;
	const config: AgentLoopConfig = {
		model: args.model as any,
		apiKey: args.apiKey,
		headers: args.headers,
		maxTokens: 2048,
		convertToLlm: (msgs) => msgs as Message[],
		toolExecution: "sequential",
		...(reasoning ? { reasoning: "high" as const } : {}),
	};

	try {
		const stream = agentLoop(prompts, context, config, args.signal);
		for await (const _event of stream) {
			// Drain events; the tool's execute already records drops.
		}
		await stream.result();
	} catch {
		return { kept: observations, droppedIds: [], fellBack: true };
	}

	const kept = observations.filter((o) => !dropped.has(o.id));
	return { kept, droppedIds: Array.from(dropped), fellBack: false };
}

export async function runPruner(
	args: LlmArgs,
	reflections: Reflection[],
	observations: ObservationRecord[],
	budgetTokens: number,
): Promise<PrunerResult> {
	if (observations.length === 0) {
		return { observations: [], droppedIds: [], fellBack: false };
	}

	const target = Math.max(1, Math.floor(budgetTokens * PRUNER_TARGET_RATIO));
	let pool = observations;
	const allDropped: string[] = [];
	let fellBack = false;

	for (let pass = 1; pass <= PRUNER_MAX_PASSES; pass++) {
		const poolTokens = observationPoolTokens(pool);
		if (poolTokens <= target) break;

		const deltaTokens = poolTokens - target;
		const result = await runPrunerPass(args, reflections, pool, {
			poolTokens,
			targetTokens: target,
			deltaTokens,
			pass,
			maxPasses: PRUNER_MAX_PASSES,
		});

		if (result.fellBack) {
			fellBack = true;
			break;
		}
		if (result.droppedIds.length === 0) break;

		pool = result.kept;
		allDropped.push(...result.droppedIds);
	}

	return { observations: pool, droppedIds: allDropped, fellBack };
}

export function renderSummary(reflections: Reflection[], observations: ObservationRecord[]): string {
	if (reflections.length === 0 && observations.length === 0) return "";

	const parts: string[] = [CONTEXT_USAGE_INSTRUCTIONS];

	if (reflections.length > 0) {
		parts.push(`## Reflections\n${reflections.join("\n")}`);
	}
	if (observations.length > 0) {
		const body = observations.map((o) => `${o.timestamp} [${o.relevance}] ${o.content}`).join("\n");
		parts.push(`## Observations\n${body}`);
	}

	return parts.join("\n\n");
}
