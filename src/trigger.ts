import type { AgentMessage } from "@mariozechner/pi-agent-core";
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
