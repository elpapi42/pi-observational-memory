import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Static } from "typebox";
import { debugLog } from "../../debug-log.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { reflectionToSummaryLine, type Observation, type Reflection } from "../../session-ledger/index.js";
import { DROPPER_SYSTEM } from "./prompts.js";
import {
	REFLECTION_COVERAGE_DROP_RANK,
	coverageTierForObservation,
	reflectionCoverageMap,
	summarizeCoverageByRelevance,
	summarizeCoverageByRelevanceForIds,
	observationToDropperLine,
} from "./coverage.js";
import { observationPoolMetrics } from "./pool.js";
export {
	maxDropCountForPool,
	observationPoolFullness,
	observationPoolMetrics,
} from "./pool.js";
export type { ObservationPoolMetrics } from "./pool.js";
export {
	REFLECTION_COVERAGE_TIERS,
	coverageTierForObservation,
	emptyCoverageSummaryByRelevance,
	observationToDropperLine,
	reflectionCoverageMap,
	reflectionCoverageTierForCount,
	reflectionSupportCounts,
	summarizeCoverageByRelevance,
	summarizeCoverageByRelevanceForIds,
	summarizeCoverageTransitionsByRelevance,
} from "./coverage.js";
export type { CoverageSummaryByRelevance, CoverageTransitionSummaryByRelevance, ReflectionCoverageTier } from "./coverage.js";

interface RunDropperArgs {
	model: Model<any>;
	apiKey: string;
	headers?: Record<string, string>;
	reflections: Reflection[];
	observations: Observation[];
	targetTokens: number;
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	maxTurns?: number;
	thinkingLevel?: ModelThinkingLevel;
}

const RELEVANCE_DROP_RANK: Record<Observation["relevance"], number> = {
	low: 0,
	medium: 1,
	high: 2,
	critical: 3,
};

const DropObservationsSchema = Type.Object({
	ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	reason: Type.Optional(Type.String()),
});

type DropObservationsArgs = Static<typeof DropObservationsSchema>;

function joinOrEmpty(items: string[]): string {
	return items.length ? items.join("\n") : "(none yet)";
}

function relevanceCounts(observations: readonly Observation[]): Record<Observation["relevance"], number> {
	return observations.reduce<Record<Observation["relevance"], number>>((counts, observation) => {
		counts[observation.relevance]++;
		return counts;
	}, { low: 0, medium: 0, high: 0, critical: 0 });
}

export function normalizeDropObservationIds(
	ids: readonly string[] | undefined,
	observations: readonly Observation[],
): string[] | undefined {
	if (!ids || ids.length === 0) return undefined;
	const allowed = new Map(observations.map((observation) => [observation.id, observation]));
	const result: string[] = [];
	const seen = new Set<string>();
	for (const id of ids) {
		const observation = allowed.get(id);
		if (!observation) continue;
		if (seen.has(id)) continue;
		seen.add(id);
		result.push(id);
	}
	return result.length > 0 ? result : undefined;
}

