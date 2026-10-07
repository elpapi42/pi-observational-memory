import {
	createAssistantMessageEventStream,
	getCurrentTools,
	type AssistantMessage,
	type JsonObject,
	type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { DEFAULTS } from "../src/config.js";
import { runConsolidationPipeline } from "../src/hooks/consolidation-trigger.js";
import { Runtime } from "../src/runtime.js";
import {
	foldLedger,
	latestCoverageMarkerId,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	type Entry,
} from "../src/session-ledger/index.js";
import type { WorkerStreamSimple } from "../src/agents/worker-stream.js";
import { observation, observationsRecordedEntry, textCustomMessage } from "./fixtures/session.js";

const MODEL = {
	id: "completion-repro",
	name: "Completion repro",
	provider: "anthropic",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	contextWindow: 200_000,
	maxTokens: 8_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies Model<"anthropic-messages">;

function providerStream(content: AssistantMessage["content"], stopReason: "stop" | "toolUse" | "error") {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		timestamp: 1,
		stopReason,
		content,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	stream.push({ type: "done", reason: stopReason === "error" ? "stop" : stopReason, message });
	return stream;
}

function observationCall(id: string, toolArguments: JsonObject): AssistantMessage["content"][number] {
	return { type: "toolCall", id, name: "record_observations", arguments: toolArguments };
}

function observationScenario(
	validSupport = true,
	options: { completeOnRequest?: number; emptyComplete?: boolean; failAfterRecord?: boolean } = {},
) {
	let entries: Entry[] = [
		textCustomMessage("raw-1", "User prefers deterministic tests."),
		textCustomMessage("raw-2", "User also requires useful failure messages."),
	];
	let requests = 0;
	let runtime = createRuntime({ agentMaxTurns: options.failAfterRecord ? 2 : 1 });

	const streamSimple: WorkerStreamSimple = () => {
		requests++;
		if (options.failAfterRecord && requests > 1) return providerStream([], "error");
		const complete = options.emptyComplete === true || requests === options.completeOnRequest;
		return providerStream(
			[
				observationCall(`call-${requests}`, {
					complete,
					observations: options.emptyComplete
						? []
						: [
								{
									timestamp: "2026-05-02 10:30",
									content: "User prefers deterministic tests.",
									relevance: "high",
									sourceEntryIds: [validSupport ? "raw-1" : "invented"],
								},
							],
				}),
			],
			"toolUse",
		);
	};
	const modelRegistry = {
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "local-test-only" }),
		streamSimple,
	};
	const pi = createLedgerWriter(
		() => entries,
		(nextEntries) => {
			entries = nextEntries;
		},
	);
	const context = {
		cwd: process.cwd(),
		hasUI: false,
		model: MODEL,
		modelRegistry,
		sessionManager: { getBranch: () => entries },
	};

	return {
		get entries() {
			return entries;
		},
		get runtime() {
			return runtime;
		},
		requests: () => requests,
		run: () => runConsolidationPipeline(pi, runtime, context),
		restart() {
			entries = structuredClone(entries);
			const config = runtime.config;
			runtime = createRuntime();
			runtime.config = config;
		},
	};
}

