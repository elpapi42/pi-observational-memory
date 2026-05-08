import { describe, expect, it } from "vitest";
import { CompactionProgressTracker } from "../src/progress.js";

describe("CompactionProgressTracker", () => {
	it("starts in idle state with no phase", () => {
		const tracker = new CompactionProgressTracker();
		expect(tracker.getPhase()).toBeUndefined();
		expect(tracker.getPass()).toBe(0);
		expect(tracker.getMaxPasses()).toBe(0);
		expect(tracker.getToolCallCount()).toBe(0);
		expect(tracker.getTurnCount()).toBe(0);
	});

	it("transitions to observer phase", () => {
		const tracker = new CompactionProgressTracker();
		tracker.setPhase("observer", 1, 1);
		expect(tracker.getPhase()).toBe("observer");
		expect(tracker.getPass()).toBe(1);
		expect(tracker.getMaxPasses()).toBe(1);
	});

	it("transitions to reflector phase with pass info", () => {
		const tracker = new CompactionProgressTracker();
		tracker.setPhase("reflector", 1, 3);
		expect(tracker.getPhase()).toBe("reflector");
		expect(tracker.getPass()).toBe(1);
		expect(tracker.getMaxPasses()).toBe(3);
	});

	it("transitions to pruner phase with pass info", () => {
		const tracker = new CompactionProgressTracker();
		tracker.setPhase("pruner", 2, 5);
		expect(tracker.getPhase()).toBe("pruner");
		expect(tracker.getPass()).toBe(2);
		expect(tracker.getMaxPasses()).toBe(5);
	});

	it("counts tool calls from agent events", () => {
		const tracker = new CompactionProgressTracker();
		tracker.setPhase("reflector", 1, 3);
		tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "record_reflections", args: {} });
		tracker.onEvent({ type: "tool_execution_end", toolCallId: "tc1", toolName: "record_reflections", result: {}, isError: false });
		tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc2", toolName: "record_reflections", args: {} });
		expect(tracker.getToolCallCount()).toBe(2);
	});

	it("counts turns from agent events", () => {
		const tracker = new CompactionProgressTracker();
		tracker.setPhase("pruner", 1, 5);
		tracker.onEvent({ type: "turn_start" });
		tracker.onEvent({ type: "turn_end", message: {} as any, toolResults: [] });
		tracker.onEvent({ type: "turn_start" });
		expect(tracker.getTurnCount()).toBe(2);
	});

	it("formats widget text for reflector phase", () => {
		const tracker = new CompactionProgressTracker();
		tracker.setPhase("reflector", 2, 3);
		tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "record_reflections", args: {} });
		const text = tracker.formatWidget({
			fg: (color: string, t: string) => `<${color}>${t}</>`,
		});
		expect(text).toContain("Reflector");
		expect(text).toContain("2/3");
		expect(text).toContain("1 tool call");
	});

	it("formats widget text for pruner phase with observations dropped", () => {
		const tracker = new CompactionProgressTracker();
		tracker.setStartingCounts(10, 100);
		tracker.setPhase("pruner", 3, 5);
		tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "drop_observations", args: {} });
		tracker.onEvent({
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "drop_observations",
			result: { content: [], details: { dropped: Array.from({ length: 7 }, (_, i) => `o${i}`), unknown: [], already: [], remaining: 3 } },
			isError: false,
		});
		const text = tracker.formatWidget({
			fg: (color: string, t: string) => `<${color}>${t}</>`,
		});
		expect(text).toContain("Pruner");
		expect(text).toContain("3/5");
		expect(text).toContain("O 93(-7)");
	});

	it("formats widget text for observer phase", () => {
		const tracker = new CompactionProgressTracker();
		tracker.setPhase("observer", 1, 1);
		tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "record_observations", args: {} });
		const text = tracker.formatWidget({
			fg: (color: string, t: string) => `<${color}>${t}</>`,
		});
		expect(text).toContain("Observer");
	});

	it("resets counts when phase changes", () => {
		const tracker = new CompactionProgressTracker();
		tracker.setPhase("reflector", 1, 3);
		tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "record_reflections", args: {} });
		tracker.onEvent({ type: "turn_start" });
		// Change phase
		tracker.setPhase("pruner", 1, 5);
		expect(tracker.getToolCallCount()).toBe(0);
		expect(tracker.getTurnCount()).toBe(0);
	});

	it("clears state", () => {
		const tracker = new CompactionProgressTracker();
		tracker.setPhase("reflector", 1, 3);
		tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "record_reflections", args: {} });
		tracker.clear();
		expect(tracker.getPhase()).toBeUndefined();
		expect(tracker.getToolCallCount()).toBe(0);
	});

	it("ignores events when no phase is set", () => {
		const tracker = new CompactionProgressTracker();
		tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "record_reflections", args: {} });
		expect(tracker.getToolCallCount()).toBe(0);
	});

	it("renders pipeline overview with completed phases", () => {
		const tracker = new CompactionProgressTracker();
		tracker.setCompletedPhases(["observer"]);
		tracker.setPhase("reflector", 2, 3);
		const text = tracker.formatWidget({
			fg: (color: string, t: string) => `<${color}>${t}</>`,
		});
		expect(text).toContain("✓O"); // completed observer
		expect(text).toContain("Reflector"); // active
	});

	it("auto-marks previous phase as completed when transitioning to a new phase", () => {
		const tracker = new CompactionProgressTracker();
		tracker.setPhase("observer", 1, 1);
		tracker.setPhase("reflector", 1, 3);
		const text = tracker.formatWidget({
			fg: (color: string, t: string) => `<${color}>${t}</>`,
		});
		expect(text).toContain("✓O"); // auto-completed observer
		expect(text).toContain("Reflector"); // active
	});

	it("uses singular 'tool call' for 1 and plural for 0 or 2+", () => {
		const tracker = new CompactionProgressTracker();
		tracker.setPhase("reflector", 1, 3);
		let text = tracker.formatWidget({ fg: (_c: string, t: string) => t });
		expect(text).toContain("0 tool calls");
		tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "r", args: {} });
		text = tracker.formatWidget({ fg: (_c: string, t: string) => t });
		expect(text).toContain("1 tool call");
		tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc2", toolName: "r", args: {} });
		text = tracker.formatWidget({ fg: (_c: string, t: string) => t });
		expect(text).toContain("2 tool calls");
	});

	it("returns empty string when no phase is set for formatWidget", () => {
		const tracker = new CompactionProgressTracker();
		expect(tracker.formatWidget({ fg: (_c: string, t: string) => t })).toBe("");
	});

	// --- Delta counters: R total(+accumulated), M total, O remaining(-accumulated) ---

	it("tracks reflections added from record_reflections tool_execution_end", () => {
		const tracker = new CompactionProgressTracker();
		tracker.setPhase("reflector", 1, 3);
		tracker.setStartingCounts(15, 50);
		tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "record_reflections", args: {} });
		tracker.onEvent({
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "record_reflections",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { accepted: 3, added: 2, merged: 1, duplicates: 0, unsupported: 0 },
			},
			isError: false,
		});
		const text = tracker.formatWidget({ fg: (_c: string, t: string) => t });
		expect(text).toContain("R 17(+2)");
		expect(text).toContain("M 1");
	});

	it("accumulates reflection deltas across multiple tool calls in same pass", () => {
		const tracker = new CompactionProgressTracker();
		tracker.setPhase("reflector", 1, 3);
		tracker.setStartingCounts(10, 50);
		// First call: 3 added, 1 merged
		tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "record_reflections", args: {} });
		tracker.onEvent({
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "record_reflections",
			result: { content: [], details: { accepted: 4, added: 3, merged: 1, duplicates: 0, unsupported: 0 } },
			isError: false,
		});
		// Second call: 2 added, 0 merged
		tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc2", toolName: "record_reflections", args: {} });
		tracker.onEvent({
			type: "tool_execution_end",
			toolCallId: "tc2",
			toolName: "record_reflections",
			result: { content: [], details: { accepted: 2, added: 2, merged: 0, duplicates: 0, unsupported: 0 } },
			isError: false,
		});
		const text = tracker.formatWidget({ fg: (_c: string, t: string) => t });
		expect(text).toContain("R 15(+5)");
		expect(text).toContain("M 1");
	});

	it("does not show R/M when no reflections added or merged", () => {
		const tracker = new CompactionProgressTracker();
		tracker.setPhase("reflector", 1, 3);
		tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "record_reflections", args: {} });
		tracker.onEvent({
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "record_reflections",
			result: { content: [], details: { accepted: 0, added: 0, merged: 0, duplicates: 2, unsupported: 0 } },
			isError: false,
		});
		const text = tracker.formatWidget({ fg: (_c: string, t: string) => t });
		expect(text).not.toContain("R ");
		expect(text).not.toContain("M ");
	});

	it("tracks observations dropped from drop_observations tool_execution_end", () => {
		const tracker = new CompactionProgressTracker();
		tracker.setPhase("pruner", 1, 5);
		tracker.setStartingCounts(10, 20);
		tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "drop_observations", args: {} });
		tracker.onEvent({
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "drop_observations",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { dropped: ["o1", "o2", "o3"], unknown: [], already: [], remaining: 10 },
			},
			isError: false,
		});
		const text = tracker.formatWidget({ fg: (_c: string, t: string) => t });
		expect(text).toContain("O 17(-3)");
	});

	it("accumulates observation drops across multiple tool calls in same pass", () => {
		const tracker = new CompactionProgressTracker();
		tracker.setPhase("pruner", 1, 5);
		tracker.setStartingCounts(10, 300);
		// First call: drop 4
		tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "drop_observations", args: {} });
		tracker.onEvent({
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "drop_observations",
			result: { content: [], details: { dropped: ["a", "b", "c", "d"], unknown: [], already: [], remaining: 8 } },
			isError: false,
		});
		// Second call: drop 3
		tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc2", toolName: "drop_observations", args: {} });
		tracker.onEvent({
			type: "tool_execution_end",
			toolCallId: "tc2",
			toolName: "drop_observations",
			result: { content: [], details: { dropped: ["e", "f", "g"], unknown: [], already: [], remaining: 5 } },
			isError: false,
		});
		const text = tracker.formatWidget({ fg: (_c: string, t: string) => t });
		expect(text).toContain("O 293(-7)");
	});

	it("shows O remaining(-accumulated) delta format for pruner", () => {
		const tracker = new CompactionProgressTracker();
		tracker.setPhase("pruner", 1, 5);
		tracker.setStartingCounts(10, 100);
		tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "drop_observations", args: {} });
		tracker.onEvent({
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "drop_observations",
			result: { content: [], details: { dropped: ["o1"], unknown: [], already: [], remaining: 9 } },
			isError: false,
		});
		const text = tracker.formatWidget({ fg: (_c: string, t: string) => t });
		expect(text).toContain("O 99(-1)");
		expect(text).not.toContain("dropped");
	});

	it("preserves deltas across passes within same phase", () => {
		const tracker = new CompactionProgressTracker();
		tracker.setStartingCounts(10, 50);
		tracker.setPhase("reflector", 1, 3);
		tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "record_reflections", args: {} });
		tracker.onEvent({
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "record_reflections",
			result: { content: [], details: { accepted: 3, added: 3, merged: 0, duplicates: 0, unsupported: 0 } },
			isError: false,
		});
		// Pass 2 — same phase, deltas should accumulate
		tracker.setPhase("reflector", 2, 3);
		tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc2", toolName: "record_reflections", args: {} });
		tracker.onEvent({
			type: "tool_execution_end",
			toolCallId: "tc2",
			toolName: "record_reflections",
			result: { content: [], details: { accepted: 2, added: 2, merged: 1, duplicates: 0, unsupported: 0 } },
			isError: false,
		});
		const text = tracker.formatWidget({ fg: (_c: string, t: string) => t });
		expect(text).toContain("R 15(+5)");
		expect(text).toContain("M 1");
	});

	it("resets deltas when phase changes", () => {
		const tracker = new CompactionProgressTracker();
		tracker.setStartingCounts(10, 50);
		tracker.setPhase("reflector", 1, 3);
		tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "record_reflections", args: {} });
		tracker.onEvent({
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "record_reflections",
			result: { content: [], details: { accepted: 2, added: 2, merged: 0, duplicates: 0, unsupported: 0 } },
			isError: false,
		});
		// Transition to pruner — deltas reset
		tracker.setPhase("pruner", 1, 5);
		const text = tracker.formatWidget({ fg: (_c: string, t: string) => t });
		expect(text).not.toContain("R 12(+2)");
	});

	it("ignores tool_execution_end for unknown tools", () => {
		const tracker = new CompactionProgressTracker();
		tracker.setStartingCounts(10, 50);
		tracker.setPhase("reflector", 1, 3);
		tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "record_reflections", args: {} });
		tracker.onEvent({
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "some_other_tool",
			result: { content: [], details: { accepted: 5, added: 5, merged: 0, duplicates: 0, unsupported: 0 } },
			isError: false,
		});
		const text = tracker.formatWidget({ fg: (_c: string, t: string) => t });
		expect(text).not.toContain("R 15(+5)");
	});

	it("ignores tool_execution_end with missing details", () => {
		const tracker = new CompactionProgressTracker();
		tracker.setStartingCounts(10, 50);
		tracker.setPhase("pruner", 1, 5);
		tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "drop_observations", args: {} });
		tracker.onEvent({
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "drop_observations",
			result: { content: [] }, // no details
			isError: false,
		});
		const text = tracker.formatWidget({ fg: (_c: string, t: string) => t });
		expect(text).not.toContain("O 50(-1)");
	});

	it("ignores tool_execution_end when isError is true", () => {
		const tracker = new CompactionProgressTracker();
		tracker.setStartingCounts(10, 50);
		tracker.setPhase("reflector", 1, 3);
		tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "record_reflections", args: {} });
		tracker.onEvent({
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "record_reflections",
			result: { content: [], details: { accepted: 5, added: 5, merged: 0, duplicates: 0, unsupported: 0 } },
			isError: true,
		});
		const text = tracker.formatWidget({ fg: (_c: string, t: string) => t });
		expect(text).not.toContain("R 15(+5)");
	});
});
