import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import type { TomConfig } from "./config.js";

export interface TriggerState {
	lastToolCallAt: number;
	inFlight: boolean;
}

export function newTriggerState(): TriggerState {
	return { lastToolCallAt: 0, inFlight: false };
}

export function shouldFire(rawTokens: number, cfg: TomConfig, state: TriggerState, now: number): boolean {
	if (state.inFlight) return false;
	if (rawTokens <= cfg.T) return false;
	if (now - state.lastToolCallAt < cfg.debounceMs) return false;
	return true;
}

export function sumMessageTokens(messages: AgentMessage[]): number {
	let total = 0;
	for (const msg of messages) {
		total += estimateTokens(msg);
	}
	return total;
}

export interface ChunkSelection {
	chunk: AgentMessage[];
	firstKeptIndex: number;
}

export function selectChunk(messagesToSummarize: AgentMessage[], cfg: TomConfig): ChunkSelection {
	const B = cfg.T - cfg.S;
	if (messagesToSummarize.length === 0) {
		return { chunk: [], firstKeptIndex: 0 };
	}
	const chunk: AgentMessage[] = [];
	let accumulated = 0;
	let idx = 0;
	for (; idx < messagesToSummarize.length; idx++) {
		const t = estimateTokens(messagesToSummarize[idx]);
		if (accumulated + t > B && chunk.length > 0) break;
		chunk.push(messagesToSummarize[idx]);
		accumulated += t;
	}
	return { chunk, firstKeptIndex: idx };
}
