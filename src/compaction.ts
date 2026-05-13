import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Message, type Model } from "@mariozechner/pi-ai";
import type { Static } from "@sinclair/typebox";
import { hashId } from "./ids.js";
import { observationsToPromptLines } from "./observer.js";
import { buildPrunerPassGuidance, buildReflectorPassGuidance, CONTEXT_USAGE_INSTRUCTIONS, PRUNER_SYSTEM, REFLECTOR_SYSTEM } from "./prompts.js";
import { truncateRecordContent } from "./serialize.js";
import { estimateStringTokens } from "./tokens.js";
import { reflectionContent, reflectionToPromptLine } from "./types.js";
import type { MemoryReflection, ObservationRecord, ReflectionRecord } from "./types.js";

const REFLECTOR_MAX_PASSES = 3;
const PRUNER_MAX_PASSES = 5;
const PRUNER_TARGET_RATIO = 0.8;

export function observationPoolTokens(observations: ObservationRecord[]): number {
	return estimateStringTokens(observationsToPromptLines(observations).join("\n"));
}

interface LlmArgs {
	model: Model<any>;
	apiKey: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
}

function joinReflectionsOrEmpty(items: MemoryReflection[]): string {
	return items.length ? items.map(reflectionToPromptLine).join("\n") : "(none yet)";
}

function joinObservationsOrEmpty(items: ObservationRecord[]): string {
	return items.length ? observationsToPromptLines(items).join("\n") : "(none yet)";
}

export type ObservationCoverageTag = "uncited" | "cited" | "reinforced";

export function deriveObservationCoverageTags(
	reflections: MemoryReflection[],
	observations: ObservationRecord[],
): Map<string, ObservationCoverageTag> {
	const activeIds = new Set(observations.map((o) => o.id));
	const counts = new Map<string, number>();
	for (const observation of observations) counts.set(observation.id, 0);

	for (const reflection of reflections) {
		if (typeof reflection === "string" || reflection.legacy === true) continue;
		const citedActiveIds = new Set(reflection.supportingObservationIds.filter((id) => activeIds.has(id)));
		for (const id of citedActiveIds) counts.set(id, (counts.get(id) ?? 0) + 1);
	}

	const tags = new Map<string, ObservationCoverageTag>();
	for (const observation of observations) {
		const count = counts.get(observation.id) ?? 0;
		tags.set(observation.id, count === 0 ? "uncited" : count >= 4 ? "reinforced" : "cited");
	}
	return tags;
}

