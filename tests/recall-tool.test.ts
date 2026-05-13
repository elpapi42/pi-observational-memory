import { describe, expect, it, vi } from "vitest";

import observationalMemory from "../src/index.js";
import {
	RECALL_OBSERVATION_TOOL_NAME,
	formatRecallCallForTui,
	formatRecallHeaderForTui,
	formatRecallRenderedResultForTui,
	formatRecallResultForTui,
	recallObservationTool,
} from "../src/tools/recall-observation.js";
import type { MemoryDetailsV4, ObservationRecord, ReflectionRecord } from "../src/types.js";
import { compactionEntry, messageEntry, observationEntry } from "./fixtures/session.js";

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

const reflection = {
	id: "111111111111",
	content: "User prefers recallable durable reflections.",
	supportingObservationIds: [baseObservation.id],
} satisfies ReflectionRecord;

const migratedLegacyReflection = {
	id: "222222222222",
	content: "Migrated legacy reflection without recorded provenance.",
	supportingObservationIds: [],
	legacy: true,
} satisfies ReflectionRecord;

function memoryDetailsV4(reflections: MemoryDetailsV4["reflections"] = [reflection], observations: ObservationRecord[] = []): MemoryDetailsV4 {
	return {
		type: "observational-memory",
		version: 4,
		observations,
		reflections,
	};
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

describe("recall tool registration", () => {
	it("is registered from the extension entrypoint without removing existing registrations", () => {
		const pi = {
			on: vi.fn(),
			registerCommand: vi.fn(),
			registerTool: vi.fn(),
		};

		observationalMemory(pi as never);

		expect(pi.on).toHaveBeenCalledTimes(3);
		expect(pi.registerCommand).toHaveBeenCalledTimes(3);
		expect(pi.registerTool).toHaveBeenCalledTimes(1);
		expect(pi.registerTool.mock.calls[0][0].name).toBe(RECALL_OBSERVATION_TOOL_NAME);
	});

	it("defines prompt metadata so the actor can discover the narrow recall tool", () => {
		expect(recallObservationTool.name).toBe("recall");
		expect(recallObservationTool.label).toBe("Recall memory evidence");
		expect(formatRecallCallForTui(observationId)).toBe("recall abc123def456");
		expect(recallObservationTool.description).toContain("Recover exact evidence and source context");
		expect(recallObservationTool.promptSnippet).toContain("precision matters");
		const guidelines = recallObservationTool.promptGuidelines?.join("\n") ?? "";
		expect(guidelines).toContain("important decision");
		expect(guidelines).toContain("exact wording, rationale, file paths, commands, errors, commits, user constraints, or provenance");
		expect(guidelines).toContain("not use recall as semantic search or transcript browsing");
		expect(guidelines).toContain("Do not recall every id preemptively");
	});
});

describe("recall tool execution", () => {
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

	it("formats collapsed and expanded TUI output from metadata without truncating observation content", async () => {
		const fullObservationContent = "User wants recalled observation content shown fully in collapsed and expanded TUI views, without truncation.";
		const assistantSource = messageEntry({
			id: "source-assistant",
			message: {
				role: "assistant",
				timestamp: "2026-05-02 10:01",
				content: [
					{ type: "text", text: "I will inspect the code." },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/tools/recall-observation.ts" } },
				],
			},
		});
		const { result } = await executeRecall(observationId, [
			sourceEntry(),
			assistantSource,
			obsEntry("obs-entry", [
				{ ...baseObservation, content: fullObservationContent, sourceEntryIds: ["source-user", "source-assistant"] },
			]),
		]);

		const header = formatRecallHeaderForTui(result.details);
		const collapsed = formatRecallResultForTui(result, false);
		const renderedCollapsed = formatRecallRenderedResultForTui(result, false);
		const expanded = formatRecallResultForTui(result, true);

		expect(header).toContain("✓ success · 1 observation · 2 sources");
		expect(formatRecallCallForTui(observationId)).toBe("recall abc123def456");
		expect(collapsed).not.toContain("✓ success");
		expect(collapsed).not.toContain("recall abc123def456");
		expect(collapsed.startsWith(`✓ observation   2026-05-02 10:00 [high]`)).toBe(true);
		expect(renderedCollapsed.startsWith(`\n✓ success · 1 observation · 2 sources`)).toBe(true);
		expect(renderedCollapsed).toContain(`\n\n✓ observation   2026-05-02 10:00 [high]`);
		expect(renderedCollapsed).toContain(fullObservationContent);
		expect(renderedCollapsed).not.toContain("recall abc123def456");
		expect(collapsed).toContain(`✓ observation   2026-05-02 10:00 [high]`);
		expect(collapsed).toContain(fullObservationContent);
		expect(collapsed).toContain("\n\n✓ source        2026-05-02 10:00 [user]");
		expect(collapsed).toContain("✓ source        2026-05-02 10:01 [assistant]");
		expect(collapsed).not.toContain("• note");
		expect(collapsed).not.toContain("source-user");
		expect(collapsed).not.toContain("tool calls: read");
		expect(collapsed).not.toContain("Please preserve exact sources.");
		expect(collapsed).not.toContain("I will inspect the code.");
		expect(collapsed).toContain("(Ctrl+O to expand)");

		expect(expanded).toContain(`✓ observation   2026-05-02 10:00 [high]`);
		expect(expanded).toContain(fullObservationContent);
		expect(expanded).toContain("    Please preserve exact sources.");
		expect(expanded).toContain("    I will inspect the code.");
		expect(expanded).toContain('[read({"path":"src/tools/recall-observation.ts"})]');
		expect(expanded).not.toContain("    [User @ 2026-05-02 10:00]:");
		expect(expanded).not.toContain("    [Assistant @ 2026-05-02 10:01]:");
	});

	it("renders reflection recall with reflection rows, observation rows, and a shared source section", async () => {
		const { result, getBranch, getEntries } = await executeRecall(reflection.id, [
			sourceEntry(),
			obsEntry("supporting-entry", [{ ...baseObservation, sourceEntryIds: ["source-user"] }]),
			compactionEntry({ id: "compaction-current", details: memoryDetailsV4([reflection]) }),
		]);

		expect(result.details.status).toBe("ok");
		expect(result.details.reflections.map((item) => item.id)).toEqual([reflection.id]);
		expect(result.details.observations.map((item) => item.observation.id)).toEqual([baseObservation.id]);
		expect(result.details.sourceEntries.map((entry) => entry.id)).toEqual(["source-user"]);
		expect(result.content[0].text).toContain(`Reflections:\n[${reflection.id}] ${reflection.content}`);
		expect(result.content[0].text).toContain(`Observations:\n[${baseObservation.id}] 2026-05-02 10:00 [high] ${baseObservation.content}`);
		expect(result.content[0].text).toContain("Sources:\n[User @ 2026-05-02 10:00]: Please preserve exact sources.");
		expect(getBranch).toHaveBeenCalledTimes(1);
		expect(getEntries).not.toHaveBeenCalled();

		const header = formatRecallHeaderForTui(result.details);
		const collapsed = formatRecallResultForTui(result, false);
		const expanded = formatRecallResultForTui(result, true);
		expect(header).toContain("✓ success · 1 reflection · 1 observation · 1 source");
		expect(collapsed).toContain(`✓ reflection`);
		expect(collapsed).toContain(reflection.content);
		expect(collapsed).not.toContain(`✓ reflection · ${reflection.id}`);
		expect(collapsed).toContain(`✓ observation   2026-05-02 10:00 [high]`);
		expect(collapsed).toContain(baseObservation.content);
		expect(collapsed.indexOf("✓ reflection")).toBeLessThan(collapsed.indexOf("✓ observation"));
		expect(collapsed.indexOf("✓ observation")).toBeLessThan(collapsed.indexOf("✓ source"));
		expect(collapsed).not.toContain("• note");
		expect(collapsed).not.toContain("Please preserve exact sources.");
		expect(collapsed).toContain("(Ctrl+O to expand)");
		expect(expanded).toContain("    Please preserve exact sources.");
	});

	it("returns all evidence for mixed observation/reflection id conflicts", async () => {
		const supportingObservation = {
			...baseObservation,
			id: "222222222222",
			content: "Supporting observation for the colliding reflection.",
			sourceEntryIds: ["source-b"],
		} satisfies ObservationRecord;
		const collidingReflection = { ...reflection, id: observationId, supportingObservationIds: [supportingObservation.id] } satisfies ReflectionRecord;
		const { result } = await executeRecall(observationId, [
			sourceEntry("source-a", "direct observation source"),
			sourceEntry("source-b", "supporting observation source"),
			obsEntry("direct-entry", [{ ...baseObservation, sourceEntryIds: ["source-a"] }]),
			obsEntry("support-entry", [supportingObservation]),
			compactionEntry({ id: "compaction-current", details: memoryDetailsV4([collidingReflection]) }),
		]);

		expect(result.details.status).toBe("ok");
		expect(result.details.collision).toBe(true);
		expect(result.details.reflections.map((item) => item.id)).toEqual([observationId]);
		expect(result.details.directObservationMatches.map((item) => item.observation.id)).toEqual([observationId]);
		expect(result.details.observations.map((item) => item.observationEntryId)).toEqual(["direct-entry", "support-entry"]);
		expect(result.details.sourceEntries.map((entry) => entry.id)).toEqual(["source-a", "source-b"]);
		expect(result.content[0].text).toContain("Memory id abc123def456 matched multiple observations/reflections");
		expect(result.content[0].text).toContain("[User @ 2026-05-02 10:00]: direct observation source");
		expect(result.content[0].text).toContain("[User @ 2026-05-02 10:00]: supporting observation source");
		const collapsed = formatRecallResultForTui(result, false);
		expect(formatRecallHeaderForTui(result.details)).toContain("✓ success · 1 reflection · 2 observations · 2 sources");
		expect(collapsed).toContain("• note          [id collision]");
		expect(collapsed).toContain("multiple memory items share abc123def456");
	});

	it("renders no-provenance diagnostics for migrated legacy reflection recall", async () => {
		const { result, getBranch, getEntries } = await executeRecall(migratedLegacyReflection.id, [
			sourceEntry(),
			compactionEntry({ id: "compaction-current", details: memoryDetailsV4([migratedLegacyReflection]) }),
		]);

		expect(result.details.status).toBe("no_provenance");
		expect(result.details.partial).toBe(true);
		expect(result.details.reflections).toEqual([
			expect.objectContaining({ id: migratedLegacyReflection.id, legacy: true, supportingObservationIds: [] }),
		]);
		expect(result.details.observations).toEqual([]);
		expect(result.details.sourceEntries).toEqual([]);
		expect(result.details.unavailableReflectionProvenance).toEqual([
			{ reflectionId: migratedLegacyReflection.id, reflectionIndex: 0, reason: "legacy" },
		]);
		expect(result.content[0].text).toContain(`Reflections:\n[${migratedLegacyReflection.id}] ${migratedLegacyReflection.content}`);
		expect(result.content[0].text).toContain("Unavailable reflection provenance");
		expect(result.content[0].text).toContain("migrated from legacy memory created before reflection provenance was recorded");
		expect(result.content[0].text).not.toContain("Sources:");
		expect(getBranch).toHaveBeenCalledTimes(1);
		expect(getEntries).not.toHaveBeenCalled();

		const header = formatRecallHeaderForTui(result.details);
		const collapsed = formatRecallResultForTui(result, false);
		const expanded = formatRecallResultForTui(result, true);
		expect(header).toContain("✓ success · 1 reflection");
		expect(collapsed).toContain("✓ reflection");
		expect(collapsed).toContain(migratedLegacyReflection.content);
		expect(collapsed).not.toContain(`✓ reflection · ${migratedLegacyReflection.id}`);
		expect(collapsed).toContain("• note          [unavailable evidence]");
		expect(collapsed).toContain("migrated legacy reflection has no supporting observations");
		expect(collapsed).not.toContain("✓ source");
		expect(expanded).not.toContain("Please preserve exact sources.");
	});

	it("returns available evidence and no-provenance diagnostics for mixed legacy reflection id conflicts", async () => {
		const legacyCollision = { ...migratedLegacyReflection, id: observationId } satisfies ReflectionRecord;
		const { result } = await executeRecall(observationId, [
			sourceEntry("source-a", "direct observation source"),
			obsEntry("direct-entry", [{ ...baseObservation, sourceEntryIds: ["source-a"] }]),
			compactionEntry({ id: "compaction-current", details: memoryDetailsV4([legacyCollision]) }),
		]);

		expect(result.details.status).toBe("partial");
		expect(result.details.collision).toBe(true);
		expect(result.details.reflections.map((item) => item.id)).toEqual([observationId]);
		expect(result.details.directObservationMatches.map((item) => item.observation.id)).toEqual([observationId]);
		expect(result.details.sourceEntries.map((entry) => entry.id)).toEqual(["source-a"]);
		expect(result.details.unavailableReflectionProvenance).toEqual([
			{ reflectionId: observationId, reflectionIndex: 0, reason: "legacy" },
		]);
		expect(result.content[0].text).toContain("Memory id abc123def456 matched multiple observations/reflections");
		expect(result.content[0].text).toContain("Unavailable reflection provenance");
		expect(result.content[0].text).toContain("[User @ 2026-05-02 10:00]: direct observation source");
		const collapsed = formatRecallResultForTui(result, false);
		expect(formatRecallHeaderForTui(result.details)).toContain("✓ success · 1 reflection · 1 observation · 1 source");
		expect(collapsed).toContain("• note          [id collision]");
		expect(collapsed).not.toContain("unavailable evidence");
		expect(collapsed).not.toContain("reflection provenance unavailable");
	});

	it("renders partial unavailable diagnostics while preserving available reflection evidence", async () => {
		const metadataEntry = obsEntry("metadata-entry", [
			{ ...baseObservation, id: "333333333333", sourceEntryIds: ["source-user"] },
		]);
		const partialObservation = {
			...baseObservation,
			id: "222222222222",
			content: "Observation with partial source availability.",
			sourceEntryIds: ["source-user", "missing-source", "metadata-entry"],
		} satisfies ObservationRecord;
		const partialReflection = {
			...reflection,
			supportingObservationIds: [partialObservation.id, "999999999999"],
		} satisfies ReflectionRecord;
		const { result } = await executeRecall(partialReflection.id, [
			sourceEntry(),
			metadataEntry,
			obsEntry("partial-support-entry", [partialObservation]),
			compactionEntry({ id: "compaction-current", details: memoryDetailsV4([partialReflection]) }),
		]);

		expect(result.details.status).toBe("partial");
		expect(result.details.partial).toBe(true);
		expect(result.details.sourceEntries.map((entry) => entry.id)).toEqual(["source-user"]);
		expect(result.details.unavailableSupportingObservations.map((item) => item.observationId)).toEqual(["999999999999"]);
		expect(result.details.missingSourceEntryIds).toEqual(["missing-source"]);
		expect(result.details.nonSourceEntryIds).toEqual(["metadata-entry"]);
		expect(result.content[0].text).toContain("Unavailable supporting observations");
		expect(result.content[0].text).toContain("Unavailable source entries: missing: missing-source; non-source: metadata-entry");
		expect(result.content[0].text).toContain("[User @ 2026-05-02 10:00]: Please preserve exact sources.");
		const collapsed = formatRecallResultForTui(result, false);
		expect(formatRecallHeaderForTui(result.details)).toContain("✓ success · 1 reflection · 1 observation · 1 source");
		expect(collapsed).not.toContain("supporting observation unavailable");
		expect(collapsed).not.toContain("source unavailable");
		expect(collapsed).not.toContain("unavailable evidence");
	});

	it("renders partial diagnostics when a reflection is supported by a no-source observation", async () => {
		const legacySupportingObservation = {
			...baseObservation,
			id: "222222222222",
			content: "Legacy observation without source ids supports the reflection.",
		} satisfies ObservationRecord;
		const partialReflection = {
			...reflection,
			supportingObservationIds: [legacySupportingObservation.id],
		} satisfies ReflectionRecord;
		const { result } = await executeRecall(partialReflection.id, [
			obsEntry("legacy-support-entry", [legacySupportingObservation]),
			compactionEntry({ id: "compaction-current", details: memoryDetailsV4([partialReflection]) }),
		]);

		expect(result.details.status).toBe("partial");
		expect(result.details.partial).toBe(true);
		expect(result.details.reflections.map((item) => item.id)).toEqual([partialReflection.id]);
		expect(result.details.observations).toHaveLength(1);
		expect(result.details.observations[0]).toMatchObject({ status: "no_source", observationEntryId: "legacy-support-entry" });
		expect(result.details.sourceEntries).toEqual([]);
		expect(result.content[0].text).toContain("Unavailable observation sources");
		expect(result.content[0].text).toContain("Observation 222222222222 has no source entries associated");
		const collapsed = formatRecallResultForTui(result, false);
		expect(formatRecallHeaderForTui(result.details)).toContain("✓ success · 1 reflection · 1 observation");
		expect(collapsed).toContain("• note          [unavailable evidence]");
		expect(collapsed).toContain("no source entries are available for this memory id");
		expect(collapsed).not.toContain("legacy/unattributed observation");
		expect(collapsed).not.toContain("✓ source");
	});

	it("renders a static recall call and pi-fork-style result body without invalidating", async () => {
		const { result } = await executeRecall(observationId, [
			sourceEntry(),
			obsEntry("obs-entry", [{ ...baseObservation, sourceEntryIds: ["source-user"] }]),
		]);
		const state = {};
		const invalidate = vi.fn();
		const context = { state, invalidate } as never;

		const callComponent = recallObservationTool.renderCall?.({ id: observationId }, undefined as never, context);
		const callText = callComponent?.render(200).join("\n") ?? "";
		expect(callText).toContain("recall abc123def456");
		expect(callText).not.toContain("1 match");

		const resultComponent = recallObservationTool.renderResult?.(
			result,
			{ expanded: false, isPartial: false },
			undefined as never,
			context,
		);

		expect(invalidate).not.toHaveBeenCalled();
		expect(callComponent?.render(200).join("\n") ?? "").toContain("recall abc123def456");
		expect(callComponent?.render(200).join("\n") ?? "").not.toContain("1 match");
		const renderedResult = resultComponent?.render(200) ?? [];
		expect(renderedResult[0].trim()).toBe("");
		const renderedText = renderedResult.join("\n");
		expect(renderedText).toContain("✓ success · 1 observation · 1 source");
		expect(renderedText).not.toContain("recall abc123def456");
		expect(renderedResult[2].trim()).toBe("");
		expect(renderedResult[3].trim()).toContain("✓ observation   2026-05-02 10:00 [high]");
		expect(renderedResult[3].trim()).toContain("User confirmed exact source ids are required.");
	});

	it("returns invalid_id for malformed ids", async () => {
		const { result, getBranch } = await executeRecall("not-an-id", []);

		expect(result.details.status).toBe("invalid_id");
		expect(result.content[0].text).toContain("12 lowercase hex characters");
		expect(formatRecallHeaderForTui(result.details)).toBe("× failure");
		expect(formatRecallResultForTui(result, false)).toContain("• note          [invalid id]");
		expect(formatRecallResultForTui(result, false)).toContain("memory ids must be 12 lowercase hex characters; received not-an-id");
		expect(getBranch).not.toHaveBeenCalled();
	});

	it("returns not_found when no current-branch observation has the id", async () => {
		const { result } = await executeRecall(observationId, [
			sourceEntry(),
			obsEntry("obs-entry", [{ ...baseObservation, id: "fedcba654321", sourceEntryIds: ["source-user"] }]),
		]);

		expect(result.details.status).toBe("not_found");
		expect(result.details.matches).toEqual([]);
		expect(result.content[0].text).toContain("No observation or reflection with id abc123def456 was found on the current branch");
		expect(formatRecallHeaderForTui(result.details)).toBe("× failure");
		expect(formatRecallResultForTui(result, false)).toContain("• note          [not found]");
		expect(formatRecallResultForTui(result, false)).toContain("no observation or reflection with id abc123def456 was found on the current branch");
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
		expect(formatRecallHeaderForTui(result.details)).toContain("✓ success · 1 observation · 1 source");
		expect(formatRecallResultForTui(result, false)).toContain("✓ source        2026-05-02 10:00 [user]");
		expect(formatRecallResultForTui(result, false)).not.toContain("unavailable evidence");
		expect(formatRecallResultForTui(result, false)).not.toContain("source unavailable");
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

	it("returns full source content even when rendered evidence is large", async () => {
		const longSource = `start-${"x".repeat(20_000)}-end`;
		const { result } = await executeRecall(observationId, [
			sourceEntry("source-large", longSource),
			obsEntry("obs-entry", [{ ...baseObservation, sourceEntryIds: ["source-large"] }]),
		]);

		expect(result.details.status).toBe("ok");
		expect(result.details.sourceCharacterCount).toBeGreaterThan(20_000);
		expect(result.content[0].text).toContain("start-");
		expect(result.content[0].text).toContain("-end");
		expect(result.content[0].text).not.toContain("too large to return safely");
		expect(formatRecallResultForTui(result, false)).toContain("✓ observation   2026-05-02 10:00 [high]");
		expect(formatRecallResultForTui(result, false)).toContain("✓ source        2026-05-02 10:00 [user]");
		expect(formatRecallResultForTui(result, false)).not.toContain("source-large");
	});
});
