import { createHash } from "node:crypto";

/** Worker stages that build their own prompt prefix. */
export type WorkerCacheStage = "observer" | "reflector" | "dropper";

/**
 * OpenAI's `prompt_cache_key` limit. pi-ai truncates longer keys from the tail
 * (`clampOpenAIPromptCacheKey`), which would cut off the part that distinguishes
 * one session from another, so keys that would overflow are hashed instead.
 */
const MAX_CACHE_KEY_LENGTH = 64;

type SessionIdSource = {
	sessionManager?: { getSessionId?: () => string | undefined };
};

/**
 * Read the session id for cache keys.
 *
 * Pi's stale-context guard can make `getSessionId` throw after a session
 * replacement, and memory workers must keep working without a key, so this
 * never propagates a failure.
 */
export function sessionCacheId(ctx: SessionIdSource | undefined): string | undefined {
	try {
		return ctx?.sessionManager?.getSessionId?.();
	} catch {
		return undefined;
	}
}

/**
 * Provider-neutral cache key for one memory-worker stage.
 *
 * The value is handed to `streamSimple` as `sessionId`, which pi-ai uses for
 * session-aware caching and routing: OpenAI-compatible adapters send it as
 * `prompt_cache_key` (OpenAI, Responses, Codex, Azure, Mistral), and
 * Anthropic/OpenRouter-style adapters send it as session-affinity headers.
 *
 * Why per stage: observer, reflector, and dropper build structurally different
 * prompts, so a single key would group unrelated prefixes under one routing
 * hint. Each stage keeps a stable key for the whole session, which is what the
 * providers use to route repeated prefixes of that stage back to the same
 * backend.
 *
 * Returns `undefined` when the session has no id, preserving the previous
 * behavior of sending no key at all.
 */
export function workerCacheKey(stage: WorkerCacheStage, sessionId: string | undefined): string | undefined {
	const trimmed = sessionId?.trim();
	if (!trimmed) return undefined;
	const prefix = `om:${stage}:`;
	if (prefix.length + trimmed.length <= MAX_CACHE_KEY_LENGTH) return prefix + trimmed;
	const digest = createHash("sha256").update(trimmed).digest("hex");
	return prefix + digest.slice(0, MAX_CACHE_KEY_LENGTH - prefix.length);
}
