/**
 * Tests for gap detection after compaction in passive mode.
 *
 * Bug: observation entries from before compaction can have coversUpToId values
 * pointing to entries before the compaction boundary. gapRawEntries() would include
 * all those already-compact entries in the gap, creating a massive chunk that
 * exceeds the model's context window when passed to the sync catch-up observer.
 *
 * Fix: gapRawEntries() clamps the start boundary to at least the last compaction
 * entry index, so only entries after the last compaction are included in the gap.
 */
import { describe, expect, it, vi } from "vitest";

const agentLoopMock = vi.hoisted(() => vi.fn());
const codingAgentMock = vi.hoisted(() => ({ agentDir: "" }));

vi.mock("@mariozechner/pi-agent-core", () => ({
	agentLoop: agentLoopMock,
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
	getAgentDir: () => codingAgentMock.agentDir,
	estimateTokens: (msg: any) => {
		if (typeof msg?.content === "string") return Math.ceil(msg.content.length / 4);
		return 0;
	},
}));

import { gapRawEntries, lastObservationCoverEndIdx } from "../src/branch.js";
import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { estimateStringTokens } from "../src/tokens.js";
import type { ObservationRecord } from "../src/types.js";
import { compactionEntry, messageEntry, observationEntry } from "./fixtures/session.js";

const observation: ObservationRecord = {
	id: "abc123def456",
	timestamp: "2026-05-02 10:30",
	relevance: "high",
	content: "User confirmed recall should use exact supporting source entry ids.",
	sourceEntryIds: ["source-before-compact"],
};

function emptyAgentStream() {
	return {
		async *[Symbol.asyncIterator]() {},
		result: async () => ({}),
	};
}

