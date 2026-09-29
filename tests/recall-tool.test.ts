import { describe, expect, it, vi } from "vitest";

import {
	RECALL_OBSERVATION_TOOL_NAME,
	createRecallTool,
	formatRecallCallForTui,
	formatRecallSearchResultForTui,
	formatRecallRenderedResultForTui,
	recallObservationTool,
	registerRecallTool,
} from "../src/tools/recall-observation.js";
import {
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	compactionEntry,
	oldV2ObservationEntry,
	rawMessage,
	reflection,
	reflectionsDroppedEntry,
	reflectionsRecordedEntry,
	type TestEntry,
} from "./fixtures/session.js";

function fakeCtx(entries: TestEntry[]) {
	const getBranch = vi.fn(() => entries);
	const getEntries = vi.fn(() => {
		throw new Error("recall tool must not use getEntries");
	});
	return { ctx: { sessionManager: { getBranch, getEntries, getSessionId: () => "session-1" } }, getBranch, getEntries };
}

async function execute(id: string | { id?: string; query?: string }, entries: TestEntry[]) {
	const { ctx, getBranch, getEntries } = fakeCtx(entries);
	const params = typeof id === "string" ? { id } : id;
	const result = await recallObservationTool.execute("tool-1", params, undefined as any, undefined as any, ctx as any);
	const text = result.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n");
	return { result, text, getBranch, getEntries };
}

