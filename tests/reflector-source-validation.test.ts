import { describe, expect, it } from "vitest";

import {
	ReflectorRecordingContractError,
	ReflectorStreamError,
	runReflector,
} from "../src/agents/reflector/agent.js";
import { hashId } from "../src/ids.js";
import { observation, reflection } from "./fixtures/session.js";
import { scriptedReflectorStream, type ReflectorStreamStep } from "./fixtures/reflector-source-validation-stream.js";

const actualObservationId = "1782029e";
const typoObservationId = "1782029b";
const secondObservationId = "1782029f";
const reflectionContent = "User approved bounded reflector citation preflight.";
const recordArguments = (supportingObservationIds: string[], content = reflectionContent) => ({
	reflections: [{ content, supportingObservationIds }],
});

function runSteps(steps: ReflectorStreamStep[], overrides: Record<string, unknown> = {}) {
	const controlled = scriptedReflectorStream(steps);
	const observations = [
		observation(actualObservationId, { content: "User approved bounded reflector citation preflight." }),
		observation(secondObservationId, { content: "The preflight remains read-only." }),
	];
	const result = runReflector({
		model: { api: "controlled-test", provider: "controlled", id: "reflector" } as any,
		apiKey: "test",
		reflections: [],
		observations,
		streamSimple: controlled.streamSimple as any,
		...overrides,
	});
	return { result, observations, ...controlled };
}

