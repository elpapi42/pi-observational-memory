import { describe, expect, it, vi } from "vitest";
import { streamSimple as compatStreamSimple } from "@earendil-works/pi-ai/compat";

import { resolveWorkerStreamSimple, type WorkerStreamSimple } from "../src/agents/worker-stream.js";
import { runObserver } from "../src/agents/observer/agent.js";

const customStream = vi.fn() as unknown as WorkerStreamSimple;

describe("resolveWorkerStreamSimple", () => {
	const customApiModel = { api: "cursor-sdk", provider: "cursor", id: "grok-4.6" } as any;

	it("prefers an explicit override", () => {
		const override = vi.fn() as unknown as WorkerStreamSimple;
		expect(resolveWorkerStreamSimple(customApiModel, {
			streamSimple: customStream,
		}, override)).toBe(override);
	});

	it("uses ModelRegistry.streamSimple when the host exposes the composed facade", () => {
		expect(resolveWorkerStreamSimple(customApiModel, {
			streamSimple: customStream,
		})).not.toBe(compatStreamSimple);
		const resolved = resolveWorkerStreamSimple(customApiModel, { streamSimple: customStream });
		const model = {} as any;
		const context = {} as any;
		resolved(model, context);
		expect(customStream).toHaveBeenCalledWith(model, context, undefined);
	});

	it("matches getRegisteredProviderConfig().streamSimple by model.api", () => {
		const cursorStream = vi.fn() as unknown as WorkerStreamSimple;
		const otherStream = vi.fn() as unknown as WorkerStreamSimple;
		const resolved = resolveWorkerStreamSimple(customApiModel, {
			getRegisteredProviderIds: () => ["openai", "cursor"],
			getRegisteredProviderConfig: (id) => {
				if (id === "openai") return { api: "openai-completions", streamSimple: otherStream };
				if (id === "cursor") return { api: "cursor-sdk", streamSimple: cursorStream };
				return undefined;
			},
		});
		expect(resolved).toBe(cursorStream);
	});

	it("falls back to pi-ai compat for built-in APIs with no composed handler", () => {
		expect(resolveWorkerStreamSimple({ api: "openai-completions" } as any, {
			getRegisteredProviderIds: () => [],
			getRegisteredProviderConfig: () => undefined,
		})).toBe(compatStreamSimple);
	});

	it("falls back to compat when registry lookup throws", () => {
		expect(resolveWorkerStreamSimple(customApiModel, {
			getRegisteredProviderIds: () => {
				throw new Error("no runtime");
			},
			getRegisteredProviderConfig: () => undefined,
		})).toBe(compatStreamSimple);
	});
});

describe("runObserver composed stream dispatch", () => {
	it("passes the composed handler into agentLoop instead of compat streamSimple", async () => {
		const composed = vi.fn() as unknown as WorkerStreamSimple;
		let received: unknown;
		const loop = ((prompts: any[], context: any, config: any, _signal: unknown, streamFn: unknown) => {
			received = streamFn;
			return {
				async *[Symbol.asyncIterator]() {},
				result: async () => ({}),
			};
		}) as any;

		await runObserver({
			model: { api: "cliproxyapi-codex-responses", provider: "cliproxyapi", id: "haiku" } as any,
			apiKey: "test",
			priorReflections: [],
			priorObservations: [],
			chunk: "[Source entry id: entry-a]\nhello",
			allowedSourceEntryIds: ["entry-a"],
			agentLoop: loop,
			modelRegistry: {
				getRegisteredProviderIds: () => ["cliproxyapi"],
				getRegisteredProviderConfig: () => ({
					api: "cliproxyapi-codex-responses",
					streamSimple: composed,
				}),
			},
		});

		expect(received).toBe(composed);
	});
});
