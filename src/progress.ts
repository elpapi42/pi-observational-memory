import type { AgentEvent } from "@mariozechner/pi-agent-core";

export type CompactionPhase = "observer" | "reflector" | "pruner";

export interface ThemeLike {
	fg: (color: string, text: string) => string;
}

const ALL_PHASES: CompactionPhase[] = ["observer", "reflector", "pruner"];

export class CompactionProgressTracker {
	private phase: CompactionPhase | undefined;
	private pass = 0;
	private maxPasses = 0;
	private toolCallCount = 0;
	private turnCount = 0;
	// Starting counts before compaction tools run
	private startingReflections = 0;
	private startingObservations = 0;
	// Accumulated deltas across all passes within a phase
	private reflectionsAdded = 0;
	private reflectionsMerged = 0;
	private observationsDropped = 0;
	private completedPhases: CompactionPhase[] = [];

	getPhase(): CompactionPhase | undefined {
		return this.phase;
	}

	getPass(): number {
		return this.pass;
	}

	getMaxPasses(): number {
		return this.maxPasses;
	}

	getToolCallCount(): number {
		return this.toolCallCount;
	}

	getTurnCount(): number {
		return this.turnCount;
	}

	setPhase(phase: CompactionPhase, pass: number, maxPasses: number): void {
		const prevPhase = this.phase;
		if (prevPhase && prevPhase !== phase && !this.completedPhases.includes(prevPhase)) {
			this.completedPhases.push(prevPhase);
		}
		// Reset deltas when transitioning to a different phase
		if (prevPhase !== phase) {
			this.reflectionsAdded = 0;
			this.reflectionsMerged = 0;
			this.observationsDropped = 0;
		}
		this.phase = phase;
		this.pass = pass;
		this.maxPasses = maxPasses;
		// Reset per-phase counters only when transitioning to a different phase,
		// not when advancing pass/batch within the same phase
		if (prevPhase !== phase) {
			this.toolCallCount = 0;
			this.turnCount = 0;
		}
	}

	setStartingCounts(reflections: number, observations: number): void {
		this.startingReflections = reflections;
		this.startingObservations = observations;
	}

	setCompletedPhases(phases: CompactionPhase[]): void {
		this.completedPhases = phases;
	}

	onEvent(event: AgentEvent): void {
		if (!this.phase) return;
		switch (event.type) {
			case "tool_execution_start":
				this.toolCallCount++;
				break;
			case "tool_execution_end": {
				if (event.isError) break;
				const details = (event.result as { details?: Record<string, unknown> } | undefined)?.details;
				if (!details) break;
				if (event.toolName === "record_reflections") {
					this.reflectionsAdded += (details.added as number) ?? 0;
					this.reflectionsMerged += (details.merged as number) ?? 0;
				} else if (event.toolName === "drop_observations") {
					this.observationsDropped += Array.isArray(details.dropped) ? details.dropped.length : 0;
				}
				break;
			}
			case "turn_start":
				this.turnCount++;
				break;
		}
	}

	clear(): void {
		this.phase = undefined;
		this.pass = 0;
		this.maxPasses = 0;
		this.toolCallCount = 0;
		this.turnCount = 0;
		this.startingReflections = 0;
		this.startingObservations = 0;
		this.reflectionsAdded = 0;
		this.reflectionsMerged = 0;
		this.observationsDropped = 0;
		this.completedPhases = [];
	}

	formatWidget(theme: ThemeLike): string {
		if (!this.phase) return "";

		const parts: string[] = [];

		// Pipeline overview: show all phases with completion state
		const phaseLabels = ALL_PHASES.map((p) => {
			if (p === this.phase) {
				return theme.fg("accent", p.charAt(0).toUpperCase() + p.slice(1));
			}
			if (this.completedPhases.includes(p)) {
				return theme.fg("success", `✓${p.charAt(0).toUpperCase()}`);
			}
			return theme.fg("dim", p.charAt(0).toUpperCase());
		});
		parts.push(phaseLabels.join(theme.fg("dim", " → ")));

		// Pass/batch info (only for multi-pass phases)
		if (this.maxPasses > 1) {
			const label = this.phase === "observer" ? "batch" : "pass";
			parts.push(theme.fg("muted", `${label} ${this.pass}/${this.maxPasses}`));
		}

		// Tool calls (only shown when non-zero — observer batches don't feed events)
		if (this.toolCallCount > 0) {
			const tcLabel = this.toolCallCount === 1 ? "tool call" : "tool calls";
			parts.push(theme.fg("muted", `${this.toolCallCount} ${tcLabel}`));
		}

		// Delta counters: R total(+accumulated), M total(+accumulated), O remaining(-accumulated)
		const deltas: string[] = [];
		if (this.reflectionsAdded > 0) {
			const total = this.startingReflections + this.reflectionsAdded;
			deltas.push(`R ${total}(+${this.reflectionsAdded})`);
		}
		if (this.reflectionsMerged > 0) {
			deltas.push(`M ${this.reflectionsMerged}`);
		}
		if (this.observationsDropped > 0) {
			const remaining = this.startingObservations - this.observationsDropped;
			deltas.push(`O ${remaining}(-${this.observationsDropped})`);
		}
		if (deltas.length > 0) {
			parts.push(theme.fg("accent", deltas.join(" ")));
		}

		return parts.join(theme.fg("dim", " · "));
	}
}
