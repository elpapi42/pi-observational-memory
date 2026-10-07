import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import {
	completedWorkerOutcome,
	failedWorkerOutcome,
	incompleteWorkerOutcome,
	WorkerCompletionTracker,
	type WorkerOutcome,
} from "../worker-completion.js";
import { hashId } from "../../ids.js";
import { logAgentStreamError } from "../stream-errors.js";
import { resolveWorkerStreamSimple, type StreamableModelRegistry, type WorkerStreamSimple } from "../worker-stream.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { OBSERVER_SYSTEM } from "./prompts.js";
import { nowTimestamp, truncateRecordContent } from "../../serialize.js";
import type { Observation, Relevance } from "../../session-ledger/index.js";
import { observationLineTokenCount } from "../../tokens.js";

interface RunObserverArgs {
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

const OBSERVATION_PROPOSAL_SCHEMA = Type.Object({
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
});

const RecordObservationsSchema = Type.Object({
	observations: Type.Array(OBSERVATION_PROPOSAL_SCHEMA),
	complete: Type.Boolean(),
});

type RecordObservationsArgs = Static<typeof RecordObservationsSchema>;

/**
 * Thrown when the agent loop ends with an API/stream failure (`stopReason`
 * `"error"`/`"aborted"`) without recording anything. agent-core returns such
 * runs normally, so without this the caller cannot tell a hard failure from a
 * deliberate empty result (#32).
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

export function normalizeSourceEntryIds(
	sourceEntryIds: readonly string[] | undefined,
	allowedSourceEntryIds: readonly string[],
): string[] | undefined {
	if (!sourceEntryIds || sourceEntryIds.length === 0) return undefined;
	const allowedOrder = new Map<string, number>();
	for (let i = 0; i < allowedSourceEntryIds.length; i++) allowedOrder.set(allowedSourceEntryIds[i], i);

	const seen = new Set<string>();
	for (const id of sourceEntryIds) {
		if (!allowedOrder.has(id)) return undefined;
		seen.add(id);
	}
	if (seen.size === 0) return undefined;
	return Array.from(seen).sort((a, b) => (allowedOrder.get(a) ?? 0) - (allowedOrder.get(b) ?? 0));
}

/** Returns tool-certified completion or partial observations; throws stream failures before any record was accepted. */
export async function runObserver(args: RunObserverArgs): Promise<WorkerOutcome<Observation>> {
	const { model, apiKey, headers, env, priorReflections, priorObservations, chunk, allowedSourceEntryIds, signal } = args;
	const conversation = chunk.trim();
	if (!conversation) {
		return incompleteWorkerOutcome([]);
	}

	const accumulated = new Map<string, Observation>();

	const recordObservations: AgentTool<typeof RecordObservationsSchema> = {
		name: "record_observations",
		label: "Record observations",
		description:
			"Record observations distilled from the conversation chunk. " +
			"Use an empty complete=true batch when the fully reviewed chunk has nothing new. " +
			"Use complete=false for partial batches or corrections.",
		parameters: RecordObservationsSchema,
		execute: async (_id, params: RecordObservationsArgs) => {
			if (!params.complete && params.observations.length === 0) {
				return {
					content: [{ type: "text", text: "Incomplete batches need at least one observation. Use complete=true for an intentional no-new verdict after reviewing the full chunk." }],
					details: { added: 0, duplicates: 0, rejected: 1, total: accumulated.size },
					terminate: false,
				};
			}
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
			const rejectedPart = rejected > 0
				? ` ${rejected} observation${rejected === 1 ? "" : "s"} rejected for missing or invalid sourceEntryIds.`
				: "";
			const ack =
				`Recorded ${added} new observation${added === 1 ? "" : "s"} ` +
				(duplicates > 0 ? `(${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped).` : ".") +
				rejectedPart +
				` Total so far this run: ${accumulated.size}. ` +
				`Continue with complete=false while content remains or corrections are needed; use complete=true on the final valid batch.`;
			return {
				content: [{ type: "text", text: ack }],
				details: { added, duplicates, rejected, total: accumulated.size },
				terminate: params.complete && rejected === 0,
			};
		},
	};

	const now = nowTimestamp();
	const userText = `Current local time: ${now}

CURRENT REFLECTIONS:
${joinOrEmpty(priorReflections)}

CURRENT OBSERVATIONS:
${joinOrEmpty(priorObservations)}

Compress the following new conversation chunk into observations by calling record_observations one or more times. Use complete=false for partial batches or corrections. Use complete=true only on the final valid batch after the chunk is fully covered. If the fully reviewed chunk has nothing new, call record_observations with observations:[] and complete:true. Plain text without that explicit completion call leaves the chunk unfinished. Do not restate facts already present in current reflections or current observations. Prefer inline conversation timestamps when assigning times; fall back to the current local time above only if no message timestamp applies.

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
		messages: [{ role: "system", content: OBSERVER_SYSTEM, timestamp: Date.now() }],
		tools: [recordObservations as AgentTool<any>],
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
					turnCount++;
					return turnCount >= effectiveMaxTurns ? { action: "end" } : undefined;
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
	const completion = new WorkerCompletionTracker("record_observations");
	let streamError: { stopReason: string; errorMessage?: string } | undefined;
	try {
		for await (const event of stream) {
			completion.observe(event);
			logAgentStreamError("observer", event);
			if (event.type === "message_end" && event.message.role === "assistant") {
				if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
					streamError = { stopReason: event.message.stopReason, errorMessage: event.message.errorMessage };
				}
			}
		}
		await stream.result();
	} catch (error) {
		const failure = error instanceof Error ? error : new Error(`Observer worker stream failed: ${String(error)}`);
		const failedOutcome = failedWorkerOutcome(Array.from(accumulated.values()), failure);
		if (failedOutcome) {
			return failedOutcome;
		}
		throw failure;
	}

	if (streamError) {
		const failure = new ObserverStreamError(streamError.stopReason, streamError.errorMessage);
		const failedOutcome = failedWorkerOutcome(Array.from(accumulated.values()), failure);
		if (failedOutcome) {
			return failedOutcome;
		}
		throw failure;
	}

	const records = Array.from(accumulated.values());
	return completion.isComplete() ? completedWorkerOutcome(records) : incompleteWorkerOutcome(records);
}
