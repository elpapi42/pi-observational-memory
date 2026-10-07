import {
	createAssistantMessageEventStream,
	getCurrentTools,
	type AssistantMessage,
	type Model,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import type { WorkerStreamSimple } from "../agents/worker-stream.js";
import { DEFAULTS, type Config } from "../config.js";
import { Runtime } from "../runtime.js";
import {
	foldLedger,
	latestCoverageMarkerId,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	type Entry,
	unobservedSourceSpanBefore,
} from "../session-ledger/index.js";
import { observation, observationsRecordedEntry, textCustomMessage } from "../../tests/fixtures/session.js";
import { registerConsolidationTrigger } from "./consolidation-trigger.js";
import { catchUpObserver } from "./compaction-catch-up.js";

const MODEL = {
	id: "hook-integration",
	name: "Hook integration",
	provider: "anthropic",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	contextWindow: 200_000,
	maxTokens: 8_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies Model<"anthropic-messages">;

function workerResponseStream(content: AssistantMessage["content"], failed = false) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		timestamp: 1,
		stopReason: failed ? "error" : "toolUse",
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
	if (failed) {
		stream.push({ type: "error", reason: "error", error: message });
	} else {
		stream.push({ type: "done", reason: "toolUse", message });
	}
	return stream;
}

function hookSession(
	options: {
		entries?: Entry[];
		config?: Partial<Config>;
		complete?: boolean;
		abortOnRequest?: boolean;
		emptyComplete?: boolean;
		failAfterRecord?: boolean;
		beforeResponse?: () => void;
	} = {},
) {
	let entries: Entry[] = options.entries ?? [
		textCustomMessage("raw-1", "User needs deterministic tests and useful failure messages."),
	];
	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.config = {
		...DEFAULTS,
		model: undefined,
		observeAfterTokens: 1,
		reflectAfterTokens: 1,
		observationsPoolTargetTokens: 1_000,
		agentMaxTurns: 1,
		showWorkerNotifications: false,
		debugLog: false,
		...options.config,
	};
	const requests: string[] = [];
	const inputs: string[] = [];
	const streamSimple: WorkerStreamSimple = (...[, context]) => {
		const observer = getCurrentTools(context.messages).some((tool) => tool.name === "record_observations");
		const stage = observer ? "observer" : "reflector";
		requests.push(stage);
		inputs.push(JSON.stringify(context.messages));
		options.beforeResponse?.();
		if (options.failAfterRecord && requests.length > 1) {
			return workerResponseStream([], true);
		}
		if (options.abortOnRequest) {
			runtime.abortConsolidation();
		}
		const content: AssistantMessage["content"] = [
			{
				type: "toolCall",
				id: `${stage}-${requests.length}`,
				name: observer ? "record_observations" : "record_reflections",
				arguments: observer
					? {
							complete: options.complete ?? true,
							observations: options.emptyComplete
								? []
								: [
										{
											timestamp: "2026-05-02 10:30",
											content: "User needs deterministic tests.",
											relevance: "high",
											sourceEntryIds: ["raw-1"],
										},
									],
						}
					: {
							complete: options.complete ?? true,
							reflections: [
								{
									content: "Deterministic tests are required.",
									supportingObservationIds: foldLedger(entries)
										.activeObservations.slice(-1)
										.map((record) => record.id),
								},
							],
						},
			},
		];
		return workerResponseStream(content);
	};
	const context = {
		cwd: process.cwd(),
		hasUI: false,
		model: MODEL,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "local-test-only" }),
			find: () => ({ ...MODEL, id: "fallback" }),
			streamSimple,
		},
		sessionManager: { getBranch: () => entries },
	};
	type HookEvent = { type: "agent_start" | "turn_end" | "agent_settled" };
	const handlers = new Map<string, (event: HookEvent, ctx: typeof context) => void>();
	const registerHook = (name: string, handler: (event: HookEvent, ctx: typeof context) => void) => {
		handlers.set(name, handler);
		return () => {
			handlers.delete(name);
		};
	};
	const pi = {
		on: registerHook,
		appendEntry(customType: string, data: Entry["data"]) {
			entries = [...entries, { type: "custom", id: `saved-${entries.length}`, customType, data }];
		},
	};
	registerConsolidationTrigger(pi, runtime);
	return {
		runtime,
		requests,
		inputs,
		handlers,
		async catchUp(signal?: AbortSignal) {
			const gap = unobservedSourceSpanBefore(entries, entries.length);
			if (!gap) {
				throw new Error("Catch-up test requires unobserved source entries");
			}
			return catchUpObserver({
				pi,
				runtime,
				ctx: context,
				entries,
				gap,
				maxChunks: 2,
				signal,
			});
		},
		get entries() {
			return entries;
		},
		async emit(name: HookEvent["type"]) {
			const handler = handlers.get(name);
			if (!handler) {
				throw new Error(`Consolidation hook missing: ${name}`);
			}
			handler({ type: name }, context);
			await runtime.consolidationPromise;
		},
	};
}

