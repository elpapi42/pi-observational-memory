/**
 * Token and cost accounting for observational-memory worker agent loops.
 *
 * pi tracks usage only for the main session's assistant messages. The
 * observer, reflector and dropper are separate `agentLoop` runs that call the
 * same provider, so their spend is billed but invisible to pi's session cost.
 * This accumulates it so the consolidation pipeline can report a true total.
 */

export interface WorkerUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export const EMPTY_WORKER_USAGE: WorkerUsageTotals = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: 0,
};

const EMPTY = EMPTY_WORKER_USAGE;

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Read one assistant message's usage into totals, or undefined when absent/empty. */
export function workerUsageFromMessage(message: unknown): WorkerUsageTotals | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const usage = (message as { usage?: unknown }).usage;
	if (typeof usage !== "object" || usage === null) return undefined;
	const raw = usage as {
		input?: unknown;
		output?: unknown;
		cacheRead?: unknown;
		cacheWrite?: unknown;
		totalTokens?: unknown;
		cost?: unknown;
	};
	const cost =
		typeof raw.cost === "object" && raw.cost !== null
			? finiteNumber((raw.cost as { total?: unknown }).total)
			: 0;
	const totals: WorkerUsageTotals = {
		input: finiteNumber(raw.input),
		output: finiteNumber(raw.output),
		cacheRead: finiteNumber(raw.cacheRead),
		cacheWrite: finiteNumber(raw.cacheWrite),
		totalTokens: finiteNumber(raw.totalTokens),
		cost,
	};
	const empty =
		totals.input === 0 &&
		totals.output === 0 &&
		totals.cacheRead === 0 &&
		totals.cacheWrite === 0 &&
		totals.cost === 0;
	return empty ? undefined : totals;
}

export function addWorkerUsage(a: WorkerUsageTotals, b: WorkerUsageTotals): WorkerUsageTotals {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		totalTokens: a.totalTokens + b.totalTokens,
		cost: a.cost + b.cost,
	};
}

export function deltaWorkerUsage(after: WorkerUsageTotals, before: WorkerUsageTotals): WorkerUsageTotals {
	return {
		input: after.input - before.input,
		output: after.output - before.output,
		cacheRead: after.cacheRead - before.cacheRead,
		cacheWrite: after.cacheWrite - before.cacheWrite,
		totalTokens: after.totalTokens - before.totalTokens,
		cost: after.cost - before.cost,
	};
}

/**
 * Running total shared by a Runtime and its worker agents.
 *
 * `agentLoop` emits exactly one `turn_end` per assistant turn, so recording
 * there counts each provider response once whether or not it made tool calls.
 */
export class WorkerUsageAccumulator {
	private totals: WorkerUsageTotals = { ...EMPTY };

	add(message: unknown): void {
		const delta = workerUsageFromMessage(message);
		if (!delta) return;
		this.totals = addWorkerUsage(this.totals, delta);
	}

	/** Record an agent-loop stream event, ignoring everything but assistant turns. */
	addEvent(event: unknown): void {
		if (typeof event !== "object" || event === null) return;
		const typed = event as { type?: unknown; message?: unknown };
		if (typed.type !== "turn_end") return;
		this.add(typed.message);
	}

	snapshot(): WorkerUsageTotals {
		return { ...this.totals };
	}

	reset(): void {
		this.totals = { ...EMPTY };
	}
}
