import { describe, expect, it } from "vitest";

import { ObserverStreamError, runObserver, runObserverWithOutcome } from "../src/agents/observer/agent.js";
import { hashId } from "../src/ids.js";
import { scriptedObserverStream, type ObserverStreamStep } from "./fixtures/observer-source-validation-stream.js";

const actualSourceId = "1782029e";
const typoSourceId = "1782029b";
const observationContent = "User approved bounded source citation preflight.";
const recordArguments = (sourceEntryIds: string[], content = observationContent) => ({
	observations: [{
		timestamp: "2026-09-17 08:00",
		content,
		relevance: "high",
		sourceEntryIds,
	}],
});

const secondSourceId = "1782029f";
const twoSourceOverrides = {
	chunk: `[Source entry id: ${actualSourceId}]\nFirst source.\n[Source entry id: ${secondSourceId}]\nSecond source.`,
	allowedSourceEntryIds: [actualSourceId, secondSourceId],
};

function runSteps(steps: ObserverStreamStep[], overrides: Record<string, unknown> = {}) {
	const controlled = scriptedObserverStream(steps);
	const allowedSourceEntryIds = [actualSourceId];
	const outcome = runObserverWithOutcome({
		model: { api: "controlled-test", provider: "controlled", id: "observer" } as any,
		apiKey: "test",
		priorReflections: [],
		priorObservations: [],
		chunk: `[Source entry id: ${actualSourceId}]\nUser approved bounded source citation preflight.`,
		allowedSourceEntryIds,
		streamSimple: controlled.streamSimple as any,
		...overrides,
	});
	return { outcome, allowedSourceEntryIds, ...controlled };
}

