import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Message, type Model } from "@mariozechner/pi-ai";
import type { Static } from "@sinclair/typebox";
import { hashId } from "./ids.js";
import { observationsToPromptLines } from "./observer.js";
import { buildPrunerPassGuidance, CONTEXT_USAGE_INSTRUCTIONS, PRUNER_SYSTEM, REFLECTOR_SYSTEM } from "./prompts.js";
import { truncateRecordContent } from "./serialize.js";
import { estimateStringTokens } from "./tokens.js";
import { reflectionContent, reflectionToPromptLine } from "./types.js";
import type { MemoryReflection, ObservationRecord, ReflectionRecord } from "./types.js";

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

function joinReflectionsOrEmpty(items: MemoryReflection[]): string {
	return items.length ? items.map(reflectionToPromptLine).join("\n") : "(none yet)";
}

function joinObservationsOrEmpty(items: ObservationRecord[]): string {
	return items.length ? observationsToPromptLines(items).join("\n") : "(none yet)";
}

const RecordReflectionsSchema = Type.Object({
	reflections: Type.Array(
		Type.Object({
			content: Type.String({
				minLength: 1,
				description: "Single-line plain prose reflection. No markdown, no tags, no timestamp, no bullets.",
			}),
			supportingObservationIds: Type.Array(
				Type.String({
					pattern: "^[a-f0-9]{12}$",
					description: "Exact observation id from the current-observations list that supports this reflection.",
				}),
				{
					minItems: 1,
					description:
						"Smallest exact set of current observation ids that directly support this reflection. " +
						"Use only ids shown in the current observations list; never invent ids.",
				},
			),
		}),
		{
			minItems: 1,
			description: "Batch of new reflection proposals with their supporting observation ids.",
		},
	),
});

type RecordReflectionsArgs = Static<typeof RecordReflectionsSchema>;

export function normalizeSupportingObservationIds(
	supportingObservationIds: readonly string[] | undefined,
	allowedObservationIds: readonly string[],
): string[] | undefined {
	if (!supportingObservationIds || supportingObservationIds.length === 0) return undefined;
	const allowedOrder = new Map<string, number>();
	for (let i = 0; i < allowedObservationIds.length; i++) {
		if (!allowedOrder.has(allowedObservationIds[i])) allowedOrder.set(allowedObservationIds[i], i);
	}

	const seen = new Set<string>();
	for (const id of supportingObservationIds) {
		if (!allowedOrder.has(id)) return undefined;
		seen.add(id);
	}
	if (seen.size === 0) return undefined;
	return Array.from(seen).sort((a, b) => (allowedOrder.get(a) ?? 0) - (allowedOrder.get(b) ?? 0));
}

export async function runReflector(
	args: LlmArgs,
	reflections: MemoryReflection[],
	observations: ObservationRecord[],
): Promise<ReflectionRecord[]> {
	const existing = new Set(reflections.map((r) => reflectionContent(r).trim()));
	const allowedObservationIds = observations.map((o) => o.id);
	const added = new Map<string, ReflectionRecord>();

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
			let unsupported = 0;
			for (const proposal of params.reflections) {
				const content = truncateRecordContent(proposal.content.trim());
				if (!content || /[\r\n]/.test(content)) {
					unsupported++;
					continue;
				}
				const supportingObservationIds = normalizeSupportingObservationIds(
					proposal.supportingObservationIds,
					allowedObservationIds,
				);
				if (!supportingObservationIds) {
					unsupported++;
					continue;
				}
				if (existing.has(content) || added.has(content)) {
					duplicates++;
					continue;
				}
				added.set(content, {
					id: hashId(content),
					content,
					supportingObservationIds,
				});
				accepted++;
			}
			const parts: string[] = [];
			parts.push(`Recorded ${accepted} new reflection${accepted === 1 ? "" : "s"}.`);
			if (duplicates) parts.push(`${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped.`);
			if (unsupported) parts.push(`${unsupported} unsupported proposal${unsupported === 1 ? "" : "s"} rejected for invalid supporting observation ids.`);
			parts.push(`Total new this run: ${added.size}.`);
			parts.push("Call record_reflections again if more should be crystallized; otherwise stop and emit a short plain-text confirmation.");
			return {
				content: [{ type: "text", text: parts.join(" ") }],
				details: { accepted, duplicates, unsupported, total: added.size },
			};
		},
	};

	const userText = `CURRENT REFLECTIONS:
${joinReflectionsOrEmpty(reflections)}

CURRENT OBSERVATIONS:
${joinObservationsOrEmpty(observations)}

Crystallize new long-lived reflections from the observation pool. Call record_reflections with batches of new reflection proposals, each with the exact supporting observation ids. You may call the tool multiple times as you reason through the pool. Do not restate reflections already in the current reflections list. When done, stop calling the tool and emit a short plain-text confirmation.`;

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

	return Array.from(added.values());
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
	reflections: MemoryReflection[],
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
	reflections: MemoryReflection[],
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

export function renderSummary(reflections: MemoryReflection[], observations: ObservationRecord[]): string {
	if (reflections.length === 0 && observations.length === 0) return "";

	const parts: string[] = [CONTEXT_USAGE_INSTRUCTIONS];

	if (reflections.length > 0) {
		parts.push(`## Reflections\n${reflections.map(reflectionToPromptLine).join("\n")}`);
	}
	if (observations.length > 0) {
		const body = observationsToPromptLines(observations).join("\n");
		parts.push(`## Observations\n${body}`);
	}

	return parts.join("\n\n");
}
