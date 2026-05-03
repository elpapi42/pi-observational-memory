import { describe, expect, it, vi } from "vitest";

import { registerStatusCommand } from "../src/commands/status.js";
import { registerCompactionTrigger } from "../src/hooks/compaction-trigger.js";
import { registerObserverTrigger } from "../src/hooks/observer-trigger.js";
import type { MemoryDetailsV4 } from "../src/types.js";
import { compactionEntry, messageEntry } from "./fixtures/session.js";

function passiveRuntime() {
	const runtime = {
		ensureConfig: vi.fn(() => {
			runtime.config.passive = true;
		}),
		config: {
			observationThresholdTokens: 1,
			compactionThresholdTokens: 1,
			reflectionThresholdTokens: 1,
			passive: false,
		},
		observerInFlight: false,
		compactInFlight: false,
		observerPromise: undefined,
		launchObserverTask: vi.fn(),
	};
	return runtime;
}

function captureEventHandler(eventName: string, register: (pi: never, runtime: never) => void) {
	let handler: ((event: unknown, ctx: unknown) => void) | undefined;
	const pi = {
		on: vi.fn((name: string, cb: typeof handler) => {
			expect(name).toBe(eventName);
			handler = cb;
		}),
	};
	const runtime = passiveRuntime();
	register(pi as never, runtime as never);
	if (!handler) throw new Error(`${eventName} handler was not registered`);
	return { handler, runtime };
}

describe("passive mode proactive triggers", () => {
	it("observer trigger no-ops after loading passive config", () => {
		const { handler, runtime } = captureEventHandler("turn_end", registerObserverTrigger as never);
		const ctx = {
			cwd: "/tmp/project",
			sessionManager: {
				getBranch: vi.fn(() => []),
				getLeafId: vi.fn(() => "leaf"),
			},
			hasUI: true,
			ui: { notify: vi.fn() },
		};

		handler({}, ctx);

		expect(runtime.ensureConfig).toHaveBeenCalledWith(ctx.cwd);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(runtime.launchObserverTask).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("proactive compaction trigger no-ops after loading passive config", () => {
		const { handler, runtime } = captureEventHandler("agent_end", registerCompactionTrigger as never);
		const ctx = {
			cwd: "/tmp/project",
			sessionManager: { getBranch: vi.fn(() => []) },
			hasUI: true,
			ui: { notify: vi.fn() },
			isIdle: vi.fn(() => true),
			compact: vi.fn(),
		};

		handler({}, ctx);

		expect(runtime.ensureConfig).toHaveBeenCalledWith(ctx.cwd);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
	});
});

describe("/om-status passive mode", () => {
	it("reports passive mode while keeping status available", async () => {
		let handler: ((args: string[], ctx: unknown) => Promise<void>) | undefined;
		const pi = {
			registerCommand: vi.fn((name: string, command: { handler: typeof handler }) => {
				expect(name).toBe("om-status");
				handler = command.handler;
			}),
		};
		const runtime = passiveRuntime();
		registerStatusCommand(pi as never, runtime as never);
		if (!handler) throw new Error("om-status handler was not registered");

		const details: MemoryDetailsV4 = {
			type: "observational-memory",
			version: 4,
			observations: [],
			reflections: [],
		};
		const notify = vi.fn();
		await handler([], {
			cwd: "/tmp/project",
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
		expect(message).toContain("── Mode ──");
		expect(message).toContain("Passive: proactive observation and compaction triggers disabled; compaction hook remains active");
		expect(message).toContain("Observation trigger: passive");
		expect(message).toContain("proactive observation is disabled; manual/Pi compaction can still run sync catch-up observation");
		expect(message).toContain("Compaction trigger:  passive");
		expect(message).toContain("proactive extension-triggered compaction is disabled; manual/Pi compaction still uses the custom hook");
		expect(message).not.toContain("Next observation:");
		expect(message).not.toContain("Next compaction:");
	});
});
