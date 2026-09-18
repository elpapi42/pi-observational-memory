import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { debugLog } from "../../debug-log.js";
import { hashId } from "../../ids.js";
import { logAgentStreamError } from "../stream-errors.js";
import { resolveWorkerStreamSimple, type StreamableModelRegistry, type WorkerStreamSimple } from "../worker-stream.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { truncateRecordContent } from "../../serialize.js";
import { REFLECTOR_SYSTEM } from "./prompts.js";
import { estimateStringTokens } from "../../tokens.js";
import { reflectionToSummaryLine, type Observation, type Reflection } from "../../session-ledger/index.js";
import {
	coverageTierForObservation,
	reflectionCoverageMap,
	summarizeCoverageByRelevance,
	summarizeCoverageTransitionsByRelevance,
	type ReflectionCoverageTier,
} from "../dropper/coverage.js";

interface RunReflectorArgs {
	model: Model<any>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	reflections: Reflection[];
	observations: Observation[];
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	maxTurns?: number;
	/** Maximum output tokens for the loop (defaults to {@link AGENT_LOOP_MAX_TOKENS}). */
	maxOutputTokens?: number;
	thinkingLevel?: ModelThinkingLevel;
	modelRegistry?: StreamableModelRegistry;
	streamSimple?: WorkerStreamSimple;
}

const RecordReflectionsSchema = Type.Object({
	reflections: Type.Array(
		Type.Object({
			content: Type.String({ minLength: 1 }),
			supportingObservationIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		}),
		{ minItems: 1 },
	),
});

type RecordReflectionsArgs = Static<typeof RecordReflectionsSchema>;

const ValidateSupportingObservationIdsSchema = Type.Object({
	supportingObservationIds: Type.Array(Type.String({ minLength: 1 }), {
		minItems: 1,
		description:
			"Exact active observation ids collected for the next reflection batch. " +
			"Use only ids shown in the current observations list.",
	}),
});

type ValidateSupportingObservationIdsArgs = Static<typeof ValidateSupportingObservationIdsSchema>;

type SupportingObservationIdValidation = {
	canonicalSupportingObservationIds?: string[];
	invalidSupportingObservationIds: string[];
};

type UnresolvedSupportingObservationValidation = {
	invalidCount: number;
	schemaFailure: boolean;
};

export type ReflectorRecordingContractFailureReason =
	| "invalid-supporting-observation-ids"
	| "invalid-reflection-content"
	| "validation-unfinished"
	| "tool-validation";

export class ReflectorRecordingContractError extends Error {
	readonly reason: ReflectorRecordingContractFailureReason;
	constructor(reason: ReflectorRecordingContractFailureReason, message: string) {
		super(message);
		this.name = "ReflectorRecordingContractError";
		this.reason = reason;
	}
}

export class ReflectorStreamError extends Error {
	readonly stopReason: string;
	constructor(stopReason: string, errorMessage?: string) {
		super(`reflector stream ended with stopReason "${stopReason}"${errorMessage ? `: ${errorMessage}` : ""}`);
		this.name = "ReflectorStreamError";
		this.stopReason = stopReason;
	}
}

function joinOrEmpty(items: string[]): string {
	return items.length ? items.join("\n") : "(none yet)";
}

