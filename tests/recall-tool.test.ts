import { describe, expect, it, vi } from "vitest";

import observationalMemory from "../src/index.js";
import {
	RECALL_OBSERVATION_SOURCE_CHAR_LIMIT,
	RECALL_OBSERVATION_TOOL_NAME,
	recallObservationTool,
} from "../src/tools/recall-observation.js";
import type { ObservationRecord } from "../src/types.js";
import { messageEntry, observationEntry } from "./fixtures/session.js";

const observationId = "abc123def456";

const baseObservation = {
	id: observationId,
	content: "User confirmed exact source ids are required.",
	timestamp: "2026-05-02 10:00",
	relevance: "high",
} satisfies ObservationRecord;

function obsEntry(id: string, records: ObservationRecord[]) {
	return observationEntry({
		id,
		data: {
			records,
			coversFromId: "source-user",
			coversUpToId: "source-user",
			tokenCount: 12,
		},
	});
}

function sourceEntry(id = "source-user", content = "Please preserve exact sources.") {
	return messageEntry({
		id,
		message: { role: "user", timestamp: "2026-05-02 10:00", content },
	});
}

function fakeCtx(entries: unknown[]) {
	const getBranch = vi.fn(() => entries);
	const getEntries = vi.fn(() => {
		throw new Error("recall tool must not use getEntries");
	});
	return {
		ctx: { sessionManager: { getBranch, getEntries } },
		getBranch,
		getEntries,
	};
}

async function executeRecall(id: string, entries: unknown[]) {
	const fake = fakeCtx(entries);
	const result = await recallObservationTool.execute("tool-call", { id }, undefined, undefined, fake.ctx as never);
	return { result, ...fake };
}

describe("recall_observation tool registration", () => {
	it("is registered from the extension entrypoint without removing existing registrations", () => {
		const pi = {
			on: vi.fn(),
			registerCommand: vi.fn(),
			registerTool: vi.fn(),
		};

		observationalMemory(pi as never);

		expect(pi.on).toHaveBeenCalledTimes(3);
		expect(pi.registerCommand).toHaveBeenCalledTimes(2);
		expect(pi.registerTool).toHaveBeenCalledTimes(1);
		expect(pi.registerTool.mock.calls[0][0].name).toBe(RECALL_OBSERVATION_TOOL_NAME);
	});

	it("defines prompt metadata so the actor can discover the narrow recall tool", () => {
		expect(recallObservationTool.name).toBe("recall_observation");
		expect(recallObservationTool.promptSnippet).toContain("observation id");
		expect(recallObservationTool.promptGuidelines?.join("\n")).toContain("not general search");
	});
});

