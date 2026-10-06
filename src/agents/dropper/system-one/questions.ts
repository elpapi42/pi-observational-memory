import type { Observation, Reflection } from "../../../session-ledger/index.js";
import { coverageTierForObservation, type ReflectionCoverageTier } from "../coverage.js";
import type { ClassifierAnswer, ClassifierQuestion } from "./classifier.js";

/**
 * The five signals the LLM dropper weighs in prose, asked as independent typed
 * questions. `floor` is a veto; the other three are drop evidence; `safety` is
 * an overall rubric that has to agree before anything is proposed.
 */
export const SIGNAL_KEYS = ["floor", "redundant", "superseded", "lowSignal", "safety"] as const;
export type SignalKey = (typeof SIGNAL_KEYS)[number];

export type ObservationSignals = Record<SignalKey, number>;

/**
 * Mirrors the preservation floor in DROPPER_SYSTEM. Collapsed into one question
 * because every item resolves to the same action — never drop — so splitting
 * them would multiply request size to buy diagnostics, not decision quality.
 */
const PRESERVATION_FLOOR_ITEMS = [
	"user preferences, constraints, corrections, or identity/role facts",
	"concrete completions that future runs must not redo",
	"named identifiers, file paths, function names, package names, tickets, commit SHAs, handles, or exact commands",
	"exact error messages, diagnostic output, or test failure names",
	"architectural or technical decisions and their rationale",
	"dates of specific events, deadlines, meetings, migrations, or incidents",
	"current unresolved blockers, TODOs, partial work, or decisions waiting on the user",
	"non-standard user terminology or unusual phrasing needed for future recognition",
];

export const SAFETY_LEVELS = [
	"Unsafe: this observation uniquely carries information a future session would need, and removing it would cause repeated, contradicted, or misremembered work.",
	"Risky: most of its meaning exists elsewhere, but it still retains some unique detail worth keeping.",
	"Safe: its durable meaning is fully preserved by a reflection or a newer observation, or it is routine low-signal work state that carries no future value.",
];

export function questionKey(observationId: string, signal: SignalKey): string {
	return `${observationId}:${signal}`;
}

export function parseQuestionKey(key: string): { observationId: string; signal: SignalKey } | undefined {
	const separator = key.lastIndexOf(":");
	if (separator <= 0) return undefined;
	const signal = key.slice(separator + 1) as SignalKey;
	if (!SIGNAL_KEYS.includes(signal)) return undefined;
	return { observationId: key.slice(0, separator), signal };
}

export type SystemOneState = {
	purpose: string;
	reflections: { id: string; content: string }[];
	observations: {
		id: string;
		timestamp: string;
		relevance: string;
		reflectionCoverage: ReflectionCoverageTier;
		content: string;
	}[];
};

/**
 * Sent once per request and evaluated against every question in parallel.
 * Questions reference observations by id rather than restating them, which
 * keeps the question budget roughly flat as the pool grows.
 */
export function buildState(
	observations: readonly Observation[],
	reflections: readonly Reflection[],
	coverageById: Map<string, ReflectionCoverageTier>,
): SystemOneState {
	return {
		purpose:
			"Compacted memory for a coding assistant. Once the raw conversation is compacted away, these observations and reflections are the only record of past interactions. `observations` are timestamped evidence, ordered oldest first. `reflections` are durable facts already distilled from them. `reflectionCoverage` reports how many current reflections cite that observation id.",
		reflections: reflections.map((reflection) => ({ id: reflection.id, content: reflection.content })),
		observations: observations.map((observation) => ({
			id: observation.id,
			timestamp: observation.timestamp,
			relevance: observation.relevance,
			reflectionCoverage: coverageTierForObservation(observation, coverageById),
			content: observation.content,
		})),
	};
}

function about(observationId: string, question: string): Record<string, unknown> {
	return { observation_id: observationId, question: `Consider the entry in \`observations\` whose id is \`observation_id\`. ${question}` };
}

