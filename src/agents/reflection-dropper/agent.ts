import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { debugLog } from "../../debug-log.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { logAgentStreamError } from "../stream-errors.js";
import { resolveWorkerStreamSimple, type StreamableModelRegistry, type WorkerStreamSimple } from "../worker-stream.js";
import { observationToSummaryLine, type Observation, type Reflection } from "../../session-ledger/index.js";
import { REFLECTION_DROPPER_SYSTEM } from "./prompts.js";
import type { WorkerUsageAccumulator } from "../../worker-usage.js";
import {
	evidenceForReflection,
	reflectionEvidenceMap,
	reflectionToDropperLine,
	summarizeReflectionEvidence,
	type ReflectionEvidence,
} from "./evidence.js";
import { reflectionPoolMetrics } from "./pool.js";
import { reflectionLineTokenCount } from "../../tokens.js";

export { reflectionPoolMetrics, reflectionTokenSum } from "./pool.js";
export type { ReflectionPoolMetrics } from "./pool.js";
export {
	evidenceForReflection,
	reflectionEvidenceMap,
	reflectionToDropperLine,
	summarizeReflectionEvidence,
} from "./evidence.js";
export type { ReflectionEvidence, ReflectionEvidenceSummary } from "./evidence.js";

interface RunReflectionDropperArgs {
	model: Model<any>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	/** Active reflections; the drop candidate pool. */
	reflections: Reflection[];
	/** Active observations, shown as current-work orientation. */
	observations: Observation[];
	/** All recorded observations by id, including dropped ones, for derived recency. */
	observationsById: ReadonlyMap<string, Observation>;
	droppedObservationIds: ReadonlySet<string>;
	targetTokens: number;
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	maxTurns?: number;
	/** Maximum output tokens for the loop (defaults to {@link AGENT_LOOP_MAX_TOKENS}). */
	maxOutputTokens?: number;
	thinkingLevel?: ModelThinkingLevel;
	modelRegistry?: StreamableModelRegistry;
	streamSimple?: WorkerStreamSimple;
	/** Accumulates this run's provider usage; pi does not see worker calls. */
	usage?: WorkerUsageAccumulator;
	/**
	 * Receives what the model asked to drop, before the budget and the
	 * orphan-count/recency sort in `selectReflectionDropCandidates` cut it down,
	 * so the model's judgement stays separable from that ordering.
	 */
	onProposedIds?: (ids: readonly string[]) => void;
}

const DropReflectionsSchema = Type.Object({
	ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	reason: Type.Optional(Type.String()),
});

type DropReflectionsArgs = Static<typeof DropReflectionsSchema>;

function joinOrEmpty(items: string[]): string {
	return items.length ? items.join("\n") : "(none yet)";
}

export function normalizeDropReflectionIds(
	ids: readonly string[] | undefined,
	reflections: readonly Reflection[],
): string[] | undefined {
	if (!ids || ids.length === 0) return undefined;
	const allowed = new Set(reflections.map((reflection) => reflection.id));
	const result: string[] = [];
	const seen = new Set<string>();
	for (const id of ids) {
		if (!allowed.has(id)) continue;
		if (seen.has(id)) continue;
		seen.add(id);
		result.push(id);
	}
	return result.length > 0 ? result : undefined;
}

/**
 * Rank model-proposed drops and cap them at the pool-derived maximum.
 *
 * Orphan risk dominates: a reflection that is the last active carrier of
 * already-pruned observations is dropped only after every safer candidate.
 * Older evidence is preferred next, since dated scope is the common reason a
 * reflection stops being durable, and reflections with unknown recency sort
 * last. Proposal order breaks remaining ties.
 */
