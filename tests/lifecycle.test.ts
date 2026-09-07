import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgents = vi.hoisted(() => ({
	runObserver: vi.fn(),
	runReflector: vi.fn(),
	runDropper: vi.fn(),
}));

vi.mock("../src/agents/observer/agent.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/agents/observer/agent.js")>()),
	runObserver: mockAgents.runObserver,
}));
vi.mock("../src/agents/reflector/agent.js", () => ({ runReflector: mockAgents.runReflector }));
vi.mock("../src/agents/dropper/agent.js", () => ({ runDropper: mockAgents.runDropper }));

import { DEFAULTS } from "../src/config.js";
import { registerCompactionTrigger } from "../src/hooks/compaction-trigger.js";
import { registerConsolidationTrigger } from "../src/hooks/consolidation-trigger.js";
import { registerLifecycleReset } from "../src/hooks/lifecycle.js";
import { Runtime } from "../src/runtime.js";
import { gateRecallTool } from "../src/tool-gate.js";
import { observation, textCustomMessage } from "./fixtures/session.js";

function setup(activeTools: string[] = ["read", "bash", "recall"]) {
	const handlers: Record<string, ((event: unknown, ctx: any) => void) | undefined> = {};
	let currentActiveTools = [...activeTools];
	const pi = {
		on: vi.fn((eventName: string, cb: (event: unknown, ctx: any) => void) => {
			handlers[eventName] = cb;
		}),
		appendEntry: vi.fn(),
		getActiveTools: vi.fn(() => currentActiveTools),
		setActiveTools: vi.fn((names: string[]) => {
			currentActiveTools = [...names];
		}),
	};
	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.config = { ...DEFAULTS, observeAfterTokens: 1, reflectAfterTokens: 1_000_000, agentMaxTurns: 1 };
	runtime.enabled = true;
	runtime.sessionBoundaryReset = () => gateRecallTool(pi as any, runtime);

	registerLifecycleReset(pi as any, runtime);
	registerConsolidationTrigger(pi as any, runtime);
	registerCompactionTrigger(pi as any, runtime);

	return { pi, runtime, handlers, getActiveTools: () => currentActiveTools };
}

describe("session lifecycle reset and generation invalidation", () => {
	beforeEach(() => {
		mockAgents.runObserver.mockReset();
		mockAgents.runReflector.mockReset();
		mockAgents.runDropper.mockReset();
	});

	it("registers session_start and session_shutdown handlers", () => {
		const { pi } = setup();
		expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
	});

	it("resets activation to disabled on session_start regardless of prior activation", () => {
		const { runtime, handlers } = setup();
		expect(runtime.enabled).toBe(true);

		handlers.session_start!({ type: "session_start", reason: "reload" }, {});

		expect(runtime.enabled).toBe(false);
	});

	it("resets activation on every enumerated session boundary reason", () => {
		const reasons = ["startup", "reload", "new", "resume", "fork"] as const;
		for (const reason of reasons) {
			const { runtime, handlers } = setup();
			handlers.session_start!({ type: "session_start", reason }, {});
			expect(runtime.enabled).toBe(false);
		}
	});
	it("re-gates recall when a session id changes without a session_start event", () => {
		const { runtime, handlers, getActiveTools } = setup(["read", "recall"]);
		runtime.activatedSessionId = "session-1";

		handlers.before_agent_start!({ type: "before_agent_start" }, {
			sessionManager: { getSessionId: () => "session-2" },
		});

		expect(runtime.enabled).toBe(false);
		expect(getActiveTools()).toEqual(["read"]);
	});


	it("gates recall out of the active tool allowlist on session_start while preserving other active tools (#12)", () => {
		const { runtime, handlers, getActiveTools } = setup(["read", "bash", "recall"]);

		handlers.session_start!({ type: "session_start", reason: "startup" }, {});

		expect(getActiveTools()).toEqual(["read", "bash"]);
		expect(runtime.recallActiveBeforeGate).toBe(true);
	});

	it("re-runs the recall gate on every session boundary reason without duplicating removals", () => {
		const reasons = ["startup", "reload", "new", "resume", "fork"] as const;
		for (const reason of reasons) {
			const { handlers, getActiveTools } = setup(["read", "recall"]);
			handlers.session_start!({ type: "session_start", reason }, {});
			expect(getActiveTools()).toEqual(["read"]);
		}
	});

	it("leaves the active tool allowlist untouched when recall was never active", () => {
		const { runtime, handlers, pi, getActiveTools } = setup(["read", "bash"]);

		handlers.session_start!({ type: "session_start", reason: "startup" }, {});

		expect(getActiveTools()).toEqual(["read", "bash"]);
		expect(runtime.recallActiveBeforeGate).toBe(false);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("bumps the generation and clears in-flight flags on session_shutdown", () => {
		const { runtime, handlers } = setup();
		runtime.consolidationInFlight = true;
		runtime.compactInFlight = true;
		runtime.compactHookInFlight = true;
		const before = runtime.generation;

		handlers.session_shutdown!({ type: "session_shutdown", reason: "reload" }, {});

		expect(runtime.generation).toBe(before + 1);
		expect(runtime.consolidationInFlight).toBe(false);
		expect(runtime.compactInFlight).toBe(false);
		expect(runtime.compactHookInFlight).toBe(false);
	});

	it("stops an in-flight consolidation run from writing to the ledger or notifying after session_shutdown", async () => {
		const { pi, runtime, handlers } = setup();
		let resolveObserver: (value: unknown) => void = () => {};
		mockAgents.runObserver.mockImplementation(
			() => new Promise((resolve) => { resolveObserver = resolve; }),
		);

		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const notices: string[] = [];
		const ctx = {
			cwd: "/tmp/project",
			hasUI: true,
			ui: { notify: (message: string) => notices.push(message) },
			model: { provider: "anthropic", id: "claude", contextWindow: 200_000 },
			modelRegistry: {
				find: () => undefined,
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
				isUsingOAuth: () => false,
				hasConfiguredAuth: () => true,
			},
			sessionManager: { getBranch: () => entries, getSessionId: () => "session-1" },
		};

		handlers.turn_end!(undefined, ctx);
		expect(runtime.consolidationInFlight).toBe(true);
		const inFlight = runtime.consolidationPromise;
		expect(inFlight).not.toBeNull();

		// Session tears down while the observer call is still awaiting a response.
		handlers.session_shutdown!({ type: "session_shutdown", reason: "reload" }, {});
		expect(runtime.consolidationInFlight).toBe(false);

		// The stale observer call now resolves with real observations.
		resolveObserver([observation("late-obs", { sourceEntryIds: ["raw-1"], tokenCount: 5 })]);
		await inFlight;

		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(notices.some((message) => message.includes("recorded"))).toBe(false);
	});

	it("stops a deferred proactive compaction from running after session_shutdown", async () => {
		vi.useFakeTimers();
		try {
			const { runtime, handlers } = setup();
			runtime.config = { ...runtime.config, compactAfterTokens: 1 };
			const entries = [textCustomMessage("raw-1", "aaaaaaaaaaaa")];
			const compact = vi.fn();
			const ctx = {
				cwd: "/tmp/project",
				hasUI: true,
				ui: { notify: vi.fn() },
				model: undefined,
				sessionManager: { getBranch: () => entries },
				isIdle: () => true,
				compact,
			};

			handlers.agent_settled!(undefined, ctx);
			expect(runtime.compactInFlight).toBe(true);

			handlers.session_shutdown!({ type: "session_shutdown", reason: "reload" }, {});
			expect(runtime.compactInFlight).toBe(false);

			await vi.runAllTimersAsync();

			expect(compact).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
