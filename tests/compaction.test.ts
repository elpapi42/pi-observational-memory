import { describe, expect, it, vi } from "vitest";

const agentLoopMock = vi.hoisted(() => vi.fn());

vi.mock("@mariozechner/pi-agent-core", () => ({
	agentLoop: agentLoopMock,
}));

import { observationPoolTokens, migrateLegacyReflections, normalizeSupportingObservationIds, renderSummary } from "../src/compaction.js";
import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { hashId } from "../src/ids.js";
import { observationsToPromptLines } from "../src/observer.js";
import { CONTEXT_USAGE_INSTRUCTIONS, REFLECTOR_SYSTEM } from "../src/prompts.js";
import { estimateStringTokens } from "../src/tokens.js";
import type { MemoryReflection, ObservationRecord, ReflectionRecord } from "../src/types.js";
import { compactionEntry, messageEntry, observationEntry } from "./fixtures/session.js";

const observation: ObservationRecord = {
	id: "abc123def456",
	timestamp: "2026-05-02 10:30",
	relevance: "high",
	content: "User confirmed recall should use exact supporting source entry ids.",
	sourceEntryIds: ["entry-user", "entry-tool"],
};

const reflectionContent = "User values exact source traceability.";
const reflectionRecord: ReflectionRecord = {
	id: hashId(reflectionContent),
	content: reflectionContent,
	supportingObservationIds: [observation.id],
};

const migratedLegacyRecord: ReflectionRecord = {
	id: hashId("Migrated legacy reflection."),
	content: "Migrated legacy reflection.",
	supportingObservationIds: [],
	legacy: true,
};

function emptyAgentStream() {
	return {
		async *[Symbol.asyncIterator]() {
			// no model events needed for this test
		},
		result: async () => ({}),
	};
}

describe("legacy reflection migration", () => {
	it("converts eligible legacy string reflections into id-bearing legacy records", () => {
		const migrated = migrateLegacyReflections(["  Migrated legacy reflection.  "]);

		expect(migrated).toEqual([migratedLegacyRecord]);
	});

	it("preserves native records and migrated records unchanged", () => {
		const migrated = migrateLegacyReflections([reflectionRecord, migratedLegacyRecord]);

		expect(migrated).toEqual([reflectionRecord, migratedLegacyRecord]);
	});

	it("dedupes by reflection content while preferring native records over migrated legacy records", () => {
		const migrated = migrateLegacyReflections([
			reflectionContent,
			reflectionRecord,
			"Migrated legacy reflection.",
			"Migrated legacy reflection.",
		]);

		expect(migrated).toEqual([reflectionRecord, migratedLegacyRecord]);
	});

	it("normalizes multiline legacy string reflections into id-bearing legacy records", () => {
		const migrated = migrateLegacyReflections(["Legacy reflection with\nmultiple\tlines."]);

		expect(migrated).toEqual([
			{
				id: hashId("Legacy reflection with multiple lines."),
				content: "Legacy reflection with multiple lines.",
				supportingObservationIds: [],
				legacy: true,
			},
		]);
	});

	it("checks multiline migration eligibility before truncating normalized content", () => {
		const newlineAfterTruncationBoundary = `${"x".repeat(10_001)}\nsecond line`;
		const [migrated] = migrateLegacyReflections([newlineAfterTruncationBoundary]);

		const truncatedContent = `${"x".repeat(10_000)} … [truncated 13 chars]`;
		expect(migrated).toEqual({
			id: hashId(truncatedContent),
			content: truncatedContent,
			supportingObservationIds: [],
			legacy: true,
		});
	});

	it("preserves empty legacy strings as plain strings", () => {
		const empty = "   ";

		expect(migrateLegacyReflections([empty])).toEqual([empty]);
	});
});

describe("reflection supporting observation normalization", () => {
	const allowed = ["111111111111", "222222222222", "333333333333"];

	it("accepts supporting observation ids from the working observation pool and orders them by pool order", () => {
		expect(normalizeSupportingObservationIds(["333333333333", "111111111111"], allowed)).toEqual([
			"111111111111",
			"333333333333",
		]);
	});

	it("dedupes repeated supporting observation ids", () => {
		expect(normalizeSupportingObservationIds(["222222222222", "222222222222", "111111111111"], allowed)).toEqual([
			"111111111111",
			"222222222222",
		]);
	});

	it("rejects missing, empty, hallucinated, or unsupported supporting observation ids", () => {
		expect(normalizeSupportingObservationIds(undefined, allowed)).toBeUndefined();
		expect(normalizeSupportingObservationIds([], allowed)).toBeUndefined();
		expect(normalizeSupportingObservationIds(["111111111111", "not-in-pool"], allowed)).toBeUndefined();
		expect(normalizeSupportingObservationIds(["111111111111"], [])).toBeUndefined();
	});
});

