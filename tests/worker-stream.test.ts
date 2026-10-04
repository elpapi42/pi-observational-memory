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

	it("uses ModelRegistry.streamSimple without querying provider registration", () => {
		const registry = {
			streamSimple: customStream,
			getRegisteredProviderConfig: () => {
				throw new Error("registry must not be queried");
			},
		};
		expect(resolveWorkerStreamSimple(customApiModel, registry)).not.toBe(compatStreamSimple);
		const resolved = resolveWorkerStreamSimple(customApiModel, registry);
		const model = {} as any;
		const context = {} as any;
		resolved(model, context);
		expect(customStream).toHaveBeenCalledWith(model, context, undefined);
	});

	it("calls a class-based registry streamSimple with its receiver", () => {
		const runtimeStream = vi.fn() as unknown as WorkerStreamSimple;
		class RegistryDouble {
			runtime = { streamSimple: runtimeStream };

			streamSimple(model: any, context: any, options?: any) {
				return this.runtime.streamSimple(model, context, options);
			}
		}

		const registry = new RegistryDouble();
		const model = {} as any;
		const context = {} as any;

		expect(resolveWorkerStreamSimple(model, registry as any)).not.toBe(compatStreamSimple);
		resolveWorkerStreamSimple(model, registry as any)(model, context);
		expect(runtimeStream).toHaveBeenCalledWith(model, context, undefined);
	});

	it("uses the exact provider's composed stream despite a foreign same-API registration", () => {
		const cursorStream = vi.fn() as unknown as WorkerStreamSimple;
		const foreignStream = vi.fn() as unknown as WorkerStreamSimple;
		const getRegisteredProviderConfig = vi.fn((id: string) => {
			if (id === "cursor") return { api: "cursor-sdk", streamSimple: cursorStream };
			if (id === "other") return { api: "cursor-sdk", streamSimple: foreignStream };
			return undefined;
		});

		expect(resolveWorkerStreamSimple(customApiModel, {
			getRegisteredProviderIds: () => ["other", "cursor"],
			getRegisteredProviderConfig,
		})).toBe(cursorStream);
		expect(getRegisteredProviderConfig).toHaveBeenCalledWith("cursor");
	});

	it("falls back to compat when only a foreign provider has the same API", () => {
		const foreignStream = vi.fn() as unknown as WorkerStreamSimple;
		const minimaxModel = { api: "anthropic-messages", provider: "minimax", id: "MiniMax-M3" } as any;
		const getRegisteredProviderConfig = vi.fn((id: string) => {
			if (id === "anthropic") return { api: "anthropic-messages", streamSimple: foreignStream };
			return undefined;
		});

		expect(resolveWorkerStreamSimple(minimaxModel, {
			getRegisteredProviderIds: () => ["anthropic"],
			getRegisteredProviderConfig,
		})).toBe(compatStreamSimple);
		expect(getRegisteredProviderConfig).toHaveBeenCalledWith("minimax");
	});

	it("falls back to compat when the exact provider has a different API", () => {
		const minimaxStream = vi.fn() as unknown as WorkerStreamSimple;
		const minimaxModel = { api: "anthropic-messages", provider: "minimax", id: "MiniMax-M3" } as any;

		expect(resolveWorkerStreamSimple(minimaxModel, {
			getRegisteredProviderConfig: (id) => id === "minimax"
				? { api: "openai-completions", streamSimple: minimaxStream }
				: undefined,
		})).toBe(compatStreamSimple);
	});

	it("falls back to pi-ai compat for built-in APIs with no composed handler", () => {
		expect(resolveWorkerStreamSimple({ api: "openai-completions", provider: "openai", id: "gpt" } as any, {
			getRegisteredProviderConfig: () => undefined,
		})).toBe(compatStreamSimple);
	});

	it("falls back to compat when registry lookup throws", () => {
		expect(resolveWorkerStreamSimple(customApiModel, {
			getRegisteredProviderConfig: () => {
				throw new Error("no runtime");
			},
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
				getRegisteredProviderConfig: (id) => id === "cliproxyapi" ? {
					api: "cliproxyapi-codex-responses",
					streamSimple: composed,
				} : undefined,
			},
		});

		expect(received).toBe(composed);
	});
});
