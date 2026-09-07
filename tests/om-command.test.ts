import { describe, expect, it, vi } from "vitest";

import { registerActivationCommand } from "../src/commands/om.js";
import { DEFAULTS, type Config } from "../src/config.js";
import { Runtime } from "../src/runtime.js";

function setup(configOverrides: Partial<Config> = {}) {
	let handler: ((args: string, ctx: { cwd: string; ui: { notify: ReturnType<typeof vi.fn> } }) => Promise<void>) | undefined;
	const pi = {
		registerCommand: vi.fn((name: string, command: { handler: typeof handler }) => {
			expect(name).toBe("om");
			handler = command.handler;
		}),
	};

	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.config = { ...DEFAULTS, ...configOverrides };

	registerActivationCommand(pi as any, runtime);
	if (!handler) throw new Error("om command handler was not registered");

	const notices: Array<{ message: string; type?: string }> = [];
	const ctx = {
		cwd: "/tmp/project",
		ui: { notify: vi.fn((message: string, type?: string) => { notices.push({ message, type }); }) },
	};

	return { runtime, notices, invoke: (args = "") => handler!(args, ctx) };
}

describe("/om activation command", () => {
	it("leaves a fresh runtime disabled until /om is dispatched", () => {
		const { runtime } = setup();
		expect(runtime.enabled).toBe(false);
	});

	it("enables observational memory in this runtime on a bare dispatch", async () => {
		const { runtime, invoke, notices } = setup();

		await invoke("");

		expect(runtime.enabled).toBe(true);
		expect(notices).toEqual([{ message: "Observational memory enabled for this session.", type: "info" }]);
	});

	it("is idempotent: repeating /om reports already-enabled without re-running activation", async () => {
		const { runtime, invoke, notices } = setup();

		await invoke("");
		await invoke("");

		expect(runtime.enabled).toBe(true);
		expect(notices).toEqual([
			{ message: "Observational memory enabled for this session.", type: "info" },
			{ message: "Observational memory is already enabled.", type: "info" },
		]);
	});

	it("rejects a non-bare invocation without mutating activation state", async () => {
		const { runtime, invoke, notices } = setup();

		await invoke("status");

		expect(runtime.enabled).toBe(false);
		expect(notices).toEqual([{ message: "Usage: /om (no arguments)", type: "info" }]);
	});

	it("is a hard lockout under passive mode: activation never proceeds", async () => {
		const { runtime, invoke, notices } = setup({ passive: true });

		await invoke("");

		expect(runtime.enabled).toBe(false);
		expect(notices).toEqual([
			{ message: "Observational memory is locked out: passive mode is enabled for this runtime.", type: "warning" },
		]);
	});

	it("scopes activation to the runtime that received the command; an independent runtime is unaffected", async () => {
		const tuiSession = setup();
		const rpcSession = setup();

		await tuiSession.invoke("");

		expect(tuiSession.runtime.enabled).toBe(true);
		expect(rpcSession.runtime.enabled).toBe(false);
	});

	it("activation is lazy: no model resolution or consolidation/compaction work is scheduled by the command itself", async () => {
		const { runtime, invoke } = setup();
		const resolveModelSpy = vi.spyOn(runtime, "resolveModel");
		const launchSpy = vi.spyOn(runtime, "launchConsolidationTask");

		await invoke("");

		expect(resolveModelSpy).not.toHaveBeenCalled();
		expect(launchSpy).not.toHaveBeenCalled();
		expect(runtime.consolidationInFlight).toBe(false);
		expect(runtime.compactInFlight).toBe(false);
	});
});