describe("compaction hook", () => {
	it("uses rendered observation tokens for the reflector/pruner gate", async () => {
		agentLoopMock.mockReset();
		agentLoopMock.mockImplementation(() => emptyAgentStream());

		let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
		const pi = {
			on: vi.fn((eventName: string, cb: typeof handler) => {
				expect(eventName).toBe("session_before_compact");
				handler = cb;
			}),
			appendEntry: vi.fn(),
		};
		const shortObservation: ObservationRecord = {
			id: "111111111111",
			timestamp: "2026-05-02 10:30",
			relevance: "medium",
			content: "x",
			sourceEntryIds: ["source-entry"],
		};
		const contentOnlyTokens = estimateStringTokens(shortObservation.content);
		const renderedTokens = observationPoolTokens([shortObservation]);
		const threshold = contentOnlyTokens + 1;

		expect(contentOnlyTokens).toBeLessThan(threshold);
		expect(renderedTokens).toBeGreaterThan(threshold);

		const runtime = {
			compactHookInFlight: false,
			observerPromise: null,
			resolveFailureNotified: false,
			config: {
				observationThresholdTokens: 1,
				compactionThresholdTokens: 50_000,
				reflectionThresholdTokens: threshold,
				passive: false,
			},
			ensureConfig: vi.fn(),
			resolveModel: vi.fn(async () => ({ ok: true, model: {}, apiKey: "test-key" })),
		};
		registerCompactionHook(pi as never, runtime as never);
		if (!handler) throw new Error("session_before_compact handler was not registered");

		const entries = [
			messageEntry({ id: "source-entry", message: { role: "user", content: "source" } }),
			observationEntry({
				id: "observation-entry",
				data: {
					records: [shortObservation],
					coversFromId: "source-entry",
					coversUpToId: "source-entry",
					tokenCount: contentOnlyTokens,
				},
			}),
			messageEntry({ id: "kept-entry", message: { role: "user", content: "kept tail" } }),
		];
		const notify = vi.fn();
		const result = await handler({
			preparation: { firstKeptEntryId: "kept-entry", tokensBefore: 123 },
			branchEntries: entries,
			signal: undefined,
		}, {
			cwd: "/tmp/project",
			hasUI: true,
			ui: { notify, setWidget: vi.fn() },
			sessionManager: { getBranch: vi.fn(() => entries) },
		});

		expect(result).toMatchObject({
			compaction: {
				firstKeptEntryId: "kept-entry",
				details: { observations: [shortObservation] },
			},
		});
		expect(notify).toHaveBeenCalledWith("Observational memory: running reflector + pruner...", "info");
		const notifyMessages = notify.mock.calls.map(([message]) => String(message));
		expect(notifyMessages.some((message) => message.includes("Observational memory: diagnostics") && message.includes("reflector") && message.includes("coverage") && message.includes("pruner") && message.includes("zero_drops"))).toBe(true);
		expect(agentLoopMock).toHaveBeenCalledTimes(4);
		expect(agentLoopMock.mock.calls.map(([, context]) => context.tools[0].name)).toEqual([
			"record_reflections",
			"record_reflections",
			"record_reflections",
			"drop_observations",
		]);
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(observationsToPromptLines([shortObservation]).join("\n")).toContain("[111111111111]");
	});

	it("explains zero-delta compaction cancellations with committed and pending counts", async () => {
		agentLoopMock.mockReset();

		let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
		const pi = {
			on: vi.fn((eventName: string, cb: typeof handler) => {
				expect(eventName).toBe("session_before_compact");
				handler = cb;
			}),
			appendEntry: vi.fn(),
		};
		const runtime = {
			compactHookInFlight: false,
			observerPromise: null,
			resolveFailureNotified: false,
			config: {
				observationThresholdTokens: 1,
				compactionThresholdTokens: 50_000,
				reflectionThresholdTokens: 1,
				passive: false,
			},
			ensureConfig: vi.fn(),
			resolveModel: vi.fn(async () => ({ ok: true, model: {}, apiKey: "test-key" })),
		};
		registerCompactionHook(pi as never, runtime as never);
		if (!handler) throw new Error("session_before_compact handler was not registered");

		const entries = [
			messageEntry({ id: "source-entry", message: { role: "user", content: "source" } }),
			messageEntry({ id: "kept-entry", message: { role: "user", content: "kept" } }),
			observationEntry({
				id: "observation-entry",
				data: {
					records: [observation],
					coversFromId: "source-entry",
					coversUpToId: "kept-entry",
					tokenCount: estimateStringTokens(observation.content),
				},
			}),
			compactionEntry({
				id: "prior-compaction",
				firstKeptEntryId: "kept-entry",
				details: {
					type: "observational-memory",
					version: 4,
					observations: [observation],
					reflections: [reflectionRecord],
				},
			}),
			messageEntry({ id: "tail-entry", message: { role: "user", content: "tail" } }),
		];
		const notify = vi.fn();
		const result = await handler({
			preparation: { firstKeptEntryId: "tail-entry", tokensBefore: 123 },
			branchEntries: entries,
			signal: undefined,
		}, {
			cwd: "/tmp/project",
			hasUI: true,
			ui: { notify, setWidget: vi.fn() },
			sessionManager: { getBranch: vi.fn(() => entries) },
		});

		expect(result).toMatchObject({
			compaction: {
				firstKeptEntryId: "tail-entry",
				tokensBefore: 123,
				details: {
					type: "observational-memory",
					version: 4,
					observations: [observation],
					reflections: [expect.objectContaining({ content: reflectionRecord.content })],
				},
			},
		});
		expect(agentLoopMock).not.toHaveBeenCalled();
		const notifyMessages = notify.mock.calls.map(([message]) => String(message));
		expect(notifyMessages.some((message) => message.includes("no new observations") && message.includes("carrying forward"))).toBe(true);
	});
});