export function observationToReflectorLine(
	observation: Observation,
	coverage: ReflectionCoverageTier,
): string {
	return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] [coverage: ${coverage}] ${observation.content}`;
}

export function summarizeSupportIdCounts(reflections: readonly Reflection[]): {
	reflectionCount: number;
	totalSupportIds: number;
	minSupportIds: number;
	maxSupportIds: number;
	averageSupportIds: number;
	histogram: Record<string, number>;
} {
	if (reflections.length === 0) {
		return { reflectionCount: 0, totalSupportIds: 0, minSupportIds: 0, maxSupportIds: 0, averageSupportIds: 0, histogram: {} };
	}
	const counts = reflections.map((reflection) => reflection.supportingObservationIds.length);
	const totalSupportIds = counts.reduce((sum, count) => sum + count, 0);
	const histogram: Record<string, number> = {};
	for (const count of counts) histogram[String(count)] = (histogram[String(count)] ?? 0) + 1;
	return {
		reflectionCount: reflections.length,
		totalSupportIds,
		minSupportIds: Math.min(...counts),
		maxSupportIds: Math.max(...counts),
		averageSupportIds: totalSupportIds / reflections.length,
		histogram,
	};
}

function validateAndNormalizeSupportingObservationIds(
	supportingObservationIds: readonly string[] | undefined,
	allowedObservationIds: readonly string[],
): SupportingObservationIdValidation {
	if (!supportingObservationIds || supportingObservationIds.length === 0) return { invalidSupportingObservationIds: [] };
	const allowedOrder = new Map<string, number>();
	for (let i = 0; i < allowedObservationIds.length; i++) {
		if (!allowedOrder.has(allowedObservationIds[i])) allowedOrder.set(allowedObservationIds[i], i);
	}

	const seen = new Set<string>();
	const invalidSupportingObservationIds: string[] = [];
	for (const id of supportingObservationIds) {
		if (!allowedOrder.has(id)) invalidSupportingObservationIds.push(id);
		else seen.add(id);
	}
	if (invalidSupportingObservationIds.length > 0 || seen.size === 0) return { invalidSupportingObservationIds };
	return {
		canonicalSupportingObservationIds: Array.from(seen).sort(
			(a, b) => (allowedOrder.get(a) ?? 0) - (allowedOrder.get(b) ?? 0),
		),
		invalidSupportingObservationIds,
	};
}

export function normalizeSupportingObservationIds(
	supportingObservationIds: readonly string[] | undefined,
	allowedObservationIds: readonly string[],
): string[] | undefined {
	return validateAndNormalizeSupportingObservationIds(supportingObservationIds, allowedObservationIds)
		.canonicalSupportingObservationIds;
}

function boundedObservationId(id: string): string {
	return id
		.replace(/\s+/g, " ")
		.replace(/`/g, "'")
		.replace(/[\u0000-\u001f\u007f]/g, "?")
		.slice(0, 64);
}

function invalidSupportingObservationIdFeedback(invalidIds: readonly string[]): string {
	const shown = invalidIds.slice(0, 8).map((id) => `\`${boundedObservationId(id)}\``).join(", ");
	const omitted = invalidIds.length > 8 ? "; showing first 8" : "";
	return `${invalidIds.length} invalid supporting observation ID${invalidIds.length === 1 ? "" : "s"}: ${shown}${omitted}. ` +
		"Use exact ids from the current active observations, correct the IDs, and call validate_supporting_observation_ids again before recording.";
}

function boundedTerminalErrorMessage(errorMessage: string | undefined): string | undefined {
	if (!errorMessage) return undefined;
	return errorMessage.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 512);
}

function validatorToolErrorResult() {
	return {
		content: [{
			type: "text" as const,
			text: "validate_supporting_observation_ids rejected invalid arguments. Use one or more exact ids from the current active observations and revalidate before recording.",
		}],
		details: { valid: false, validationError: true },
	};
}

function recorderToolErrorResult() {
	return {
		content: [{
			type: "text" as const,
			text: "record_reflections rejected invalid arguments. The reflection batch was not recorded. Submit a schema-valid batch using exact active observation ids.",
		}],
		details: { recorded: false, validationError: true },
	};
}

function normalizeReflectionContent(content: string): string | undefined {
	const normalized = truncateRecordContent(content.trim());
	if (!normalized || /\r|\n/.test(normalized)) return undefined;
	return normalized;
}

