import { describe, expect, it, vi } from "vitest";

import { Runtime } from "../src/runtime.js";
import {
	RECALL_OBSERVATION_TOOL_NAME,
	formatRecallCallForTui,
	formatRecallRenderedResultForTui,
	recallObservationTool,
	registerRecallTool,
} from "../src/tools/recall-observation.js";
import {
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	oldV2ObservationEntry,
	rawMessage,
	reflection,
	reflectionsRecordedEntry,
	type TestEntry,
} from "./fixtures/session.js";

function fakeCtx(entries: TestEntry[]) {
	const getBranch = vi.fn(() => entries);
	const getEntries = vi.fn(() => {
		throw new Error("recall tool must not use getEntries");
	});
	return { ctx: { sessionManager: { getBranch, getEntries } }, getBranch, getEntries };
}

async function execute(id: string, entries: TestEntry[]) {
	const { ctx, getBranch, getEntries } = fakeCtx(entries);
	const result = await recallObservationTool.execute("tool-1", { id }, undefined as any, undefined as any, ctx as any);
	const text = result.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n");
	return { result, text, getBranch, getEntries };
}

describe("V3 recall tool", () => {
	it("keeps the public tool name and TUI call rendering", () => {
		const pi = { registerTool: vi.fn() };
		const runtime = new Runtime();

		registerRecallTool(pi as any, runtime);

		expect(RECALL_OBSERVATION_TOOL_NAME).toBe("recall");
		expect(recallObservationTool.name).toBe("recall");
		expect(recallObservationTool.label).toBe("Recall memory evidence");
		expect(formatRecallCallForTui("aaaaaaaaaaaa")).toBe("recall aaaaaaaaaaaa");
		expect(pi.registerTool).toHaveBeenCalledWith(
			expect.objectContaining({ name: "recall", label: "Recall memory evidence" }),
		);
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
		expect(text).toContain("Memory id must be 12 lowercase hex characters");
		expect(getBranch).not.toHaveBeenCalled();
	});

	it("reports not found and ignores old V2 memory", async () => {
		const entries = [oldV2ObservationEntry("v2-obs")];

		const { result, text } = await execute("aaaaaaaaaaaa", entries);

		expect(result.details?.status).toBe("not_found");
		expect(text).toContain("No observation or reflection with id aaaaaaaaaaaa was found");
	});

	describe("gated by runtime.enabled (#12)", () => {
		function registeredTool(runtime: Runtime) {
			const pi = { registerTool: vi.fn() };
			registerRecallTool(pi as any, runtime);
			return pi.registerTool.mock.calls[0]?.[0] as typeof recallObservationTool;
		}

		it("returns the stable disabled message without reading the branch while disabled", async () => {
			const runtime = new Runtime();
			runtime.enabled = false;
			const tool = registeredTool(runtime);
			const { ctx, getBranch } = fakeCtx([oldV2ObservationEntry("v2-obs")]);

			const result = await tool.execute("tool-1", { id: "aaaaaaaaaaaa" }, undefined as any, undefined as any, ctx as any);
			const text = result.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n");

			expect(text).toBe("Observational memory is disabled; run /om to enable it.");
			expect(result.details?.status).toBe("disabled");
			expect(getBranch).not.toHaveBeenCalled();
		});

		it("returns the disabled message even for a malformed id, without validating it", async () => {
			const runtime = new Runtime();
			runtime.enabled = false;
			const tool = registeredTool(runtime);
			const { ctx } = fakeCtx([]);

			const result = await tool.execute("tool-1", { id: "not-a-valid-id" }, undefined as any, undefined as any, ctx as any);
			const text = result.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n");

			expect(text).toBe("Observational memory is disabled; run /om to enable it.");
			expect(result.details?.status).toBe("disabled");
		});

		it("performs the normal recall lookup once enabled", async () => {
			const runtime = new Runtime();
			runtime.enabled = true;
			const tool = registeredTool(runtime);
			const obs = observation("aaaaaaaaaaaa", { content: "User likes tea.", sourceEntryIds: ["raw-1"] });
			const entries = [rawMessage("raw-1", "I like tea."), observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" })];
			const { ctx, getBranch } = fakeCtx(entries);

			const result = await tool.execute("tool-1", { id: "aaaaaaaaaaaa" }, undefined as any, undefined as any, ctx as any);

			expect(getBranch).toHaveBeenCalledOnce();
			expect(result.details?.status).toBe("ok");
		});
	});
});
