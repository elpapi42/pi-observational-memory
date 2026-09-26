import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import {
	compactionEntry,
	observation,
	observationsRecordedEntry,
	rawMessage,
	type TestEntry,
} from "./fixtures/session.js";

function chain(entries: TestEntry[]): TestEntry[] {
	return entries.map((entry, index) => ({ ...entry, parentId: entries[index - 1]?.id ?? null }));
}

async function compact(entries: TestEntry[], firstKeptEntryId: string) {
	let handler: ((event: unknown, ctx: unknown) => Promise<any>) | undefined;
	registerCompactionHook({
		on(eventName: string, callback: typeof handler) {
			expect(eventName).toBe("session_before_compact");
			handler = callback;
		},
	} as any, {
		config: { observationsPoolMaxTokens: 20_000 },
		compactHookInFlight: false,
		ensureConfig() {},
	} as any);
	if (!handler) throw new Error("compaction hook was not registered");

	const result = await handler({
		preparation: { firstKeptEntryId, tokensBefore: 123 },
		branchEntries: entries,
	}, { cwd: "/tmp/project", hasUI: false });
	if (!result?.compaction) throw new Error("fixture must produce a memory-owned compaction");

	const checkpoint = compactionEntry("cmp-current", {
		firstKeptEntryId: result.compaction.firstKeptEntryId,
		summary: result.compaction.summary,
		details: result.compaction.details,
	}, { parentId: entries.at(-1)?.id ?? null });
	const projection = buildSessionProjection([...entries, checkpoint] as any);
	return {
		compaction: result.compaction,
		visibleEntryIds: projection.entries.filter((entry) => entry.messages.length > 0).map((entry) => entry.sourceEntry.id),
	};
}

function recorded(id: string, coversUpToId: string, sourceEntryIds: string[]) {
	return observationsRecordedEntry(`om-${id}`, {
		observations: [observation(id, { sourceEntryIds })],
		coversUpToId,
	});
}

describe("coverage-safe memory compaction (issue #90)", () => {
	it("keeps Pi's cut when no source message lies between observation coverage and the retained tail", async () => {
		const entries = chain([
			rawMessage("m1", "already observed"),
			recorded("aaaaaaaaaaaa", "m1", ["m1"]),
			rawMessage("m2", "recent tail"),
		]);

		const result = await compact(entries, "m2");

		expect(result.compaction.firstKeptEntryId).toBe("m2");
		expect(result.visibleEntryIds).toEqual(["cmp-current", "m2"]);
	});

	it("retains source messages that the observer has not covered before Pi's cut", async () => {
		const entries = chain([
			rawMessage("m1", "already observed"),
			recorded("aaaaaaaaaaaa", "m1", ["m1"]),
			rawMessage("m2", "unobserved decision"),
			rawMessage("m3", "recent tail"),
		]);

		const result = await compact(entries, "m3");

		expect(result.compaction.firstKeptEntryId).toBe("m2");
		expect(result.visibleEntryIds).toEqual(["cmp-current", "m2", "m3"]);
	});

	it("retains pre-cut source when a recorded observation batch crosses Pi's cut", async () => {
		const entries = chain([
			rawMessage("m1", "already observed"),
			recorded("aaaaaaaaaaaa", "m1", ["m1"]),
			rawMessage("m2", "decision in crossing batch"),
			rawMessage("m3", "first kept"),
			rawMessage("m4", "batch end"),
			recorded("bbbbbbbbbbbb", "m4", ["m2"]),
		]);

		const result = await compact(entries, "m3");

		expect(result.compaction.summary).not.toContain("bbbbbbbbbbbb");
		expect(result.compaction.firstKeptEntryId).toBe("m2");
		expect(result.visibleEntryIds).toEqual(["cmp-current", "m2", "m3", "m4"]);
	});

	it("keeps an uncovered tool result with its matching assistant tool call", async () => {
		const entries = chain([
			rawMessage("m1", "user request"),
			rawMessage("m2", "", { message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
			} }),
			rawMessage("m3", "", { message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "unobserved result" }],
				isError: false,
			} }),
			recorded("aaaaaaaaaaaa", "m2", ["m2"]),
			rawMessage("m4", "recent tail"),
		]);

		const result = await compact(entries, "m4");

		expect(result.compaction.firstKeptEntryId).toBe("m2");
		expect(result.visibleEntryIds).toEqual(["cmp-current", "m2", "m3", "m4"]);
	});

	it("retains uncovered raw tail on a second compaction after a prior native compaction", async () => {
		const entries = chain([
			rawMessage("m1", "old source"),
			recorded("aaaaaaaaaaaa", "m1", ["m1"]),
			rawMessage("m2", "retained by the prior native compaction"),
			compactionEntry("cmp-native", { firstKeptEntryId: "m2", summary: "NATIVE_ONLY_FACT" }),
			rawMessage("m3", "new uncovered source"),
			rawMessage("m4", "recent tail"),
		]);

		const result = await compact(entries, "m4");

		expect(result.compaction.firstKeptEntryId).toBe("m2");
		expect(result.visibleEntryIds).toEqual(["cmp-current", "m2", "m3", "m4"]);
	});
});
