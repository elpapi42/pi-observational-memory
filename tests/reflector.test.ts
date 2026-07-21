import { describe, expect, it } from "vitest";

import {
	normalizeSupportingObservationIds,
	observationToReflectorLine,
	runReflector,
	summarizeSupportIdCounts,
} from "../src/agents/reflector/agent.js";
import { hashId } from "../src/ids.js";
import { estimateStringTokens } from "../src/tokens.js";
import { observation, reflection } from "./fixtures/session.js";

function fakeAgentLoop(handler: (prompts: any[], context: any, config: any, signal: AbortSignal | undefined, streamFunction: unknown) => Promise<void> | void): any {
	return ((prompts: any[], context: any, config: any, signal: AbortSignal | undefined, streamFunction: unknown) => ({
		async *[Symbol.asyncIterator]() {},
		result: async () => {
			await handler(prompts, context, config, signal, streamFunction);
			return {};
		},
	})) as any;
}

describe("V3 reflector agent", () => {
	const obsA = observation("aaaaaaaaaaaa");
	const obsB = observation("bbbbbbbbbbbb");
	const baseArgs = {
		model: {} as any,
		apiKey: "test",
		reflections: [],
		observations: [obsA, obsB],
	};

	it("keeps core reflector prompt guidance in V3 terms", async () => {
		let systemPrompt = "";
		const loop = fakeAgentLoop((_prompts, context) => {
			systemPrompt = context.systemPrompt;
		});

		await runReflector({ ...baseArgs, agentLoop: loop });

		expect(systemPrompt).toContain("Your task is different from the observer");
		expect(systemPrompt).toContain("User assertions are authoritative");
		expect(systemPrompt).toContain("supportingObservationIds");
		expect(systemPrompt).toContain("coverage/provenance set");
		expect(systemPrompt).toContain("Do not lightly reword existing reflections");
		expect(systemPrompt).toContain("Reflections are scarce, expensive durable orientation anchors");
		expect(systemPrompt).toContain("not a second observation layer");
		expect(systemPrompt).toContain("Over-reflection is also memory distortion");
		expect(systemPrompt).toContain("makes transient details look durable");
		expect(systemPrompt).toContain("Decision procedure:");
		expect(systemPrompt).toContain("First reject observations that are transient, low-level, partial, routine, or only useful as current working state");
		expect(systemPrompt).toContain("future-agent utility test");
		expect(systemPrompt).toContain("avoid a wrong decision, repeated work, or user-preference violation");
		expect(systemPrompt).toContain("If the candidate fails that future-agent utility test, leave it as an observation");
		expect(systemPrompt).toContain("If unsure, emit no reflection");
		expect(systemPrompt).toContain("High and critical observations deserve careful review, not automatic reflection");
		expect(systemPrompt).toContain("Do not turn each observation into a reflection");
		expect(systemPrompt).toContain("Observations are evidence; reflections are compressed durable conclusions");
		expect(systemPrompt).toContain("Single-observation reflections are allowed");
		expect(systemPrompt).toContain("durable user preference, constraint, correction, decision, invariant, completed outcome, or long-lived blocker");
		expect(systemPrompt).toContain("Do not copy or lightly paraphrase observation lines");
		expect(systemPrompt).toContain("Prefer fewer, higher-value reflections");
		expect(systemPrompt).toContain("zero reflections than to create one reflection per observation");
		expect(systemPrompt).toContain("Most transient task-log observations");
		expect(systemPrompt).toContain("files inspected, commands run, failed attempts, partial implementation, and current working state");
		expect(systemPrompt).toContain("[coverage: none|partial|strong]");
		expect(systemPrompt).toContain("Coverage tiers are review context");
		expect(systemPrompt).toContain("Coverage is not a quota, target, priority score, or instruction to emit reflections");
		expect(systemPrompt).toContain("Support ids and coverage stewardship");
		expect(systemPrompt).toContain("First decide whether the reflection content passes the durable-value bar");
		expect(systemPrompt).toContain("include all current observation ids whose durable meaning is preserved");
		expect(systemPrompt).toContain("supportingObservationIds are not a checklist");
		expect(systemPrompt).toContain("Do not add ids merely to improve coverage counts");
		expect(systemPrompt).toContain("False or inflated support ids can cause unsafe downstream dropper pruning");
		expect(systemPrompt).toContain("emit zero reflections even when observations have coverage: none");
		expect(systemPrompt).toContain("BAD: completed: edited src/hooks/reflect-drop-trigger.ts");
		expect(systemPrompt).toContain("GOOD: completed: V3 reflect/drop coverage now uses raw progress watermarks");
		expect(systemPrompt).toContain("BAD: npm test passed");
		expect(systemPrompt).toContain("GOOD: completed: V3 package namespace migration passed full tests and typecheck");
		expect(systemPrompt).toContain("ZERO REFLECTIONS: The only new observations are files inspected, commands run, failed attempts, partial implementation, transient debugging, or current working state with no durable conclusion yet");
		expect(systemPrompt).toContain("Focus on:");
		expect(systemPrompt).toContain("User identity, role, preferences, constraints");
		expect(systemPrompt).toContain("Project goals, architecture, technical decisions");
		expect(systemPrompt).toContain("Recurring user behavior or preferences");
		expect(systemPrompt).toContain("Completed outcomes future runs must not redo");
		expect(systemPrompt).toContain("Durable blockers, invariants, and open decisions");
		expect(systemPrompt).toContain("Reflection content rules");
		expect(systemPrompt).toContain("Lead with the fact or pattern");
		expect(systemPrompt).not.toContain("legacy/no-provenance");
		expect(systemPrompt).not.toContain("pruner");
		expect(systemPrompt).not.toContain("Pass strategy");
	});

	it("passes the required Pi 0.81 stream function to the agent loop", async () => {
		let seenStreamFunction: unknown;
		const loop = fakeAgentLoop((_prompts, _context, _config, _signal, streamFunction) => {
			seenStreamFunction = streamFunction;
		});

		await runReflector({ ...baseArgs, agentLoop: loop });

		expect(seenStreamFunction).toBeTypeOf("function");
	});

	it("renders coverage tiers in every active observation line for the reflector", async () => {
		const none = observation("aaaaaaaaaaaa", { content: "Uncovered durable fact" });
		const partial = observation("bbbbbbbbbbbb", { content: "Partially covered fact" });
		const strong = observation("cccccccccccc", { content: "Strongly covered fact" });
		let userText = "";
		const loop = fakeAgentLoop((prompts) => {
			userText = prompts[0].content[0].text;
		});

		await runReflector({
			...baseArgs,
			observations: [none, partial, strong],
			reflections: [
				reflection("rrrrrrrrrrr1", ["bbbbbbbbbbbb", "cccccccccccc"]),
				reflection("rrrrrrrrrrr2", ["cccccccccccc"]),
			],
			agentLoop: loop,
		});

		expect(userText).toContain("[aaaaaaaaaaaa]");
		expect(userText).toContain("[coverage: none] Uncovered durable fact");
		expect(userText).toContain("[coverage: partial] Partially covered fact");
		expect(userText).toContain("[coverage: strong] Strongly covered fact");
		expect(userText).not.toContain("drop-priority");
		expect(userText).not.toContain("drop-resistance");
	});

	it("renders reflector observation lines with coverage evidence only", () => {
		const line = observationToReflectorLine(
			observation("aaaaaaaaaaaa", { relevance: "critical", content: "Important reflected fact" }),
			"partial",
		);

		expect(line).toContain("[aaaaaaaaaaaa]");
		expect(line).toContain("[critical]");
		expect(line).toContain("[coverage: partial]");
		expect(line).toContain("Important reflected fact");
		expect(line).not.toContain("drop-priority");
		expect(line).not.toContain("drop-resistance");
	});

	it("summarizes accepted reflection support-id counts without exposing ids", () => {
		expect(summarizeSupportIdCounts([])).toEqual({
			reflectionCount: 0,
			totalSupportIds: 0,
			minSupportIds: 0,
			maxSupportIds: 0,
			averageSupportIds: 0,
			histogram: {},
		});
		expect(summarizeSupportIdCounts([
			reflection("rrrrrrrrrrr1", ["aaaaaaaaaaaa"]),
			reflection("rrrrrrrrrrr2", ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"]),
		])).toEqual({
			reflectionCount: 2,
			totalSupportIds: 4,
			minSupportIds: 1,
			maxSupportIds: 3,
			averageSupportIds: 2,
			histogram: { "1": 1, "3": 1 },
		});
	});

	it("normalizes supporting observation ids by active observation order", () => {
		expect(normalizeSupportingObservationIds(["bbbbbbbbbbbb", "aaaaaaaaaaaa", "aaaaaaaaaaaa"], ["aaaaaaaaaaaa", "bbbbbbbbbbbb"])).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
		expect(normalizeSupportingObservationIds(["aaaaaaaaaaaa", "missing"], ["aaaaaaaaaaaa"])).toBeUndefined();
		expect(normalizeSupportingObservationIds([], ["aaaaaaaaaaaa"])).toBeUndefined();
	});

	it("records one-line V3 reflections with code-computed ids and token counts", async () => {
		const content = "User prefers source-backed memory.";
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				reflections: [{ content, supportingObservationIds: ["bbbbbbbbbbbb", "aaaaaaaaaaaa"] }],
			});
		});

		const result = await runReflector({ ...baseArgs, agentLoop: loop });

		expect(result).toEqual([{ id: hashId(content), content, supportingObservationIds: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"], tokenCount: estimateStringTokens(content) }]);
	});

	it("rejects invented support ids and multiline content", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				reflections: [
					{ content: "Bad support", supportingObservationIds: ["missing"] },
					{ content: "Two\nlines", supportingObservationIds: ["aaaaaaaaaaaa"] },
				],
			});
		});

		await expect(runReflector({ ...baseArgs, agentLoop: loop })).resolves.toBeUndefined();
	});

	it("dedupes proposals and skips existing reflection ids", async () => {
		const content = "User prefers terse updates.";
		const existing = reflection(hashId(content), ["aaaaaaaaaaaa"], { content });
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				reflections: [
					{ content, supportingObservationIds: ["aaaaaaaaaaaa"] },
					{ content: "New durable fact.", supportingObservationIds: ["aaaaaaaaaaaa"] },
					{ content: "New durable fact.", supportingObservationIds: ["bbbbbbbbbbbb"] },
				],
			});
		});

		const result = await runReflector({ ...baseArgs, reflections: [existing], agentLoop: loop });

		expect(result?.map((item) => item.content)).toEqual(["New durable fact."]);
	});

	it("returns undefined when no tool call records reflections", async () => {
		const loop = fakeAgentLoop(() => {});
		await expect(runReflector({ ...baseArgs, agentLoop: loop })).resolves.toBeUndefined();
	});
});
