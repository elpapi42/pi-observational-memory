import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgents = vi.hoisted(() => ({
	runObserver: vi.fn(),
	runReflector: vi.fn(),
	runReflectionDropper: vi.fn(),
	runDropper: vi.fn(),
	runSystemOneDropper: vi.fn(),
	scoreObservations: vi.fn(),
	appendDropScores: vi.fn(),
	appendReflectionDropScores: vi.fn(),
}));

vi.mock("../src/agents/observer/agent.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/agents/observer/agent.js")>()),
	runObserver: mockAgents.runObserver,
}));
vi.mock("../src/agents/reflector/agent.js", () => ({ runReflector: mockAgents.runReflector }));
// The evidence and sort helpers stay real; the score log ranks the pool with them.
vi.mock("../src/agents/reflection-dropper/agent.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/agents/reflection-dropper/agent.js")>()),
	runReflectionDropper: mockAgents.runReflectionDropper,
}));
// Only the agent entry point is stubbed; selectDropCandidates is a pure ranking
// helper the score log uses for its heuristic baseline.
vi.mock("../src/agents/dropper/agent.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/agents/dropper/agent.js")>()),
	runDropper: mockAgents.runDropper,
}));
vi.mock("../src/agents/dropper/system-one/agent.js", () => ({
	runSystemOneDropper: mockAgents.runSystemOneDropper,
	scoreObservations: mockAgents.scoreObservations,
}));
vi.mock("../src/drop-scores.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/drop-scores.js")>()),
	appendDropScores: mockAgents.appendDropScores,
	appendReflectionDropScores: mockAgents.appendReflectionDropScores,
}));

import { ObserverStreamError } from "../src/agents/observer/agent.js";
import { registerConsolidationTrigger } from "../src/hooks/consolidation-trigger.js";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_DROPPED,
	OM_REFLECTIONS_RECORDED,
} from "../src/session-ledger/index.js";
import {
	compactionEntry,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	rawMessage,
	reflection,
	reflectionsDroppedEntry,
	reflectionsRecordedEntry,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

beforeEach(() => {
	mockAgents.runObserver.mockReset();
	mockAgents.runReflector.mockReset();
	mockAgents.runReflectionDropper.mockReset();
	mockAgents.runDropper.mockReset();
	mockAgents.runSystemOneDropper.mockReset();
	mockAgents.scoreObservations.mockReset();
	mockAgents.appendDropScores.mockReset();
	mockAgents.scoreObservations.mockResolvedValue({ signalsById: new Map(), requestCount: 0, inputTokens: 0 });
	mockAgents.appendDropScores.mockReturnValue(true);
	mockAgents.appendReflectionDropScores.mockReset();
	mockAgents.appendReflectionDropScores.mockReturnValue(true);
	mockAgents.runObserver.mockResolvedValue(undefined);
	mockAgents.runReflector.mockResolvedValue(undefined);
	mockAgents.runReflectionDropper.mockResolvedValue(undefined);
	mockAgents.runDropper.mockResolvedValue(undefined);
	mockAgents.runSystemOneDropper.mockResolvedValue(undefined);
});

function setup(args: {
	entries: TestEntry[];
	observeAfterTokens?: number;
	reflectAfterTokens?: number;
	observerChunkMaxTokens?: number;
	observationsPoolMaxTokens?: number;
	observationsPoolTargetTokens?: number;
	reflectionsPoolTargetTokens?: number;
	workerMemoryMaxTokens?: number;
	showWorkerNotifications?: boolean;
	passive?: boolean;
	consolidationInFlight?: boolean;
	appendEntryReturnsId?: boolean;
	sessionId?: string;
	systemOneDropper?: Record<string, unknown>;
	consolidateWhenIdle?: boolean;
	afterIdleConsolidation?: (ctx: unknown) => void;
}) {
	let entries = [...args.entries];
	let sessionId = args.sessionId ?? "session-1";
	const handlers: Record<string, ((event: unknown, ctx: any) => void) | undefined> = {};
	const pi = {
		on: vi.fn((eventName: string, cb: (event: unknown, ctx: any) => void) => {
			handlers[eventName] = cb;
		}),
		appendEntry: vi.fn((customType: string, data: unknown) => {
			const id = `appended-${pi.appendEntry.mock.calls.length}`;
			entries = [...entries, { type: "custom", id, parentId: entries.at(-1)?.id ?? null, timestamp: "2026-05-02T10:00:00.000Z", customType, data }];
			return args.appendEntryReturnsId === false ? undefined : id;
		}),
	};
	let launchedWork: (() => Promise<void>) | undefined;
	let resolveLaunched: (() => void) | undefined;
	const runtime = {
		config: {
			showWorkerNotifications: args.showWorkerNotifications ?? true,
			passive: args.passive ?? false,
			consolidateWhenIdle: args.consolidateWhenIdle ?? false,
			debugLog: false,
			observeAfterTokens: args.observeAfterTokens ?? 1,
			reflectAfterTokens: args.reflectAfterTokens ?? 1,
			observerChunkMaxTokens: args.observerChunkMaxTokens,
			workerMemoryMaxTokens: args.workerMemoryMaxTokens,
			observationsPoolMaxTokens: args.observationsPoolMaxTokens ?? 100,
			observationsPoolTargetTokens: args.observationsPoolTargetTokens ?? Math.floor((args.observationsPoolMaxTokens ?? 100) / 2),
			reflectionsPoolTargetTokens: args.reflectionsPoolTargetTokens ?? 1_000,
			agentMaxTurns: 9,
			agentMaxTokens: 32000,
			model: { provider: "anthropic", id: "memory", thinking: "minimal" },
			systemOneDropper: args.systemOneDropper,
		},
		consolidationInFlight: args.consolidationInFlight ?? false,
		consolidationAbortController: undefined as AbortController | undefined,
		abortConsolidation: vi.fn(() => {
			if (!runtime.consolidationInFlight || !runtime.consolidationAbortController) return false;
			runtime.consolidationAbortController.abort();
			return true;
		}),
		consolidationPhase: undefined as "observer" | "reflector" | "reflection-dropper" | "dropper" | undefined,
		resolveFailureNotified: false,
		lastObserverError: undefined as string | undefined,
		lastReflectorError: undefined as string | undefined,
		lastReflectionDropperError: undefined as string | undefined,
		lastDropperError: undefined as string | undefined,
		ensureConfig: vi.fn(),
		resolveModel: vi.fn(async () => ({ ok: true, model: { reasoning: true }, apiKey: "key", headers: { h: "v" }, thinking: "minimal" })),
		resolveFallbackModel: vi.fn(async () => ({ ok: false, reason: "no fallback model configured" })),
		launchConsolidationTask: vi.fn((_ctx, work) => {
			runtime.consolidationInFlight = true;
			runtime.consolidationAbortController = new AbortController();
			launchedWork = work;
			// Resolve when the test drives the work via runLaunchedWork().
			return new Promise<void>((resolve) => {
				resolveLaunched = () => {
					runtime.consolidationInFlight = false;
					resolve();
				};
			});
		}),
		recordConsolidationStageError: vi.fn((ctx, phase: "observer" | "reflector" | "reflection-dropper" | "dropper", error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			if (phase === "observer") runtime.lastObserverError = message;
			if (phase === "reflector") runtime.lastReflectorError = message;
			if (phase === "reflection-dropper") runtime.lastReflectionDropperError = message;
			if (phase === "dropper") runtime.lastDropperError = message;
			ctx.ui?.notify(`Observational memory: ${phase} failed: ${message}`, "warning");
			return message;
		}),
	};
	registerConsolidationTrigger(pi as any, runtime as any, { afterIdleConsolidation: args.afterIdleConsolidation });
	if (!handlers.agent_start) throw new Error("agent_start consolidation handler not registered");
	if (!handlers.turn_end) throw new Error("turn_end consolidation handler not registered");
	if (!handlers.agent_settled) throw new Error("agent_settled consolidation handler not registered");
	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: { notify: vi.fn() },
		model: { provider: "session" },
		modelRegistry: {},
		sessionManager: {
			getBranch: () => entries,
			getSessionId: () => sessionId,
		},
	};
	return {
		pi,
		runtime,
		ctx,
		fire: (eventName = "turn_end") => handlers[eventName]!(undefined, ctx),
		fireAgentStart: () => handlers.agent_start!(undefined, ctx),
		fireTurnEnd: () => handlers.turn_end!(undefined, ctx),
		runLaunchedWork: async () => {
			try {
				await launchedWork?.();
			} finally {
				resolveLaunched?.();
			}
		},
		fireAgentSettled: () => handlers.agent_settled!(undefined, ctx),
		addEntries: (...more: TestEntry[]) => {
			entries = [...entries, ...more];
		},
		setSessionId: (next: string) => {
			sessionId = next;
		},
		getEntries: () => entries,
	};
}