describe("reflector supporting-observation citation preflight", () => {
	it("corrects a one-character support typo and records in one production agent loop", async () => {
		const run = runSteps([
			{ toolName: "validate_supporting_observation_ids", arguments: { supportingObservationIds: [typoObservationId] } },
			{ toolName: "validate_supporting_observation_ids", arguments: { supportingObservationIds: [actualObservationId] } },
			{ toolName: "record_reflections", arguments: recordArguments([actualObservationId]) },
			{ stopReason: "stop" },
		]);

		await expect(run.result).resolves.toEqual([expect.objectContaining({
			id: hashId(reflectionContent),
			content: reflectionContent,
			supportingObservationIds: [actualObservationId],
		})]);
		expect(run.calls()).toBe(4);
		expect(run.toolFeedback[0]?.text).toContain(typoObservationId);
		expect(run.toolFeedback[0]?.text).not.toContain(actualObservationId);
		expect(run.toolFeedback[0]?.details).toMatchObject({ valid: false, invalidCount: 1 });
		expect(run.toolFeedback[1]?.details).toMatchObject({ valid: true, canonicalCount: 1 });
	});

	it("sanitizes schema-invalid validator feedback and permits correction", async () => {
		const rawSentinel = `RAW_SENTINEL${"x".repeat(4_000)}`;
		const run = runSteps([
			{ toolName: "validate_supporting_observation_ids", arguments: { supportingObservationIds: [], extra: rawSentinel } },
			{ toolName: "validate_supporting_observation_ids", arguments: { supportingObservationIds: [actualObservationId] } },
			{ toolName: "record_reflections", arguments: recordArguments([actualObservationId]) },
			{ stopReason: "stop" },
		]);

		await expect(run.result).resolves.toHaveLength(1);
		const feedback = run.toolFeedback[0];
		expect(feedback).toMatchObject({
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "validate_supporting_observation_ids",
			isError: true,
		});
		expect(feedback?.text.length).toBeLessThan(500);
		expect(feedback?.text).not.toContain("RAW_SENTINEL");
		expect(feedback?.text).not.toContain("Received arguments");
		expect(JSON.stringify(feedback?.details)).not.toContain("RAW_SENTINEL");
	});

	it("bounds invalid diagnostics to eight sanitized 64-character ids", async () => {
		const invalidIds = Array.from({ length: 12 }, (_, index) => `${index}-${index === 0 ? "`" : ""}\n${"x".repeat(100)}`);
		const run = runSteps([
			{ toolName: "validate_supporting_observation_ids", arguments: { supportingObservationIds: invalidIds } },
			{ stopReason: "stop" },
		]);
		await expect(run.result).rejects.toBeInstanceOf(ReflectorRecordingContractError);
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

	it("keeps precise invalid ids model-facing and out of the outer error", async () => {
		const sentinel = "MODEL_CONTENT_SENTINEL";
		const run = runSteps([
			{ toolName: "validate_supporting_observation_ids", arguments: { supportingObservationIds: [sentinel] } },
			{ stopReason: "stop" },
		]);
		await expect(run.result).rejects.toMatchObject({
			name: "ReflectorRecordingContractError",
			message: expect.not.stringContaining(sentinel),
		});
		expect(run.toolFeedback[0]?.text).toContain(sentinel);
	});

	it("allows the authoritative recorder to use a different active support id", async () => {
		const run = runSteps([
			{ toolName: "validate_supporting_observation_ids", arguments: { supportingObservationIds: [actualObservationId] } },
			{ toolName: "record_reflections", arguments: recordArguments([secondObservationId]) },
			{ stopReason: "stop" },
		]);
		await expect(run.result).resolves.toMatchObject([{ supportingObservationIds: [secondObservationId] }]);
	});

	it("bounds schema-invalid recorder feedback and keeps earlier accepted reflections noncommittable", async () => {
		const sentinel = `REFLECTION_SENTINEL${"x".repeat(4_000)}`;
		const run = runSteps([
			{ toolName: "record_reflections", arguments: recordArguments([actualObservationId], "Accepted before schema failure.") },
			{ toolName: "record_reflections", arguments: { reflections: [{ content: "", supportingObservationIds: [actualObservationId] }], extra: sentinel } },
			{ stopReason: "stop" },
		]);

		await expect(run.result).rejects.toBeInstanceOf(ReflectorRecordingContractError);
		const feedback = run.toolFeedback.find((item) => item.toolName === "record_reflections" && item.isError);
		expect(feedback).toMatchObject({ role: "toolResult", toolCallId: "tool-2", toolName: "record_reflections", isError: true });
		expect(feedback?.text.length).toBeLessThan(500);
		expect(feedback?.text).toContain("batch was not recorded");
		expect(feedback?.text).not.toContain("Received arguments");
		expect(feedback?.text).not.toContain(sentinel);
		expect(JSON.stringify(feedback?.details)).not.toContain(sentinel);
	});

	it("latches an authoritative recorder rejection even after a later valid correction", async () => {
		const run = runSteps([
			{ toolName: "record_reflections", arguments: recordArguments(["outside-active"]) },
			{ toolName: "record_reflections", arguments: recordArguments([actualObservationId]) },
			{ stopReason: "stop" },
		]);
		await expect(run.result).rejects.toBeInstanceOf(ReflectorRecordingContractError);
	});

	it("latches invalid multiline and empty content recorder proposals", async () => {
		const run = runSteps([
			{ toolName: "record_reflections", arguments: { reflections: [
				{ content: "Two\nlines", supportingObservationIds: [actualObservationId] },
				{ content: "   ", supportingObservationIds: [actualObservationId] },
			] } },
			{ toolName: "record_reflections", arguments: recordArguments([actualObservationId]) },
			{ stopReason: "stop" },
		]);
		await expect(run.result).rejects.toBeInstanceOf(ReflectorRecordingContractError);
	});

	it("makes partial reflections noncommittable when a later validation is unfinished", async () => {
		const run = runSteps([
			{ toolName: "record_reflections", arguments: recordArguments([actualObservationId], "First durable reflection.") },
			{ toolName: "validate_supporting_observation_ids", arguments: { supportingObservationIds: [secondObservationId] } },
			{ stopReason: "stop" },
		]);
		await expect(run.result).rejects.toBeInstanceOf(ReflectorRecordingContractError);
	});

	it("fails when an invalid validation is corrected but not consumed", async () => {
		const run = runSteps([
			{ toolName: "validate_supporting_observation_ids", arguments: { supportingObservationIds: [typoObservationId] } },
			{ toolName: "validate_supporting_observation_ids", arguments: { supportingObservationIds: [actualObservationId] } },
			{ stopReason: "stop" },
		]);
		await expect(run.result).rejects.toBeInstanceOf(ReflectorRecordingContractError);
	});

	it("does not consume successful validation with an empty or fully rejected record", async () => {
		const empty = runSteps([
			{ toolName: "validate_supporting_observation_ids", arguments: { supportingObservationIds: [actualObservationId] } },
			{ toolName: "record_reflections", arguments: { reflections: [] } },
			{ stopReason: "stop" },
		]);
		const rejected = runSteps([
			{ toolName: "validate_supporting_observation_ids", arguments: { supportingObservationIds: [actualObservationId] } },
			{ toolName: "record_reflections", arguments: recordArguments(["outside-active"]) },
			{ stopReason: "stop" },
		]);
		await expect(empty.result).rejects.toBeInstanceOf(ReflectorRecordingContractError);
		await expect(rejected.result).rejects.toBeInstanceOf(ReflectorRecordingContractError);
	});

	it("consumes successful validation with a valid duplicate", async () => {
		const existing = reflection(hashId(reflectionContent), [actualObservationId], { content: reflectionContent });
		const run = runSteps([
			{ toolName: "validate_supporting_observation_ids", arguments: { supportingObservationIds: [actualObservationId] } },
			{ toolName: "record_reflections", arguments: recordArguments([actualObservationId]) },
			{ stopReason: "stop" },
		], { reflections: [existing] });
		await expect(run.result).resolves.toBeUndefined();
	});

	it("preserves direct valid recording and deliberate no-tool undefined behavior", async () => {
		const direct = runSteps([
			{ toolName: "record_reflections", arguments: recordArguments([actualObservationId]) },
			{ stopReason: "stop" },
		]);
		const empty = runSteps([{ stopReason: "stop" }]);
		await expect(direct.result).resolves.toHaveLength(1);
		await expect(empty.result).resolves.toBeUndefined();
	});

	it.each([
		["error", undefined],
		["aborted", undefined],
		["length", undefined],
	] as const)("gives %s terminal state precedence over recording-contract failure", async (stopReason, errorMessage) => {
		const run = runSteps([
			{ toolName: "validate_supporting_observation_ids", arguments: { supportingObservationIds: [typoObservationId] } },
			{ stopReason, errorMessage },
		]);
		await expect(run.result).rejects.toBeInstanceOf(ReflectorStreamError);
	});

	it("bounds and sanitizes retained provider error text", async () => {
		const rawError = `useful provider detail\n${"x".repeat(1_000)}`;
		const run = runSteps([{ stopReason: "error", errorMessage: rawError }]);
		const error = await run.result.catch((caught) => caught as ReflectorStreamError);
		expect(error).toBeInstanceOf(ReflectorStreamError);
		expect(error.message).toContain("useful provider detail");
		expect(error.message).not.toContain("\n");
		expect(error.message.length).toBeLessThan(600);
	});

	it("latches an earlier length tool-call response across later recovery and stop", async () => {
		const run = runSteps([
			{ toolName: "record_reflections", arguments: recordArguments([actualObservationId]) },
			{
				toolName: "validate_supporting_observation_ids",
				arguments: { supportingObservationIds: ["MODEL_CONTENT_SENTINEL"] },
				stopReason: "length",
				errorMessage: "length evidence",
			},
			{ toolName: "validate_supporting_observation_ids", arguments: { supportingObservationIds: [actualObservationId] } },
			{ toolName: "record_reflections", arguments: recordArguments([actualObservationId]) },
			{ stopReason: "stop" },
		]);

		await expect(run.result).rejects.toMatchObject({
			name: "ReflectorStreamError",
			stopReason: "length",
			message: expect.stringContaining("length evidence"),
		});
	});

	it("treats configured turn exhaustion as a stream error", async () => {
		const run = runSteps([
			{ toolName: "validate_supporting_observation_ids", arguments: { supportingObservationIds: [actualObservationId] } },
		], { maxTurns: 1 });
		await expect(run.result).rejects.toBeInstanceOf(ReflectorStreamError);
	});
});
