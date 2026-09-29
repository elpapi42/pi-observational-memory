import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { IndexOutcome, SessionEmbeddings } from "../embeddings.js";
import type { Runtime } from "../runtime.js";
import type { Entry } from "../session-ledger/index.js";

/** Embedding time per turn while the agent works. */
export const TURN_BUDGET_MS = 1_000;
/** Embedding time per run once the agent settles, and per idle run after that. */
export const SETTLE_BUDGET_MS = 60_000;
/** Idle time between settle-time runs while a backlog remains. */
export const IDLE_DELAY_MS = 30_000;

/**
 * Spreads recall indexing over the session. Compaction hides a whole range of transcript at
 * once; embedding it in one pass stalls the process, so each turn embeds a slice, a settle
 * embeds a longer one, and idle time keeps going until the backlog is gone. A recall query
 * embeds whatever is left before it scores. Compacted branches without an index wait for /om:index.
 */
export function registerRecallIndexing(pi: ExtensionAPI, runtime: Runtime, embeddings: SessionEmbeddings): void {
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	// Bumped whenever the agent starts, settles, or the session ends, so an earlier idle chain stops.
	let epoch = 0;

	const interrupt = () => {
		epoch++;
		clearTimeout(idleTimer);
		idleTimer = undefined;
		embeddings.stopIncremental();
	};

	const index = (ctx: ExtensionContext, budgetMs: number): Promise<IndexOutcome> | undefined => {
		runtime.ensureConfig(ctx.cwd);
		const run = embeddings.scheduleIncrementalIndex(ctx.sessionManager.getSessionId(), ctx.sessionManager.getBranch() as Entry[], { budgetMs });
		void run?.then(() => {
			if (!embeddings.failure || embeddings.failureNotified) return;
			embeddings.failureNotified = true;
			if (ctx.hasUI) ctx.ui.notify(`Observational memory: recall embeddings unavailable, using keyword search: ${embeddings.failure}`, "warning");
		});
		return run;
	};

	// Runs a settle-sized slice, then another after each idle delay until one completes.
	const settle = async (ctx: ExtensionContext, started: number) => {
		await embeddings.whenIdle();
		if (started !== epoch) return;
		const outcome = await index(ctx, SETTLE_BUDGET_MS);
		if (outcome !== "aborted" || started !== epoch) return;
		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			try {
				if (started === epoch && ctx.isIdle()) void settle(ctx, started);
			} catch {
				// The context went stale with its session; the next settle starts over.
			}
		}, IDLE_DELAY_MS);
	};

	pi.on("turn_end", (_event, ctx: ExtensionContext) => {
		void index(ctx, TURN_BUDGET_MS);
	});
	pi.on("agent_start", interrupt);
	pi.on("session_shutdown", interrupt);
	pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
		clearTimeout(idleTimer);
		void settle(ctx, ++epoch);
	});
}
