import { describe, expect, it } from "vitest";

import {
	applyReflectionProposals,
	renderReflectionsForReflectorPrompt,
	runReflector,
	type ReflectionProposal,
} from "../src/compaction.js";
import { hashId } from "../src/ids.js";
import { buildReflectorPassGuidance, REFLECTOR_SYSTEM } from "../src/prompts.js";
import type { MemoryReflection, ObservationRecord, ReflectionRecord } from "../src/types.js";

const obsA: ObservationRecord = {
	id: "111111111111",
	timestamp: "2026-05-03 10:00",
	relevance: "high",
	content: "User prefers forks for code exploration.",
	sourceEntryIds: ["entry-a"],
};

const obsB: ObservationRecord = {
	id: "222222222222",
	timestamp: "2026-05-03 10:01",
	relevance: "medium",
	content: "User reiterated that implementation work should use forks.",
	sourceEntryIds: ["entry-b"],
};

const obsC: ObservationRecord = {
	id: "333333333333",
	timestamp: "2026-05-03 10:02",
	relevance: "critical",
	content: "User decided multi-pass reflection should run before pruning tags.",
	sourceEntryIds: ["entry-c"],
};

const observations = [obsA, obsB, obsC];
const allowedObservationIds = observations.map((o) => o.id);

function nativeReflection(content = "User prefers fork-based investigation.", support = [obsA.id]): ReflectionRecord {
	return {
		id: hashId(content),
		content,
		supportingObservationIds: support,
	};
}

function migratedLegacyReflection(content = "User prefers fork-based investigation."): ReflectionRecord {
	return {
		id: hashId(content),
		content,
		supportingObservationIds: [],
		legacy: true,
	};
}

function apply(
	reflections: MemoryReflection[],
	proposals: readonly ReflectionProposal[],
	minSupportingObservationIds: number,
) {
	return applyReflectionProposals(reflections, proposals, allowedObservationIds, { minSupportingObservationIds });
}

function fakeAgentLoop(handler: (prompts: any[], context: any) => Promise<void> | void): any {
	return ((prompts: any[], context: any) => ({
		async *[Symbol.asyncIterator]() {
			// No streaming events needed for these tests.
		},
		result: async () => {
			await handler(prompts, context);
			return {};
		},
	})) as any;
}

function promptText(prompts: any[]): string {
	return prompts[0].content[0].text;
}

describe("reflector pass guidance", () => {
	it("describes the three specialized reflector passes", () => {
		expect(buildReflectorPassGuidance(1, 3)).toContain("multi-observation synthesis");
		expect(buildReflectorPassGuidance(1, 3)).toContain("at least 2 distinct supportingObservationIds");
		expect(buildReflectorPassGuidance(2, 3)).toContain("atomic durable facts + safety review");
		expect(buildReflectorPassGuidance(2, 3)).toContain("single authoritative observation");
		expect(buildReflectorPassGuidance(2, 3)).toContain("Review high and critical observations");
		expect(buildReflectorPassGuidance(3, 3)).toContain("coverage strengthening");
		expect(buildReflectorPassGuidance(3, 3)).toContain("additional supportingObservationIds");
		expect(buildReflectorPassGuidance(3, 3)).toContain("Do not create low-quality reflections just for coverage");
	});

	it("teaches the reflector merge, promotion, and coverage contracts", () => {
		expect(REFLECTOR_SYSTEM).toContain("exact same reflection content with additional supportingObservationIds");
		expect(REFLECTOR_SYSTEM).toContain("promote a legacy/no-provenance reflection");
		expect(REFLECTOR_SYSTEM).toContain("omit any bracketed id handle");
		expect(REFLECTOR_SYSTEM).toContain("Rewording creates a separate reflection");
		expect(REFLECTOR_SYSTEM).toContain("durable meaning is captured by the reflection");
		expect(REFLECTOR_SYSTEM).toContain("coverage/provenance set, not merely the smallest proof example set");
		expect(REFLECTOR_SYSTEM).toContain("Do not include observations whose unique exact detail");
		expect(REFLECTOR_SYSTEM).not.toContain("smallest exact set of current observation ids");
		expect(REFLECTOR_SYSTEM).not.toContain("metadata after \" · \"");
	});
});

