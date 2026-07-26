import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { debugLog } from "../debug-log.js";

export interface LlmStreamError {
	stopReason: "error" | "aborted";
	errorMessage?: string;
}

/**
 * Provider failures worth retrying after a short delay: transient capacity or
 * connectivity problems, not request defects. Mirrors the spirit of Pi's own
 * retryable-error detection for the main agent (see compaction-trigger.ts).
 */
const TRANSIENT_LLM_ERROR_RE =
	/overloaded|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|no available accounts|network.?error|connection.?(error|refused|lost|reset)|fetch failed|socket hang up|upstream.?connect|reset before headers|other side closed|ended without|timed? out|timeout|terminated/i;

export function isTransientLlmError(error: LlmStreamError): boolean {
	return error.stopReason === "error" && typeof error.errorMessage === "string" && TRANSIENT_LLM_ERROR_RE.test(error.errorMessage);
}

/**
 * Surface LLM failures from an agent-loop event stream.
 *
 * When the underlying LLM call fails, the loop ends the stream with a final
 * assistant message whose stopReason is "error" (or "aborted") — no exception
 * is thrown. Without this hook the drain loops treat such runs exactly like
 * "the model chose not to call the tool", which hides the real cause
 * (rate limits, oversized prompts, auth failures, ...) from the debug log.
 */
export function logAgentStreamError(stage: "observer" | "reflector" | "dropper", event: AgentEvent): LlmStreamError | undefined {
	if (event.type !== "message_end") return undefined;
	const message = event.message;
	if (message.role !== "assistant") return undefined;
	if (message.stopReason !== "error" && message.stopReason !== "aborted") return undefined;
	debugLog(`${stage}.stream_error`, {
		stopReason: message.stopReason,
		errorMessage: message.errorMessage,
	});
	return { stopReason: message.stopReason, errorMessage: message.errorMessage };
}