export function buildQuestions(observationId: string): Record<string, ClassifierQuestion> {
	return {
		[questionKey(observationId, "floor")]: {
			type: "bool",
			instructions: about(
				observationId,
				`Is it the only place in \`observations\` and \`reflections\` that carries any of the following: ${PRESERVATION_FLOOR_ITEMS.join("; ")}?`,
			),
			criteria: {
				true: "It uniquely carries at least one of those, so losing it loses that information.",
				false: "It carries none of those, or every one it carries also appears in another observation or reflection.",
			},
		},
		[questionKey(observationId, "redundant")]: {
			type: "bool",
			instructions: about(
				observationId,
				"Is its durable meaning already captured by one of the entries in `reflections` with equivalent fidelity?",
			),
			criteria: {
				true: "A reflection already preserves its durable meaning and important details.",
				false: "No reflection preserves it, or a reflection covers it only partially or with less detail.",
			},
		},
		[questionKey(observationId, "superseded")]: {
			type: "bool",
			instructions: about(
				observationId,
				"Does a later entry in `observations` clearly replace it, making its state obsolete?",
			),
			criteria: {
				true: "A newer observation describes the same thing in a later state, so this one is stale.",
				false: "Nothing newer replaces it, or later entries describe different work.",
			},
		},
		[questionKey(observationId, "lowSignal")]: {
			type: "bool",
			instructions: about(
				observationId,
				"Is it a routine tool acknowledgement or a low-signal progress update that records no decision, constraint, exact error, or user-specific fact?",
			),
			criteria: {
				true: "Routine progress or acknowledgement with nothing a future session would act on.",
				false: "It records a decision, constraint, error, identifier, or user-specific fact.",
			},
		},
		[questionKey(observationId, "safety")]: {
			type: "score",
			instructions: about(observationId, "How safe is it to remove from active compacted memory?"),
			criteria: SAFETY_LEVELS,
		},
	};
}

function answerValue(answer: ClassifierAnswer | undefined): number | undefined {
	if (!answer) return undefined;
	if (answer.type === "bool") return Number.isFinite(answer.probability) ? answer.probability : undefined;
	if (answer.type === "score" && Number.isFinite(answer.score)) {
		// Normalize the rubric level onto [0, 1] so it composes with the bools.
		return answer.score / (SAFETY_LEVELS.length - 1);
	}
	return undefined;
}

/**
 * Collect answers into per-observation signals. Observations with any missing
 * or unusable answer are omitted, so an incomplete response can never produce
 * a drop from partial evidence.
 */
export function collectSignals(answers: Record<string, ClassifierAnswer>): Map<string, ObservationSignals> {
	const partial = new Map<string, Partial<ObservationSignals>>();
	for (const [key, answer] of Object.entries(answers)) {
		const parsed = parseQuestionKey(key);
		if (!parsed) continue;
		const value = answerValue(answer);
		if (value === undefined) continue;
		const signals = partial.get(parsed.observationId) ?? {};
		signals[parsed.signal] = Math.min(1, Math.max(0, value));
		partial.set(parsed.observationId, signals);
	}

	const complete = new Map<string, ObservationSignals>();
	for (const [observationId, signals] of partial) {
		if (SIGNAL_KEYS.every((signal) => signals[signal] !== undefined)) {
			complete.set(observationId, signals as ObservationSignals);
		}
	}
	return complete;
}

/**
 * Drop evidence and the safety rubric multiply rather than average: an
 * observation must both look removable for a concrete reason and be judged
 * safe overall, so one confident signal cannot carry a drop on its own.
 */
export function dropProbability(signals: ObservationSignals): number {
	return Math.max(signals.redundant, signals.superseded, signals.lowSignal) * signals.safety;
}

export type RankedCandidate = {
	id: string;
	dropProbability: number;
	signals: ObservationSignals;
};

export function rankCandidates(
	observations: readonly Observation[],
	signalsById: Map<string, ObservationSignals>,
	vetoThreshold: number,
	dropThreshold: number,
): { candidates: RankedCandidate[]; vetoedCount: number; belowThresholdCount: number; missingSignalsCount: number } {
	const candidates: RankedCandidate[] = [];
	let vetoedCount = 0;
	let belowThresholdCount = 0;
	let missingSignalsCount = 0;

	for (const observation of observations) {
		const signals = signalsById.get(observation.id);
		if (!signals) {
			missingSignalsCount++;
			continue;
		}
		if (signals.floor >= vetoThreshold) {
			vetoedCount++;
			continue;
		}
		const probability = dropProbability(signals);
		if (probability < dropThreshold) {
			belowThresholdCount++;
			continue;
		}
		candidates.push({ id: observation.id, dropProbability: probability, signals });
	}

	candidates.sort((a, b) => b.dropProbability - a.dropProbability);
	return { candidates, vetoedCount, belowThresholdCount, missingSignalsCount };
}