describe("gap detection after compaction", () => {
	it("lastObservationCoverEndIdx returns -1 when observation entries have dangling coversUpToId", () => {
		const entries = [
			compactionEntry({
				id: "prior-compaction",
				firstKeptEntryId: "kept-1",
				details: {
					type: "observational-memory",
					version: 4,
					observations: [observation],
					reflections: [],
				},
			}),
			messageEntry({ id: "kept-1", message: { role: "user", content: "kept tail message 1" } }),
			messageEntry({ id: "kept-2", message: { role: "user", content: "kept tail message 2" } }),
			// This observation entry survived compaction but its coversUpToId points to
			// an entry that no longer exists in the branch
			observationEntry({
				id: "surviving-obs",
				data: {
					records: [observation],
					coversFromId: "source-before-compact", // gone after compaction
					coversUpToId: "source-before-compact", // gone after compaction
					tokenCount: 100,
				},
			}),
			messageEntry({ id: "kept-3", message: { role: "user", content: "more tail" } }),
		];

		const result = lastObservationCoverEndIdx(entries);
		expect(result).toBe(-1);
	});

	it("gapRawEntries clamps to compaction entry when lastObservationCoverEndIdx is -1", () => {
		const entries = [
			compactionEntry({
				id: "prior-compaction",
				firstKeptEntryId: "kept-1",
				details: {
					type: "observational-memory",
					version: 4,
					observations: [observation],
					reflections: [],
				},
			}),
			messageEntry({ id: "kept-1", message: { role: "user", content: "a".repeat(1000) } }),
			messageEntry({ id: "kept-2", message: { role: "user", content: "b".repeat(1000) } }),
			messageEntry({ id: "kept-3", message: { role: "user", content: "c".repeat(1000) } }),
			messageEntry({ id: "new-boundary", message: { role: "user", content: "d".repeat(1000) } }),
			messageEntry({ id: "kept-5", message: { role: "user", content: "e".repeat(1000) } }),
		];

		// lastBoundIdx = -1, clamped to compaction entry index = 0
		// gap = entries from index 1 to "new-boundary"-1 = kept-1, kept-2, kept-3
		const gap = gapRawEntries(entries, "new-boundary");

		expect(gap.length).toBe(3);
		expect(gap.map((e) => e.id)).toEqual(["kept-1", "kept-2", "kept-3"]);
	});

	it("gapRawEntries excludes entries before compaction when observation cover is pre-compaction", () => {
		// Scenario: observation entry exists BEFORE the compaction entry with a valid
		// coversUpToId pointing to an entry that also exists before compaction.
		// Without the fix, the gap would include all entries from the observation cover
		// to the new boundary — including the pre-compaction entries that are already
		// represented in the compaction details.
		const entries = [
			// Pre-compaction entries (already represented in compaction details)
			messageEntry({ id: "old-source", message: { role: "user", content: "old content" } }),
			messageEntry({ id: "old-source-2", message: { role: "user", content: "more old content" } }),
			// Observation entry from previous sync catch-up — coversUpToId points to pre-compaction entry
			observationEntry({
				id: "old-obs",
				data: {
					records: [observation],
					coversFromId: "old-source",
					coversUpToId: "old-source-2", // valid — entry exists in branch
					tokenCount: 100,
				},
			}),
			// Compaction entry — marks boundary between compact and live
			compactionEntry({
				id: "prior-compaction",
				firstKeptEntryId: "kept-1",
				details: {
					type: "observational-memory",
					version: 4,
					observations: [observation],
					reflections: [],
				},
			}),
			// Live tail entries — these are the ones that need observation
			messageEntry({ id: "kept-1", message: { role: "user", content: "live content 1" } }),
			messageEntry({ id: "kept-2", message: { role: "user", content: "live content 2" } }),
			messageEntry({ id: "kept-3", message: { role: "user", content: "live content 3" } }),
			messageEntry({ id: "new-boundary", message: { role: "user", content: "boundary" } }),
			messageEntry({ id: "tail", message: { role: "user", content: "kept recent" } }),
		];

		// Without fix: lastBoundIdx = index of "old-source-2" = 1
		//   gap would be entries from index 2 to "new-boundary"-1 = 6
		//   That's [old-obs, prior-compaction, kept-1, kept-2, kept-3] — includes compacted entries!
		//
		// With fix: lastBoundIdx clamped to compaction entry index = 3
		//   gap = entries from index 4 to "new-boundary"-1 = 6
		//   That's [kept-1, kept-2, kept-3] — only live tail entries
		const gap = gapRawEntries(entries, "new-boundary");

		expect(gap.length).toBe(3);
		expect(gap.map((e) => e.id)).toEqual(["kept-1", "kept-2", "kept-3"]);
		// Should NOT include pre-compaction entries
		expect(gap.map((e) => e.id)).not.toContain("old-source");
		expect(gap.map((e) => e.id)).not.toContain("old-source-2");
	});

	it("compaction hook passes only post-compaction gap to observer", async () => {
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
		const runtime = {
			compactHookInFlight: false,
			observerPromise: null,
			resolveFailureNotified: false,
			config: {
				observationThresholdTokens: 1,
				compactionThresholdTokens: 50_000,
				reflectionThresholdTokens: 30_000,
				passive: true,
				debugLog: false,
			},
			ensureConfig: vi.fn(),
			resolveModel: vi.fn(async () => ({ ok: true, model: {}, apiKey: "test-key" })),
		};
		registerCompactionHook(pi as never, runtime as never);
		if (!handler) throw new Error("session_before_compact handler was not registered");

		// Simulate a realistic branch: pre-compaction entries with observation cover,
		// then compaction entry, then live tail that needs observation.
		const entries = [
			// Pre-compaction entries (content already in compaction details)
			messageEntry({ id: "old-source", message: { role: "user", content: "old".repeat(500) } }),
			messageEntry({ id: "old-source-2", message: { role: "user", content: "old2".repeat(500) } }),
			observationEntry({
				id: "old-obs",
				data: {
					records: [observation],
					coversFromId: "old-source",
					coversUpToId: "old-source-2",
					tokenCount: 100,
				},
			}),
			compactionEntry({
				id: "prior-compaction",
				firstKeptEntryId: "kept-1",
				details: {
					type: "observational-memory",
					version: 4,
					observations: [observation],
					reflections: [],
				},
			}),
			// Live tail — these need sync catch-up observation
			messageEntry({ id: "kept-1", message: { role: "user", content: "start of kept tail" } }),
			...Array.from({ length: 10 }, (_, i) =>
				messageEntry({
					id: `raw-${i}`,
					message: { role: "user", content: `Message ${i} content` },
				})
			),
			messageEntry({ id: "new-boundary", message: { role: "user", content: "boundary" } }),
			messageEntry({ id: "tail", message: { role: "user", content: "kept tail" } }),
		];

		const notify = vi.fn();
		const result = await handler({
			preparation: { firstKeptEntryId: "new-boundary", tokensBefore: 50000 },
			branchEntries: entries,
			signal: undefined,
		}, {
			cwd: "/tmp/project",
			hasUI: true,
			ui: { notify, setWidget: vi.fn() },
			sessionManager: { getBranch: vi.fn(() => entries) },
		});

		// The observer was called — at least once for the first turn-aligned chunk
		expect(agentLoopMock).toHaveBeenCalled();

		// Collect all observer prompt texts across all calls
		const allPromptTexts = agentLoopMock.mock.calls
			.map((call) => {
				const prompts = call[0] as Array<{ content: Array<{ text: string }> }>;
				return prompts[0]?.content?.[0]?.text ?? "";
			})
			.filter((text) => text.includes("NEW CONVERSATION CHUNK"));

		// Verify that the first chunk contains the first turn (kept-1)
		// and does NOT contain pre-compaction entries
		expect(allPromptTexts.length).toBeGreaterThanOrEqual(1);
		expect(allPromptTexts[0]).toContain("kept-1");

		// Verify pre-compaction entries are NOT in any chunk
		const combinedText = allPromptTexts.join("\n");
		expect(combinedText).not.toContain("old-source");
		expect(combinedText).not.toContain("old2");

		// Note: the mock agentLoop produces no tool calls, so runObserver returns
		// undefined (no records). The loop breaks after the first empty result.
		// In production, each turn-aligned chunk that produces records would get
		// its own appendEntry call and the loop would continue to the next turn.

		// Verify compaction succeeded
		expect(result).toHaveProperty("compaction");
	});
});
