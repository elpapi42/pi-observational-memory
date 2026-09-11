/** Wall-clock and token throughput for one completed observer/reflector/dropper LLM run. */
export interface AgentRunStats {
	durationMs: number;
	/** Summed across every LLM call the run made (a run may span several tool-calling turns). */
	inputTokens: number;
	/** Summed across every LLM call the run made. */
	outputTokens: number;
}

/**
 * Human-readable local-LLM performance line for a completed observer/reflector/
 * dropper run. Always shown regardless of `showWorkerNotifications`: unlike the
 * routine progress messages it gates, this is diagnostic signal for judging
 * how the configured (often local) memory-worker model is performing.
 */
export function formatAgentStats(label: string, stats: AgentRunStats): string {
	const seconds = stats.durationMs / 1000;
	const outputTokensPerSecond = seconds > 0 ? stats.outputTokens / seconds : 0;
	return (
		`Observational memory: ${label} — ${seconds.toFixed(1)}s wall, ` +
		`${stats.inputTokens.toLocaleString()} tok in, ${stats.outputTokens.toLocaleString()} tok out, ` +
		`${outputTokensPerSecond.toFixed(1)} out tok/s`
	);
}