function reflectionScenario(includePartialTail = false, completeOnRequest?: number) {
	const observations = [
		observation("aaaaaaaaaaaa", {
			content: "User needs reliable memory for requirement one.",
			sourceEntryIds: ["raw-1"],
			tokenCount: 100,
		}),
		observation("bbbbbbbbbbbb", {
			content: "User needs reliable memory for requirement two.",
			sourceEntryIds: ["raw-1"],
			tokenCount: 100,
		}),
	];
	const entries: Entry[] = includePartialTail
		? [
				textCustomMessage("raw-1", "User needs useful and reliable memory."),
				{
					type: "custom",
					id: "observed-complete",
					customType: OM_OBSERVATIONS_RECORDED,
					data: { completion: "completed", observations: [observations[0]], coversUpToId: "raw-1" },
				},
				textCustomMessage("raw-2", "Additional unfinished memory source."),
				{
					type: "custom",
					id: "observed-partial",
					customType: OM_OBSERVATIONS_RECORDED,
					data: { completion: "incomplete", observations: [observations[1]], inputUpToId: "raw-2" },
				},
			]
		: [
				textCustomMessage("raw-1", "User needs useful and reliable memory."),
				observationsRecordedEntry("observed", { observations, coversUpToId: "raw-1" }),
			];
	const runtime = createRuntime({
		observeAfterTokens: 1_000_000,
		reflectAfterTokens: 1,
		observationsPoolTargetTokens: 1,
	});
	const requests: string[] = [];
	const inputs: Array<{ stage: string; messages: string }> = [];
	const streamSimple: WorkerStreamSimple = (...[, context]: Parameters<WorkerStreamSimple>) => {
		const isReflector = getCurrentTools(context.messages).some((tool) => tool.name === "record_reflections");
		const stage = isReflector ? "reflector" : "dropper";
		requests.push(stage);
		inputs.push({ stage, messages: JSON.stringify(context.messages) ?? "" });
		const content: AssistantMessage["content"] = isReflector
			? [
					{
						type: "toolCall",
						name: "record_reflections",
						id: "partial-reflection",
						arguments: {
							complete: includePartialTail || requests.length === completeOnRequest,
							reflections: [
								{
									content: "Reliable memory is required.",
									supportingObservationIds: ["aaaaaaaaaaaa"],
								},
							],
						},
					},
				]
			: [{ type: "text", text: "Nothing to drop." }];
		return providerStream(content, isReflector ? "toolUse" : "stop");
	};
	const modelRegistry = {
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "local-test-only" }),
		streamSimple,
	};
	const pi = createLedgerWriter(
		() => entries,
		(nextEntries) => {
			entries.splice(0, entries.length, ...nextEntries);
		},
	);
	const context = {
		cwd: process.cwd(),
		hasUI: false,
		model: MODEL,
		modelRegistry,
		sessionManager: { getBranch: () => entries },
	};

	return { entries, requests, inputs, run: () => runConsolidationPipeline(pi, runtime, context) };
}

function createRuntime(overrides: Partial<typeof DEFAULTS> = {}): Runtime {
	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.config = {
		...DEFAULTS,
		observeAfterTokens: 1,
		reflectAfterTokens: 1_000_000,
		agentMaxTurns: 1,
		...overrides,
	};
	return runtime;
}

function createLedgerWriter(
	getEntries: () => Entry[],
	setEntries: (entries: Entry[]) => void,
): Pick<ExtensionAPI, "appendEntry"> {
	return {
		appendEntry(customType, data) {
			setEntries([...getEntries(), { type: "custom", id: `saved-${getEntries().length}`, customType, data }]);
		},
	};
}