describe("consolidation hook worker integration", () => {
	it("registers agent_start, turn_end, and agent_settled handlers", () => {
		const session = hookSession();
		expect([...session.handlers.keys()]).toEqual(["agent_start", "turn_end", "agent_settled"]);
	});

	it.each(["agent_start", "turn_end"] as const)(
		"runs observer and reflector from %s and persists completed coverage",
		async (event) => {
			const session = hookSession();
			await session.emit(event);

			expect(session.requests).toEqual(["observer", "reflector"]);
			expect(foldLedger(session.entries).activeObservations.map((record) => record.content)).toEqual([
				"User needs deterministic tests.",
			]);
			expect(foldLedger(session.entries).reflections.map((record) => record.content)).toEqual([
				"Deterministic tests are required.",
			]);
			expect(latestCoverageMarkerId(session.entries, OM_OBSERVATIONS_RECORDED)).toBe("raw-1");
			expect(latestCoverageMarkerId(session.entries, OM_REFLECTIONS_RECORDED)).toBe("raw-1");
			expect(session.runtime.lastObserverError).toBeUndefined();
			expect(session.runtime.lastReflectorError).toBeUndefined();
		},
	);

	it("does not run workers from agent_start below both thresholds", async () => {
		const session = hookSession({ config: { observeAfterTokens: 1_000, reflectAfterTokens: 1_000 } });
		await session.emit("agent_start");

		expect(session.requests).toEqual([]);
		expect(session.entries).toHaveLength(1);
		expect(session.runtime.consolidationPromise).toBeNull();
	});

	it("keeps an incomplete agent_start review retryable", async () => {
		const session = hookSession({ complete: false });
		await session.emit("agent_start");
		await session.emit("agent_start");

		expect(session.requests).toEqual(["observer", "observer"]);
		expect(foldLedger(session.entries).activeObservations).toHaveLength(1);
		expect(latestCoverageMarkerId(session.entries, OM_OBSERVATIONS_RECORDED)).toBeUndefined();
		expect(latestCoverageMarkerId(session.entries, OM_REFLECTIONS_RECORDED)).toBeUndefined();
	});

	it("preserves idle-mode launch rules", async () => {
		const session = hookSession({ config: { consolidateWhenIdle: true } });
		await session.emit("agent_start");
		await session.emit("turn_end");
		expect(session.requests).toEqual([]);

		await session.emit("agent_settled");
		expect(session.requests).toEqual(["observer", "reflector"]);
		expect(latestCoverageMarkerId(session.entries, OM_REFLECTIONS_RECORDED)).toBe("raw-1");
	});

	it("does not persist a stage that was aborted or retry it with a fallback", async () => {
		const session = hookSession({
			abortOnRequest: true,
			config: { fallbackModel: { provider: MODEL.provider, id: "fallback" } },
		});
		await session.emit("agent_start");

		expect(session.requests).toEqual(["observer"]);
		expect(session.entries).toHaveLength(1);
		expect(session.runtime.lastObserverError).toBeUndefined();
	});

	it("does not certify or drop observations omitted from a capped reflector review", async () => {
		const older = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], content: "Older requirement ".repeat(80) });
		const newer = observation("bbbbbbbbbbbb", {
			sourceEntryIds: ["raw-1"],
			content: "User needs deterministic tests.",
		});
		const session = hookSession({
			entries: [
				textCustomMessage("raw-1", "User requirements."),
				observationsRecordedEntry("observed", { observations: [older, newer], coversUpToId: "raw-1" }),
			],
			config: { observeAfterTokens: 1_000, workerMemoryMaxTokens: 80, observationsPoolTargetTokens: 1 },
		});
		await session.emit("agent_start");

		expect(session.requests).toEqual(["reflector"]);
		expect(session.inputs[0]).toContain(newer.content);
		expect(session.inputs[0]).not.toContain(older.content);
		expect(foldLedger(session.entries).reflections).toHaveLength(1);
		expect(session.entries.at(-1)?.data).toMatchObject({ completion: "incomplete", inputUpToId: "raw-1" });
		expect(latestCoverageMarkerId(session.entries, OM_REFLECTIONS_RECORDED)).toBeUndefined();
	});
});

