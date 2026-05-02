import { describe, expect, it } from "vitest";

import {
	renderRecallSourceEntries,
	serializeBranchEntries,
	serializeSourceAddressedBranchEntries,
} from "../src/serialize.js";
import { branchSummaryEntry, customMessageEntry, messageEntry, observationEntry } from "./fixtures/session.js";

const userMessage = {
	role: "user",
	timestamp: "2026-05-02 10:00",
	content: [
		{ type: "text", text: "Please remember this decision." },
		{ type: "image", data: "base64", mimeType: "image/png" },
	],
};

const assistantMessage = {
	role: "assistant",
	timestamp: "2026-05-02 10:01",
	content: [
		{ type: "text", text: "I will preserve exact source ids." },
		{ type: "thinking", thinking: "visible thought" },
		{ type: "thinking", thinking: "redacted thought", redacted: true },
		{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/types.ts" } },
	],
};

const toolResultMessage = {
	role: "toolResult",
	timestamp: "2026-05-02 10:02",
	toolCallId: "call-1",
	toolName: "read",
	content: [{ type: "text", text: "file contents" }],
	isError: false,
};

describe("source-addressable observer serialization", () => {
	it("renders source ids for source-renderable entries and returns the allowed id list", () => {
		const source = serializeSourceAddressedBranchEntries([
			messageEntry({ id: "entry-user", message: userMessage }),
			customMessageEntry({ id: "entry-custom", customType: "note", content: "custom source" }),
			branchSummaryEntry({ id: "entry-summary", summary: "branch source" }),
			observationEntry({
				id: "entry-observation",
				data: {
					records: [],
					coversFromId: "entry-user",
					coversUpToId: "entry-summary",
					tokenCount: 0,
				},
			}),
		]);

		expect(source.sourceEntryIds).toEqual(["entry-user", "entry-custom", "entry-summary"]);
		expect(source.text).toContain("[Source entry id: entry-user]");
		expect(source.text).toContain("[Source entry id: entry-custom]");
		expect(source.text).toContain("[Source entry id: entry-summary]");
		expect(source.text).not.toContain("entry-observation");
	});

	it("does not alter the existing branch serializer format", () => {
		expect(serializeBranchEntries([messageEntry({ id: "entry-user", message: userMessage })])).toContain(
			"[User @ 2026-05-02 10:00]: Please remember this decision.",
		);
	});
});

describe("recall source rendering", () => {
	it("renders source entries as simple origin, timestamp, and content blocks", () => {
		const rendered = renderRecallSourceEntries([
			messageEntry({ id: "entry-user", message: userMessage }),
			messageEntry({ id: "entry-assistant", message: assistantMessage }),
			messageEntry({ id: "entry-tool", message: toolResultMessage }),
			customMessageEntry({
				id: "entry-custom",
				timestamp: "2026-05-02 10:02",
				customType: "note",
				content: [{ type: "text", text: "custom source" }],
			}),
			branchSummaryEntry({ id: "entry-summary", timestamp: "2026-05-02 10:03", summary: "branch source" }),
		]);

		expect(rendered).toContain("[User @ 2026-05-02 10:00]: Please remember this decision.\n[non-text content omitted]");
		expect(rendered).toContain("[Assistant @ 2026-05-02 10:01]: I will preserve exact source ids.");
		expect(rendered).toContain("[thinking: visible thought]");
		expect(rendered).not.toContain("redacted thought");
		expect(rendered).toContain('[read({"path":"src/types.ts"})]');
		expect(rendered).toContain("[Tool result: read @ 2026-05-02 10:02]: file contents");
		expect(rendered).toContain("[Custom message (note) @ 2026-05-02 10:02]: custom source");
		expect(rendered).toContain("[Branch summary @ 2026-05-02 10:03]: branch source");
	});

	it("falls back from missing message timestamp to entry timestamp and then Unknown time", () => {
		const rendered = renderRecallSourceEntries([
			messageEntry({
				id: "entry-with-entry-time",
				timestamp: "2026-05-02 11:00",
				message: { role: "user", content: "uses entry timestamp" },
			}),
			{ type: "message", id: "entry-no-time", message: { role: "user", content: "uses unknown time" } },
		]);

		expect(rendered).toContain("[User @ 2026-05-02 11:00]: uses entry timestamp");
		expect(rendered).toContain("[User @ Unknown time]: uses unknown time");
	});

	it("excludes custom metadata entries such as om.observation from recalled source evidence", () => {
		const rendered = renderRecallSourceEntries([
			observationEntry({
				id: "entry-observation",
				data: {
					records: [],
					coversFromId: "entry-a",
					coversUpToId: "entry-b",
					tokenCount: 0,
				},
			}),
		]);

		expect(rendered).toBe("");
	});
});
