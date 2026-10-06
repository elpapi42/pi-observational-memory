import { debugLog } from "../../../debug-log.js";
import type { SystemOneDropperConfig } from "../../../config.js";
import type { Observation, Reflection } from "../../../session-ledger/index.js";
import {
	coverageTierForObservation,
	reflectionCoverageMap,
	summarizeCoverageByRelevance,
	summarizeCoverageByRelevanceForIds,
} from "../coverage.js";
import { observationPoolMetrics } from "../pool.js";
import { selectDropCandidates } from "../agent.js";
import type { ClassifierAnswer, ClassifierQuestion, ClassifierRegistry } from "./classifier.js";
import { resolveClassifier } from "./classifier.js";
import {
	SIGNAL_KEYS,
	buildQuestions,
	buildState,
	collectSignals,
	rankCandidates,
	type ObservationSignals,
} from "./questions.js";

export interface RunSystemOneDropperArgs {
	config: SystemOneDropperConfig;
	/** pi's model registry; the classifier is resolved from `config.provider`/`model`. */
	registry?: ClassifierRegistry;
	reflections: Reflection[];
	observations: Observation[];
	targetTokens: number;
	signal?: AbortSignal;
}

/**
 * Split observations so each request stays within the endpoint's combined
 * state-plus-questions budget. Every chunk sends the full pool as state, so
 * supersession and redundancy stay visible regardless of where an observation
 * lands.
 */
export function chunkObservations(
	observations: readonly Observation[],
	maxQuestionsPerRequest: number,
): Observation[][] {
	const perObservation = SIGNAL_KEYS.length;
	const size = Math.max(1, Math.floor(maxQuestionsPerRequest / perObservation));
	const chunks: Observation[][] = [];
	for (let i = 0; i < observations.length; i += size) chunks.push(observations.slice(i, i + size));
	return chunks;
}

export interface SystemOneScores {
	signalsById: Map<string, ObservationSignals>;
	requestCount: number;
	inputTokens: number;
}

/**
 * Score every observation without deciding anything.
 *
 * Split out from `runSystemOneDropper` so shadow mode can collect scores while
 * the LLM dropper still owns the decision.
 */
export async function scoreObservations(args: RunSystemOneDropperArgs): Promise<SystemOneScores> {
	const { config, registry, reflections, observations, signal } = args;
	const classifier = resolveClassifier(registry, config, config.requestTimeoutMs);
	if (!classifier) {
		const target = config.model ? `${config.provider}/${config.model}` : config.provider;
		throw new Error(`no classifier model registered for ${target}`);
	}
	const coverageById = reflectionCoverageMap(observations, reflections);
	const state = buildState(observations, reflections, coverageById);
	const chunks = chunkObservations(observations, config.maxQuestionsPerRequest);
	const answers: Record<string, ClassifierAnswer> = {};
	let inputTokens = 0;

	for (const [index, chunk] of chunks.entries()) {
		const questions: Record<string, ClassifierQuestion> = {};
		for (const observation of chunk) Object.assign(questions, buildQuestions(observation.id));
		const response = await classifier(state, questions, signal);
		Object.assign(answers, response.answers);
		inputTokens += response.usage?.input ?? 0;
		debugLog("dropper.system_one.request", {
			chunkIndex: index,
			chunkCount: chunks.length,
			observationCount: chunk.length,
			questionCount: Object.keys(questions).length,
			answerCount: Object.keys(response.answers).length,
			model: `${config.provider}${config.model ? `/${config.model}` : ""}`,
		});
	}

	return { signalsById: collectSignals(answers), requestCount: chunks.length, inputTokens };
}

/**
 * Dropper stage backed by a System One decision endpoint.
 *
 * Returns the same contract as the LLM dropper: the ids to drop, or undefined
 * when nothing is safely removable. Ranking happens here, but the final budget
 * and tie-breaks still go through `selectDropCandidates`, so both paths obey
 * the same selection rules.
 */
export async function runSystemOneDropper(args: RunSystemOneDropperArgs): Promise<string[] | undefined> {
	const { config, reflections, observations, targetTokens } = args;
	if (observations.length === 0) return undefined;

	const metrics = observationPoolMetrics(observations, targetTokens);
	const coverageById = reflectionCoverageMap(observations, reflections);
	debugLog("dropper.system_one.start", {
		provider: config.provider,
		model: config.model,
		activeObservationCount: observations.length,
		reflectionCount: reflections.length,
		observationTokens: metrics.observationTokens,
		targetTokens,
		maxDropsAllowed: metrics.maxDropsAllowed,
		vetoThreshold: config.vetoThreshold,
		dropThreshold: config.dropThreshold,
		coverageSummaryByRelevance: summarizeCoverageByRelevance(observations, coverageById),
	});
	if (metrics.maxDropsAllowed <= 0) {
		debugLog("dropper.system_one.result", { reason: "not_over_target", selectedDropsCount: 0 });
		return undefined;
	}

	const { signalsById, requestCount, inputTokens } = await scoreObservations(args);
	const ranked = rankCandidates(observations, signalsById, config.vetoThreshold, config.dropThreshold);
	const droppedIds = selectDropCandidates(
		ranked.candidates.map((candidate) => candidate.id),
		observations,
		metrics.maxDropsAllowed,
		reflections,
	);

	debugLog("dropper.system_one.result", {
		reason: droppedIds.length > 0 ? "selected_nonempty" : "selected_empty",
		requestCount,
		inputTokens,
		scoredObservationCount: signalsById.size,
		missingSignalsCount: ranked.missingSignalsCount,
		vetoedCount: ranked.vetoedCount,
		belowThresholdCount: ranked.belowThresholdCount,
		candidateCount: ranked.candidates.length,
		selectedDropsCount: droppedIds.length,
		selectedDropTokens: droppedIds.reduce(
			(sum, id) => sum + (observations.find((observation) => observation.id === id)?.tokenCount ?? 0),
			0,
		),
		selectedCoverageSummaryByRelevance: summarizeCoverageByRelevanceForIds(droppedIds, observations, coverageById),
		maxDropsAllowed: metrics.maxDropsAllowed,
		topCandidates: ranked.candidates.slice(0, 10).map((candidate) => ({
			id: candidate.id,
			dropProbability: Number(candidate.dropProbability.toFixed(4)),
			coverage: coverageTierForObservation(
				observations.find((observation) => observation.id === candidate.id)!,
				coverageById,
			),
			signals: candidate.signals,
		})),
	});
	return droppedIds.length > 0 ? droppedIds : undefined;
}