function timestampRank(timestamp: string): number {
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

export function selectDropCandidates(
	ids: readonly string[],
	observations: readonly Observation[],
	maxDrops: number,
	reflections: readonly Reflection[] = [],
): string[] {
	if (maxDrops <= 0 || ids.length === 0) return [];

	const byId = new Map(observations.map((observation) => [observation.id, observation]));
	const coverageById = reflectionCoverageMap(observations, reflections);
	const firstProposalIndex = new Map<string, number>();
	for (let i = 0; i < ids.length; i++) {
		const id = ids[i];
		if (!firstProposalIndex.has(id)) firstProposalIndex.set(id, i);
	}

	return Array.from(firstProposalIndex.entries())
		.map(([id, index]) => ({ id, index, observation: byId.get(id) }))
		.filter((candidate): candidate is { id: string; index: number; observation: Observation } =>
			candidate.observation !== undefined
		)
		.sort((a, b) => {
			const coverageDelta = REFLECTION_COVERAGE_DROP_RANK[coverageTierForObservation(a.observation, coverageById)]
				- REFLECTION_COVERAGE_DROP_RANK[coverageTierForObservation(b.observation, coverageById)];
			const relevanceDelta = RELEVANCE_DROP_RANK[a.observation.relevance] - RELEVANCE_DROP_RANK[b.observation.relevance];
			const ageDelta = timestampRank(a.observation.timestamp) - timestampRank(b.observation.timestamp);
			return coverageDelta || relevanceDelta || ageDelta || a.index - b.index;
		})
		.slice(0, maxDrops)
		.map((candidate) => candidate.id);
}

export async function runDropper(args: RunDropperArgs): Promise<string[] | undefined> {
	const { model, apiKey, headers, reflections, observations, targetTokens, signal } = args;
	if (observations.length === 0) return undefined;

	const metrics = observationPoolMetrics(observations, targetTokens);
	const { observationTokens, fullness, tokensOverTarget, maxDropsAllowed } = metrics;
	const coverageById = reflectionCoverageMap(observations, reflections);
	const coverageSummaryByRelevance = summarizeCoverageByRelevance(observations, coverageById);
	debugLog("dropper.agent_start", {
		activeObservationCount: observations.length,
		reflectionCount: reflections.length,
		observationTokens,
		targetTokens,
		tokensOverTarget,
		fullness,
		maxDropsAllowed,
		relevanceCounts: relevanceCounts(observations),
		coverageSummaryByRelevance,
	});
	if (maxDropsAllowed <= 0) {
		debugLog("dropper.result", {
			reason: "not_over_target",
			toolCallCount: 0,
			rawRequestedIdsCount: 0,
			acceptedCandidateCount: 0,
			selectedDropsCount: 0,
			selectedDropTokens: 0,
			selectedCoverageSummaryByRelevance: summarizeCoverageByRelevanceForIds([], observations, coverageById),
			maxDropsAllowed,
		});
		return undefined;
	}

	const proposedDropIds: string[] = [];
	const proposed = new Set<string>();
	const allowed = new Map(observations.map((observation) => [observation.id, observation]));
	let toolCallCount = 0;
	let rawRequestedIdsCount = 0;
	let missingIdsCount = 0;
	let criticalCandidateIdsCount = 0;
	let duplicateInRequestCount = 0;
	let duplicateInRunCount = 0;

	const dropObservations: AgentTool<typeof DropObservationsSchema> = {
		name: "drop_observations",
		label: "Drop observations",
		description: "Propose active observation ids that are safe to remove from compacted memory.",
		parameters: DropObservationsSchema,
		execute: async (_id, params: DropObservationsArgs) => {
			toolCallCount++;
			rawRequestedIdsCount += params.ids.length;
			const seenInRequest = new Set<string>();
			let added = 0;
			let requestMissingIds = 0;
			let requestCriticalCandidateIds = 0;
			let requestDuplicateIds = 0;
			let requestDuplicateInRunIds = 0;
			for (const id of params.ids) {
				const observation = allowed.get(id);
				if (!observation) {
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
				if (observation.relevance === "critical") {
					criticalCandidateIdsCount++;
					requestCriticalCandidateIds++;
				}
				added++;
			}
			debugLog("dropper.tool_call", {
				toolCallCount,
				rawRequestedIdsCount: params.ids.length,
				acceptedIdsCount: added,
				missingIdsCount: requestMissingIds,
				criticalCandidateIdsCount: requestCriticalCandidateIds,
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
	const userText = `CURRENT REFLECTIONS:\n${joinOrEmpty(reflections.map(reflectionToSummaryLine))}\n\nCURRENT OBSERVATIONS:\n${joinOrEmpty(observations.map((observation) => observationToDropperLine(observation, coverageTierForObservation(observation, coverageById))))}\n\nActive observation pool: ~${observationTokens.toLocaleString()} tokens; target: ~${targetTokens.toLocaleString()} tokens; fullness against target: ~${fullnessPercent.toLocaleString()}%; over target by ~${tokensOverTarget.toLocaleString()} tokens.\nMaximum drops allowed this run: ${maxDropsAllowed.toLocaleString()} observation${maxDropsAllowed === 1 ? "" : "s"}. This maximum is sized to move the active pool toward the target if every proposed drop is clearly safe.\nThis maximum is a hard upper bound, not a target. Drop fewer or none if fewer observations are clearly safe.`;
	const prompts: Message[] = [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }];
	const context: AgentContext = { systemPrompt: DROPPER_SYSTEM, messages: [], tools: [dropObservations as AgentTool<any>] };
	const reasoning = (model as { reasoning?: unknown }).reasoning;
	const thinkingLevel = args.thinkingLevel ?? "low";
	const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : undefined;
	let turnCount = 0;
	const config: AgentLoopConfig = {
		model,
		apiKey,
		headers,
		maxTokens: boundedMaxTokens(model, AGENT_LOOP_MAX_TOKENS),
		convertToLlm: (msgs) => msgs as Message[],
		toolExecution: "sequential",
		...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
		...(effectiveMaxTurns !== undefined ? { shouldStopAfterTurn: () => ++turnCount >= effectiveMaxTurns } : {}),
	};

	const loop = args.agentLoop ?? agentLoop;
	const stream = loop(prompts, context, config, signal, streamSimple);
	for await (const _event of stream) {
		// Tool execution collects candidate ids.
	}
	await stream.result();
	const droppedIds = selectDropCandidates(proposedDropIds, observations, maxDropsAllowed, reflections);
	const reason = droppedIds.length > 0
		? "selected_nonempty"
		: toolCallCount === 0
			? "no_tool_call"
			: proposedDropIds.length === 0
				? "all_filtered"
				: "selected_empty";
	const selectedDropTokens = droppedIds.reduce((sum, id) => sum + (allowed.get(id)?.tokenCount ?? 0), 0);
	debugLog("dropper.result", {
		reason,
		toolCallCount,
		rawRequestedIdsCount,
		missingIdsCount,
		criticalCandidateIdsCount,
		duplicateInRequestCount,
		duplicateInRunCount,
		acceptedCandidateCount: proposedDropIds.length,
		selectedDropsCount: droppedIds.length,
		selectedDropTokens,
		selectedCoverageSummaryByRelevance: summarizeCoverageByRelevanceForIds(droppedIds, observations, coverageById),
		maxDropsAllowed,
	});
	return droppedIds.length > 0 ? droppedIds : undefined;
}
