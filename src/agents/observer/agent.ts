import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { hashId } from "../../ids.js";
import { logAgentStreamError } from "../stream-errors.js";
import { resolveWorkerStreamSimple, type StreamableModelRegistry, type WorkerStreamSimple } from "../worker-stream.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { OBSERVER_SYSTEM } from "./prompts.js";
import { nowTimestamp, truncateRecordContent } from "../../serialize.js";
import type { Observation, Relevance } from "../../session-ledger/index.js";
import { observationLineTokenCount } from "../../tokens.js";

export interface RunObserverArgs {
	model: Model<any>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	priorReflections: string[];
	priorObservations: string[];
	chunk: string;
	allowedSourceEntryIds: string[];
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	maxTurns?: number;
	/** Maximum output tokens for the loop (defaults to {@link AGENT_LOOP_MAX_TOKENS}). */
	maxOutputTokens?: number;
	thinkingLevel?: ModelThinkingLevel;
	modelRegistry?: StreamableModelRegistry;
	streamSimple?: WorkerStreamSimple;
}

const RelevanceSchema = Type.Union([
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("critical"),
]);

export const OBSERVATION_TIMESTAMP_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$";

const RecordObservationsSchema = Type.Object({
	observations: Type.Array(
		Type.Object({
			timestamp: Type.String({
				pattern: OBSERVATION_TIMESTAMP_PATTERN,
				description: "Observation time in local 'YYYY-MM-DD HH:MM' format.",
			}),
			content: Type.String({
				minLength: 1,
				description: "Single-line plain prose. No markdown, no tags, no embedded timestamp.",
			}),
			relevance: RelevanceSchema,
			sourceEntryIds: Type.Array(
				Type.String({ minLength: 1 }),
				{
					minItems: 1,
					description:
						"Exact source entry ids from the chunk that directly support this observation. " +
						"Use only ids shown in '[Source entry id: ...]' labels; never invent ids.",
				},
			),
		}),
		{ description: "Batch of new observations. May be empty only if the tool is not called at all." },
	),
});

type RecordObservationsArgs = Static<typeof RecordObservationsSchema>;

const ValidateSourceEntryIdsSchema = Type.Object({
	sourceEntryIds: Type.Array(Type.String({ minLength: 1 }), {
		minItems: 1,
		description:
			"Exact source entry ids collected for the next observation batch. " +
			"Use only ids shown in '[Source entry id: ...]' labels.",
	}),
});

type ValidateSourceEntryIdsArgs = Static<typeof ValidateSourceEntryIdsSchema>;

type SourceEntryIdValidation = {
	canonicalSourceEntryIds?: string[];
	invalidSourceEntryIds: string[];
};

type UnresolvedSourceValidation = {
	invalidCount: number;
	schemaFailure: boolean;
};

/**
 * Compatibility error for callers of runObserver. Detailed outcomes are
 * available through runObserverWithOutcome without exposing partial results
 * to existing publication paths.
 */
export class ObserverStreamError extends Error {
	readonly stopReason: string;
	constructor(stopReason: string, errorMessage?: string) {
		super(`observer stream ended with stopReason "${stopReason}"${errorMessage ? `: ${errorMessage}` : ""}`);
		this.name = "ObserverStreamError";
		this.stopReason = stopReason;
	}
}

function joinOrEmpty(items: string[]): string {
	return items.length ? items.join("\n") : "(none yet)";
}

function validateAndNormalizeSourceEntryIds(
	sourceEntryIds: readonly string[] | undefined,
	allowedSourceEntryIds: readonly string[],
): SourceEntryIdValidation {
	if (!sourceEntryIds || sourceEntryIds.length === 0) return { invalidSourceEntryIds: [] };
	const allowedOrder = new Map<string, number>();
	for (let i = 0; i < allowedSourceEntryIds.length; i++) allowedOrder.set(allowedSourceEntryIds[i], i);

	const seen = new Set<string>();
	const invalidSourceEntryIds: string[] = [];
	for (const id of sourceEntryIds) {
		if (!allowedOrder.has(id)) invalidSourceEntryIds.push(id);
		else seen.add(id);
	}
	if (invalidSourceEntryIds.length > 0 || seen.size === 0) return { invalidSourceEntryIds };
	return {
		canonicalSourceEntryIds: Array.from(seen).sort(
			(a, b) => (allowedOrder.get(a) ?? 0) - (allowedOrder.get(b) ?? 0),
		),
		invalidSourceEntryIds,
	};
}

