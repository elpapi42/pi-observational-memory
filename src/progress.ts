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
	private droppedCount = 0;
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
		if (this.phase && this.phase !== phase && !this.completedPhases.includes(this.phase)) {
			this.completedPhases.push(this.phase);
		}
		this.phase = phase;
		this.pass = pass;
		this.maxPasses = maxPasses;
		this.toolCallCount = 0;
		this.turnCount = 0;
	}

	setCompletedPhases(phases: CompactionPhase[]): void {
		this.completedPhases = phases;
	}

	addDroppedCount(count: number): void {
		this.droppedCount += count;
	}

	onEvent(event: AgentEvent): void {
		if (!this.phase) return;
		switch (event.type) {
			case "tool_execution_start":
				this.toolCallCount++;
				break;
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
		this.droppedCount = 0;
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

		// Pass info (only for multi-pass phases)
		if (this.maxPasses > 1) {
			parts.push(theme.fg("muted", `pass ${this.pass}/${this.maxPasses}`));
		}

		// Tool calls
		const tcLabel = this.toolCallCount === 1 ? "tool call" : "tool calls";
		parts.push(theme.fg("muted", `${this.toolCallCount} ${tcLabel}`));

		// Dropped count for pruner
		if (this.phase === "pruner" && this.droppedCount > 0) {
			parts.push(theme.fg("muted", `${this.droppedCount} dropped`));
		}

		return parts.join(theme.fg("dim", " · "));
	}
}
