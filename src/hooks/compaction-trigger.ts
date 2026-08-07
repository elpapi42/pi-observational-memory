import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveCompactAfterTokens } from "../config.js";
import { rawTokensSinceLastCompaction, type Entry } from "../session-ledger/index.js";
import type { Runtime } from "../runtime.js";

/**
 * Regex matching Pi's internal retryable error detection.
 * When the last assistant message in agent_end has stopReason "error" matching this pattern,
 * Pi will auto-retry — we must not trigger compaction between attempts.
 */
const RETRYABLE_ERROR_RE =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

export function registerCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	let deferredTimer: ReturnType<typeof setTimeout> | undefined;
	let lifecycleGeneration = 0;

	pi.on("session_shutdown", () => {
		lifecycleGeneration += 1;
		if (deferredTimer !== undefined) {
			clearTimeout(deferredTimer);
			deferredTimer = undefined;
		}
		runtime.compactInFlight = false;
	});

	pi.on("agent_end", (event: any, ctx: any) => {
		runtime.ensureConfig(ctx.cwd);
		if (runtime.config.passive === true) return;
		if (runtime.compactInFlight) return;

		// Don't trigger compaction if Pi will auto-retry — the agent hasn't truly finished.
		// Pi emits agent_end before its own retry check, so we must detect this ourselves.
		// The next agent_end (after retry succeeds or exhausts attempts) will re-evaluate.
		const lastAssistant = [...event.messages].reverse().find(
			(m): m is Extract<typeof m, { role: "assistant" }> => m.role === "assistant",
		);
		if (
			lastAssistant
			&& lastAssistant.stopReason === "error"
			&& lastAssistant.errorMessage
			&& RETRYABLE_ERROR_RE.test(lastAssistant.errorMessage)
		) {
			return;
		}

		// Use the session's REAL context usage (provider-reported tokens) instead of a
		// client-side token estimate. The old raw-token estimate systematically
		// undercounted the live context — it omitted the system prompt, tool schemas,
		// thinking/reasoning tokens, and drifted from the provider's own accounting by
		// ~20-46% in practice. The trigger could therefore lag the visible footer
		// context percentage badly (e.g. UI at 36% while the estimate sat below a
		// 0.35 × window threshold), so compaction never fired in long sessions.
		// ctx.getContextUsage() reports the same basis the footer percentage uses.
		const contextUsage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
		let tokens = contextUsage?.tokens;
		if (typeof tokens !== "number" || !Number.isFinite(tokens)) {
			// getContextUsage is unavailable on older pi hosts, or context is unknown
			// until the next valid assistant response. Fall back to the raw
			// source-entry estimate so the trigger still works on older pi versions.
			const entries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
			if (!entries) return;
			tokens = rawTokensSinceLastCompaction(entries);
			if (typeof tokens !== "number") return;
		}
		// Resolve the proactive-compaction threshold from the active model's context
		// window when ratio mode is configured. Prefer the window reported by
		// getContextUsage(); fall back to ctx.model (Model<any> | undefined).
		const contextWindow =
			contextUsage?.contextWindow
			?? (typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined);
		const threshold = resolveCompactAfterTokens(runtime.config, contextWindow);
		if (tokens < threshold) return;

		// Capture ctx properties synchronously — the setTimeout + async work below
		// may outlive the extension ctx (stale after session replacement/reload).
		const hasUI = ctx.hasUI;
		const ui = ctx.ui;

		if (hasUI) ui?.notify(
			`Observational memory: compaction threshold reached (~${tokens.toLocaleString()} tokens); triggering compaction`,
			"info",
		);

		runtime.compactInFlight = true;
		const generation = lifecycleGeneration;
		deferredTimer = setTimeout(() => {
			deferredTimer = undefined;
			if (generation !== lifecycleGeneration) {
				runtime.compactInFlight = false;
				return;
			}
			try {
				if (!ctx.isIdle()) {
					runtime.compactInFlight = false;
					if (hasUI) ui?.notify(
						"Observational memory: compaction deferred — agent became busy before compaction",
						"info",
					);
					return;
				}
				const currentUsage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
				let currentTokens = currentUsage?.tokens;
				if (typeof currentTokens !== "number") {
					const currentEntries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
					if (!currentEntries) {
						runtime.compactInFlight = false;
						return;
					}
					currentTokens = rawTokensSinceLastCompaction(currentEntries);
				}
				if (typeof currentTokens !== "number" || currentTokens < threshold) {
					runtime.compactInFlight = false;
					if (hasUI) ui?.notify(
						"Observational memory: compaction skipped — another compaction already ran before deferred compaction",
						"info",
					);
					return;
				}
				ctx.compact({
					onComplete: () => {
						if (generation !== lifecycleGeneration) return;
						runtime.compactInFlight = false;
						if (hasUI) ui?.notify("Observational memory: compaction complete", "info");
					},
					onError: (error: { message: string }) => {
						if (generation !== lifecycleGeneration) return;
						runtime.compactInFlight = false;
						if (error.message === "Compaction cancelled") {
							// We already notified the user with the real reason before returning { cancel: true }.
							return;
						}
						if (hasUI) ui?.notify(`Observational memory: ${error.message}`, "error");
					},
				});
			} catch (error) {
				if (generation !== lifecycleGeneration) return;
				runtime.compactInFlight = false;
				const msg = error instanceof Error ? error.message : String(error);
				if (hasUI) ui?.notify(`Observational memory: compact threw: ${msg}`, "error");
			}
		}, 0);
	});
}