describe("renderSummary", () => {
	it("renders compacted observations with ids for recall and legacy reflections as plain prose", () => {
		const summary = renderSummary(["User values exact source traceability."], [observation]);

		expect(summary).toContain("## Reflections\nUser values exact source traceability.");
		expect(summary).toContain(
			"## Observations\n[abc123def456] 2026-05-02 10:30 [high] User confirmed recall should use exact supporting source entry ids.",
		);
	});

	it("renders id-bearing reflection records with ids for recall", () => {
		const summary = renderSummary([reflectionRecord], [observation]);

		expect(summary).toContain(`## Reflections\n[${reflectionRecord.id}] ${reflectionContent}`);
		expect(summary).toContain("## Observations\n[abc123def456] 2026-05-02 10:30 [high]");
	});

	it("renders migrated legacy reflection records with ids like native records", () => {
		const [migrated] = migrateLegacyReflections(["Migrated legacy reflection."]);
		const summary = renderSummary([migrated], [observation]);

		expect(summary).toContain(`## Reflections\n[${migratedLegacyRecord.id}] Migrated legacy reflection.`);
		expect(summary).not.toContain("legacy: true");
		expect(summary).not.toContain("supportingObservationIds");
	});

	it("keeps raw source and reflection provenance metadata out of compact summaries", () => {
		const reflections: MemoryReflection[] = [reflectionRecord];
		const summary = renderSummary(reflections, [observation]);

		expect(summary).not.toContain("sourceEntryIds");
		expect(summary).not.toContain("entry-user");
		expect(summary).not.toContain("entry-tool");
		expect(summary).not.toContain("supportingObservationIds");
		expect(summary).not.toContain(`supportingObservationIds: [${observation.id}]`);
	});

	it("includes concise on-demand recall guidance for observation and reflection ids", () => {
		expect(CONTEXT_USAGE_INSTRUCTIONS).toContain("New reflection lines may include ids in brackets.");
		expect(CONTEXT_USAGE_INSTRUCTIONS).toContain("Observation lines include ids in brackets.");
		expect(CONTEXT_USAGE_INSTRUCTIONS).toContain("recall tool");
		expect(CONTEXT_USAGE_INSTRUCTIONS).toContain("observation or reflection id");
		expect(CONTEXT_USAGE_INSTRUCTIONS).toContain("materially affects a decision");
		expect(CONTEXT_USAGE_INSTRUCTIONS).toContain("Do not use recall as broad search");
	});

	it("tells the reflector to cite supporting observation ids and not invent them", () => {
		expect(REFLECTOR_SYSTEM).toContain("supportingObservationIds");
		expect(REFLECTOR_SYSTEM).toContain("Never invent supporting observation ids");
		expect(REFLECTOR_SYSTEM).toContain("will be rejected and not recorded");
	});
});
