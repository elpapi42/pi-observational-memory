import { describe, expect, it, vi } from "vitest";

import { registerViewCommand } from "../src/commands/view.js";
import {
	compactionEntry,
	memoryDetails,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	oldV2CompactionDetails,
	oldV2ObservationEntry,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

const COPY_SUCCESS = "Copied /om:view output to clipboard.";
const COPY_FAILURE = "Warning: failed to copy /om:view output to clipboard.";

function setup(entries: TestEntry[], clipboardResult = true) {
	let handler: ((args: unknown, ctx: any) => Promise<void>) | undefined;
	const pi = {
		registerCommand: vi.fn((name: string, command: { handler: typeof handler }) => {
			expect(name).toBe("om:view");
			handler = command.handler;
		}),
	};
	const runtime = { enabled: true, ensureConfig: vi.fn() };
	const copyToClipboard = vi.fn(async () => clipboardResult);
	registerViewCommand(pi as any, runtime as any, { copyToClipboard });
	if (!handler) throw new Error("view handler not registered");
	const notify = vi.fn();
	const ctx = { cwd: "/tmp/project", ui: { notify }, sessionManager: { getBranch: () => entries } };
	const run = async (args: unknown = []) => {
		await handler!(args, ctx);
		return {
			output: notify.mock.calls.at(-1)?.[0] as string,
			clipboardText: copyToClipboard.mock.calls.at(-1)?.[0] as string | undefined,
			copyToClipboard,
		};
	};
	return { run, notify, copyToClipboard };
}

function expectNoDiagnostics(output: string) {
	expect(output).not.toContain("Memory view:");
	expect(output).not.toContain("Memory diff:");
	expect(output).not.toContain("recorded / ");
	expect(output).not.toContain("dropped");
	expect(output).not.toContain(" visible +");
	expect(output).not.toContain("tokens");
	expect(output).not.toContain("Observation pool");
	expect(output).not.toContain("Reflection pool");
	expect(output).not.toContain("Full fold pool");
	expect(output).not.toContain("only in full");
}

describe("V3 /om:view", () => {
	it("renders no-memory visible output as content-only sections and copies it", async () => {
		const { output, clipboardText, copyToClipboard } = await setup([]).run();
		const expected = [
			"── Reflections ──",
			"No visible reflections.",
			"",
			"── Observations ──",
			"No visible observations.",
		].join("\n");

		expect(copyToClipboard).toHaveBeenCalledTimes(1);
		expect(clipboardText).toBe(expected);
		expect(output).toBe(`${expected}\n\n${COPY_SUCCESS}`);
		expect(output).not.toContain("committed");
		expect(output).not.toContain("pending");
		expectNoDiagnostics(output);
	});

	it("default view renders latest visible om.folded memory content only and copies clean output", async () => {
		const obs = observation("aaaaaaaaaaaa");
		const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs", { observations: [observation("bbbbbbbbbbbb")], coversUpToId: "raw-1" }),
			compactionEntry("cmp", { firstKeptEntryId: "raw-1", details: memoryDetails({ observations: [obs], reflections: [ref] }) }),
		];

		const { output, clipboardText, copyToClipboard } = await setup(entries).run();

		expect(copyToClipboard).toHaveBeenCalledTimes(1);
		expect(clipboardText).toContain("── Reflections ──");
		expect(clipboardText).toContain("[eeeeeeeeeeee] Reflection eeeeeeeeeeee");
		expect(clipboardText).toContain("── Observations ──");
		expect(clipboardText).toContain("[aaaaaaaaaaaa]");
		expect(clipboardText).not.toContain("bbbbbbbbbbbb");
		expect(clipboardText).not.toContain(COPY_SUCCESS);
		expect(output).toBe(`${clipboardText}\n\n${COPY_SUCCESS}`);
		expectNoDiagnostics(output);
	});

	it("full view folds recorded V3 memory, excludes dropped observations, and copies clean output", async () => {
		const obsA = observation("aaaaaaaaaaaa", { content: "Dropped observation content" });
		const obsB = observation("bbbbbbbbbbbb", { content: "Kept observation content" });
		const ref = reflection("eeeeeeeeeeee", ["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			oldV2ObservationEntry("v2-obs"),
			compactionEntry("cmp-v2", { firstKeptEntryId: "raw-1", details: oldV2CompactionDetails() }),
			observationsRecordedEntry("om-obs", { observations: [obsA, obsB], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [ref], coversUpToId: "om-obs" }),
			observationsDroppedEntry("om-drop", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "om-ref" }),
		];

		const { output, clipboardText, copyToClipboard } = await setup(entries).run(["full"]);

		expect(copyToClipboard).toHaveBeenCalledTimes(1);
		expect(clipboardText).toContain("── Reflections ──");
		expect(clipboardText).toContain("[eeeeeeeeeeee] Reflection eeeeeeeeeeee");
		expect(clipboardText).toContain("── Observations ──");
		expect(clipboardText).toContain("[bbbbbbbbbbbb]");
		expect(clipboardText).toContain("Kept observation content");
		expect(clipboardText).not.toContain("[aaaaaaaaaaaa]");
		expect(clipboardText).not.toContain("Dropped observation content");
		expect(clipboardText).not.toContain("v2-obs");
		expect(clipboardText).not.toContain("observational-memory");
		expect(output).toBe(`${clipboardText}\n\n${COPY_SUCCESS}`);
		expectNoDiagnostics(output);
	});

	it("full view renders recorded empty states and copies them", async () => {
		const { output, clipboardText } = await setup([]).run(["full"]);
		const expected = [
			"── Reflections ──",
			"No recorded reflections.",
			"",
			"── Observations ──",
			"No recorded observations.",
		].join("\n");

		expect(clipboardText).toBe(expected);
		expect(output).toBe(`${expected}\n\n${COPY_SUCCESS}`);
		expectNoDiagnostics(output);
	});

	it("keeps rendering the memory view when clipboard copy fails", async () => {
		const { output, clipboardText, copyToClipboard } = await setup([], false).run();
		const expected = [
			"── Reflections ──",
			"No visible reflections.",
			"",
			"── Observations ──",
			"No visible observations.",
		].join("\n");

		expect(copyToClipboard).toHaveBeenCalledTimes(1);
		expect(clipboardText).toBe(expected);
		expect(clipboardText).not.toContain("failed to copy");
		expect(output).toBe(`${expected}\n\n${COPY_FAILURE}`);
	});

	it("rejects unsupported view arguments without copying", async () => {
		const { output, clipboardText, copyToClipboard } = await setup([]).run(["diff"]);

		expect(copyToClipboard).not.toHaveBeenCalled();
		expect(clipboardText).toBeUndefined();
		expect(output).toBe("Usage: /om:view [full]");
	});
});

describe("V3 /om:view gated by runtime.enabled (#12)", () => {
	it("returns only the stable disabled message and never reads config, the branch, or clipboard", async () => {
		let handler: ((args: unknown, ctx: any) => Promise<void>) | undefined;
		const pi = { registerCommand: vi.fn((_name: string, command: { handler: typeof handler }) => { handler = command.handler; }) };
		const ensureConfig = vi.fn();
		const runtime = { enabled: false, ensureConfig };
		const copyToClipboard = vi.fn(async () => true);
		registerViewCommand(pi as any, runtime as any, { copyToClipboard });
		if (!handler) throw new Error("view handler not registered");

		const notify = vi.fn();
		const getBranch = vi.fn(() => []);
		await handler(["full"], { cwd: "/tmp/project", ui: { notify }, sessionManager: { getBranch } });

		expect(notify).toHaveBeenCalledWith("Observational memory is disabled; run /om to enable it.", "info");
		expect(ensureConfig).not.toHaveBeenCalled();
		expect(getBranch).not.toHaveBeenCalled();
		expect(copyToClipboard).not.toHaveBeenCalled();
	});
});