export function normalizeSourceEntryIds(
	sourceEntryIds: readonly string[] | undefined,
	allowedSourceEntryIds: readonly string[],
): string[] | undefined {
	return validateAndNormalizeSourceEntryIds(sourceEntryIds, allowedSourceEntryIds).canonicalSourceEntryIds;
}

function boundedSourceEntryId(id: string): string {
	return id
		.replace(/\s+/g, " ")
		.replace(/`/g, "'")
		.replace(/[\u0000-\u001f\u007f]/g, "?")
		.slice(0, 64);
}

function invalidSourceEntryIdFeedback(invalidSourceEntryIds: readonly string[]): string {
	const shown = invalidSourceEntryIds.slice(0, 8).map((id) => `\`${boundedSourceEntryId(id)}\``).join(", ");
	const omitted = invalidSourceEntryIds.length > 8 ? `; showing first 8` : "";
	return `${invalidSourceEntryIds.length} invalid source entry ID${invalidSourceEntryIds.length === 1 ? "" : "s"}: ${shown}${omitted}. ` +
		"Use exact labels from the current conversation chunk, correct the IDs, and call validate_source_entry_ids again before recording.";
}

function boundedTerminalErrorMessage(errorMessage: string | undefined): string | undefined {
	if (!errorMessage) return undefined;
	return errorMessage.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 512);
}

function validatorToolErrorResult() {
	return {
		content: [{
			type: "text" as const,
			text: "validate_source_entry_ids rejected invalid arguments. Use one or more exact source labels from the current chunk and revalidate before recording.",
		}],
		details: { valid: false, validationError: true },
	};
}

function recorderToolErrorResult() {
	return {
		content: [{
			type: "text" as const,
			text: "record_observations rejected invalid arguments. The observation batch was not recorded. Submit a schema-valid batch using exact source labels from the current chunk.",
		}],
		details: { recorded: false, validationError: true },
	};
}

export type RecordingContractFailureReason = "invalid-source-entry-ids" | "tool-validation";

export type ObserverRunOutcome =
	| { status: "complete"; observations: Observation[] }
	| { status: "clean-empty"; observations: [] }
	| { status: "failed"; observations: Observation[]; stopReason: string; failureKind: "recording-contract"; recordingContractReason: RecordingContractFailureReason; error?: string }
	| { status: "failed"; observations: Observation[]; stopReason: string; failureKind: "stream"; error?: string }
	| { status: "aborted"; observations: Observation[]; stopReason: string; error?: string }
	| { status: "turn-exhausted"; observations: Observation[]; stopReason: string; error?: string };