describe("reflector prompt rendering", () => {
	it("renders current reflections flat with ids only", () => {
		const native = nativeReflection();
		const legacy = migratedLegacyReflection("Legacy no-provenance fact.");
		const rendered = renderReflectionsForReflectorPrompt([
			native,
			legacy,
			"Plain fallback reflection.",
		]);

		expect(rendered).toContain(`[${native.id}] ${native.content}`);
		expect(rendered).toContain(`[${legacy.id}] ${legacy.content}`);
		expect(rendered).toContain("Plain fallback reflection.");
		expect(rendered).not.toContain("supports:");
		expect(rendered).not.toContain("provenance:");
		expect(rendered).not.toContain("legacy string/no id");
		expect(rendered).not.toContain(" · ");
	});
});

describe("reflection proposal acceptance", () => {
	it("enforces pass-specific minimum support counts", () => {
		const oneSupport = [{ content: "User prefers fork-based investigation.", supportingObservationIds: [obsA.id] }];
		const twoSupports = [{ content: "User repeatedly prefers fork-based investigation.", supportingObservationIds: [obsA.id, obsB.id] }];

		expect(apply([], oneSupport, 2)).toMatchObject({ accepted: 0, unsupported: 1, reflections: [] });
		expect(apply([], twoSupports, 2)).toMatchObject({ accepted: 1, added: 1 });
		expect(apply([], oneSupport, 1)).toMatchObject({ accepted: 1, added: 1 });
	});

	it("rejects invalid or hallucinated support ids", () => {
		const result = apply([], [{ content: "Invalid support.", supportingObservationIds: [obsA.id, "not-in-pool"] }], 1);

		expect(result).toMatchObject({ accepted: 0, unsupported: 1, reflections: [] });
	});

	it("merges exact-content native reflection supports in observation-pool order", () => {
		const existing = nativeReflection("User prefers fork-based investigation.", [obsB.id]);
		const result = apply(
			[existing],
			[{ content: existing.content, supportingObservationIds: [obsC.id, obsA.id] }],
			1,
		);

		expect(result).toMatchObject({ accepted: 1, merged: 1 });
		expect(result.reflections).toEqual([
			{
				...existing,
				supportingObservationIds: [obsA.id, obsB.id, obsC.id],
			},
		]);
	});

	it("preserves historical support ids while ordering current support ids by observation pool", () => {
		const historicalObservationId = "aaaaaaaaaaaa";
		const existing = nativeReflection("User prefers fork-based investigation.", [historicalObservationId, obsB.id]);
		const result = apply(
			[existing],
			[{ content: existing.content, supportingObservationIds: [obsC.id, obsA.id] }],
			1,
		);

		expect(result).toMatchObject({ accepted: 1, merged: 1 });
		expect(result.reflections).toEqual([
			{
				...existing,
				supportingObservationIds: [historicalObservationId, obsA.id, obsB.id, obsC.id],
			},
		]);
	});

	it("treats exact-content native proposals with no new supports as no-ops", () => {
		const existing = nativeReflection("User prefers fork-based investigation.", [obsA.id, obsB.id]);
		const result = apply([existing], [{ content: existing.content, supportingObservationIds: [obsB.id, obsA.id] }], 1);

		expect(result).toMatchObject({ accepted: 0, duplicates: 1 });
		expect(result.reflections).toEqual([existing]);
	});

	it("promotes exact-content migrated legacy records to native provenance-backed records", () => {
		const legacy = migratedLegacyReflection();
		const result = apply([legacy], [{ content: legacy.content, supportingObservationIds: [obsA.id, obsC.id] }], 1);

		expect(result).toMatchObject({ accepted: 1, promoted: 1 });
		expect(result.reflections).toEqual([
			{
				id: legacy.id,
				content: legacy.content,
				supportingObservationIds: [obsA.id, obsC.id],
			},
		]);
	});

	it("promotes exact-content plain legacy strings defensively", () => {
		const result = apply(["Plain legacy reflection."], [{ content: "Plain legacy reflection.", supportingObservationIds: [obsC.id] }], 1);

		expect(result).toMatchObject({ accepted: 1, promoted: 1 });
		expect(result.reflections).toEqual([
			{
				id: hashId("Plain legacy reflection."),
				content: "Plain legacy reflection.",
				supportingObservationIds: [obsC.id],
			},
		]);
	});
});

