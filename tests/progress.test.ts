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
		tracker.setPhase("pruner", 3, 5);
		tracker.addDroppedCount(7);
		tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "drop_observations", args: {} });
		const text = tracker.formatWidget({
			fg: (color: string, t: string) => `<${color}>${t}</>`,
		});
		expect(text).toContain("Pruner");
		expect(text).toContain("3/5");
		expect(text).toContain("7 dropped");
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
});
