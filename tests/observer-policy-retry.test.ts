import { describe, expect, it, vi } from "vitest";

import { observeChunkWithThinkingRetry, ObserverStreamError } from "../src/agents/observer/agent.js";
import { serializeSourceAddressedBranchEntries } from "../src/serialize.js";

const entries = [
	{
		type: "message",
		id: "a1",
		timestamp: "2026-05-02T10:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "thinking", thinking: "private plan" }, { type: "text", text: "visible answer" }],
			timestamp: Date.parse("2026-05-02T10:00:00.000Z"),
		},
	},
];

const blocked = new ObserverStreamError("error", "This request was blocked as it seems to violate Anthropic's Terms of Service.");

describe("observer policy-block retry", () => {
	it("serializes thinking by default and can leave it out", () => {
		expect(serializeSourceAddressedBranchEntries(entries).text).toContain("private plan");
		const without = serializeSourceAddressedBranchEntries(entries, { includeThinking: false }).text;
		expect(without).not.toContain("private plan");
		expect(without).toContain("visible answer");
	});

	it("retries a policy-blocked chunk once without thinking", async () => {
		const chunk = serializeSourceAddressedBranchEntries(entries);
		const run = vi.fn(async (text: string) => {
			if (text.includes("private plan")) throw blocked;
			return text;
		});
		const onRetry = vi.fn();
		const result = await observeChunkWithThinkingRetry(entries, chunk, {}, run, onRetry);
		expect(run).toHaveBeenCalledTimes(2);
		expect(result).toContain("[Source entry id: a1]");
		expect(result).not.toContain("private plan");
		expect(onRetry).toHaveBeenCalledWith(blocked);
	});

	it("does not retry other failures or chunks without thinking", async () => {
		const chunk = serializeSourceAddressedBranchEntries(entries);
		const other = new ObserverStreamError("error", "rate limited");
		const failing = vi.fn(async () => { throw other; });
		await expect(observeChunkWithThinkingRetry(entries, chunk, {}, failing)).rejects.toBe(other);
		expect(failing).toHaveBeenCalledTimes(1);

		const plainEntries = [{ ...entries[0], message: { ...entries[0].message, content: [{ type: "text", text: "visible answer" }] } }];
		const plain = serializeSourceAddressedBranchEntries(plainEntries);
		const blockedRun = vi.fn(async () => { throw blocked; });
		await expect(observeChunkWithThinkingRetry(plainEntries, plain, {}, blockedRun)).rejects.toBe(blocked);
		expect(blockedRun).toHaveBeenCalledTimes(1);
	});
});
