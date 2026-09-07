/**
 * Session headers for OpenCode-backed models.
 *
 * OpenCode Go requires every request to carry a stable session id in
 * `x-opencode-session` (400 `MissingSessionID` without it). Mirrors pi's own
 * `getSessionHeaders` (`mergeProviderAttributionHeaders` in pi's
 * `provider-attribution.js`): provider `opencode`/`opencode-go`, or any model
 * whose `baseUrl` points at the `opencode.ai` host.
 */
const OPENCODE_HOST = "opencode.ai";

function matchesOpenCodeHost(baseUrl: unknown): boolean {
	try {
		return typeof baseUrl === "string" && new URL(baseUrl).hostname === OPENCODE_HOST;
	} catch {
		return false;
	}
}

export function isOpenCodeModel(model: unknown): boolean {
	if (!model || typeof model !== "object") return false;
	const { provider, baseUrl } = model as { provider?: unknown; baseUrl?: unknown };
	if (provider === "opencode" || provider === "opencode-go") return true;
	return matchesOpenCodeHost(baseUrl);
}

/**
 * Headers routing an OpenCode request to its conversation, or `undefined` when
 * the model is not OpenCode-backed or no session id is available. The caller
 * merges these under (never over) the resolved auth headers.
 */
export function getOpenCodeSessionHeaders(
	model: unknown,
	sessionId: string | undefined,
): Record<string, string> | undefined {
	if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
	if (!isOpenCodeModel(model)) return undefined;
	return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}