describe("incomplete worker coverage through the real consolidation pipeline", () => {
	it("keeps accepted partial observations without covering the submitted source span", async () => {
		const run = observationScenario();
		await run.run();

		expect(run.requests()).toBe(1);
		expect(foldLedger(run.entries).activeObservations.map((record) => record.content)).toEqual([
			"User prefers deterministic tests.",
		]);
		expect(latestCoverageMarkerId(run.entries, OM_OBSERVATIONS_RECORDED)).toBeUndefined();
		expect(run.entries.find((entry) => entry.customType === OM_OBSERVATIONS_RECORDED)?.data).toMatchObject({
			completion: "incomplete",
			inputUpToId: "raw-2",
			observations: [{ content: "User prefers deterministic tests." }],
		});
	});

	it("retries unfinished source input without duplicating accepted observations", async () => {
		const run = observationScenario();
		await run.run();
		await run.run();

		expect(run.requests()).toBe(2);
		expect(foldLedger(run.entries).activeObservations.map((record) => record.content)).toEqual([
			"User prefers deterministic tests.",
		]);
	});

	it("retries unfinished source input after restoring entries into a fresh Runtime", async () => {
		const run = observationScenario();
		await run.run();
		run.restart();
		await run.run();

		expect(run.requests()).toBe(2);
		expect(foldLedger(run.entries).activeObservations.map((record) => record.content)).toEqual([
			"User prefers deterministic tests.",
		]);
	});

	it("advances coverage on a duplicate-only completed retry", async () => {
		const run = observationScenario(true, { completeOnRequest: 2 });
		await run.run();
		await run.run();

		expect(run.requests()).toBe(2);
		expect(foldLedger(run.entries).activeObservations.map((record) => record.content)).toEqual([
			"User prefers deterministic tests.",
		]);
		expect(latestCoverageMarkerId(run.entries, OM_OBSERVATIONS_RECORDED)).toBe("raw-2");
		expect(run.entries.at(-1)?.data).toEqual({ completion: "completed", observations: [], coversUpToId: "raw-2" });
	});

	it("persists explicit empty completion and does not repeat covered work", async () => {
		const run = observationScenario(true, { emptyComplete: true });
		await run.run();
		await run.run();

		expect(run.requests()).toBe(1);
		expect(latestCoverageMarkerId(run.entries, OM_OBSERVATIONS_RECORDED)).toBe("raw-2");
		expect(run.entries.at(-1)?.data).toEqual({ completion: "completed", observations: [], coversUpToId: "raw-2" });
	});

	it("saves partial records as incomplete before reporting a later stream failure", async () => {
		const run = observationScenario(true, { failAfterRecord: true });
		await run.run();

		expect(run.requests()).toBe(2);
		expect(latestCoverageMarkerId(run.entries, OM_OBSERVATIONS_RECORDED)).toBeUndefined();
		expect(run.entries.at(-1)?.data).toMatchObject({ completion: "incomplete", inputUpToId: "raw-2" });
		expect(run.runtime.lastObserverError).toBeDefined();
	});

	it("keeps partial reflections without completing observation review", async () => {
		const run = reflectionScenario();
		await run.run();

		expect(foldLedger(run.entries).reflections.map((record) => record.content)).toEqual([
			"Reliable memory is required.",
		]);
		expect(latestCoverageMarkerId(run.entries, OM_REFLECTIONS_RECORDED)).toBeUndefined();
	});

	it("persists duplicate-only completed reflection review without unlocking the dropper", async () => {
		const run = reflectionScenario(false, 2);
		await run.run();
		await run.run();

		expect(run.requests).toEqual(["reflector", "reflector"]);
		expect(foldLedger(run.entries).reflections.map((record) => record.content)).toEqual([
			"Reliable memory is required.",
		]);
		expect(latestCoverageMarkerId(run.entries, OM_REFLECTIONS_RECORDED)).toBe("raw-1");
		expect(run.entries.at(-1)?.data).toEqual({ completion: "completed", reflections: [], coversUpToId: "raw-1" });

		await run.run();
		expect(run.requests).toEqual(["reflector", "reflector"]);
	});

	it("does not launch the dropper after an incomplete reflection review", async () => {
		const run = reflectionScenario();
		await run.run();

		expect(run.requests).toEqual(["reflector"]);
	});

	it("limits reflector and dropper inputs to completed observer coverage", async () => {
		const run = reflectionScenario(true);
		await run.run();

		const reflectorInput = run.inputs.find((input) => input.stage === "reflector")?.messages ?? "";
		const dropperInput = run.inputs.find((input) => input.stage === "dropper")?.messages ?? "";
		expect(run.requests).toEqual(["reflector", "dropper"]);
		expect(reflectorInput).toContain("User needs reliable memory for requirement one.");
		expect(reflectorInput).not.toContain("User needs reliable memory for requirement two.");
		expect(dropperInput).toContain("User needs reliable memory for requirement one.");
		expect(dropperInput).not.toContain("User needs reliable memory for requirement two.");
		expect(latestCoverageMarkerId(run.entries, OM_REFLECTIONS_RECORDED)).toBe("raw-1");
	});

	it("leaves rejected incomplete work uncovered and retryable", async () => {
		const run = observationScenario(false);
		await run.run();
		await run.run();

		expect(run.requests()).toBe(2);
		expect(foldLedger(run.entries).activeObservations).toEqual([]);
		expect(latestCoverageMarkerId(run.entries, OM_OBSERVATIONS_RECORDED)).toBeUndefined();
	});
});