export async function runReflector(args: RunReflectorArgs): Promise<Reflection[] | undefined> {
	const { model, apiKey, headers, env, reflections, observations, signal } = args;
	if (observations.length === 0) return undefined;

	const coverageById = reflectionCoverageMap(observations, reflections);
	debugLog("reflector.agent_start", {
		activeObservationCount: observations.length,
		reflectionCount: reflections.length,
		coverageSummaryByRelevance: summarizeCoverageByRelevance(observations, coverageById),
	});

	const allowedObservationIds = observations.map((observation) => observation.id);
	const existingReflectionIds = new Set(reflections.map((reflection) => reflection.id));
	const accumulated = new Map<string, Reflection>();
	let toolCallCount = 0;
	let rawProposedReflectionCount = 0;
	let acceptedReflectionCount = 0;
	let duplicateReflectionCount = 0;
	let rejectedReflectionCount = 0;
	let recordingFailure: ReflectorRecordingContractError | undefined;
	let validationAttempted = false;
	let unresolvedValidation: UnresolvedSupportingObservationValidation | undefined;
	let validatedIdsForNextBatch: Set<string> | undefined;
	const handledValidatorToolFailureIds = new Set<string>();
	const markValidatorToolFailure = (toolCallId?: string) => {
		if (toolCallId && handledValidatorToolFailureIds.has(toolCallId)) return;
		if (toolCallId) handledValidatorToolFailureIds.add(toolCallId);
		validationAttempted = true;
		validatedIdsForNextBatch = undefined;
		unresolvedValidation = { invalidCount: 0, schemaFailure: true };
	};

	const recordReflections: AgentTool<typeof RecordReflectionsSchema> = {
		name: "record_reflections",
		label: "Record reflections",
		description:
			"Record new durable reflections after preflighting the intended supporting observation ids. " +
			"Every actual submitted id is independently checked against the current active observations.",
		parameters: RecordReflectionsSchema,
		execute: async (_id, params: RecordReflectionsArgs) => {
			toolCallCount++;
			rawProposedReflectionCount += params.reflections.length;
			let added = 0;
			let duplicates = 0;
			let rejected = 0;
			for (const proposal of params.reflections) {
				const content = normalizeReflectionContent(proposal.content);
				const supportingObservationIds = normalizeSupportingObservationIds(proposal.supportingObservationIds, allowedObservationIds);
				if (!content || !supportingObservationIds) {
					rejected++;
					continue;
				}
				const id = hashId(content);
				if (existingReflectionIds.has(id) || accumulated.has(id)) {
					duplicates++;
					continue;
				}
				accumulated.set(id, {
					id,
					content,
					supportingObservationIds,
					tokenCount: estimateStringTokens(content),
				});
				added++;
			}
			acceptedReflectionCount += added;
			duplicateReflectionCount += duplicates;
			rejectedReflectionCount += rejected;
			if (validationAttempted && added + duplicates > 0) validatedIdsForNextBatch = undefined;
			if (rejected > 0 && !recordingFailure) {
				const hasInvalidContent = params.reflections.some((proposal) => !normalizeReflectionContent(proposal.content));
				recordingFailure = new ReflectorRecordingContractError(
					hasInvalidContent ? "invalid-reflection-content" : "invalid-supporting-observation-ids",
					`record_reflections rejected ${rejected} proposal${rejected === 1 ? "" : "s"}`,
				);
			}
			return {
				content: [{ type: "text", text: `Recorded ${added} reflection${added === 1 ? "" : "s"}; ${duplicates} duplicate${duplicates === 1 ? "" : "s"}; ${rejected} rejected. Total this run: ${accumulated.size}.` }],
				details: { added, duplicates, rejected, total: accumulated.size },
			};
		},
	};

	const validateSupportingObservationIds: AgentTool<typeof ValidateSupportingObservationIdsSchema> = {
		name: "validate_supporting_observation_ids",
		label: "Validate supporting observation IDs",
		description:
			"Check that ids collected for the next reflection batch exactly match current active observation ids. " +
			"This checks membership only, not whether an observation semantically supports a reflection. Correct failures and revalidate before recording.",
		parameters: ValidateSupportingObservationIdsSchema,
		execute: async (_id, params: ValidateSupportingObservationIdsArgs) => {
			validationAttempted = true;
			const validation = validateAndNormalizeSupportingObservationIds(params.supportingObservationIds, allowedObservationIds);
			if (!validation.canonicalSupportingObservationIds) {
				const feedback = invalidSupportingObservationIdFeedback(validation.invalidSupportingObservationIds);
				validatedIdsForNextBatch = undefined;
				unresolvedValidation = {
					invalidCount: validation.invalidSupportingObservationIds.length,
					schemaFailure: false,
				};
				return {
					content: [{ type: "text", text: feedback }],
					details: {
						valid: false,
						submittedCount: params.supportingObservationIds.length,
						invalidCount: validation.invalidSupportingObservationIds.length,
					},
				};
			}
			unresolvedValidation = undefined;
			validatedIdsForNextBatch = new Set(validation.canonicalSupportingObservationIds);
			const count = validation.canonicalSupportingObservationIds.length;
			return {
				content: [{
					type: "text",
					text: `Validated ${count} supporting observation ID${count === 1 ? "" : "s"} against the current active observations. Record the finished reflection batch next.`,
				}],
				details: { valid: true, submittedCount: params.supportingObservationIds.length, canonicalCount: count },
			};
		},
	};

	const userText = `CURRENT REFLECTIONS:\n${joinOrEmpty(reflections.map(reflectionToSummaryLine))}\n\nCURRENT OBSERVATIONS:\n${joinOrEmpty(observations.map((observation) => observationToReflectorLine(observation, coverageTierForObservation(observation, coverageById))))}\n\nCrystallize any missing durable facts or patterns into new reflections. For each intended batch, collect exact supporting observation IDs, call validate_supporting_observation_ids, correct and revalidate any failures, then call record_reflections. The recorder independently validates the actual submitted IDs. If nothing is stable enough, do not call either tool.`;
	const prompts: Message[] = [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }];
	const context: AgentContext = {
		systemPrompt: REFLECTOR_SYSTEM,
		messages: [],
		// Keep the recorder first for compatibility with existing embedded callers and tests.
		tools: [recordReflections as AgentTool<any>, validateSupportingObservationIds as AgentTool<any>],
	};
	const reasoning = (model as { reasoning?: unknown }).reasoning;
	const thinkingLevel = args.thinkingLevel ?? "low";
	const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : undefined;
	let turnCount = 0;
	let turnLimitReached = false;
	const config: AgentLoopConfig = {
		model,
		apiKey,
		headers,
		env,
		maxTokens: boundedMaxTokens(model, args.maxOutputTokens ?? AGENT_LOOP_MAX_TOKENS),
		convertToLlm: (msgs) => msgs.map((message) => {
			const toolResult = message as typeof message & {
				role?: string;
				toolCallId?: string;
				toolName?: string;
				isError?: boolean;
			};
			if (toolResult.role !== "toolResult" || !toolResult.isError) return message;
			if (toolResult.toolName === "record_reflections") return { ...message, ...recorderToolErrorResult() };
			if (toolResult.toolName !== "validate_supporting_observation_ids") return message;
			markValidatorToolFailure(toolResult.toolCallId);
			return { ...message, ...validatorToolErrorResult() };
		}) as Message[],
		toolExecution: "sequential",
		afterToolCall: async ({ toolCall, isError }) => {
			if (toolCall.name !== "validate_supporting_observation_ids" || !isError) return undefined;
			markValidatorToolFailure(toolCall.id);
			return { ...validatorToolErrorResult(), isError: true };
		},
		...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
		...(effectiveMaxTurns !== undefined ? {
			shouldStopAfterTurn: () => {
				turnCount++;
				turnLimitReached = turnCount >= effectiveMaxTurns;
				return turnLimitReached;
			},
		} : {}),
	};

	const loop = args.agentLoop ?? agentLoop;
	const stream = loop(
		prompts,
		context,
		config,
		signal,
		resolveWorkerStreamSimple(model, args.modelRegistry, args.streamSimple),
	);
	let terminalError: { stopReason: "error"; errorMessage?: string } | undefined;
	let terminalAbort: { stopReason: "aborted"; errorMessage?: string } | undefined;
	let terminalLength: { stopReason: "length"; errorMessage?: string } | undefined;
	let latestTerminalStopReason: string | undefined;
	for await (const event of stream) {
		// Tool execution collects records.
		logAgentStreamError("reflector", event);
		const agentEvent = event as {
			type?: string;
			toolCallId?: string;
			toolName?: string;
			isError?: boolean;
			message?: { role?: string; stopReason?: string; errorMessage?: string };
		};
		const message = agentEvent.message;
		if (message?.role === "assistant" && typeof message.stopReason === "string") {
			latestTerminalStopReason = message.stopReason;
			const errorMessage = boundedTerminalErrorMessage(message.errorMessage);
			if (message.stopReason === "error" && !terminalError) terminalError = { stopReason: "error", errorMessage };
			if (message.stopReason === "aborted" && !terminalAbort) terminalAbort = { stopReason: "aborted", errorMessage };
			if (message.stopReason === "length" && !terminalLength) terminalLength = { stopReason: "length", errorMessage };
		}
		if (agentEvent.type === "tool_execution_end" && agentEvent.isError) {
			if (agentEvent.toolName === "record_reflections" && !recordingFailure) {
				recordingFailure = new ReflectorRecordingContractError(
					"tool-validation",
					"record_reflections tool execution failed",
				);
			} else if (agentEvent.toolName === "validate_supporting_observation_ids") {
				markValidatorToolFailure(agentEvent.toolCallId);
			}
		}
	}
	await stream.result();
	const acceptedReflections = Array.from(accumulated.values());
	const afterCoverageById = reflectionCoverageMap(observations, [...reflections, ...acceptedReflections]);
	const streamFailure = terminalError !== undefined || terminalAbort !== undefined || signal?.aborted;
	const turnExhausted = terminalLength !== undefined || (turnLimitReached && latestTerminalStopReason === "toolUse");
	const validationUnfinished = Boolean(
		unresolvedValidation ||
		validatedIdsForNextBatch !== undefined ||
		(validationAttempted && toolCallCount === 0),
	);
	const reason = streamFailure
		? "stream_failed"
		: turnExhausted
			? "turn_exhausted"
			: recordingFailure
				? recordingFailure.reason === "tool-validation" ? "tool_validation_failed" : "recording_contract_failed"
				: validationUnfinished
					? unresolvedValidation?.schemaFailure ? "validator_schema_failed" : "validation_unfinished"
					: acceptedReflections.length > 0
						? "accepted_nonempty"
						: toolCallCount === 0
							? "no_tool_call"
							: "all_filtered";
	debugLog("reflector.result", {
		reason,
		toolCallCount,
		rawProposedReflectionCount,
		acceptedReflectionCount,
		duplicateReflectionCount,
		rejectedReflectionCount,
		acceptedSupportIdCounts: summarizeSupportIdCounts(acceptedReflections),
		coverageTransitionsByRelevance: summarizeCoverageTransitionsByRelevance(observations, coverageById, afterCoverageById),
	});
	if (terminalError) throw new ReflectorStreamError(terminalError.stopReason, terminalError.errorMessage);
	if (terminalAbort || signal?.aborted) {
		throw new ReflectorStreamError("aborted", terminalAbort?.errorMessage);
	}
	if (turnExhausted) {
		throw new ReflectorStreamError(
			terminalLength?.stopReason ?? latestTerminalStopReason ?? "length",
			terminalLength?.errorMessage ?? "reflector exhausted its turn/output allowance",
		);
	}
	if (recordingFailure) throw recordingFailure;
	if (validationUnfinished) {
		throw new ReflectorRecordingContractError(
			"validation-unfinished",
			unresolvedValidation
				? unresolvedValidation.schemaFailure
					? "validate_supporting_observation_ids rejected invalid arguments"
					: `${unresolvedValidation.invalidCount} supporting observation ID${unresolvedValidation.invalidCount === 1 ? "" : "s"} failed exact-membership validation`
				: "supporting observation IDs were validated, but no nonempty accepted reflection call consumed them",
		);
	}
	return acceptedReflections.length > 0 ? acceptedReflections : undefined;
}