export function selectReflectionDropCandidates(
	ids: readonly string[],
	reflections: readonly Reflection[],
	maxDrops: number,
	evidenceById: ReadonlyMap<string, ReflectionEvidence>,
): string[] {
	if (maxDrops <= 0 || ids.length === 0) return [];

	const byId = new Map(reflections.map((reflection) => [reflection.id, reflection]));
	const firstProposalIndex = new Map<string, number>();
	for (let i = 0; i < ids.length; i++) {
		if (!firstProposalIndex.has(ids[i])) firstProposalIndex.set(ids[i], i);
	}

	return Array.from(firstProposalIndex.entries())
		.map(([id, index]) => ({ id, index, reflection: byId.get(id) }))
		.filter((candidate): candidate is { id: string; index: number; reflection: Reflection } =>
			candidate.reflection !== undefined
		)
		.sort((a, b) => {
			const aEvidence = evidenceForReflection(a.reflection, evidenceById);
			const bEvidence = evidenceForReflection(b.reflection, evidenceById);
			const orphanDelta = aEvidence.orphanCount - bEvidence.orphanCount;
			// Infinity - Infinity is NaN when both sides have unknown recency; every
			// other infinite delta is a real ordering (unknown recency sorts last).
			const recencyDelta = aEvidence.lastEvidenceRank - bEvidence.lastEvidenceRank;
			return orphanDelta || (Number.isNaN(recencyDelta) ? 0 : recencyDelta) || a.index - b.index;
		})
		.slice(0, maxDrops)
		.map((candidate) => candidate.id);
}