describe("V3 recall tool", () => {
	it("keeps the public tool name and TUI call rendering", () => {
		const pi = { registerTool: vi.fn() };
		registerRecallTool(pi as any);

		expect(RECALL_OBSERVATION_TOOL_NAME).toBe("recall");
		expect(recallObservationTool.name).toBe("recall");
		expect(recallObservationTool.label).toBe("Recall memory evidence");
		expect(formatRecallCallForTui("aaaaaaaaaaaa")).toBe("recall aaaaaaaaaaaa");
		expect(pi.registerTool).toHaveBeenCalledWith(recallObservationTool);
	});

	it("renders active observation source evidence", async () => {
		const obs = observation("aaaaaaaaaaaa", { content: "User likes tea.", sourceEntryIds: ["raw-1"] });
		const entries = [rawMessage("raw-1", "I like tea."), observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" })];

		const { result, text, getBranch, getEntries } = await execute("aaaaaaaaaaaa", entries);

		expect(getBranch).toHaveBeenCalledOnce();
		expect(getEntries).not.toHaveBeenCalled();
		expect(result.details?.status).toBe("ok");
		expect(result.details?.matches[0].observation.status).toBe("active");
		expect(text).toContain("I like tea.");
		expect(formatRecallRenderedResultForTui(result as any, false)).toContain("✓ observation");
	});

	it("renders dropped observations as recallable but dropped", async () => {
		const obs = observation("aaaaaaaaaaaa", { content: "User likes tea.", sourceEntryIds: ["raw-1"] });
		const entries = [
			rawMessage("raw-1", "I like tea."),
			observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
			observationsDroppedEntry("om-drop", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "om-obs" }),
		];

		const { result, text } = await execute("aaaaaaaaaaaa", entries);
		const tui = formatRecallRenderedResultForTui(result as any, false);

		expect(result.details?.matches[0].observation.status).toBe("dropped");
		expect(text).toContain("dropped from active memory but remains recallable");
		expect(tui).toContain("[dropped]");
	});

	it("renders reflection recall with supporting observations and sources", async () => {
		const obs = observation("aaaaaaaaaaaa", { content: "User likes tea.", sourceEntryIds: ["raw-1"] });
		const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: "User likes tea." });
		const entries = [
			rawMessage("raw-1", "I like tea."),
			observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [ref], coversUpToId: "om-obs" }),
		];

		const { result, text } = await execute("eeeeeeeeeeee", entries);

		expect(result.details?.status).toBe("ok");
		expect(result.details?.reflections).toHaveLength(1);
		expect(result.details?.observations).toHaveLength(1);
		expect(text).toContain("Reflections:");
		expect(text).toContain("[eeeeeeeeeeee] User likes tea.");
		expect(text).toContain("Observations:");
		expect(text).toContain("Sources:");
		expect(text).toContain("I like tea.");
	});

	it("reports missing sources as partial", async () => {
		const obs = observation("aaaaaaaaaaaa", { sourceEntryIds: ["missing-raw"] });
		const entries = [observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "om-obs" })];

		const { result, text } = await execute("aaaaaaaaaaaa", entries);

		expect(result.details?.status).toBe("partial");
		expect(result.details?.missingSourceEntryIds).toEqual(["missing-raw"]);
		expect(text).toContain("missing: missing-raw");
	});

	it("reports invalid ids without reading the branch", async () => {
		const { result, text, getBranch } = await execute("not-valid", []);

		expect(result.details?.status).toBe("invalid_id");
		expect(text).toContain("12 lowercase hex characters for memory");
		expect(getBranch).not.toHaveBeenCalled();
	});

	it("reports not found and ignores old V2 memory", async () => {
		const entries = [oldV2ObservationEntry("v2-obs")];

		const { result, text } = await execute("aaaaaaaaaaaa", entries);

		expect(result.details?.status).toBe("not_found");
		expect(text).toContain("No observation or reflection with id aaaaaaaaaaaa was found");
	});
	it("searches by query and expands transcript hits by entry id", async () => {
		const entries = [
			rawMessage("abcd1234", "The deploy failed because the S3 bucket policy denied PutObject."),
			rawMessage("abcd5678", "Recent turn."),
			compactionEntry("cmp-1", { firstKeptEntryId: "abcd5678" }),
		];

		const search = await execute({ query: "bucket policy" }, entries);
		expect(search.text).toContain("[abcd1234] transcript");
		expect(search.text).toContain("Pass an id to recall");

		const expanded = await execute("abcd1234", entries);
		expect(expanded.result.details?.status).toBe("ok");
		expect(expanded.text).toContain("denied PutObject");

		const both = await execute({ query: "bucket", id: "abcd1234" }, entries);
		expect(both.result.details?.status).toBe("invalid_id");
	});

	it("renders dropped reflections as recallable but dropped", async () => {
		const obs = observation("aaaaaaaaaaaa", { content: "User likes tea.", sourceEntryIds: ["raw-1"] });
		const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: "User likes tea." });
		const entries = [
			rawMessage("raw-1", "I like tea."),
			observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [ref], coversUpToId: "om-obs" }),
			reflectionsDroppedEntry("om-ref-drop", { reflectionIds: ["eeeeeeeeeeee"], coversUpToId: "om-ref" }),
		];

		const { result, text } = await execute("eeeeeeeeeeee", entries);
		const tui = formatRecallRenderedResultForTui(result as any, false);

		expect(result.details?.status).toBe("ok");
		expect(result.details?.reflections[0].status).toBe("dropped");
		expect(text).toContain("Reflection eeeeeeeeeeee is dropped from active memory but remains recallable.");
		expect(text).toContain("[eeeeeeeeeeee] [dropped] User likes tea.");
		expect(tui).toContain("one or more reflections are dropped from active memory but remain recallable");
		// Supporting evidence survives the tombstone.
		expect(text).toContain("I like tea.");
	});

	it("leaves an active reflection unmarked", async () => {
		const obs = observation("aaaaaaaaaaaa", { content: "User likes tea.", sourceEntryIds: ["raw-1"] });
		const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: "User likes tea." });
		const entries = [
			rawMessage("raw-1", "I like tea."),
			observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [ref], coversUpToId: "om-obs" }),
		];

		const { result, text } = await execute("eeeeeeeeeeee", entries);

		expect(result.details?.reflections[0].status).toBe("active");
		expect(text).not.toContain("[dropped]");
	});

	it("reports embedding progress while a query waits for the index", async () => {
		const entries = [
			rawMessage("abcd1234", "The deploy failed because the S3 bucket policy denied PutObject."),
			rawMessage("abcd5678", "Recent turn."),
			compactionEntry("cmp-1", { firstKeptEntryId: "abcd5678" }),
		];
		const scorer = vi.fn(async (_sessionId: string, _entries: unknown, docs: unknown[], _query: string, options: any) => {
			options.onProgress({ done: 0, total: 0 });
			options.onProgress({ done: 16, total: 40 });
			return docs.map(() => 1);
		});
		const onUpdate = vi.fn();
		const signal = new AbortController().signal;
		const { ctx } = fakeCtx(entries);
		const result = await createRecallTool(scorer).execute("tool-1", { query: "bucket" }, signal, onUpdate, ctx as any);

		expect(scorer).toHaveBeenCalledWith("session-1", entries, expect.any(Array), "bucket", expect.objectContaining({ signal }));
		expect(onUpdate).toHaveBeenCalledTimes(1);
		const partial = onUpdate.mock.calls[0][0];
		expect(partial.content[0].text).toBe("Embedding recall documents 16 / 40 before searching…");
		expect(formatRecallSearchResultForTui(partial.details)).toBe("\n… embedding 16 / 40 documents before searching");
		expect(result.details).toMatchObject({ mode: "search", semantic: true });
		expect(result.details).not.toHaveProperty("indexing");
	});
});