describe("V3 consolidation trigger", () => {
	const obsA = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 10 });
	const obsB = observation("bbbbbbbbbbbb", { sourceEntryIds: ["raw-2"], tokenCount: 10 });
	const refA = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);

	it("registers agent_start and turn_end consolidation entrypoints", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { pi } = setup({ entries });

		expect(pi.on).toHaveBeenCalledWith("agent_start", expect.any(Function));
		expect(pi.on).toHaveBeenCalledWith("turn_end", expect.any(Function));
	});

	it("does not launch below all thresholds from either entrypoint", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [refA], coversUpToId: "raw-1" }),
			observationsDroppedEntry("om-drop", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-1" }),
		];
		const { fireAgentStart, fireTurnEnd, runtime } = setup({ entries, observeAfterTokens: 10, reflectAfterTokens: 10 });

		fireAgentStart();
		fireTurnEnd();

		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});

	it("does not launch from either entrypoint in passive mode", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const passive = setup({ entries, passive: true });

		passive.fireAgentStart();
		passive.fireTurnEnd();

		expect(passive.runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});

	it("does not launch from either entrypoint while consolidation is already in flight", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const locked = setup({ entries, consolidationInFlight: true });

		locked.fireAgentStart();
		locked.fireTurnEnd();

		expect(locked.runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});

	it("launches on a due raw backlog even when provider growth since the last compaction is below the threshold", () => {
		// Coverage stops before the latest compaction, so the provider delta is
		// measured from the post-compaction baseline (1000 -> 1000 = 0 growth)
		// while the uncovered raw backlog is far above observeAfterTokens.
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
			compactionEntry("cmp-1", { firstKeptEntryId: "assistant-1" }),
			rawMessage("assistant-1", "done", {
				message: { role: "assistant", content: "done", stopReason: "end_turn", usage: { totalTokens: 1000 } },
			}),
			textCustomMessage("raw-3", "cccc"),
		];
		const { fireTurnEnd, runtime, ctx } = setup({ entries, observeAfterTokens: 5, reflectAfterTokens: 1000 });
		(ctx as any).getContextUsage = () => ({ tokens: 1000, contextWindow: 65536 });

		fireTurnEnd();

		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
	});

	it("does not launch when both the raw backlog and provider growth are below the threshold", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			compactionEntry("cmp-1", { firstKeptEntryId: "assistant-1" }),
			rawMessage("assistant-1", "done", {
				message: { role: "assistant", content: "done", stopReason: "end_turn", usage: { totalTokens: 1000 } },
			}),
			textCustomMessage("raw-2", "bbbb"),
		];
		const { fireTurnEnd, runtime, ctx } = setup({ entries, observeAfterTokens: 5, reflectAfterTokens: 1000 });
		(ctx as any).getContextUsage = () => ({ tokens: 1002, contextWindow: 65536 });

		fireTurnEnd();

		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});

	it("launches from agent_start when work is due", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fireAgentStart, runtime } = setup({ entries });

		fireAgentStart();

		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
	});

	it("uses the shared lock when agent_start fires before turn_end", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fireAgentStart, fireTurnEnd, runtime } = setup({ entries });

		fireAgentStart();
		fireTurnEnd();

		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
	});

	it("uses the shared lock when turn_end fires before agent_start", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fireAgentStart, fireTurnEnd, runtime } = setup({ entries });

		fireTurnEnd();
		fireAgentStart();

		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
	});

	it("runs observer first and appends source-addressed observations", async () => {
		const obs = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce([obs]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi, runtime } = setup({ entries, reflectAfterTokens: 999 });

		fire();
		await runLaunchedWork();

		expect(runtime.launchConsolidationTask).toHaveBeenCalled();
		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({
			allowedSourceEntryIds: ["raw-1"],
			maxTurns: 9,
			thinkingLevel: "minimal",
		}));
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, { observations: [obs], coversUpToId: "raw-1" });
	});

	it("forwards OAuth-shaped auth (headers, no apiKey) to the observer agent", async () => {
		const obs = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce([obs]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi, runtime } = setup({ entries, reflectAfterTokens: 999 });
		runtime.resolveModel.mockResolvedValueOnce({
			ok: true,
			model: { provider: "kimi-coding" },
			apiKey: undefined,
			headers: { Authorization: "Bearer oauth-token" },
		});

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({
			apiKey: undefined,
			headers: { Authorization: "Bearer oauth-token" },
		}));
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, { observations: [obs], coversUpToId: "raw-1" });
	});

	it("adds x-opencode-session headers for opencode-go worker models", async () => {
		const obs = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce([obs]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi, runtime } = setup({ entries, reflectAfterTokens: 999, sessionId: "session-abc" });
		runtime.resolveModel.mockResolvedValueOnce({
			ok: true,
			model: { provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1", reasoning: true },
			apiKey: "go-key",
		});

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({
			apiKey: "go-key",
			headers: { "x-opencode-session": "session-abc", "x-opencode-client": "pi" },
		}));
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, { observations: [obs], coversUpToId: "raw-1" });
	});

	it("merges x-opencode-session with existing auth headers and preserves them", async () => {
		const obs = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce([obs]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, runtime } = setup({ entries, reflectAfterTokens: 999, sessionId: "session-1" });
		runtime.resolveModel.mockResolvedValueOnce({
			ok: true,
			model: { provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" },
			apiKey: "go-key",
			headers: { Authorization: "Bearer go-key" },
		});

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({
			headers: {
				Authorization: "Bearer go-key",
				"x-opencode-session": "session-1",
				"x-opencode-client": "pi",
			},
		}));
	});

	it("detects opencode hosts by baseUrl even when provider is generic", async () => {
		const obs = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce([obs]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, runtime } = setup({ entries, reflectAfterTokens: 999, sessionId: "session-1" });
		runtime.resolveModel.mockResolvedValueOnce({
			ok: true,
			model: { provider: "custom", baseUrl: "https://opencode.ai/zen/go/v1" },
			apiKey: "go-key",
		});

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({
			headers: { "x-opencode-session": "session-1", "x-opencode-client": "pi" },
		}));
	});

	it("leaves headers untouched for non-opencode worker models", async () => {
		const obs = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce([obs]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, runtime } = setup({ entries, reflectAfterTokens: 999, sessionId: "session-1" });
		runtime.resolveModel.mockResolvedValueOnce({
			ok: true,
			model: { provider: "anthropic", baseUrl: "https://api.anthropic.com" },
			apiKey: "k",
		});

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({
			apiKey: "k",
			headers: undefined,
		}));
	});

	it("uses existing observation coverage and retries larger ranges after no-output", async () => {
		const prior = observation("cccccccccccc", { sourceEntryIds: ["raw-1"] });
		const newObs = observation("dddddddddddd", { sourceEntryIds: ["raw-2"] });
		mockAgents.runObserver.mockResolvedValueOnce([newObs]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-prior", { observations: [prior], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			textCustomMessage("raw-3", "cccccccc"),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries, reflectAfterTokens: 999 });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({ allowedSourceEntryIds: ["raw-2", "raw-3"] }));
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, { observations: [newObs], coversUpToId: "raw-3" });
	});

	it("observer no-output appends nothing and does not fake observation coverage", async () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi } = setup({ entries });

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(mockAgents.runReflector).not.toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
	});

	it("shows routine worker notifications by default", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runObserver.mockResolvedValueOnce([obsA]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, ctx } = setup({ entries, observationsPoolTargetTokens: 5 });

		fire();
		await runLaunchedWork();

		expect(ctx.ui.notify.mock.calls).toEqual([
			[expect.stringMatching(/^Observational memory: observer running on ~\d+-token chunk$/), "info"],
			["Observational memory: 1 observation recorded", "info"],
			["Observational memory: reflector running (~2 tokens)", "info"],
			["Observational memory: dropper running after reflection — active observation pool ~19 / 5 target tokens (380%)", "info"],
		]);
	});

	it("suppresses routine worker notifications without hiding warnings", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runObserver.mockResolvedValueOnce([obsA]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const quiet = setup({ entries, observationsPoolTargetTokens: 5, showWorkerNotifications: false });

		quiet.fire();
		await quiet.runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledOnce();
		expect(mockAgents.runReflector).toHaveBeenCalledOnce();
		expect(mockAgents.runDropper).toHaveBeenCalledOnce();
		expect(quiet.ctx.ui.notify).not.toHaveBeenCalled();

		// Deliberate empty is routine info: also hidden when quiet.
		mockAgents.runObserver.mockReset();
		mockAgents.runObserver.mockResolvedValueOnce(undefined);
		const noOutput = setup({ entries, reflectAfterTokens: 999, showWorkerNotifications: false });

		noOutput.fire();
		await noOutput.runLaunchedWork();

		expect(noOutput.ctx.ui.notify).not.toHaveBeenCalled();

		// Real failures still surface as warnings when quiet.
		mockAgents.runObserver.mockReset();
		mockAgents.runObserver.mockRejectedValueOnce(new ObserverStreamError("error", "prompt is too long"));
		const failed = setup({ entries, reflectAfterTokens: 999, showWorkerNotifications: false });

		failed.fire();
		await failed.runLaunchedWork();

		expect(failed.ctx.ui.notify).toHaveBeenCalledOnce();
		expect(failed.ctx.ui.notify.mock.calls[0][1]).toBe("warning");
		expect(failed.ctx.ui.notify.mock.calls[0][0]).toContain("observer failed");
	});

	it("reports deliberate empty as info, not a warning", async () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, ctx } = setup({ entries, reflectAfterTokens: 999 });

		fire();
		await runLaunchedWork();

		expect(ctx.ui.notify.mock.calls).toEqual([
			[expect.stringMatching(/^Observational memory: observer running on ~\d+-token chunk$/), "info"],
			["Observational memory: observer found nothing new in this chunk (coverage unchanged; will retry later)", "info"],
		]);
	});

	it("backs off observer re-fires after a deliberate empty until enough new tokens arrive", async () => {
		const entries = [textCustomMessage("raw-1", "a".repeat(40))]; // 10 tokens
		const { fire, runLaunchedWork, addEntries, runtime } = setup({ entries, observeAfterTokens: 10, reflectAfterTokens: 999 });

		fire();
		await runLaunchedWork();
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);
		expect(runtime.observerEmptyBackoff).toEqual({
			sessionIdentity: "session-1",
			coverageId: undefined,
			tokensAtEmpty: 10,
		});

		// Same span, only 5 new tokens (< observeAfterTokens more): no re-fire.
		addEntries(textCustomMessage("raw-2", "b".repeat(20)));
		runtime.consolidationInFlight = false;
		fire();
		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(2);
		await runLaunchedWork();
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);

		// 10 more new tokens: backoff satisfied, observer re-fires over the grown span.
		addEntries(textCustomMessage("raw-3", "c".repeat(40)));
		runtime.consolidationInFlight = false;
		mockAgents.runObserver.mockResolvedValueOnce([obsA]);
		fire();
		await runLaunchedWork();
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(2);
		expect(runtime.observerEmptyBackoff).toBeUndefined();
	});

	it("does not apply deliberate-empty backoff to another session", async () => {
		const entries = [textCustomMessage("raw-1", "a".repeat(40))];
		const { fire, runLaunchedWork, runtime, setSessionId } = setup({
			entries,
			observeAfterTokens: 10,
			reflectAfterTokens: 999,
		});

		fire();
		await runLaunchedWork();
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);

		runtime.consolidationInFlight = false;
		setSessionId("session-2");
		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledTimes(2);
	});

	it("surfaces API stream errors as observer failure, never as empty", async () => {
		mockAgents.runObserver.mockRejectedValueOnce(new ObserverStreamError("error", "prompt is too long: 5198507 tokens > 1000000 maximum"));
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi, runtime, ctx } = setup({ entries, reflectAfterTokens: 999 });

		fire();
		await runLaunchedWork();

		expect(runtime.lastObserverError).toContain("prompt is too long");
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			'Observational memory: observer failed: observer stream ended with stopReason "error": prompt is too long: 5198507 tokens > 1000000 maximum',
			"warning",
		);
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("no observations"), expect.anything());
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(runtime.observerEmptyBackoff).toBeUndefined();
		expect(mockAgents.runReflector).not.toHaveBeenCalled();
	});


	it("model resolution failure skips appending and notifies once", async () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi, runtime, ctx } = setup({ entries });
		runtime.resolveModel.mockResolvedValueOnce({ ok: false, reason: "no model" });

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith("Observational memory: observer skipped — no model", "warning");
	});

	it("re-reads branch so observer append can unblock reflector in the same consolidation run", async () => {
		mockAgents.runObserver.mockResolvedValueOnce([obsA]);
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi } = setup({ entries });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalled();
		expect(mockAgents.runReflector).toHaveBeenCalledWith(expect.objectContaining({ observations: [obsA] }));
		expect(mockAgents.runObserver.mock.invocationCallOrder[0]).toBeLessThan(mockAgents.runReflector.mock.invocationCallOrder[0]);
		expect(pi.appendEntry.mock.calls[0]).toEqual([OM_OBSERVATIONS_RECORDED, { observations: [obsA], coversUpToId: "raw-1" }]);
		expect(pi.appendEntry.mock.calls[1]).toEqual([OM_REFLECTIONS_RECORDED, { reflections: [newRef], coversUpToId: "raw-1" }]);
	});

	it("runs reflector-only and appends non-empty reflections", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observationsDroppedEntry("om-drop", { observationIds: ["bbbbbbbbbbbb"], coversUpToId: "raw-2" }),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries, observeAfterTokens: 999 });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflector).toHaveBeenCalledWith(expect.objectContaining({ observations: [obsA], maxTurns: 9, thinkingLevel: "minimal" }));
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_REFLECTIONS_RECORDED, { reflections: [newRef], coversUpToId: "raw-1" });
	});

	it("runs dropper after same-run non-empty reflector output and appends non-empty drops", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries, observeAfterTokens: 999, observationsPoolTargetTokens: 5 });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflector).toHaveBeenCalled();
		expect(mockAgents.runDropper).toHaveBeenCalledWith(expect.objectContaining({ reflections: [newRef], observations: [obsA] }));
		expect(pi.appendEntry.mock.calls[0]).toEqual([OM_REFLECTIONS_RECORDED, { reflections: [newRef], coversUpToId: "raw-1" }]);
		expect(pi.appendEntry.mock.calls[1]).toEqual([OM_OBSERVATIONS_DROPPED, { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-1" }]);
	});

	it("routes the dropper to the System One endpoint in primary mode", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runSystemOneDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork, pi, runtime } = setup({
			entries,
			observeAfterTokens: 999,
			observationsPoolTargetTokens: 5,
			systemOneDropper: { mode: "primary", provider: "local-jev", vetoThreshold: 0.15, dropThreshold: 0.75 },
		});

		fire();
		await runLaunchedWork();

		expect(mockAgents.runDropper).not.toHaveBeenCalled();
		expect(mockAgents.runSystemOneDropper).toHaveBeenCalledWith(expect.objectContaining({
			reflections: [newRef],
			observations: [obsA],
		}));
		// The endpoint replaces the pi model entirely for this stage.
		expect(runtime.resolveModel).not.toHaveBeenCalledWith(expect.anything(), "dropper");
		expect(pi.appendEntry.mock.calls[1]).toEqual([OM_OBSERVATIONS_DROPPED, { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-1" }]);
	});

	it("keeps the LLM dropper when the System One block is present but off", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork } = setup({
			entries,
			observeAfterTokens: 999,
			observationsPoolTargetTokens: 5,
			systemOneDropper: { mode: "off", provider: "local-jev" },
		});

		fire();
		await runLaunchedWork();

		expect(mockAgents.runSystemOneDropper).not.toHaveBeenCalled();
		expect(mockAgents.runDropper).toHaveBeenCalledOnce();
	});

	it("scores in shadow mode but lets the LLM dropper decide, pairing both in the score log", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		mockAgents.scoreObservations.mockResolvedValueOnce({
			// The endpoint would have kept it; the LLM dropped it. That disagreement
			// is exactly what the log has to preserve.
			signalsById: new Map([["aaaaaaaaaaaa", { floor: 0.01, redundant: 0.1, superseded: 0.1, lowSignal: 0.1, safety: 0.2 }]]),
			requestCount: 1,
			inputTokens: 10,
		});
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork, pi } = setup({
			entries,
			observeAfterTokens: 999,
			observationsPoolTargetTokens: 5,
			systemOneDropper: { mode: "shadow", provider: "local-jev", vetoThreshold: 0.15, dropThreshold: 0.75 },
		});

		fire();
		await runLaunchedWork();

		expect(mockAgents.scoreObservations).toHaveBeenCalledOnce();
		expect(mockAgents.runSystemOneDropper).not.toHaveBeenCalled();
		// The applied drop is the LLM's, unchanged by shadow scoring.
		expect(pi.appendEntry.mock.calls[1]).toEqual([OM_OBSERVATIONS_DROPPED, { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-1" }]);

		const [, rows] = mockAgents.appendDropScores.mock.calls[0];
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			observationId: "aaaaaaaaaaaa",
			systemOneDecision: "keep",
			llmDecision: "drop",
		});
		expect(rows[0].dropProbability).toBeCloseTo(0.02);
	});

	it("separates what the LLM proposed from what survived the budget sort", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		// The model asks for both; only the first fits the budget, so the second is
		// a proposal the sort rejected rather than an observation it wanted kept.
		mockAgents.runDropper.mockImplementationOnce(async (args: any) => {
			args.onProposedIds?.(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
			return ["aaaaaaaaaaaa"];
		});
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA, obsB], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork } = setup({
			entries,
			observeAfterTokens: 999,
			observationsPoolTargetTokens: 5,
			systemOneDropper: { mode: "shadow", provider: "local-jev", vetoThreshold: 0.15, dropThreshold: 0.75 },
		});

		fire();
		await runLaunchedWork();

		const [, rows] = mockAgents.appendDropScores.mock.calls[0];
		const byId = Object.fromEntries(rows.map((row: any) => [row.observationId, row]));
		expect(byId["aaaaaaaaaaaa"]).toMatchObject({ llmProposed: true, llmDecision: "drop" });
		expect(byId["bbbbbbbbbbbb"]).toMatchObject({ llmProposed: true, llmDecision: "keep" });
	});

	it("omits llmProposed when the dropper never reported a proposal", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork } = setup({
			entries,
			observeAfterTokens: 999,
			observationsPoolTargetTokens: 5,
			systemOneDropper: { mode: "shadow", provider: "local-jev", vetoThreshold: 0.15, dropThreshold: 0.75 },
		});

		fire();
		await runLaunchedWork();

		const [, rows] = mockAgents.appendDropScores.mock.calls[0];
		expect(rows[0].llmProposed).toBeUndefined();
	});

	it("records an unscored row when shadow scoring fails, without blocking the drop", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		mockAgents.scoreObservations.mockRejectedValueOnce(new Error("endpoint down"));
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork, pi } = setup({
			entries,
			observeAfterTokens: 999,
			observationsPoolTargetTokens: 5,
			systemOneDropper: { mode: "shadow", provider: "local-jev", vetoThreshold: 0.15, dropThreshold: 0.75 },
		});

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry.mock.calls[1]).toEqual([OM_OBSERVATIONS_DROPPED, { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-1" }]);
		const [, rows] = mockAgents.appendDropScores.mock.calls[0];
		expect(rows[0]).toMatchObject({ systemOneDecision: "unscored", llmDecision: "drop" });
		expect(rows[0].signals).toBeUndefined();
	});

	it("does not launch dropper-only work when active pool is over target", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [refA], coversUpToId: "raw-1" }),
		];
		const { fire, runtime } = setup({ entries, observeAfterTokens: 999, reflectAfterTokens: 999, observationsPoolTargetTokens: 5 });

		fire();

		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});

	it("waits for successful reflection even when active observation pool is over target", async () => {
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork, runtime } = setup({ entries, observeAfterTokens: 999, reflectAfterTokens: 1, observationsPoolTargetTokens: 5 });

		fire();
		await runLaunchedWork();

		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
		expect(mockAgents.runReflector).toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
	});

	it("does not launch dropper-only work when dropped tombstones reduce active pool below budget", () => {
		const heavy = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 100 });
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [heavy], coversUpToId: "raw-1" }),
			observationsDroppedEntry("om-drop", { observationIds: ["cccccccccccc"], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			reflectionsRecordedEntry("om-ref", { reflections: [refA], coversUpToId: "raw-2" }),
		];
		const { fire, runtime } = setup({ entries, observeAfterTokens: 999, reflectAfterTokens: 1, observationsPoolMaxTokens: 100 });

		fire();

		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});

	it("uses same-run reflection coverage for drop coverage", async () => {
		const newRef = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runDropper.mockResolvedValueOnce(["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs-a", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observationsRecordedEntry("om-obs-b", { observations: [obsB], coversUpToId: "raw-2" }),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries, observeAfterTokens: 999, observationsPoolMaxTokens: 10 });

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry.mock.calls[0]).toEqual([OM_REFLECTIONS_RECORDED, { reflections: [newRef], coversUpToId: "raw-2" }]);
		expect(pi.appendEntry.mock.calls[1]).toEqual([OM_OBSERVATIONS_DROPPED, { observationIds: ["bbbbbbbbbbbb"], coversUpToId: "raw-2" }]);
	});

	it("does not bootstrap dropper without same-run reflection output", async () => {
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries, observeAfterTokens: 999, observationsPoolMaxTokens: 10 });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflector).toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("does not append reflect/drop entries without observation coverage", async () => {
		mockAgents.runReflector.mockResolvedValueOnce([reflection("ffffffffffff", ["aaaaaaaaaaaa"])]);
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi } = setup({ entries, observeAfterTokens: 999 });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflector).not.toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("runs reflector before dropper and covers drops through same-run reflection coverage", async () => {
		const newRef = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runDropper.mockResolvedValueOnce(["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs-a", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observationsRecordedEntry("om-obs-b", { observations: [obsB], coversUpToId: "raw-2" }),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries, observeAfterTokens: 999, observationsPoolMaxTokens: 10 });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runDropper).toHaveBeenCalledWith(expect.objectContaining({ reflections: [newRef] }));
		expect(pi.appendEntry.mock.calls[0]).toEqual([OM_REFLECTIONS_RECORDED, { reflections: [newRef], coversUpToId: "raw-2" }]);
		expect(pi.appendEntry.mock.calls[1]).toEqual([OM_OBSERVATIONS_DROPPED, { observationIds: ["bbbbbbbbbbbb"], coversUpToId: "raw-2" }]);
	});

	it("does not use appended reflection entry id for drop coverage when appendEntry returns no id", async () => {
		const newRef = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runDropper.mockResolvedValueOnce(["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs-a", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observationsRecordedEntry("om-obs-b", { observations: [obsB], coversUpToId: "raw-2" }),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries, observeAfterTokens: 999, appendEntryReturnsId: false, observationsPoolMaxTokens: 10 });

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry.mock.calls[1]).toEqual([OM_OBSERVATIONS_DROPPED, { observationIds: ["bbbbbbbbbbbb"], coversUpToId: "raw-2" }]);
	});

	it("appends no empty reflection or drop entries", async () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa"), observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" })];
		const { fire, runLaunchedWork, pi, ctx } = setup({ entries, observeAfterTokens: 999 });

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("dropper running"), "info");
	});

	it("preserves stage failure boundaries", async () => {
		mockAgents.runObserver.mockRejectedValueOnce(new Error("observe failed"));
		const observerFailure = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")] });
		observerFailure.fire();
		await observerFailure.runLaunchedWork();
		expect(observerFailure.runtime.lastObserverError).toBe("observe failed");
		expect(mockAgents.runReflector).not.toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();

		mockAgents.runObserver.mockReset();
		mockAgents.runObserver.mockResolvedValue(undefined);
		mockAgents.runReflector.mockReset();
		mockAgents.runReflector.mockRejectedValueOnce(new Error("reflect failed"));
		const reflectorFailure = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa"), observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" })], observeAfterTokens: 999 });
		reflectorFailure.fire();
		await reflectorFailure.runLaunchedWork();
		expect(reflectorFailure.runtime.lastReflectorError).toBe("reflect failed");
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
		expect(reflectorFailure.pi.appendEntry).not.toHaveBeenCalled();

		mockAgents.runReflector.mockReset();
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runDropper.mockReset();
		mockAgents.runDropper.mockRejectedValueOnce(new Error("drop failed"));
		const dropperFailure = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa"), observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" })], observeAfterTokens: 999, observationsPoolMaxTokens: 10 });
		dropperFailure.fire();
		await dropperFailure.runLaunchedWork();
		expect(dropperFailure.runtime.lastDropperError).toBe("drop failed");
		expect(dropperFailure.pi.appendEntry).toHaveBeenCalledTimes(1);
		expect(dropperFailure.pi.appendEntry).toHaveBeenCalledWith(OM_REFLECTIONS_RECORDED, { reflections: [newRef], coversUpToId: "raw-1" });
	});

	describe("fallback model retry", () => {
		it("uses the resolution-level fallback model for the observer", async () => {
			const obs = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
			mockAgents.runObserver.mockResolvedValueOnce([obs]);
			const { fire, runLaunchedWork, pi, runtime } = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")], reflectAfterTokens: 999 });
			(runtime.config as any).fallbackModel = { provider: "opencode-go", id: "deepseek-v4.1-flash", thinking: "high" };
			const fallback = { provider: "opencode-go", id: "deepseek-v4.1-flash", baseUrl: "https://opencode.ai/zen/go/v1" };
			runtime.resolveModel.mockResolvedValueOnce({
				ok: true,
				model: fallback,
				apiKey: "go-key",
				fallbackUsed: true,
				primaryFailure: "primary unavailable",
			});

			fire();
			await runLaunchedWork();

			expect(mockAgents.runObserver).toHaveBeenCalledOnce();
			expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({
				model: fallback,
				apiKey: "go-key",
				headers: { "x-opencode-session": "session-1", "x-opencode-client": "pi" },
				thinkingLevel: "high",
			}));
			expect(runtime.resolveFallbackModel).not.toHaveBeenCalled();
			expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, { observations: [obs], coversUpToId: "raw-1" });
		});

		it("retries the observer once with the fallback model after a primary stream error", async () => {
			const obs = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
			mockAgents.runObserver
				.mockRejectedValueOnce(new ObserverStreamError("error", "primary down"))
				.mockResolvedValueOnce([obs]);
			const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
			const { fire, runLaunchedWork, pi, runtime, ctx } = setup({ entries, reflectAfterTokens: 999 });
			runtime.resolveFallbackModel.mockResolvedValueOnce({
				ok: true,
				model: { provider: "opencode-go", id: "deepseek-v4.1-flash", baseUrl: "https://opencode.ai/zen/go/v1" },
				apiKey: "go-key",
			});

			fire();
			await runLaunchedWork();

			expect(mockAgents.runObserver).toHaveBeenCalledTimes(2);
			expect(mockAgents.runObserver).toHaveBeenNthCalledWith(2, expect.objectContaining({
				apiKey: "go-key",
				headers: { "x-opencode-session": "session-1", "x-opencode-client": "pi" },
			}));
			expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, { observations: [obs], coversUpToId: "raw-1" });
			expect(runtime.lastObserverError).toBeUndefined();
			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("retrying with fallback model"),
				"warning",
			);
		});

		it("reuses the fallback model for later stages in the same pass", async () => {
			const obs = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
			const ref = reflection("ffffffffffff", ["cccccccccccc"]);
			mockAgents.runObserver
				.mockRejectedValueOnce(new ObserverStreamError("error", "primary down"))
				.mockResolvedValueOnce([obs]);
			mockAgents.runReflector.mockResolvedValueOnce([ref]);
			const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
			const { fire, runLaunchedWork, runtime } = setup({ entries, reflectAfterTokens: 1 });
			runtime.resolveFallbackModel.mockResolvedValueOnce({
				ok: true,
				model: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
				apiKey: "go-key",
			});

			fire();
			await runLaunchedWork();

			expect(mockAgents.runReflector).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "go-key" }));
			expect(runtime.resolveFallbackModel).toHaveBeenCalledTimes(1);
		});

		it("aborts the observer when the fallback retry also fails", async () => {
			mockAgents.runObserver
				.mockRejectedValueOnce(new ObserverStreamError("error", "primary down"))
				.mockRejectedValueOnce(new ObserverStreamError("error", "fallback down"));
			const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
			const { fire, runLaunchedWork, runtime, pi } = setup({ entries, reflectAfterTokens: 999 });
			runtime.resolveFallbackModel.mockResolvedValueOnce({
				ok: true,
				model: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
				apiKey: "go-key",
			});

			fire();
			await runLaunchedWork();

			expect(mockAgents.runObserver).toHaveBeenCalledTimes(2);
			expect(runtime.lastObserverError).toContain("fallback down");
			expect(pi.appendEntry).not.toHaveBeenCalled();
		});

		it("retries the reflector once with the fallback model", async () => {
			const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
			mockAgents.runReflector
				.mockRejectedValueOnce(new Error("reflect failed"))
				.mockResolvedValueOnce([newRef]);
			const entries = [
				textCustomMessage("raw-1", "aaaaaaaa"),
				observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			];
			const { fire, runLaunchedWork, pi, runtime } = setup({ entries, observeAfterTokens: 999 });
			runtime.resolveFallbackModel.mockResolvedValueOnce({
				ok: true,
				model: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
				apiKey: "go-key",
			});

			fire();
			await runLaunchedWork();

			expect(mockAgents.runReflector).toHaveBeenCalledTimes(2);
			expect(pi.appendEntry).toHaveBeenCalledWith(OM_REFLECTIONS_RECORDED, { reflections: [newRef], coversUpToId: "raw-1" });
		});

		it("retries the dropper once with the fallback model after a primary error", async () => {
			const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
			mockAgents.runReflector.mockResolvedValueOnce([newRef]);
			mockAgents.runDropper.mockRejectedValueOnce(new Error("primary down")).mockResolvedValueOnce(["aaaaaaaaaaaa"]);
			const entries = [
				textCustomMessage("raw-1", "aaaaaaaa"),
				observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			];
			const { fire, runLaunchedWork, pi, runtime, ctx } = setup({ entries, observeAfterTokens: 999, observationsPoolMaxTokens: 10 });
			const fallback = { provider: "opencode-go", id: "deepseek-v4.1-flash" };
			runtime.resolveFallbackModel.mockResolvedValueOnce({ ok: true, model: fallback, apiKey: "go-key" });

			fire();
			await runLaunchedWork();

			expect(mockAgents.runDropper).toHaveBeenCalledTimes(2);
			expect(mockAgents.runDropper).toHaveBeenNthCalledWith(1, expect.objectContaining({ apiKey: "key", headers: { h: "v" } }));
			expect(mockAgents.runDropper).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: fallback, apiKey: "go-key" }));
			expect(runtime.resolveFallbackModel).toHaveBeenCalledTimes(1);
			expect(runtime.lastDropperError).toBeUndefined();
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("dropper failed (primary down); retrying with fallback model"), "warning");
			expect(pi.appendEntry.mock.calls).toEqual([
				[OM_REFLECTIONS_RECORDED, { reflections: [newRef], coversUpToId: "raw-1" }],
				[OM_OBSERVATIONS_DROPPED, { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-1" }],
			]);
		});

		it("does not retry when no fallback model is configured", async () => {
			mockAgents.runObserver.mockRejectedValueOnce(new Error("observe failed"));
			const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
			const { fire, runLaunchedWork, runtime } = setup({ entries, reflectAfterTokens: 999 });

			fire();
			await runLaunchedWork();

			expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);
			expect(runtime.resolveFallbackModel).toHaveBeenCalledTimes(1);
			expect(runtime.lastObserverError).toBe("observe failed");
		});

		it("does not retry a stage that already resolved through the fallback", async () => {
			mockAgents.runObserver.mockRejectedValueOnce(new ObserverStreamError("error", "fallback down"));
			const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
			const { fire, runLaunchedWork, runtime } = setup({ entries, reflectAfterTokens: 999 });
			runtime.resolveModel.mockResolvedValueOnce({
				ok: true,
				model: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
				apiKey: "go-key",
				fallbackUsed: true,
				primaryFailure: "primary down",
			});

			fire();
			await runLaunchedWork();

			expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);
			expect(runtime.resolveFallbackModel).not.toHaveBeenCalled();
		});

		it("uses the fallback model's thinking level on retry", async () => {
			const obs = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
			mockAgents.runObserver
				.mockRejectedValueOnce(new ObserverStreamError("error", "primary down"))
				.mockResolvedValueOnce([obs]);
			const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
			const { fire, runLaunchedWork, runtime } = setup({ entries, reflectAfterTokens: 999 });
			(runtime.config as any).fallbackModel = { provider: "opencode-go", id: "deepseek-v4.1-flash", thinking: "high" };
			runtime.resolveFallbackModel.mockResolvedValueOnce({
				ok: true,
				model: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
				apiKey: "go-key",
			});

			fire();
			await runLaunchedWork();

			expect(mockAgents.runObserver).toHaveBeenNthCalledWith(1, expect.objectContaining({ thinkingLevel: "minimal" }));
			expect(mockAgents.runObserver).toHaveBeenNthCalledWith(2, expect.objectContaining({ thinkingLevel: "high" }));
		});

		it("caps the observer chunk to a smaller-context fallback window", async () => {
			const first = observation("111111111111", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
			mockAgents.runObserver.mockResolvedValueOnce([first]);
			const entries = [
				textCustomMessage("raw-1", "a".repeat(800)),
				textCustomMessage("raw-2", "b".repeat(800)),
			];
			const { fire, runLaunchedWork, runtime, ctx } = setup({ entries, reflectAfterTokens: 999 });
			(runtime.config as any).fallbackModel = { provider: "opencode-go", id: "deepseek-v4.1-flash" };
			runtime.resolveModel.mockResolvedValueOnce({
				ok: true,
				model: { provider: "anthropic", contextWindow: 200000 },
				apiKey: "key",
			});
			// Only the fallback model advertises a window; its 100-token window caps the
			// chunk at the 256-token minimum so a single source entry fits per run.
			ctx.modelRegistry = { find: vi.fn(() => ({ contextWindow: 100 })) };

			fire();
			await runLaunchedWork();

			expect(mockAgents.runObserver).toHaveBeenNthCalledWith(1, expect.objectContaining({ allowedSourceEntryIds: ["raw-1"] }));
		});
	});
});