export async function runReflectionDropper(args: RunReflectionDropperArgs): Promise<string[] | undefined> {
	const { model, apiKey, headers, env, reflections, observations, targetTokens, signal } = args;
	if (reflections.length === 0) return undefined;

	const metrics = reflectionPoolMetrics(reflections, targetTokens);
	const { reflectionTokens, fullness, tokensOverTarget, maxDropsAllowed } = metrics;
	const evidenceById = reflectionEvidenceMap(reflections, {
		observationsById: args.observationsById,
		droppedObservationIds: args.droppedObservationIds,
	});
	debugLog("reflection_dropper.agent_start", {
		activeReflectionCount: reflections.length,
		activeObservationCount: observations.length,
		reflectionTokens,
		targetTokens,
		tokensOverTarget,
		fullness,
		maxDropsAllowed,
		evidenceSummary: summarizeReflectionEvidence(reflections, evidenceById),
	});
	if (maxDropsAllowed <= 0) {
		debugLog("reflection_dropper.result", {
			reason: "not_over_target",
			toolCallCount: 0,
			rawRequestedIdsCount: 0,
			acceptedCandidateCount: 0,
			selectedDropsCount: 0,
			selectedDropTokens: 0,
			selectedOrphanRisk: 0,
			maxDropsAllowed,
		});
		return undefined;
	}

	const proposedDropIds: string[] = [];
	const proposed = new Set<string>();
	const allowed = new Map(reflections.map((reflection) => [reflection.id, reflection]));
	let toolCallCount = 0;
	let rawRequestedIdsCount = 0;
	let missingIdsCount = 0;
	let orphanRiskCandidateCount = 0;
	let duplicateInRequestCount = 0;
	let duplicateInRunCount = 0;

	const dropReflections: AgentTool<typeof DropReflectionsSchema> = {
		name: "drop_reflections",
		label: "Drop reflections",
		description: "Propose active reflection ids that are safe to remove from durable memory.",
		parameters: DropReflectionsSchema,
		execute: async (_id, params: DropReflectionsArgs) => {
			toolCallCount++;
			rawRequestedIdsCount += params.ids.length;
			const seenInRequest = new Set<string>();
			let added = 0;
			let requestMissingIds = 0;
			let requestOrphanRiskIds = 0;
			let requestDuplicateIds = 0;
			let requestDuplicateInRunIds = 0;
			for (const id of params.ids) {
				const reflection = allowed.get(id);
				if (!reflection) {
					missingIdsCount++;
					requestMissingIds++;
					continue;
				}
				if (seenInRequest.has(id)) {
					duplicateInRequestCount++;
					requestDuplicateIds++;
					continue;
				}
				seenInRequest.add(id);
				if (proposed.has(id)) {
					duplicateInRunCount++;
					requestDuplicateInRunIds++;
					continue;
				}
				proposed.add(id);
				proposedDropIds.push(id);
				if (evidenceForReflection(reflection, evidenceById).orphanCount > 0) {
					orphanRiskCandidateCount++;
					requestOrphanRiskIds++;
				}
				added++;
			}
			debugLog("reflection_dropper.tool_call", {
				toolCallCount,
				rawRequestedIdsCount: params.ids.length,
				acceptedIdsCount: added,
				missingIdsCount: requestMissingIds,
				orphanRiskCandidateCount: requestOrphanRiskIds,
				duplicateInRequestCount: requestDuplicateIds,
				duplicateInRunCount: requestDuplicateInRunIds,
				totalCandidates: proposedDropIds.length,
				maxDropsAllowed,
			});
			return {
				content: [{ type: "text", text: `Queued ${added} drop candidate${added === 1 ? "" : "s"}. Candidates this run: ${proposedDropIds.length}. Maximum drops allowed: ${maxDropsAllowed}.` }],
				details: { added, totalCandidates: proposedDropIds.length, maxDropsAllowed },
			};
		},
	};

	const fullnessPercent = Math.round(fullness * 100);
	const userText = `CURRENT REFLECTIONS:\n${joinOrEmpty(reflections.map((reflection) => reflectionToDropperLine(reflection, evidenceForReflection(reflection, evidenceById))))}\n\nCURRENT OBSERVATIONS (orientation only; these are not drop candidates):\n${joinOrEmpty(observations.map(observationToSummaryLine))}\n\nReflection pool: ~${reflectionTokens.toLocaleString()} tokens; target: ~${targetTokens.toLocaleString()} tokens; fullness against target: ~${fullnessPercent.toLocaleString()}%; over target by ~${tokensOverTarget.toLocaleString()} tokens.\nMaximum drops allowed this run: ${maxDropsAllowed.toLocaleString()} reflection${maxDropsAllowed === 1 ? "" : "s"}. This maximum is sized to move the reflection pool toward the target if every proposed drop is clearly safe.\nThis maximum is a hard upper bound, not a target. Drop fewer or none if fewer reflections are clearly superseded, obsolete, or redundant.`;
	const prompts: Message[] = [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }];
	const context: AgentContext = {
		messages: [{ role: "system", content: REFLECTION_DROPPER_SYSTEM, timestamp: Date.now() }],
		tools: [dropReflections as AgentTool<any>],
	};
	const reasoning = (model as { reasoning?: unknown }).reasoning;
	const thinkingLevel = args.thinkingLevel ?? "low";
	const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : undefined;
	let turnCount = 0;
	const config: AgentLoopConfig = {
		model,
		apiKey,
		headers,
		env,
		maxTokens: boundedMaxTokens(model, args.maxOutputTokens ?? AGENT_LOOP_MAX_TOKENS),
		convertToLlm: (msgs) => msgs as Message[],
		toolExecution: "sequential",
		...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
		...(effectiveMaxTurns !== undefined
			? {
				finishTurn: (turn) => {
					if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return;
					return ++turnCount >= effectiveMaxTurns ? { action: "end" } : undefined;
				},
			}
			: {}),
	};

	const loop = args.agentLoop ?? agentLoop;
	const stream = loop(
		prompts,
		context,
		config,
		signal,
		resolveWorkerStreamSimple(model, args.modelRegistry, args.streamSimple),
	);
	for await (const event of stream) {
		args.usage?.addEvent(event);
		// Tool execution collects candidate ids.
		logAgentStreamError("reflection_dropper", event);
	}
	await stream.result();
	args.onProposedIds?.(proposedDropIds);
	const droppedIds = selectReflectionDropCandidates(proposedDropIds, reflections, maxDropsAllowed, evidenceById);
	const reason = droppedIds.length > 0
		? "selected_nonempty"
		: toolCallCount === 0
			? "no_tool_call"
			: proposedDropIds.length === 0
				? "all_filtered"
				: "selected_empty";
	const selectedDropTokens = droppedIds.reduce((sum, id) => {
		const reflection = allowed.get(id);
		return sum + (reflection ? reflectionLineTokenCount(reflection) : 0);
	}, 0);
	const selectedOrphanRisk = droppedIds.reduce((sum, id) => {
		const reflection = allowed.get(id);
		return sum + (reflection ? evidenceForReflection(reflection, evidenceById).orphanCount : 0);
	}, 0);
	debugLog("reflection_dropper.result", {
		reason,
		toolCallCount,
		rawRequestedIdsCount,
		missingIdsCount,
		orphanRiskCandidateCount,
		duplicateInRequestCount,
		duplicateInRunCount,
		acceptedCandidateCount: proposedDropIds.length,
		proposedDropIds,
		selectedDropsCount: droppedIds.length,
		selectedDropTokens,
		selectedOrphanRisk,
		maxDropsAllowed,
	});
	return droppedIds.length > 0 ? droppedIds : undefined;
}