describe("compaction catch-up worker completion integration", () => {
	it.each([false, true])("advances coverage on completed catch-up, including empty=%s", async (emptyComplete) => {
		const session = hookSession({ emptyComplete });
		const result = await session.catchUp();

		expect(result).toEqual({ chunksRecorded: 1 });
		expect(session.requests).toEqual(["observer"]);
		expect(latestCoverageMarkerId(session.entries, OM_OBSERVATIONS_RECORDED)).toBe("raw-1");
		expect(session.entries.at(-1)?.data).toMatchObject({ completion: "completed", coversUpToId: "raw-1" });
		expect(foldLedger(session.entries).activeObservations).toHaveLength(emptyComplete ? 0 : 1);
	});

	it("keeps partial records and retries the same source without duplicate records or coverage", async () => {
		const session = hookSession({ complete: false });
		const first = await session.catchUp();
		expect(first).toEqual({ chunksRecorded: 0, stoppedBecause: "incomplete" });
		expect(latestCoverageMarkerId(session.entries, OM_OBSERVATIONS_RECORDED)).toBeUndefined();

		const second = await session.catchUp();
		expect(second).toEqual(first);
		expect(session.requests).toEqual(["observer", "observer"]);
		expect(foldLedger(session.entries).activeObservations).toHaveLength(1);
		expect(session.entries).toHaveLength(2);
		expect(latestCoverageMarkerId(session.entries, OM_OBSERVATIONS_RECORDED)).toBeUndefined();
	});

	it("saves accepted records without coverage when a later request fails", async () => {
		const session = hookSession({ complete: false, failAfterRecord: true, config: { agentMaxTurns: 2 } });
		const result = await session.catchUp();

		expect(result).toEqual({ chunksRecorded: 0, stoppedBecause: "error" });
		expect(session.requests).toEqual(["observer", "observer"]);
		expect(foldLedger(session.entries).activeObservations).toHaveLength(1);
		expect(session.entries.at(-1)?.data).toMatchObject({ completion: "incomplete", inputUpToId: "raw-1" });
		expect(latestCoverageMarkerId(session.entries, OM_OBSERVATIONS_RECORDED)).toBeUndefined();
		expect(session.runtime.lastObserverError).toBeDefined();
	});

	it("appends nothing when catch-up is aborted during a worker request", async () => {
		const controller = new AbortController();
		const session = hookSession({ beforeResponse: () => controller.abort() });
		const result = await session.catchUp(controller.signal);

		expect(result).toEqual({ chunksRecorded: 0, stoppedBecause: "aborted" });
		expect(session.entries).toHaveLength(1);
		expect(session.runtime.lastObserverError).toBeUndefined();
	});
});