export async function runObserverWithOutcome(args: RunObserverArgs): Promise<ObserverRunOutcome> {
	const { model, apiKey, headers, env, priorReflections, priorObservations, chunk, allowedSourceEntryIds, signal } = args;
	const conversation = chunk.trim();
	if (!conversation) return { status: "clean-empty", observations: [] };

	const accumulated = new Map<string, Observation>();
	let recordingFailure: string | undefined;
	let recordingContractReason: RecordingContractFailureReason | undefined;
	let sourceValidationAttempted = false;
	let unresolvedSourceValidation: UnresolvedSourceValidation | undefined;
	let validatedSourceEntryIdsForNextBatch: Set<string> | undefined;
	const handledValidatorToolFailureIds = new Set<string>();
	const markValidatorToolFailure = (toolCallId?: string) => {
		if (toolCallId && handledValidatorToolFailureIds.has(toolCallId)) return;
		if (toolCallId) handledValidatorToolFailureIds.add(toolCallId);
		sourceValidationAttempted = true;
		validatedSourceEntryIdsForNextBatch = undefined;
		unresolvedSourceValidation = { invalidCount: 0, schemaFailure: true };
	};

	const recordObservations: AgentTool<typeof RecordObservationsSchema> = {
		name: "record_observations",
		label: "Record observations",
		description:
			"Record a batch of new observations distilled from the conversation chunk after preflighting its intended source IDs. " +
			"Every actual submitted ID is independently checked against the current chunk. Validate each new batch before calling this again. Stop calling when coverage is complete, " +
			"then emit a short plain-text confirmation to end the run.",
		parameters: RecordObservationsSchema,
		execute: async (_id, params: RecordObservationsArgs) => {
			let added = 0;
			let duplicates = 0;
			let rejected = 0;
			for (const obs of params.observations) {
				const sourceEntryIds = normalizeSourceEntryIds(obs.sourceEntryIds, allowedSourceEntryIds);
				if (!sourceEntryIds) {
					rejected++;
					continue;
				}
				const content = truncateRecordContent(obs.content);
				const id = hashId(content);
				if (accumulated.has(id)) {
					duplicates++;
					continue;
				}
				accumulated.set(id, {
					id,
					content,
					timestamp: obs.timestamp,
					relevance: obs.relevance as Relevance,
					sourceEntryIds,
					tokenCount: observationLineTokenCount({
						id,
						timestamp: obs.timestamp,
						relevance: obs.relevance,
						content,
					}),
				});
				added++;
			}
			if (sourceValidationAttempted && added + duplicates > 0) validatedSourceEntryIdsForNextBatch = undefined;
			if (rejected > 0) {
				recordingFailure = `record_observations rejected ${rejected} record${rejected === 1 ? "" : "s"} with missing or invalid sourceEntryIds`;
				recordingContractReason = "invalid-source-entry-ids";
			}
			const rejectedPart = rejected > 0
				? ` ${rejected} observation${rejected === 1 ? "" : "s"} rejected for missing or invalid sourceEntryIds.`
				: "";
			const ack =
				`Recorded ${added} new observation${added === 1 ? "" : "s"} ` +
				(duplicates > 0 ? `(${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped).` : ".") +
				rejectedPart +
				` Total so far this run: ${accumulated.size}. ` +
				`Continue if the chunk still has uncovered content; otherwise stop calling the tool and emit a short plain-text confirmation.`;
			return { content: [{ type: "text", text: ack }], details: { added, duplicates, rejected, total: accumulated.size } };
		},
	};

	const validateSourceEntryIds: AgentTool<typeof ValidateSourceEntryIdsSchema> = {
		name: "validate_source_entry_ids",
		label: "Validate source entry IDs",
		description:
			"Check that the source entry IDs collected for the next observation batch exactly match labels in the current chunk. " +
			"This checks membership only, not whether the cited sources support an observation. Correct failures and revalidate before recording.",
		parameters: ValidateSourceEntryIdsSchema,
		execute: async (_id, params: ValidateSourceEntryIdsArgs) => {
			sourceValidationAttempted = true;
			const validation = validateAndNormalizeSourceEntryIds(params.sourceEntryIds, allowedSourceEntryIds);
			if (!validation.canonicalSourceEntryIds) {
				const feedback = invalidSourceEntryIdFeedback(validation.invalidSourceEntryIds);
				validatedSourceEntryIdsForNextBatch = undefined;
				unresolvedSourceValidation = {
					invalidCount: validation.invalidSourceEntryIds.length,
					schemaFailure: false,
				};
				return {
					content: [{ type: "text", text: feedback }],
					details: {
						valid: false,
						submittedCount: params.sourceEntryIds.length,
						invalidCount: validation.invalidSourceEntryIds.length,
					},
				};
			}
			unresolvedSourceValidation = undefined;
			validatedSourceEntryIdsForNextBatch = new Set(validation.canonicalSourceEntryIds);
			const count = validation.canonicalSourceEntryIds.length;
			return {
				content: [{
					type: "text",
					text: `Validated ${count} source entry ID${count === 1 ? "" : "s"} against the current chunk. The recorder independently checks the actual current-chunk IDs; they may differ from this preflight.`,
				}],
				details: { valid: true, submittedCount: params.sourceEntryIds.length, canonicalCount: count },
			};
		},
	};

	const now = nowTimestamp();
	const userText = `Current local time: ${now}

CURRENT REFLECTIONS:
${joinOrEmpty(priorReflections)}

CURRENT OBSERVATIONS:
${joinOrEmpty(priorObservations)}

Compress the following new conversation chunk into observations. For each intended batch, collect exact supporting source IDs, call validate_source_entry_ids, and correct and revalidate any failures. Then call record_observations with the exact current-chunk IDs supporting the finished observations; the recorder independently validates every actual submitted ID. Do not restate facts already present in current reflections or current observations. Prefer inline conversation timestamps when assigning times; fall back to the current local time above only if no message timestamp applies. Stop calling the tools and reply with a short plain-text confirmation once the chunk is fully covered.

NEW CONVERSATION CHUNK:
${conversation}`;

	const prompts: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: userText }],
			timestamp: Date.now(),
		},
	];

	const context: AgentContext = {
		systemPrompt: OBSERVER_SYSTEM,
		messages: [],
		// Keep the recorder first for compatibility with existing embedded callers and tests.
		tools: [recordObservations as AgentTool<any>, validateSourceEntryIds as AgentTool<any>],
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
			if (toolResult.toolName === "record_observations") return { ...message, ...recorderToolErrorResult() };
			if (toolResult.toolName !== "validate_source_entry_ids") return message;
			markValidatorToolFailure(toolResult.toolCallId);
			return { ...message, ...validatorToolErrorResult() };
		}) as Message[],
		toolExecution: "sequential",
		afterToolCall: async ({ toolCall, isError }) => {
			if (toolCall.name !== "validate_source_entry_ids" || !isError) return undefined;
			markValidatorToolFailure(toolCall.id);
			return { ...validatorToolErrorResult(), isError: true };
		},
		...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
		...(effectiveMaxTurns !== undefined
			? {
				shouldStopAfterTurn: () => {
					turnCount++;
					turnLimitReached = turnCount >= effectiveMaxTurns;
					return turnLimitReached;
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
	let terminalError: { stopReason: "error"; errorMessage?: string } | undefined;
	let terminalAbort: { stopReason: "aborted"; errorMessage?: string } | undefined;
	let terminalLength: { stopReason: "length"; errorMessage?: string } | undefined;
	let latestTerminalStopReason: string | undefined;
	for await (const event of stream) {
		// Drain events; the tool's execute already collects records.
		logAgentStreamError("observer", event);
		// Watch for a terminal API/stream failure so it is not conflated with
		// a deliberate empty result.
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
			if (agentEvent.toolName === "record_observations") {
				recordingFailure = "record_observations tool execution failed";
				recordingContractReason = "tool-validation";
			} else if (agentEvent.toolName === "validate_source_entry_ids") {
				markValidatorToolFailure(agentEvent.toolCallId);
			}
		}
	}
	await stream.result();

	const observations = Array.from(accumulated.values());
	if (terminalError) {
		return { status: "failed", observations, stopReason: terminalError.stopReason, failureKind: "stream", error: terminalError.errorMessage };
	}
	if (terminalAbort || signal?.aborted) {
		return { status: "aborted", observations, stopReason: "aborted", error: terminalAbort?.errorMessage };
	}
	if (terminalLength || (turnLimitReached && latestTerminalStopReason === "toolUse")) {
		return {
			status: "turn-exhausted",
			observations,
			stopReason: terminalLength?.stopReason ?? latestTerminalStopReason ?? "length",
			error: terminalLength?.errorMessage,
		};
	}
	if (recordingFailure && recordingContractReason) {
		return { status: "failed", observations, stopReason: "recording_failed", failureKind: "recording-contract", recordingContractReason, error: recordingFailure };
	}
	if (
		unresolvedSourceValidation ||
		validatedSourceEntryIdsForNextBatch !== undefined ||
		(sourceValidationAttempted && observations.length === 0)
	) {
		return {
			status: "failed",
			observations,
			stopReason: "recording_failed",
			failureKind: "recording-contract",
			recordingContractReason: "invalid-source-entry-ids",
			error: unresolvedSourceValidation
				? unresolvedSourceValidation.schemaFailure
					? "validate_source_entry_ids rejected invalid arguments"
					: `${unresolvedSourceValidation.invalidCount} source entry ID${unresolvedSourceValidation.invalidCount === 1 ? "" : "s"} failed exact-membership validation`
				: "source entry IDs were validated, but no observation batch was recorded",
		};
	}
	return observations.length > 0
		? { status: "complete", observations }
		: { status: "clean-empty", observations: [] };
}

export async function runObserver(args: RunObserverArgs): Promise<Observation[] | undefined> {
	const outcome = await runObserverWithOutcome(args);
	if (outcome.status === "complete") return outcome.observations;
	if (outcome.status === "clean-empty") return undefined;
	throw new ObserverStreamError(outcome.stopReason, outcome.error);
}