describe("observer source citation preflight", () => {
	it("corrects a one-character citation typo and records in one production agent loop", async () => {
		const run = runSteps([
			{ toolName: "validate_source_entry_ids", arguments: { sourceEntryIds: [typoSourceId] } },
			{ toolName: "validate_source_entry_ids", arguments: { sourceEntryIds: [actualSourceId] } },
			{ toolName: "record_observations", arguments: recordArguments([actualSourceId]) },
			{ stopReason: "stop" },
		]);

		await expect(run.outcome).resolves.toEqual({
			status: "complete",
			observations: [expect.objectContaining({
				id: hashId(observationContent),
				content: observationContent,
				sourceEntryIds: [actualSourceId],
			})],
		});
		expect(run.calls()).toBe(4);
		expect(run.toolFeedback[0]?.text).toContain(typoSourceId);
		expect(run.toolFeedback[0]?.text).not.toContain(actualSourceId);
		expect(run.toolFeedback[0]?.details).toMatchObject({ valid: false, invalidCount: 1 });
		expect(run.toolFeedback[1]?.text).toContain("Validated 1");
		expect(run.toolFeedback[1]?.details).toMatchObject({ valid: true, canonicalCount: 1 });
		expect(run.allowedSourceEntryIds).toEqual([actualSourceId]);
	});

	it("fails the recording contract when invalid preflight remains unresolved", async () => {
		const run = runSteps([
			{ toolName: "validate_source_entry_ids", arguments: { sourceEntryIds: [typoSourceId] } },
			{ stopReason: "stop" },
		]);

		await expect(run.outcome).resolves.toMatchObject({
			status: "failed",
			observations: [],
			failureKind: "recording-contract",
			recordingContractReason: "invalid-source-entry-ids",
		});
	});

	it("fails rather than returning clean-empty after validation-only success", async () => {
		const run = runSteps([
			{ toolName: "validate_source_entry_ids", arguments: { sourceEntryIds: [actualSourceId] } },
			{ stopReason: "stop" },
		]);

		await expect(run.outcome).resolves.toMatchObject({
			status: "failed",
			observations: [],
			failureKind: "recording-contract",
			recordingContractReason: "invalid-source-entry-ids",
		});
	});

	it("accepts a different actual citation when it still belongs to the current chunk", async () => {
		const run = runSteps([
			{ toolName: "validate_source_entry_ids", arguments: { sourceEntryIds: [actualSourceId] } },
			{ toolName: "record_observations", arguments: recordArguments([secondSourceId]) },
			{ stopReason: "stop" },
		], twoSourceOverrides);

		await expect(run.outcome).resolves.toMatchObject({
			status: "complete",
			observations: [{ sourceEntryIds: [secondSourceId] }],
		});
		expect(run.toolFeedback[0]?.text).toContain("recorder independently checks the actual current-chunk IDs");
		expect(run.toolFeedback[0]?.text).toContain("may differ from this preflight");
		expect(run.toolFeedback[0]?.text).not.toContain("Record only the validated IDs");
	});

	it("rejects an actual citation outside the current chunk after valid preflight", async () => {
		const run = runSteps([
			{ toolName: "validate_source_entry_ids", arguments: { sourceEntryIds: [actualSourceId] } },
			{ toolName: "record_observations", arguments: recordArguments(["outside-current-chunk"]) },
			{ stopReason: "stop" },
		], twoSourceOverrides);

		await expect(run.outcome).resolves.toMatchObject({
			status: "failed",
			observations: [],
			failureKind: "recording-contract",
			recordingContractReason: "invalid-source-entry-ids",
		});
	});

	it("preserves direct valid recording and deliberate no-tool clean-empty behavior", async () => {
		const direct = runSteps([
			{ toolName: "record_observations", arguments: recordArguments([actualSourceId]) },
			{ stopReason: "stop" },
		]);
		const empty = runSteps([{ stopReason: "stop" }]);

		await expect(direct.outcome).resolves.toMatchObject({ status: "complete", observations: [{ sourceEntryIds: [actualSourceId] }] });
		await expect(empty.outcome).resolves.toEqual({ status: "clean-empty", observations: [] });
	});

	it("sanitizes schema-invalid feedback and permits correction in the same loop", async () => {
		const rawSentinel = `RAW_SENTINEL${"x".repeat(4_000)}`;
		const run = runSteps([
			{ toolName: "validate_source_entry_ids", arguments: { sourceEntryIds: [], extra: rawSentinel } },
			{ toolName: "validate_source_entry_ids", arguments: { sourceEntryIds: [actualSourceId] } },
			{ toolName: "record_observations", arguments: recordArguments([actualSourceId]) },
			{ stopReason: "stop" },
		]);

		await expect(run.outcome).resolves.toMatchObject({ status: "complete", observations: [{ sourceEntryIds: [actualSourceId] }] });
		const feedback = run.toolFeedback[0];
		expect(feedback).toMatchObject({
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "validate_source_entry_ids",
			isError: true,
		});
		expect(feedback?.text.length).toBeLessThan(500);
		expect(feedback?.text).not.toContain("RAW_SENTINEL");
		expect(feedback?.text).not.toContain("Received arguments");
		expect(JSON.stringify(feedback?.details)).not.toContain("RAW_SENTINEL");
	});

	it("treats an uncorrected schema-invalid validator call as a recording failure", async () => {
		const run = runSteps([
			{ toolName: "validate_source_entry_ids", arguments: { sourceEntryIds: [] } },
			{ stopReason: "stop" },
		]);

		await expect(run.outcome).resolves.toMatchObject({
			status: "failed",
			failureKind: "recording-contract",
			recordingContractReason: "invalid-source-entry-ids",
			error: expect.not.stringContaining("sourceEntryIds"),
		});
	});

	it("bounds schema-invalid recorder feedback and keeps the whole attempt noncommittable", async () => {
		const sentinel = `MODEL_CONTENT_SENTINEL${"x".repeat(4_000)}`;
		const run = runSteps([
			{ toolName: "record_observations", arguments: recordArguments([actualSourceId], "Accepted before schema failure.") },
			{ toolName: "record_observations", arguments: {
				observations: [{ timestamp: "2026-09-17 08:00", content: "", relevance: "high", sourceEntryIds: [actualSourceId] }],
				extra: sentinel,
			} },
			{ stopReason: "stop" },
		]);
		await expect(run.outcome).resolves.toMatchObject({
			status: "failed",
			observations: [expect.objectContaining({ content: "Accepted before schema failure." })],
			failureKind: "recording-contract",
			recordingContractReason: "tool-validation",
			error: "record_observations tool execution failed",
		});
		const feedback = run.toolFeedback.find((item) => item.toolName === "record_observations" && item.isError);
		expect(feedback).toMatchObject({ role: "toolResult", toolCallId: "tool-2", toolName: "record_observations", isError: true });
		expect(feedback?.text.length).toBeLessThan(500);
		expect(feedback?.text).toContain("batch was not recorded");
		expect(feedback?.text).not.toContain("Received arguments");
		expect(feedback?.text).not.toContain(sentinel);
		expect(JSON.stringify(feedback?.details)).not.toContain(sentinel);
	});

	it("bounds invalid citation diagnostics to eight sanitized 64-character ids", async () => {
		const invalidIds = Array.from({ length: 12 }, (_, index) => `${index}-${index === 0 ? "`" : ""}\n${"x".repeat(100)}`);
		const run = runSteps([
			{ toolName: "validate_source_entry_ids", arguments: { sourceEntryIds: invalidIds } },
			{ stopReason: "stop" },
		]);

		await run.outcome;
		const feedback = run.toolFeedback[0]?.text ?? "";
		expect(feedback).toContain("12 invalid");
		expect(feedback).toContain("showing first 8");
		expect(feedback).not.toContain("8- ");
		expect(feedback).not.toContain("`0-`");
		expect(feedback).not.toContain("\n");
		const shownIds = Array.from(feedback.matchAll(/`([^`]*)`/g), (match) => match[1]);
		expect(shownIds).toHaveLength(8);
		for (const shown of shownIds) {
			expect(shown.length).toBeLessThanOrEqual(64);
			expect(shown).not.toMatch(/[\n\r`\u0000-\u001f\u007f]/);
		}
	});

	it("keeps precise invalid ids model-facing and out of the outer outcome", async () => {
		const sentinel = "MODEL_CONTENT_SENTINEL";
		const run = runSteps([
			{ toolName: "validate_source_entry_ids", arguments: { sourceEntryIds: [sentinel] } },
			{ stopReason: "stop" },
		]);
		await expect(run.outcome).resolves.toMatchObject({
			status: "failed",
			failureKind: "recording-contract",
			error: expect.not.stringContaining(sentinel),
		});
		expect(run.toolFeedback[0]?.text).toContain(sentinel);
	});

	it("fails with partial observations when a later successful preflight is not recorded", async () => {
		const run = runSteps([
			{ toolName: "validate_source_entry_ids", arguments: { sourceEntryIds: [actualSourceId] } },
			{ toolName: "record_observations", arguments: recordArguments([actualSourceId], "First observation.") },
			{ toolName: "validate_source_entry_ids", arguments: { sourceEntryIds: [secondSourceId] } },
			{ stopReason: "stop" },
		], twoSourceOverrides);

		await expect(run.outcome).resolves.toMatchObject({
			status: "failed",
			observations: [{ content: "First observation." }],
			recordingContractReason: "invalid-source-entry-ids",
		});
	});

	it("fails with partial observations after an invalid later preflight is corrected but not recorded", async () => {
		const run = runSteps([
			{ toolName: "validate_source_entry_ids", arguments: { sourceEntryIds: [actualSourceId] } },
			{ toolName: "record_observations", arguments: recordArguments([actualSourceId], "First observation.") },
			{ toolName: "validate_source_entry_ids", arguments: { sourceEntryIds: ["1782029b"] } },
			{ toolName: "validate_source_entry_ids", arguments: { sourceEntryIds: [secondSourceId] } },
			{ stopReason: "stop" },
		], twoSourceOverrides);

		await expect(run.outcome).resolves.toMatchObject({
			status: "failed",
			observations: [{ content: "First observation." }],
			recordingContractReason: "invalid-source-entry-ids",
		});
	});

	it("does not consume a successful preflight with an empty recording batch", async () => {
		const run = runSteps([
			{ toolName: "validate_source_entry_ids", arguments: { sourceEntryIds: [actualSourceId] } },
			{ toolName: "record_observations", arguments: recordArguments([actualSourceId], "First observation.") },
			{ toolName: "validate_source_entry_ids", arguments: { sourceEntryIds: [secondSourceId] } },
			{ toolName: "record_observations", arguments: { observations: [] } },
			{ stopReason: "stop" },
		], twoSourceOverrides);

		await expect(run.outcome).resolves.toMatchObject({
			status: "failed",
			observations: [{ content: "First observation." }],
			recordingContractReason: "invalid-source-entry-ids",
		});
	});

	it("completes after the outstanding preflight is recorded", async () => {
		const run = runSteps([
			{ toolName: "validate_source_entry_ids", arguments: { sourceEntryIds: [actualSourceId] } },
			{ toolName: "record_observations", arguments: recordArguments([actualSourceId], "First observation.") },
			{ toolName: "validate_source_entry_ids", arguments: { sourceEntryIds: [secondSourceId] } },
			{ toolName: "record_observations", arguments: recordArguments([secondSourceId], "Second observation.") },
			{ stopReason: "stop" },
		], twoSourceOverrides);

		await expect(run.outcome).resolves.toMatchObject({
			status: "complete",
			observations: [{ content: "First observation." }, { content: "Second observation." }],
		});
	});

	it("consumes a preflight when the accepted recording is a valid duplicate", async () => {
		const run = runSteps([
			{ toolName: "validate_source_entry_ids", arguments: { sourceEntryIds: [actualSourceId] } },
			{ toolName: "record_observations", arguments: recordArguments([actualSourceId]) },
			{ toolName: "validate_source_entry_ids", arguments: { sourceEntryIds: [actualSourceId] } },
			{ toolName: "record_observations", arguments: recordArguments([actualSourceId]) },
			{ stopReason: "stop" },
		]);

		await expect(run.outcome).resolves.toMatchObject({ status: "complete", observations: [{ content: observationContent }] });
	});

	it("bounds and sanitizes retained provider error text", async () => {
		const rawError = `useful provider detail\n${"x".repeat(1_000)}`;
		const run = runSteps([{ stopReason: "error", errorMessage: rawError }]);
		const outcome = await run.outcome;
		expect(outcome).toMatchObject({
			status: "failed",
			failureKind: "stream",
			error: expect.stringContaining("useful provider detail"),
		});
		if (outcome.status !== "failed") throw new Error("expected failed outcome");
		expect(outcome.error).not.toContain("\n");
		expect(outcome.error?.length).toBeLessThanOrEqual(512);
	});

	it("latches an earlier length tool-call response across later recovery and stop", async () => {
		const run = runSteps([
			{ toolName: "record_observations", arguments: recordArguments([actualSourceId]) },
			{
				toolName: "validate_source_entry_ids",
				arguments: { sourceEntryIds: ["MODEL_CONTENT_SENTINEL"] },
				stopReason: "length",
				errorMessage: "length evidence",
			},
			{ toolName: "validate_source_entry_ids", arguments: { sourceEntryIds: [actualSourceId] } },
			{ toolName: "record_observations", arguments: recordArguments([actualSourceId]) },
			{ stopReason: "stop" },
		]);

		await expect(run.outcome).resolves.toMatchObject({
			status: "turn-exhausted",
			observations: [{ content: observationContent }],
			stopReason: "length",
			error: "length evidence",
		});
	});

	it("does not let a valid recording cure a failed preflight without revalidation", async () => {
		const run = runSteps([
			{ toolName: "validate_source_entry_ids", arguments: { sourceEntryIds: [typoSourceId] } },
			{ toolName: "record_observations", arguments: recordArguments([actualSourceId]) },
			{ stopReason: "stop" },
		]);

		await expect(run.outcome).resolves.toMatchObject({
			status: "failed",
			observations: [{ content: observationContent }],
			recordingContractReason: "invalid-source-entry-ids",
		});
	});

	it.each(["membership", "schema"] as const)("keeps a recorder %s failure sticky after a later valid recording", async (failure) => {
		const badArguments = failure === "membership"
			? recordArguments(["outside-current-chunk"], "Rejected observation.")
			: { observations: [{ timestamp: "bad", content: "Rejected observation.", relevance: "high", sourceEntryIds: [actualSourceId] }] };
		const run = runSteps([
			{ toolName: "record_observations", arguments: recordArguments([actualSourceId], "Accepted first.") },
			{ toolName: "record_observations", arguments: badArguments },
			{ toolName: "record_observations", arguments: recordArguments([actualSourceId], "Accepted correction.") },
			{ stopReason: "stop" },
		]);

		await expect(run.outcome).resolves.toMatchObject({
			status: "failed",
			observations: [{ content: "Accepted first." }, { content: "Accepted correction." }],
			failureKind: "recording-contract",
			recordingContractReason: failure === "membership" ? "invalid-source-entry-ids" : "tool-validation",
		});
	});

	it("keeps diagnostic partial observations out of the compatibility wrapper", async () => {
		const controlled = scriptedObserverStream([
			{ toolName: "record_observations", arguments: recordArguments([actualSourceId], "Accepted first.") },
			{ toolName: "record_observations", arguments: recordArguments(["outside-current-chunk"], "Rejected observation.") },
			{ stopReason: "stop" },
		]);

		await expect(runObserver({
			model: { api: "controlled-test", provider: "controlled", id: "observer" } as any,
			apiKey: "test",
			priorReflections: [],
			priorObservations: [],
			chunk: `[Source entry id: ${actualSourceId}]\nSource.`,
			allowedSourceEntryIds: [actualSourceId],
			streamSimple: controlled.streamSimple as any,
		})).rejects.toMatchObject({ name: "ObserverStreamError", stopReason: "recording_failed" });
	});

	it.each([
		["error", "failed"],
		["aborted", "aborted"],
		["length", "turn-exhausted"],
	] as const)("preserves %s terminal precedence over unresolved validation", async (stopReason, status) => {
		const run = runSteps([
			{ toolName: "validate_source_entry_ids", arguments: { sourceEntryIds: [typoSourceId] } },
			{ stopReason, errorMessage: stopReason === "error" ? "provider failed" : undefined },
		]);

		await expect(run.outcome).resolves.toMatchObject({ status });
	});

	it.each([
		["error", "failed"],
		["aborted", "aborted"],
		["length", "turn-exhausted"],
	] as const)("does not commit accepted observations after %s", async (stopReason, status) => {
		const run = runSteps([
			{ toolName: "record_observations", arguments: recordArguments([actualSourceId]) },
			{ stopReason, errorMessage: stopReason === "error" ? "provider failed" : undefined },
		]);

		await expect(run.outcome).resolves.toMatchObject({ status, observations: [{ content: observationContent }] });
		await expect(runObserver({
			model: { api: "controlled-test", provider: "controlled", id: "observer" } as any,
			apiKey: "test",
			priorReflections: [],
			priorObservations: [],
			chunk: `[Source entry id: ${actualSourceId}]\nSource.`,
			allowedSourceEntryIds: [actualSourceId],
			streamSimple: scriptedObserverStream([
				{ toolName: "record_observations", arguments: recordArguments([actualSourceId]) },
				{ stopReason, errorMessage: stopReason === "error" ? "provider failed" : undefined },
			]).streamSimple as any,
		})).rejects.toBeInstanceOf(ObserverStreamError);
	});

	it("reports signal abort after accepted output", async () => {
		const controller = new AbortController();
		const loop = ((_prompts: unknown, context: any) => ({
			async *[Symbol.asyncIterator]() {},
			result: async () => {
				await context.tools[0].execute("tool-1", recordArguments([actualSourceId]));
				controller.abort();
			},
		})) as any;
		const run = runSteps([], { agentLoop: loop, signal: controller.signal });

		await expect(run.outcome).resolves.toMatchObject({ status: "aborted", observations: [{ content: observationContent }] });
	});

	it("reports capped final tool use but permits a final stop at the cap", async () => {
		const capped = runSteps([
			{ toolName: "record_observations", arguments: recordArguments([actualSourceId]) },
		], { maxTurns: 1 });
		const stopped = runSteps([
			{ toolName: "record_observations", arguments: recordArguments([actualSourceId]) },
			{ stopReason: "stop" },
		], { maxTurns: 2 });

		await expect(capped.outcome).resolves.toMatchObject({ status: "turn-exhausted", stopReason: "toolUse" });
		await expect(stopped.outcome).resolves.toMatchObject({ status: "complete", observations: [{ content: observationContent }] });
	});

	it("does not repackage loop construction, iteration, or result exceptions", async () => {
		const constructionFailure = new Error("construction failure");
		const iterationFailure = new Error("iteration failure");
		const resultFailure = new Error("result failure");
		const throwingLoop = (() => { throw constructionFailure; }) as any;
		const throwingIterationLoop = (() => ({
			async *[Symbol.asyncIterator]() { throw iterationFailure; },
			result: async () => ({}),
		})) as any;
		const throwingResultLoop = (() => ({
			async *[Symbol.asyncIterator]() {},
			result: async () => { throw resultFailure; },
		})) as any;

		await expect(runSteps([], { agentLoop: throwingLoop }).outcome).rejects.toBe(constructionFailure);
		await expect(runSteps([], { agentLoop: throwingIterationLoop }).outcome).rejects.toBe(iterationFailure);
		await expect(runSteps([], { agentLoop: throwingResultLoop }).outcome).rejects.toBe(resultFailure);
	});
});