describe("recall_observation tool execution", () => {
	it("returns a simple source list for a source-attributed observation and uses only getBranch", async () => {
		const { result, getBranch, getEntries } = await executeRecall(observationId, [
			sourceEntry(),
			obsEntry("obs-entry", [{ ...baseObservation, sourceEntryIds: ["source-user"] }]),
		]);

		expect(result.details.status).toBe("ok");
		expect(result.details.matches).toHaveLength(1);
		expect(result.details.matches[0]).toMatchObject({ status: "ok", sourceEntryIds: ["source-user"] });
		expect(result.content[0].text).toBe("[User @ 2026-05-02 10:00]: Please preserve exact sources.");
		expect(getBranch).toHaveBeenCalledTimes(1);
		expect(getEntries).not.toHaveBeenCalled();
	});

	it("returns invalid_id for malformed ids", async () => {
		const { result, getBranch } = await executeRecall("not-an-id", []);

		expect(result.details.status).toBe("invalid_id");
		expect(result.content[0].text).toContain("12 lowercase hex characters");
		expect(getBranch).not.toHaveBeenCalled();
	});

	it("returns not_found when no current-branch observation has the id", async () => {
		const { result } = await executeRecall(observationId, [
			sourceEntry(),
			obsEntry("obs-entry", [{ ...baseObservation, id: "fedcba654321", sourceEntryIds: ["source-user"] }]),
		]);

		expect(result.details.status).toBe("not_found");
		expect(result.details.matches).toEqual([]);
		expect(result.content[0].text).toContain("No observation with id abc123def456 was found on the current branch");
	});

	it("returns no_source for legacy observations without using batch fallback", async () => {
		const { result } = await executeRecall(observationId, [
			sourceEntry(),
			obsEntry("legacy-entry", [baseObservation]),
		]);

		expect(result.details.status).toBe("no_source");
		expect(result.details.matches).toEqual([
			expect.objectContaining({ status: "no_source", observationEntryId: "legacy-entry" }),
		]);
		expect(result.content[0].text).toContain("has no source entries associated");
		expect(result.content[0].text).toContain("legacy observations");
		expect(result.content[0].text).not.toContain("Please preserve exact sources.");
	});

	it("returns source_unavailable when source ids are missing or point to metadata", async () => {
		const metadataEntry = obsEntry("metadata-entry", [
			{ ...baseObservation, id: "fedcba654321", sourceEntryIds: ["source-user"] },
		]);
		const { result } = await executeRecall(observationId, [
			sourceEntry(),
			metadataEntry,
			obsEntry("obs-entry", [
				{ ...baseObservation, sourceEntryIds: ["source-user", "missing-source", "metadata-entry"] },
			]),
		]);

		expect(result.details.status).toBe("source_unavailable");
		expect(result.details.matches[0]).toMatchObject({
			status: "source_unavailable",
			missingSourceEntryIds: ["missing-source"],
			nonSourceEntryIds: ["metadata-entry"],
		});
		expect(result.content[0].text).toContain("some are unavailable on the current branch");
		expect(result.content[0].text).not.toContain("[User @ 2026-05-02 10:00]");
	});

	it("returns all duplicate id matches instead of choosing one", async () => {
		const { result } = await executeRecall(observationId, [
			sourceEntry("source-a", "first source"),
			sourceEntry("source-b", "second source"),
			obsEntry("first-obs-entry", [{ ...baseObservation, sourceEntryIds: ["source-a"] }]),
			obsEntry("second-obs-entry", [{ ...baseObservation, content: "duplicate", sourceEntryIds: ["source-b"] }]),
			obsEntry("legacy-entry", [{ ...baseObservation, content: "legacy duplicate" }]),
		]);

		expect(result.details.status).toBe("ok");
		expect(result.details.collision).toBe(true);
		expect(result.details.matches.map((match) => match.status)).toEqual(["ok", "ok", "no_source"]);
		expect(result.content[0].text).toContain("Multiple observations share id abc123def456");
		expect(result.content[0].text).toContain("[User @ 2026-05-02 10:00]: first source");
		expect(result.content[0].text).toContain("[User @ 2026-05-02 10:00]: second source");
		expect(result.content[0].text).toContain("has no source entries associated");
	});

	it("returns too_large with no partial source content when rendered evidence exceeds the bound", async () => {
		const longSource = `start-${"x".repeat(RECALL_OBSERVATION_SOURCE_CHAR_LIMIT)}-end`;
		const { result } = await executeRecall(observationId, [
			sourceEntry("source-large", longSource),
			obsEntry("obs-entry", [{ ...baseObservation, sourceEntryIds: ["source-large"] }]),
		]);

		expect(result.details.status).toBe("too_large");
		expect(result.details.sourceCharacterLimit).toBe(RECALL_OBSERVATION_SOURCE_CHAR_LIMIT);
		expect(result.details.sourceCharacterCount).toBeGreaterThan(RECALL_OBSERVATION_SOURCE_CHAR_LIMIT);
		expect(result.content[0].text).toContain("too large to return safely");
		expect(result.content[0].text).toContain("No partial source content was returned");
		expect(result.content[0].text).not.toContain("start-");
		expect(result.content[0].text).not.toContain("-end");
	});
});