export function renderObservationsForPrunerPrompt(
	observations: ObservationRecord[],
	coverageTags: ReadonlyMap<string, ObservationCoverageTag>,
): string {
	if (observations.length === 0) return "(none yet)";
	return observations
		.map((observation) => {
			const tag = coverageTags.get(observation.id) ?? "uncited";
			return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] [coverage: ${tag}] ${observation.content}`;
		})
		.join("\n");
}

export function migrateLegacyReflections(reflections: MemoryReflection[]): MemoryReflection[] {
	const migrated: MemoryReflection[] = [];
	const contentToIndex = new Map<string, number>();

	for (const reflection of reflections) {
		const rawContent = reflectionContent(reflection).trim();
		const normalizedContent = typeof reflection === "string" ? rawContent.replace(/\s+/g, " ") : rawContent;
		if (!normalizedContent) {
			migrated.push(reflection);
			continue;
		}
		const content = truncateRecordContent(normalizedContent);

		const existingIndex = contentToIndex.get(content);
		if (existingIndex !== undefined) {
			const existing = migrated[existingIndex];
			if (typeof existing !== "string" && existing.legacy === true && typeof reflection !== "string" && reflection.legacy !== true) {
				migrated[existingIndex] = reflection;
			}
			continue;
		}

		if (typeof reflection !== "string") {
			migrated.push(reflection);
			contentToIndex.set(content, migrated.length - 1);
			continue;
		}

		migrated.push({
			id: hashId(content),
			content,
			supportingObservationIds: [],
			legacy: true,
		});
		contentToIndex.set(content, migrated.length - 1);
	}

	return migrated;
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
					description: "Exact observation id from the current-observations list whose durable meaning is captured by this reflection.",
				}),
				{
					minItems: 1,
					description:
						"Current observation ids whose durable meaning is captured by this reflection and can be treated as covered active-memory detail. " +
						"Do not include observations whose unique exact detail or current task state is not captured. Use only ids shown in the current observations list; never invent ids.",
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

export interface ReflectorPassContext {
	pass: number;
	maxPasses: number;
	minSupportingObservationIds: number;
}

export type ReflectionProposal = {
	content: string;
	supportingObservationIds?: readonly string[];
};

export interface ApplyReflectionProposalsResult {
	reflections: MemoryReflection[];
	accepted: number;
	added: number;
	merged: number;
	promoted: number;
	duplicates: number;
	unsupported: number;
}

function reflectorPassContext(pass: number): ReflectorPassContext {
	return {
		pass,
		maxPasses: REFLECTOR_MAX_PASSES,
		minSupportingObservationIds: pass === 1 ? 2 : 1,
	};
}

function reflectionContentKey(reflection: MemoryReflection): string {
	return reflectionContent(reflection).trim();
}

function normalizeReflectionProposalContent(content: string): string | undefined {
	const normalized = truncateRecordContent(content.trim());
	if (!normalized || /[\r\n]/.test(normalized)) return undefined;
	return normalized;
}

function mergeSupportingObservationIds(
	existing: readonly string[],
	incoming: readonly string[],
	allowedObservationIds: readonly string[],
): string[] | undefined {
	const allowed = new Set(allowedObservationIds);
	const historicalExisting = existing.filter((id) => !allowed.has(id));
	const currentExisting = existing.filter((id) => allowed.has(id));
	const normalizedCurrent = normalizeSupportingObservationIds([...currentExisting, ...incoming], allowedObservationIds);
	if (!normalizedCurrent) return undefined;
	return [...historicalExisting, ...normalizedCurrent];
}

export function renderReflectionsForReflectorPrompt(reflections: MemoryReflection[]): string {
	return joinReflectionsOrEmpty(reflections);
}

export function applyReflectionProposals(
	reflections: MemoryReflection[],
	proposals: readonly ReflectionProposal[],
	allowedObservationIds: readonly string[],
	passContext: Pick<ReflectorPassContext, "minSupportingObservationIds">,
): ApplyReflectionProposalsResult {
	const next = [...reflections];
	let accepted = 0;
	let added = 0;
	let merged = 0;
	let promoted = 0;
	let duplicates = 0;
	let unsupported = 0;

	for (const proposal of proposals) {
		const content = normalizeReflectionProposalContent(proposal.content);
		if (!content) {
			unsupported++;
			continue;
		}
		const supportingObservationIds = normalizeSupportingObservationIds(
			proposal.supportingObservationIds,
			allowedObservationIds,
		);
		if (!supportingObservationIds || supportingObservationIds.length < passContext.minSupportingObservationIds) {
			unsupported++;
			continue;
		}

		const existingIndex = next.findIndex((reflection) => reflectionContentKey(reflection) === content);
		if (existingIndex >= 0) {
			const existing = next[existingIndex];
			if (typeof existing === "string") {
				next[existingIndex] = {
					id: hashId(content),
					content,
					supportingObservationIds,
				};
				accepted++;
				promoted++;
				continue;
			}

			const mergedSupport = mergeSupportingObservationIds(
				existing.supportingObservationIds,
				supportingObservationIds,
				allowedObservationIds,
			);
			if (!mergedSupport) {
				unsupported++;
				continue;
			}
			const hasNewSupport = mergedSupport.length !== existing.supportingObservationIds.length;
			if (existing.legacy === true) {
				next[existingIndex] = {
					id: existing.id,
					content: existing.content,
					supportingObservationIds: mergedSupport,
				};
				accepted++;
				promoted++;
				continue;
			}
			if (hasNewSupport) {
				next[existingIndex] = {
					...existing,
					supportingObservationIds: mergedSupport,
				};
				accepted++;
				merged++;
			} else {
				duplicates++;
			}
			continue;
		}

		next.push({
			id: hashId(content),
			content,
			supportingObservationIds,
		});
		accepted++;
		added++;
	}

	return { reflections: next, accepted, added, merged, promoted, duplicates, unsupported };
}

async function runReflectorPass(
	args: LlmArgs,
	reflections: MemoryReflection[],
	observations: ObservationRecord[],
	passContext: ReflectorPassContext,
): Promise<{ reflections: MemoryReflection[]; failed: boolean }> {
	const allowedObservationIds = observations.map((o) => o.id);
	let currentReflections = reflections;

	const recordTool: AgentTool<typeof RecordReflectionsSchema> = {
		name: "record_reflections",
		label: "Record reflections",
		description:
			"Record a batch of reflections crystallized from the observation pool, with supporting ids for observations whose durable meaning is captured. " +
			"May be called multiple times. Stop calling when nothing more is stable enough to crystallize or strengthen for this pass, " +
			"then emit a short plain-text confirmation.",
		parameters: RecordReflectionsSchema,
		execute: async (_id, params: RecordReflectionsArgs) => {
			const result = applyReflectionProposals(
				currentReflections,
				params.reflections,
				allowedObservationIds,
				passContext,
			);
			currentReflections = result.reflections;
			const parts: string[] = [];
			parts.push(`Accepted ${result.accepted} reflection proposal${result.accepted === 1 ? "" : "s"}.`);
			if (result.added) parts.push(`${result.added} new.`);
			if (result.merged) parts.push(`${result.merged} merged into existing reflections.`);
			if (result.promoted) parts.push(`${result.promoted} promoted from legacy/no-provenance memory.`);
			if (result.duplicates) parts.push(`${result.duplicates} duplicate/no-op proposal${result.duplicates === 1 ? "" : "s"} skipped.`);
			if (result.unsupported) {
				parts.push(
					`${result.unsupported} unsupported proposal${result.unsupported === 1 ? "" : "s"} rejected for invalid supporting observation ids or this pass's minimum support requirement.`,
				);
			}
			parts.push("Call record_reflections again if more should be crystallized for this pass; otherwise stop and emit a short plain-text confirmation.");
			return {
				content: [{ type: "text", text: parts.join(" ") }],
				details: result,
			};
		},
	};

	const passGuidance = buildReflectorPassGuidance(passContext.pass, passContext.maxPasses);
	const userText = `CURRENT REFLECTIONS:
${renderReflectionsForReflectorPrompt(reflections)}

CURRENT OBSERVATIONS:
${joinObservationsOrEmpty(observations)}

REFLECTOR PASS GUIDANCE:
${passGuidance}

Crystallize long-lived reflections from the full observation pool for this pass. Call record_reflections with batches of reflection proposals, each with supporting observation ids whose durable meaning is captured by that reflection. You may call the tool multiple times as you reason through the pool. To strengthen or promote an existing reflection, repeat the exact existing reflection content with additional valid supporting observation ids. Do not lightly reword existing reflections. Do not attach observations whose unique exact detail or current task state is not captured with equivalent fidelity. When done, stop calling the tool and emit a short plain-text confirmation.`;

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
		const loop = args.agentLoop ?? agentLoop;
		const stream = loop(prompts, context, config, args.signal);
		for await (const _event of stream) {
			// Drain events; the tool's execute already updates reflections.
		}
		await stream.result();
	} catch {
		return { reflections: currentReflections, failed: true };
	}

	return { reflections: currentReflections, failed: false };
}

export async function runReflector(
	args: LlmArgs,
	reflections: MemoryReflection[],
	observations: ObservationRecord[],
): Promise<MemoryReflection[]> {
	let currentReflections = reflections;

	for (let pass = 1; pass <= REFLECTOR_MAX_PASSES; pass++) {
		const result = await runReflectorPass(args, currentReflections, observations, reflectorPassContext(pass));
		currentReflections = result.reflections;
		if (result.failed) break;
	}

	return currentReflections;
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
	coverageTags: ReadonlyMap<string, ObservationCoverageTag>;
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
${renderObservationsForPrunerPrompt(observations, passContext.coverageTags)}

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
		const loop = args.agentLoop ?? agentLoop;
		const stream = loop(prompts, context, config, args.signal);
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
	const coverageTags = deriveObservationCoverageTags(reflections, observations);
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
			coverageTags,
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
