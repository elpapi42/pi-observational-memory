import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

/** Certifies the submitted input after a clean final batch, retaining every accepted record. */
export interface CompletedWorkerOutcome<T> {
	kind: "completed";
	records: [T, ...T[]];
}

/** Certifies an explicit completed review that accepted no new records. */
export interface NothingNewWorkerOutcome {
	kind: "nothing-new";
}

/** Retains accepted records without certifying the submitted input. */
export interface IncompleteWorkerOutcome<T> {
	kind: "incomplete";
	records: T[];
}

/** Preserves accepted records after a stream failure without triggering immediate replay. */
export interface FailedWorkerOutcome<T> {
	kind: "failed";
	records: [T, ...T[]];
	error: Error;
}

/** Separates record validity from completed input coverage for both memory workers. */
export type WorkerOutcome<T> =
	| CompletedWorkerOutcome<T>
	| NothingNewWorkerOutcome
	| IncompleteWorkerOutcome<T>
	| FailedWorkerOutcome<T>;

const ASSISTANT_TURN_SCHEMA = Type.Object({
	role: Type.Literal("assistant"),
	stopReason: Type.String(),
	content: Type.Array(Type.Unknown()),
});

const TOOL_CALL_SCHEMA = Type.Object({
	type: Type.Literal("toolCall"),
	id: Type.String(),
	name: Type.String(),
});

const TOOL_CALL_BLOCK_SCHEMA = Type.Object({
	type: Type.Literal("toolCall"),
});

const FINALIZED_TOOL_RESULT_SCHEMA = Type.Object({
	terminate: Type.Optional(Type.Boolean()),
});

type AssistantTurn = Static<typeof ASSISTANT_TURN_SCHEMA>;
type ToolCall = Static<typeof TOOL_CALL_SCHEMA>;
interface FinalizedToolCallResult {
	toolName: string;
	isError: boolean;
	terminates: boolean;
}

/** Tracks whether the final Pi assistant tool batch fully completed a worker review. */
export class WorkerCompletionTracker {
	private readonly expectedToolName: string;
	private readonly finalizedResults = new Map<string, FinalizedToolCallResult>();
	private invalidTurn = false;
	private finalTurnCompleted = false;
	private agentEnded = false;

	constructor(expectedToolName: string) {
		this.expectedToolName = expectedToolName;
	}

	/** Consumes one Pi agent event and updates final-batch completion. */
	observe(event: AgentEvent): void {
		switch (event.type) {
			case "turn_start": {
				this.resetTurn();
				this.finalTurnCompleted = false;
				this.agentEnded = false;
				return;
			}
			case "tool_execution_end": {
				this.recordFinalizedResult(event);
				return;
			}
			case "turn_end": {
				this.finalTurnCompleted = this.isCompleteTurn(event.message);
				this.resetTurn();
				return;
			}
			case "agent_end": {
				this.agentEnded = true;
				return;
			}
			default: {
				return;
			}
		}
	}

	/** Requires a completed final batch followed by agent_end; callers must also await stream.result(). */
	isComplete(): boolean {
		return this.finalTurnCompleted && this.agentEnded;
	}

	private recordFinalizedResult(event: Extract<AgentEvent, { type: "tool_execution_end" }>): void {
		if (this.finalizedResults.has(event.toolCallId)) {
			this.invalidTurn = true;
			return;
		}
		if (!Value.Check(FINALIZED_TOOL_RESULT_SCHEMA, event.result)) {
			this.invalidTurn = true;
			return;
		}
		this.finalizedResults.set(event.toolCallId, {
			toolName: event.toolName,
			isError: event.isError,
			terminates: event.result.terminate === true,
		});
	}

	private isCompleteTurn(message: AgentMessage): boolean {
		if (this.invalidTurn || !Value.Check(ASSISTANT_TURN_SCHEMA, message)) {
			return false;
		}
		const assistantTurn: AssistantTurn = message;
		if (assistantTurn.stopReason !== "toolUse" && assistantTurn.stopReason !== "stop") {
			return false;
		}

		const toolCalls: ToolCall[] = [];
		for (const content of assistantTurn.content) {
			if (Value.Check(TOOL_CALL_SCHEMA, content)) {
				toolCalls.push(content);
				continue;
			}
			if (Value.Check(TOOL_CALL_BLOCK_SCHEMA, content)) {
				return false;
			}
		}
		if (toolCalls.length === 0 || this.finalizedResults.size !== toolCalls.length) {
			return false;
		}

		const callIds = new Set<string>();
		for (const toolCall of toolCalls) {
			if (toolCall.name !== this.expectedToolName || callIds.has(toolCall.id)) {
				return false;
			}
			callIds.add(toolCall.id);
			const result = this.finalizedResults.get(toolCall.id);
			if (!result || result.toolName !== toolCall.name || result.isError || !result.terminates) {
				return false;
			}
		}
		return true;
	}

	private resetTurn(): void {
		this.finalizedResults.clear();
		this.invalidTurn = false;
	}
}

/** Builds a completed outcome when a worker accepted at least one record. */
export function completedWorkerOutcome<T>(records: T[]): WorkerOutcome<T> {
	const [first, ...rest] = records;
	return first === undefined ? { kind: "nothing-new" } : { kind: "completed", records: [first, ...rest] };
}

/** Builds an unfinished outcome with every accepted record retained. */
export function incompleteWorkerOutcome<T>(records: T[]): IncompleteWorkerOutcome<T> {
	return { kind: "incomplete", records };
}

/** Builds a failure outcome only when the worker already accepted records. */
export function failedWorkerOutcome<T>(records: T[], error: Error): FailedWorkerOutcome<T> | undefined {
	const [first, ...rest] = records;
	return first === undefined ? undefined : { kind: "failed", records: [first, ...rest], error };
}
