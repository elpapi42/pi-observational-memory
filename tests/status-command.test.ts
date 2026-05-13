import { describe, expect, it, vi } from "vitest";

import { registerStatusCommand } from "../src/commands/status.js";
import { observationPoolTokens } from "../src/compaction.js";
import type { MemoryDetailsV4, ObservationRecord, ReflectionRecord } from "../src/types.js";
import { compactionEntry, messageEntry } from "./fixtures/session.js";

const committedObservation = {
	id: "abc123def456",
	content: "User confirmed exact source ids are required.",
	timestamp: "2026-05-02 10:00",
	relevance: "high",
} satisfies ObservationRecord;

const reflectionRecord = {
	id: "111111111111",
	content: "abcd",
	supportingObservationIds: [committedObservation.id],
} satisfies ReflectionRecord;

const legacyReflection = "abcdefgh";

const migratedLegacyReflectionRecord = {
	id: "222222222222",
	content: "abcdefghijkl",
	supportingObservationIds: [],
	legacy: true,
} satisfies ReflectionRecord;

function memoryDetailsV4(): MemoryDetailsV4 {
	return {
		type: "observational-memory",
		version: 4,
		observations: [committedObservation],
		reflections: [legacyReflection, reflectionRecord, migratedLegacyReflectionRecord],
	};
}

async function runStatus(details: MemoryDetailsV4): Promise<string> {
	let handler: ((args: string[], ctx: unknown) => Promise<void>) | undefined;
	const pi = {
		registerCommand: vi.fn((name: string, command: { handler: typeof handler }) => {
			expect(name).toBe("om-status");
			handler = command.handler;
		}),
	};
	const runtime = {
		ensureConfig: vi.fn(),
		config: {
			observationThresholdTokens: 1000,
			compactionThresholdTokens: 50000,
			reflectionThresholdTokens: 30000,
			passive: false,
		},
		observerInFlight: false,
		compactInFlight: false,
	};
	registerStatusCommand(pi as never, runtime as never);
	if (!handler) throw new Error("om-status handler was not registered");

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

describe("/om-status", () => {
	it("counts structured and migrated legacy reflection tokens using reflection content", async () => {
		const output = await runStatus(memoryDetailsV4());

		expect(output).toContain("Reflections:   ~6 tokens (3 entries)");
		expect(output).not.toContain("[object Object]");
		expect(output).not.toContain("NaN");
		expect(output).not.toContain("legacy");
		expect(output).not.toContain("supportingObservationIds");
	});

	it("counts observation tokens from rendered observation lines", async () => {
		const output = await runStatus(memoryDetailsV4());
		const renderedObsTokens = observationPoolTokens([committedObservation]);

		expect(output).toContain(`committed    ~${renderedObsTokens.toLocaleString()} tokens (1 observation)`);
		expect(output).toContain(`Next reflection:  ~${renderedObsTokens.toLocaleString()} / 30,000 tokens`);
	});
});