describe("observer chunk cap", () => {
	it("caps an oversized backlog and drains it incrementally across runs", async () => {
		const first = observation("111111111111", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		const second = observation("222222222222", { sourceEntryIds: ["raw-2"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce([first]).mockResolvedValueOnce([second]);
		const entries = [
			textCustomMessage("raw-1", "a".repeat(800)),
			textCustomMessage("raw-2", "b".repeat(800)),
			textCustomMessage("raw-3", "c".repeat(800)),
		];
		const { fire, runLaunchedWork, pi, runtime } = setup({ entries, observerChunkMaxTokens: 256, reflectAfterTokens: 999 });

		fire();
		await runLaunchedWork();

		// Only the oldest entry fits under the cap; coverage advances to it, not to the backlog tail.
		expect(mockAgents.runObserver).toHaveBeenNthCalledWith(1, expect.objectContaining({ allowedSourceEntryIds: ["raw-1"] }));
		expect(pi.appendEntry).toHaveBeenNthCalledWith(1, OM_OBSERVATIONS_RECORDED, { observations: [first], coversUpToId: "raw-1" });

		// The next run continues from the advanced coverage.
		runtime.consolidationInFlight = false;
		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenNthCalledWith(2, expect.objectContaining({ allowedSourceEntryIds: ["raw-2"] }));
		expect(pi.appendEntry).toHaveBeenNthCalledWith(2, OM_OBSERVATIONS_RECORDED, { observations: [second], coversUpToId: "raw-2" });
	});

	it("bounds one oversized tool result, preserves provenance, and continues on the next run", async () => {
		const first = observation("333333333333", { sourceEntryIds: ["raw-huge"], tokenCount: 4 });
		const second = observation("555555555555", { sourceEntryIds: ["raw-next"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce([first]).mockResolvedValueOnce([second]);
		const hugeText = `HEAD:${"m".repeat(2_000)}:TAIL`;
		const entries: TestEntry[] = [
			{
				type: "message",
				id: "raw-huge",
				parentId: null,
				timestamp: "2026-05-02T10:00:00.000Z",
				message: {
					role: "toolResult",
					toolCallId: "tool-1",
					toolName: "bash",
					content: [{ type: "text", text: hugeText }],
					isError: false,
					timestamp: Date.parse("2026-05-02T10:00:00.000Z"),
				},
			},
			textCustomMessage("raw-next", "later"),
		];
		const { fire, runLaunchedWork, pi, runtime } = setup({ entries, observerChunkMaxTokens: 100, reflectAfterTokens: 999 });

		fire();
		await runLaunchedWork();

		const firstCall = mockAgents.runObserver.mock.calls[0][0];
		expect(firstCall.allowedSourceEntryIds).toEqual(["raw-huge"]);
		expect(firstCall.chunk).toContain("HEAD:");
		expect(firstCall.chunk).toContain(":TAIL");
		expect(firstCall.chunk).toContain("middle omitted: source exceeds observer input budget");
		expect(firstCall.chunk).not.toContain("raw-next");
		expect(pi.appendEntry).toHaveBeenNthCalledWith(1, OM_OBSERVATIONS_RECORDED, { observations: [first], coversUpToId: "raw-huge" });

		// The source id still points at the full ledger entry; the next run starts
		// after it instead of retrying the oversized input forever.
		runtime.consolidationInFlight = false;
		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenNthCalledWith(2, expect.objectContaining({ allowedSourceEntryIds: ["raw-next"] }));
		expect(pi.appendEntry).toHaveBeenNthCalledWith(2, OM_OBSERVATIONS_RECORDED, { observations: [second], coversUpToId: "raw-next" });
	});

	it("derives the cap from the resolved model's context window when not configured", async () => {
		const obs = observation("444444444444", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce([obs]);
		const entries = [
			textCustomMessage("raw-1", "a".repeat(800)),
			textCustomMessage("raw-2", "b".repeat(800)),
		];
		const { fire, runLaunchedWork, pi, runtime } = setup({ entries, reflectAfterTokens: 999 });
		// contextWindow 1,280 -> cap = floor(1,280 * 0.2) = 256, so only raw-1 fits.
		runtime.resolveModel.mockResolvedValue({ ok: true, model: { reasoning: true, contextWindow: 1_280 }, apiKey: "key", headers: { h: "v" } } as any);

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({ allowedSourceEntryIds: ["raw-1"] }));
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, expect.objectContaining({ coversUpToId: "raw-1" }));
	});
});

describe("V3 reflection dropper stage", () => {
	const obsA = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 10 });
	const obsB = observation("bbbbbbbbbbbb", { sourceEntryIds: ["raw-2"], tokenCount: 10 });
	const refA = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);

	it("runs the reflection dropper on its own clock even when the reflector records nothing", async () => {
		mockAgents.runReflectionDropper.mockResolvedValueOnce(["eeeeeeeeeeee"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [refA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries, observeAfterTokens: 999, reflectionsPoolTargetTokens: 5 });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflector).not.toHaveBeenCalled();
		expect(mockAgents.runReflectionDropper).toHaveBeenCalledWith(expect.objectContaining({
			reflections: [refA],
			observations: [obsA],
			targetTokens: 5,
		}));
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_REFLECTIONS_DROPPED, { reflectionIds: ["eeeeeeeeeeee"], coversUpToId: "raw-1" });
	});

	it("records what the reflection dropper proposed next to what the budget let through", async () => {
		const refB = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		mockAgents.runReflectionDropper.mockImplementationOnce(async (args: any) => {
			args.onProposedIds(["eeeeeeeeeeee", "ffffffffffff"]);
			return ["eeeeeeeeeeee"];
		});
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA, obsB], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [refA, refB], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork } = setup({
			entries,
			observeAfterTokens: 999,
			reflectionsPoolTargetTokens: 5,
			systemOneDropper: { mode: "shadow", provider: "local-jev", vetoThreshold: 0.15, dropThreshold: 0.75 },
		});

		fire();
		await runLaunchedWork();

		expect(mockAgents.appendReflectionDropScores).toHaveBeenCalledTimes(1);
		const [sessionId, rows] = mockAgents.appendReflectionDropScores.mock.calls[0];
		expect(sessionId).toBe("session-1");
		expect(rows.map((row: any) => [row.reflectionId, row.proposed, row.decision])).toEqual([
			["eeeeeeeeeeee", true, "drop"],
			["ffffffffffff", true, "keep"],
		]);
		expect(rows.map((row: any) => row.sortRank).sort()).toEqual([0, 1]);
		expect(JSON.stringify(rows)).not.toContain(refA.content);
	});

	it("does not record reflection drop scores when the System One dropper is off", async () => {
		mockAgents.runReflectionDropper.mockResolvedValueOnce(["eeeeeeeeeeee"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [refA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork } = setup({ entries, observeAfterTokens: 999, reflectionsPoolTargetTokens: 5 });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflectionDropper).toHaveBeenCalled();
		expect(mockAgents.appendReflectionDropScores).not.toHaveBeenCalled();
	});

	it("does not run the reflection dropper when the reflector clock is not due", async () => {
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [refA], coversUpToId: "raw-2" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork } = setup({ entries, observeAfterTokens: 1, reflectAfterTokens: 999, reflectionsPoolTargetTokens: 5 });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalled();
		expect(mockAgents.runReflectionDropper).not.toHaveBeenCalled();
	});

	it("does not run the reflection dropper while the reflection pool is under target", async () => {
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [refA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork, ctx } = setup({ entries, observeAfterTokens: 999, reflectionsPoolTargetTokens: 1_000 });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflectionDropper).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("reflection dropper running"), "info");
	});

	it("covers reflection drops with same-run reflection coverage", async () => {
		const newRef = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runReflectionDropper.mockResolvedValueOnce(["eeeeeeeeeeee"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs-a", { observations: [obsA], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [refA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observationsRecordedEntry("om-obs-b", { observations: [obsB], coversUpToId: "raw-2" }),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries, observeAfterTokens: 999, reflectionsPoolTargetTokens: 5, observationsPoolTargetTokens: 1_000 });

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry.mock.calls[0]).toEqual([OM_REFLECTIONS_RECORDED, { reflections: [newRef], coversUpToId: "raw-2" }]);
		expect(pi.appendEntry.mock.calls[1]).toEqual([OM_REFLECTIONS_DROPPED, { reflectionIds: ["eeeeeeeeeeee"], coversUpToId: "raw-2" }]);
	});

	it("hides this run's dropped reflections from the observation dropper's coverage evidence", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runReflectionDropper.mockResolvedValueOnce(["eeeeeeeeeeee"]);
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [refA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observationsRecordedEntry("om-obs-b", { observations: [obsB], coversUpToId: "raw-2" }),
		];
		const { fire, runLaunchedWork, pi } = setup({
			entries,
			observeAfterTokens: 999,
			reflectionsPoolTargetTokens: 5,
			observationsPoolTargetTokens: 5,
		});

		fire();
		await runLaunchedWork();

		expect(mockAgents.runDropper).toHaveBeenCalledWith(expect.objectContaining({ reflections: [newRef] }));
		expect(pi.appendEntry.mock.calls.at(-1)).toEqual([OM_OBSERVATIONS_DROPPED, { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-2" }]);
	});

	it("shows the reflector active reflections and passes tombstoned ids as duplicates", async () => {
		const survivor = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [refA, survivor], coversUpToId: "raw-1" }),
			reflectionsDroppedEntry("om-ref-drop", { reflectionIds: ["eeeeeeeeeeee"], coversUpToId: "om-ref" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observationsRecordedEntry("om-obs-b", { observations: [obsB], coversUpToId: "raw-2" }),
		];
		const { fire, runLaunchedWork } = setup({ entries, observeAfterTokens: 999, reflectionsPoolTargetTokens: 1_000 });

		fire();
		await runLaunchedWork();

		const args = mockAgents.runReflector.mock.calls[0][0];
		expect(args.reflections).toEqual([survivor]);
		expect([...args.droppedReflectionIds]).toEqual(["eeeeeeeeeeee"]);
	});

	it("keeps a reflection dropper failure from blocking the observation dropper", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runReflectionDropper.mockRejectedValueOnce(new Error("reflection drop failed"));
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [refA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observationsRecordedEntry("om-obs-b", { observations: [obsB], coversUpToId: "raw-2" }),
		];
		const { fire, runLaunchedWork, runtime, pi } = setup({
			entries,
			observeAfterTokens: 999,
			reflectionsPoolTargetTokens: 5,
			observationsPoolTargetTokens: 5,
		});

		fire();
		await runLaunchedWork();

		expect(runtime.lastReflectionDropperError).toBe("reflection drop failed");
		expect(mockAgents.runDropper).toHaveBeenCalled();
		expect(pi.appendEntry.mock.calls.map((call) => call[0])).toEqual([OM_REFLECTIONS_RECORDED, OM_OBSERVATIONS_DROPPED]);
	});

	it("appends no reflection-drop entry when the reflection dropper drops nothing", async () => {
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [refA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries, observeAfterTokens: 999, reflectionsPoolTargetTokens: 5 });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflectionDropper).toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("notifies about reflection dropper progress only when worker notifications are on", async () => {
		mockAgents.runReflectionDropper.mockResolvedValue(["eeeeeeeeeeee"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [refA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const loud = setup({ entries, observeAfterTokens: 999, reflectionsPoolTargetTokens: 5 });
		loud.fire();
		await loud.runLaunchedWork();

		expect(loud.ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: reflection dropper running — reflection pool ~10 / 5 target tokens (200%)",
			"info",
		);
		expect(loud.ctx.ui.notify).toHaveBeenCalledWith("Observational memory: 1 reflection dropped", "info");

		const quiet = setup({ entries, observeAfterTokens: 999, reflectionsPoolTargetTokens: 5, showWorkerNotifications: false });
		quiet.fire();
		await quiet.runLaunchedWork();

		expect(quiet.ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("reflection dropper running"), "info");
	});
});

describe("consolidateWhenIdle", () => {
	const obs = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
	const dueEntries = [textCustomMessage("raw-1", "aaaaaaaa")];

	it("launches only from agent_settled", () => {
		const { fireAgentStart, fireTurnEnd, fireAgentSettled, runtime } = setup({ entries: dueEntries, consolidateWhenIdle: true });

		fireAgentStart();
		fireTurnEnd();
		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();

		fireAgentSettled();
		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
	});

	it("keeps the default entrypoints when disabled", () => {
		const { fireAgentSettled, fireTurnEnd, runtime } = setup({ entries: dueEntries, consolidateWhenIdle: false });

		fireAgentSettled();
		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
		fireTurnEnd();
		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
	});

	it("passes the run's abort signal to the workers", async () => {
		mockAgents.runObserver.mockResolvedValueOnce([obs]);
		const { fireAgentSettled, runLaunchedWork } = setup({ entries: dueEntries, consolidateWhenIdle: true, reflectAfterTokens: 999 });

		fireAgentSettled();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }));
	});

	it("aborts an in-flight run when the agent starts, without reporting a failure", async () => {
		mockAgents.runObserver.mockImplementationOnce((args: { signal: AbortSignal }) => new Promise((_, reject) => {
			if (args.signal.aborted) return reject(new Error("aborted"));
			args.signal.addEventListener("abort", () => reject(new Error("aborted")));
		}));
		const { fireAgentSettled, fireAgentStart, runLaunchedWork, runtime, pi, ctx } = setup({ entries: dueEntries, consolidateWhenIdle: true, reflectAfterTokens: 999 });

		fireAgentSettled();
		const work = runLaunchedWork();
		expect(runtime.consolidationInFlight).toBe(true);

		fireAgentStart();
		await work;

		expect(runtime.abortConsolidation).toHaveBeenCalledTimes(1);
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(runtime.lastObserverError).toBeUndefined();
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("failed"), "warning");
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: memory workers paused while the agent runs (consolidateWhenIdle)",
			"info",
		);
	});

	it("does not retry with the fallback model when the run was aborted", async () => {
		mockAgents.runObserver.mockImplementationOnce((args: { signal: AbortSignal }) => new Promise((_, reject) => {
			if (args.signal.aborted) return reject(new Error("aborted"));
			args.signal.addEventListener("abort", () => reject(new Error("aborted")));
		}));
		const { fireAgentSettled, fireAgentStart, runLaunchedWork, runtime, pi } = setup({ entries: dueEntries, consolidateWhenIdle: true, reflectAfterTokens: 999 });
		runtime.resolveFallbackModel.mockResolvedValue({ ok: true, model: { provider: "opencode-go", id: "fallback" }, apiKey: "go-key" });

		fireAgentSettled();
		const work = runLaunchedWork();
		await vi.waitFor(() => expect(mockAgents.runObserver).toHaveBeenCalledTimes(1));
		fireAgentStart();
		await work;

		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);
		expect(runtime.resolveFallbackModel).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("does not abort anything when no run is in flight", () => {
		const { fireAgentStart, runtime, ctx } = setup({ entries: dueEntries, consolidateWhenIdle: true });

		fireAgentStart();

		expect(runtime.abortConsolidation).toHaveBeenCalledTimes(1);
		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("calls afterIdleConsolidation once the run finishes, or immediately when nothing is due", async () => {
		mockAgents.runObserver.mockResolvedValueOnce([obs]);
		const afterIdleConsolidation = vi.fn();
		const { fireAgentSettled, runLaunchedWork, ctx } = setup({ entries: dueEntries, consolidateWhenIdle: true, reflectAfterTokens: 999, afterIdleConsolidation });

		fireAgentSettled();
		expect(afterIdleConsolidation).not.toHaveBeenCalled();
		await runLaunchedWork();
		await Promise.resolve();
		expect(afterIdleConsolidation).toHaveBeenCalledTimes(1);
		expect(afterIdleConsolidation).toHaveBeenCalledWith(ctx);

		const idle = setup({
			entries: [
				textCustomMessage("raw-1", "aaaa"),
				observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
			],
			consolidateWhenIdle: true,
			observeAfterTokens: 100,
			reflectAfterTokens: 100,
			afterIdleConsolidation,
		});
		idle.fireAgentSettled();
		expect(afterIdleConsolidation).toHaveBeenCalledTimes(2);
	});
});

describe("bounded worker memory in consolidation", () => {
	it("sends the observer only the newest prior memory that fits workerMemoryMaxTokens", async () => {
		const old = [1, 2, 3].map((i) => observation(`a${i}`.padEnd(12, "a"), { sourceEntryIds: [`raw-${i}`], content: `Old ${"o".repeat(120)}` }));
		const entries = [
			textCustomMessage("raw-1", "a"), textCustomMessage("raw-2", "b"), textCustomMessage("raw-3", "c"),
			observationsRecordedEntry("om-obs", { observations: old, coversUpToId: "raw-3" }),
			textCustomMessage("raw-4", "dddddddd"),
		];
		mockAgents.runObserver.mockResolvedValueOnce([observation("cccccccccccc", { sourceEntryIds: ["raw-4"] })]);
		const { fire, runLaunchedWork } = setup({ entries, reflectAfterTokens: 999, workerMemoryMaxTokens: 50 });

		fire();
		await runLaunchedWork();

		const args = mockAgents.runObserver.mock.calls[0][0];
		expect(args.priorObservations).toHaveLength(1);
		expect(args.priorObservations[0]).toContain("[a3aaaaaaaaaa]");
	});
});
