import { describe, expect, it, vi } from "vitest";

import { registerViewCommand } from "../src/commands/view.js";
import { observationPoolTokens } from "../src/compaction.js";
import type { MemoryDetailsV3, MemoryDetailsV4, ObservationRecord, ReflectionRecord } from "../src/types.js";
import { compactionEntry, messageEntry } from "./fixtures/session.js";

const committedObservation = {
	id: "abc123def456",
	content: "User confirmed exact source ids are required.",
	timestamp: "2026-05-02 10:00",
	relevance: "high",
} satisfies ObservationRecord;

const reflectionRecord = {
	id: "111111111111",
	content: "Structured reflection content.",
	supportingObservationIds: [committedObservation.id],
} satisfies ReflectionRecord;

const legacyReflection = "Plain prior reflection.";

const migratedLegacyReflectionRecord = {
	id: "222222222222",
	content: "Migrated legacy reflection content.",
	supportingObservationIds: [],
	legacy: true,
} satisfies ReflectionRecord;

function memoryDetailsV3(reflections: string[] = [legacyReflection]): MemoryDetailsV3 {
	return {
		type: "observational-memory",
		version: 3,
		observations: [committedObservation],
		reflections,
	};
}

function memoryDetailsV4(reflections: MemoryDetailsV4["reflections"] = [legacyReflection, reflectionRecord, migratedLegacyReflectionRecord]): MemoryDetailsV4 {
	return {
		type: "observational-memory",
		version: 4,
		observations: [committedObservation],
		reflections,
	};
}

async function runView(details: MemoryDetailsV3 | MemoryDetailsV4): Promise<string> {
	let handler: ((args: string[], ctx: unknown) => Promise<void>) | undefined;
	const pi = {
		registerCommand: vi.fn((name: string, command: { handler: typeof handler }) => {
			expect(name).toBe("om-view");
			handler = command.handler;
		}),
	};
	const runtime = { ensureConfig: vi.fn() };
	registerViewCommand(pi as never, runtime as never);
	if (!handler) throw new Error("om-view handler was not registered");

	const notify = vi.fn();
	await handler([], {
		cwd: process.cwd(),
		sessionManager: {
			getBranch: vi.fn(() => [
				messageEntry({ id: "source-user", message: { role: "user", content: "source" } }),
				compactionEntry({ id: "compaction-current", firstKeptEntryId: "source-user", details }),
			]),
		},
		ui: { notify },
	});

	const [[message, level]] = notify.mock.calls;
	expect(level).toBe("info");
	return message;
}

describe("/om-view", () => {
	it("renders v4 reflection ids and legacy strings without extra labels", async () => {
		const output = await runView(memoryDetailsV4());

		expect(output).toContain(`[${reflectionRecord.id}] ${reflectionRecord.content}`);
		expect(output).toContain(`[${migratedLegacyReflectionRecord.id}] ${migratedLegacyReflectionRecord.content}`);
		expect(output).toContain(legacyReflection);
		expect(output).toContain(`[${committedObservation.id}] ${committedObservation.timestamp} [${committedObservation.relevance}] ${committedObservation.content}`);
		expect(output).not.toContain("[object Object]");
		expect(output).not.toContain("NaN");
		expect(output).not.toContain("unrecallable");
		expect(output).not.toContain("recallable");
		expect(output).not.toContain("legacy: true");
		expect(output).not.toContain("supportingObservationIds");
	});

	it("counts observation tokens from rendered observation lines", async () => {
		const output = await runView(memoryDetailsV4());
		const renderedObsTokens = observationPoolTokens([committedObservation]);

		expect(output).toContain(`1 observation (1 committed, 0 pending) · ~`);
		expect(output).toContain(`Observations — committed (1 observation, ~${renderedObsTokens.toLocaleString()} tokens)`);
	});

	it("keeps v3 legacy reflections plain", async () => {
		const output = await runView(memoryDetailsV3());

		expect(output).toContain(legacyReflection);
		expect(output).not.toContain(`[${reflectionRecord.id}]`);
		expect(output).not.toContain("[object Object]");
	});
});
