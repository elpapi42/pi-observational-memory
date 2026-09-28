import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerSelfCompact, SELF_COMPACT_RESUME_TYPE, SELF_COMPACT_TOOL_NAME } from "../src/hooks/self-compact.js";

function setup(warnAt: unknown[] = []) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	let tool: any;
	const pi = {
		on: vi.fn((name: string, cb: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, cb)),
		registerTool: vi.fn((definition: unknown) => { tool = definition; }),
		getActiveTools: vi.fn(() => [] as string[]),
		setActiveTools: vi.fn(),
		sendMessage: vi.fn(),
	};
	const runtime = {
		ensureConfig: vi.fn(),
		config: { selfCompact: { enabled: true, warnAt } },
		compactInFlight: false,
		selfCompactPending: undefined as unknown,
	};
	registerSelfCompact(pi as any, runtime as any);
	const usage = { tokens: 0 as number | null, contextWindow: 100_000, percent: null };
	const branch: any[] = [];
	const ctx = {
		cwd: "/tmp/project",
		hasUI: false,
		isIdle: vi.fn(() => true),
		compact: vi.fn(),
		getContextUsage: () => usage,
		sessionManager: { getBranch: () => branch },
	};
	handlers.get("session_start")!({ type: "session_start" }, ctx);
	const settle = async () => {
		handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		await vi.runAllTimersAsync();
	};
	const turnEnd = (tokens: number, toolResults: unknown[] = [{}]) => {
		usage.tokens = tokens;
		handlers.get("turn_end")!({ type: "turn_end", toolResults }, ctx);
	};
	return { pi, runtime, ctx, settle, turnEnd, branch, tool: () => tool };
}

describe("self-compact", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("compacts after the run settles and resumes from the agent's note", async () => {
		const { pi, runtime, ctx, settle, tool } = setup();
		expect(tool().name).toBe(SELF_COMPACT_TOOL_NAME);

		const result = await tool().execute("call-1", { resume: "Finish step 3." });
		expect(result.terminate).toBe(true);
		expect(ctx.compact).not.toHaveBeenCalled();

		await settle();
		expect(runtime.compactInFlight).toBe(true);
		ctx.compact.mock.calls[0][0].onComplete({});

		expect(runtime.compactInFlight).toBe(false);
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: SELF_COMPACT_RESUME_TYPE, content: expect.stringContaining("Finish step 3.") }),
			{ triggerTurn: true },
		);
	});

	it("shows the resume note only when the result is expanded", () => {
		const { tool } = setup();
		const theme = { fg: (_color: string, text: string) => text };
		const result = { content: [{ type: "text", text: "Compaction scheduled." }], details: { scheduled: true } };
		const context = { args: { resume: "Finish step 3." } };
		const render = (expanded: boolean) =>
			tool().renderResult(result, { expanded, isPartial: false }, theme, context).render(80).join("\n");

		expect(render(false)).toContain("Compaction scheduled.");
		expect(render(false)).not.toContain("Finish step 3.");
		expect(render(true)).toContain("Finish step 3.");
	});

	it("stays idle without a note and reports failures only to a resuming agent", async () => {
		const { pi, ctx, settle, tool } = setup();

		await tool().execute("call-1", {});
		await settle();
		ctx.compact.mock.calls[0][0].onComplete({});
		expect(pi.sendMessage).not.toHaveBeenCalled();

		await tool().execute("call-2", { resume: "Next." });
		await settle();
		ctx.compact.mock.calls[1][0].onError(new Error("Nothing to compact"));
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining("Compaction failed: Nothing to compact") }),
			{ triggerTurn: true },
		);
	});

	it("warns once per threshold per compaction cycle, attaching idle warnings to the next prompt", () => {
		const { pi, turnEnd, branch } = setup([{ type: "ratio", value: 0.2 }, { type: "ratio", value: 0.28 }]);
		const warnings = () => pi.sendMessage.mock.calls.map(([message, options]: any[]) => [message.details.level, options.deliverAs]);

		turnEnd(19_000);
		turnEnd(21_000);
		turnEnd(22_000);
		turnEnd(29_000, []);
		expect(warnings()).toEqual([[1, "steer"], [2, "nextTurn"]]);
		expect(pi.sendMessage.mock.calls[1][0].content).toContain("before starting any new work");

		branch.push({ type: "compaction", id: "cmp-1" });
		turnEnd(21_000);
		expect(warnings().at(-1)).toEqual([1, "steer"]);
	});
});