describe("runReflector multi-pass orchestration", () => {
	it("runs passes sequentially and passes accepted reflections forward", async () => {
		const calls: string[] = [];
		const loop = fakeAgentLoop(async (prompts, context) => {
			const text = promptText(prompts);
			const tool = context.tools[0];
			const toolSchemaText = JSON.stringify(tool.parameters);
			calls.push(text);

			expect(toolSchemaText).toContain("durable meaning is captured by this reflection");
			expect(toolSchemaText).toContain("covered active-memory detail");
			expect(toolSchemaText).not.toContain("Smallest exact set");

			if (calls.length === 1) {
				expect(text).toContain("Pass 1 of up to 3");
				expect(text).toContain("multi-observation synthesis");
				await tool.execute("pass-1", {
					reflections: [{ content: "User consistently prefers fork-based investigation.", supportingObservationIds: [obsA.id, obsB.id] }],
				});
				return;
			}
			if (calls.length === 2) {
				expect(text).toContain("Pass 2 of up to 3");
				expect(text).toContain("atomic durable facts + safety review");
				expect(text).toContain(`[${hashId("User consistently prefers fork-based investigation.")}] User consistently prefers fork-based investigation.`);
				expect(text).not.toContain("supports:");
				await tool.execute("pass-2", {
					reflections: [{ content: "User decided multi-pass reflection should precede pruning tags.", supportingObservationIds: [obsC.id] }],
				});
				return;
			}
			expect(text).toContain("Pass 3 of up to 3");
			expect(text).toContain("coverage strengthening");
			expect(text).toContain("User decided multi-pass reflection should precede pruning tags.");
			await tool.execute("pass-3", {
				reflections: [{ content: "User consistently prefers fork-based investigation.", supportingObservationIds: [obsC.id, obsA.id] }],
			});
		});

		const result = await runReflector({ model: {} as any, apiKey: "test", agentLoop: loop }, [], observations);

		expect(calls).toHaveLength(3);
		expect(result.reflections).toEqual([
			{
				id: hashId("User consistently prefers fork-based investigation."),
				content: "User consistently prefers fork-based investigation.",
				supportingObservationIds: [obsA.id, obsB.id, obsC.id],
			},
			{
				id: hashId("User decided multi-pass reflection should precede pruning tags."),
				content: "User decided multi-pass reflection should precede pruning tags.",
				supportingObservationIds: [obsC.id],
			},
		]);
		expect(result.stats).toMatchObject({
			toolCalls: 3,
			accepted: 3,
			added: 2,
			merged: 1,
			promoted: 0,
			duplicates: 0,
			unsupported: 0,
		});
		expect(result.stats.failedPass).toBeUndefined();
		expect(result.stats.passes).toMatchObject([
			{ pass: 1, toolCalls: 1, accepted: 1, added: 1, failed: false },
			{ pass: 2, toolCalls: 1, accepted: 1, added: 1, failed: false },
			{ pass: 3, toolCalls: 1, accepted: 1, merged: 1, failed: false },
		]);
	});

	it("salvages accepted reflections from a failed pass and stops before later passes", async () => {
		let calls = 0;
		const loop = fakeAgentLoop(async (_prompts, context) => {
			calls++;
			const tool = context.tools[0];
			if (calls === 1) {
				await tool.execute("pass-1", {
					reflections: [{ content: "User consistently prefers fork-based investigation.", supportingObservationIds: [obsA.id, obsB.id] }],
				});
				return;
			}
			if (calls === 2) {
				await tool.execute("pass-2", {
					reflections: [{ content: "User decided multi-pass reflection should precede pruning tags.", supportingObservationIds: [obsC.id] }],
				});
				throw new Error("reflector pass failed");
			}
			throw new Error("pass 3 should not run");
		});

		const result = await runReflector({ model: {} as any, apiKey: "test", agentLoop: loop }, [], observations);

		expect(calls).toBe(2);
		expect(result.reflections.map((reflection) => typeof reflection === "string" ? reflection : reflection.content)).toEqual([
			"User consistently prefers fork-based investigation.",
			"User decided multi-pass reflection should precede pruning tags.",
		]);
		expect(result.stats.failedPass).toBe(2);
		expect(result.stats).toMatchObject({ toolCalls: 2, accepted: 2, added: 2 });
		expect(result.stats.passes).toMatchObject([
			{ pass: 1, toolCalls: 1, accepted: 1, added: 1, failed: false },
			{ pass: 2, toolCalls: 1, accepted: 1, added: 1, failed: true },
		]);
	});
});
