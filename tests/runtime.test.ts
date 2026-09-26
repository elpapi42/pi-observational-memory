import { describe, expect, it, vi } from "vitest";

import { Runtime } from "../src/runtime.js";

function modelRegistry(args: { found?: unknown; auth?: unknown } = {}) {
	return {
		find: vi.fn(() => args.found),
		getApiKeyAndHeaders: vi.fn(async () => args.auth ?? { ok: true, apiKey: "key", headers: { test: "yes" } }),
	};
}

describe("Runtime V3 behavior", () => {
	it("uses configured model when present", async () => {
		const runtime = new Runtime();
		const configured = { provider: "anthropic", id: "configured" };
		const registry = modelRegistry({ found: configured });
		runtime.config = { ...runtime.config, model: { provider: "anthropic", id: "configured" } };

		const result = await runtime.resolveModel({ model: { provider: "openai" }, modelRegistry: registry, hasUI: false });

		expect(registry.find).toHaveBeenCalledWith("anthropic", "configured");
		expect(result).toEqual({ ok: true, model: configured, apiKey: "key", headers: { test: "yes" } });
	});

	it("falls back to session model and notifies when configured model is missing", async () => {
		const runtime = new Runtime();
		const notify = vi.fn();
		const sessionModel = { provider: "openai" };
		const registry = modelRegistry();
		runtime.config = { ...runtime.config, model: { provider: "anthropic", id: "missing" } };

		const result = await runtime.resolveModel({ model: sessionModel, modelRegistry: registry, hasUI: true, ui: { notify } });

		expect(result).toMatchObject({ ok: true, model: sessionModel });
		expect(notify).toHaveBeenCalledWith(
			"Observational memory: configured model anthropic/missing not found, using session model",
			"warning",
		);
	});

	it("returns model resolution failures", async () => {
		const runtime = new Runtime();
		await expect(runtime.resolveModel({ model: undefined, modelRegistry: modelRegistry(), hasUI: false })).resolves.toEqual({
			ok: false,
			reason: "no model available (session has no model and no observational-memory model configured)",
		});

		const registry = modelRegistry({ auth: { ok: false } });
		await expect(runtime.resolveModel({ model: { provider: "anthropic" }, modelRegistry: registry, hasUI: false })).resolves.toEqual({
			ok: false,
			reason: 'no API key or auth headers for provider "anthropic"',
		});
	});

	it("accepts OAuth-shaped auth (headers only, no apiKey)", async () => {
		const runtime = new Runtime();
		const model = { provider: "kimi-coding", id: "kimi-for-coding" };
		const registry = modelRegistry({
			auth: { ok: true, apiKey: undefined, headers: { Authorization: "Bearer oauth-token" } },
		});

		const result = await runtime.resolveModel({ model, modelRegistry: registry, hasUI: false });

		expect(result).toEqual({
			ok: true,
			model,
			apiKey: undefined,
			headers: { Authorization: "Bearer oauth-token" },
		});
	});

	it("accepts apiKey auth unchanged", async () => {
		const runtime = new Runtime();
		const model = { provider: "anthropic", id: "claude" };
		const registry = modelRegistry({ auth: { ok: true, apiKey: "sk-ant-key" } });

		const result = await runtime.resolveModel({ model, modelRegistry: registry, hasUI: false });

		expect(result).toEqual({ ok: true, model, apiKey: "sk-ant-key", headers: undefined });
	});

	it.each([
		{ configured: false, headersOnly: false },
		{ configured: true, headersOnly: false },
		{ configured: false, headersOnly: true },
		{ configured: true, headersOnly: true },
	])("applies auth baseUrl without mutating the model (configured=$configured, headersOnly=$headersOnly)", async ({ configured, headersOnly }) => {
		const runtime = new Runtime();
		const model = Object.freeze({
			provider: "github-copilot",
			id: "gpt-4.1",
			baseUrl: "https://api.individual.githubcopilot.com",
			api: "openai-completions",
			contextWindow: 128000,
		});
		const baseUrl = "https://api.business.githubcopilot.com";
		const apiKey = headersOnly ? undefined : "test-key";
		const headers = { Authorization: "Bearer test-token" };
		const registry = modelRegistry({ found: model, auth: { ok: true, apiKey, headers, baseUrl } });
		const sessionModel = configured ? { provider: "openai", id: "session-model" } : model;
		if (configured) runtime.config = { ...runtime.config, model: { provider: model.provider, id: model.id } };

		const result = await runtime.resolveModel({ model: sessionModel, modelRegistry: registry, hasUI: false });

		expect(registry.getApiKeyAndHeaders).toHaveBeenCalledWith(model);
		expect(result).toMatchObject({ ok: true, model: { ...model, baseUrl }, apiKey, headers });
		if (!result.ok) throw new Error("model resolution failed");
		expect(result.model).not.toBe(model);
		expect(model.baseUrl).toBe("https://api.individual.githubcopilot.com");
	});

	it.each([undefined, ""])("keeps the original model when auth baseUrl is %j", async (baseUrl) => {
		const runtime = new Runtime();
		const model = Object.freeze({ provider: "openai", id: "test-model", baseUrl: "https://example.com/v1" });
		const registry = modelRegistry({ auth: { ok: true, apiKey: "test-key", baseUrl } });

		const result = await runtime.resolveModel({ model, modelRegistry: registry, hasUI: false });

		if (!result.ok) throw new Error("model resolution failed");
		expect(result.model).toBe(model);
	});

	it("rejects auth that carries neither apiKey nor usable headers", async () => {
		const runtime = new Runtime();
		const model = { provider: "xai" };

		for (const auth of [
			{ ok: true },
			{ ok: true, apiKey: "" },
			{ ok: true, headers: {} },
			{ ok: true, headers: { Authorization: "" } },
		]) {
			const registry = modelRegistry({ auth });
			await expect(runtime.resolveModel({ model, modelRegistry: registry, hasUI: false })).resolves.toEqual({
				ok: false,
				reason: 'no API key or auth headers for provider "xai"',
			});
		}
	});

	it("points OAuth providers at /login when auth resolution fails", async () => {
		const runtime = new Runtime();
		const model = { provider: "openai-codex", id: "gpt-5-codex" };
		const registry = {
			...modelRegistry({ auth: { ok: false, error: "refresh failed" } }),
			isUsingOAuth: vi.fn((candidate: { provider?: string }) => candidate?.provider === "openai-codex"),
		};

		const result = await runtime.resolveModel({ model, modelRegistry: registry, hasUI: false });

		expect(registry.isUsingOAuth).toHaveBeenCalledWith(model);
		expect(result).toEqual({
			ok: false,
			reason: 'authentication failed for provider "openai-codex" — OAuth credentials may have expired; run \'/login openai-codex\' to re-authenticate',
		});
	});

	it("tracks consolidation task state", async () => {
		const runtime = new Runtime();
		let release: (() => void) | undefined;
		const work = new Promise<void>((resolve) => {
			release = resolve;
		});

		const promise = runtime.launchConsolidationTask({ hasUI: false }, async () => {
			runtime.consolidationPhase = "observer";
			await work;
		});

		expect(runtime.consolidationInFlight).toBe(true);
		expect(runtime.consolidationPromise).toBe(promise);
		expect(runtime.consolidationPhase).toBe("observer");
		release?.();
		await promise;
		expect(runtime.consolidationInFlight).toBe(false);
		expect(runtime.consolidationPromise).toBeNull();
		expect(runtime.consolidationPhase).toBeUndefined();
	});

	it("records stage-specific consolidation errors", () => {
		const runtime = new Runtime();
		const notify = vi.fn();

		expect(runtime.recordConsolidationStageError({ hasUI: true, ui: { notify } }, "observer", new Error("observe failed"))).toBe("observe failed");
		expect(runtime.recordConsolidationStageError({ hasUI: true, ui: { notify } }, "reflector", new Error("reflect failed"))).toBe("reflect failed");
		expect(runtime.recordConsolidationStageError({ hasUI: true, ui: { notify } }, "dropper", "drop failed")).toBe("drop failed");

		expect(runtime.lastObserverError).toBe("observe failed");
		expect(runtime.lastReflectorError).toBe("reflect failed");
		expect(runtime.lastDropperError).toBe("drop failed");
		expect(notify).toHaveBeenCalledWith("Observational memory: observer failed: observe failed", "warning");
		expect(notify).toHaveBeenCalledWith("Observational memory: reflector failed: reflect failed", "warning");
		expect(notify).toHaveBeenCalledWith("Observational memory: dropper failed: drop failed", "warning");
	});

	it("keeps compaction flags independent", () => {
		const runtime = new Runtime();
		runtime.compactInFlight = true;
		runtime.compactHookInFlight = true;
		expect(runtime.consolidationInFlight).toBe(false);
		expect(runtime.consolidationPhase).toBeUndefined();
	});

	it("forwards env and baseUrl from model registry", async () => {
		const runtime = new Runtime();
		const model = { provider: "cloudflare-workers-ai", id: "@cf/mistralai/mistral-small-3.1-24b-instruct" };
		const registry = modelRegistry({
			auth: {
				ok: true,
				apiKey: "test-key",
				headers: { Authorization: "Bearer test" },
				env: { CLOUDFLARE_ACCOUNT_ID: "abc123" },
				baseUrl: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1"
			}
		});

		const result = await runtime.resolveModel({ model, modelRegistry: registry, hasUI: false });

		expect(result).toEqual({
			ok: true,
			model: { ...model, baseUrl: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1" },
			apiKey: "test-key",
			headers: { Authorization: "Bearer test" },
			env: { CLOUDFLARE_ACCOUNT_ID: "abc123" },
			baseUrl: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1"
		});
	});

	describe("fallback model", () => {
		const FALLBACK = { provider: "opencode-go", id: "deepseek-v4.1-flash" };

		function fallbackRegistry(primaryAuth: unknown, fallbackAuth: unknown) {
			return {
				find: vi.fn((provider: string, id: string) =>
					provider === FALLBACK.provider && id === FALLBACK.id ? { ...FALLBACK } : undefined,
				),
				getApiKeyAndHeaders: vi.fn(async (model: { provider?: string }) =>
					model.provider === FALLBACK.provider ? fallbackAuth : primaryAuth,
				),
				isUsingOAuth: vi.fn(() => false),
			};
		}

		it("resolves the fallback when the primary model has no usable auth", async () => {
			const runtime = new Runtime();
			const notify = vi.fn();
			runtime.config = { ...runtime.config, model: { provider: "anthropic", id: "haiku" }, fallbackModel: { ...FALLBACK } };
			const registry = fallbackRegistry({ ok: false, error: "expired" }, { ok: true, apiKey: "go-key" });

			const result = await runtime.resolveModel({
				model: { provider: "session" },
				modelRegistry: registry,
				hasUI: true,
				ui: { notify },
			});

			expect(result).toMatchObject({ ok: true, model: FALLBACK, apiKey: "go-key", fallbackUsed: true });
			if (!result.ok) throw new Error("model resolution failed");
			expect(result.primaryFailure).toContain("no API key or auth headers");
			expect(notify).toHaveBeenCalledWith(
				expect.stringContaining("using fallback opencode-go/deepseek-v4.1-flash"),
				"warning",
			);
		});

		it("does not consult the fallback when the primary model resolves", async () => {
			const runtime = new Runtime();
			const primary = { provider: "anthropic", id: "haiku" };
			runtime.config = { ...runtime.config, fallbackModel: { ...FALLBACK } };
			const registry = {
				find: vi.fn(() => ({ ...FALLBACK })),
				getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "primary-key" })),
			};

			const result = await runtime.resolveModel({ model: primary, modelRegistry: registry, hasUI: false });

			expect(result).toEqual({ ok: true, model: primary, apiKey: "primary-key", headers: undefined });
			expect(registry.find).not.toHaveBeenCalled();
		});

		it("reports both reasons when the primary and the fallback both fail", async () => {
			const runtime = new Runtime();
			runtime.config = { ...runtime.config, fallbackModel: { ...FALLBACK } };
			const registry = { ...fallbackRegistry({ ok: false }, { ok: false }), isUsingOAuth: vi.fn(() => false) };

			const result = await runtime.resolveModel({
				model: { provider: "anthropic" },
				modelRegistry: registry,
				hasUI: false,
			});

			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("expected failure");
			expect(result.reason).toContain('no API key or auth headers for provider "anthropic"');
			expect(result.reason).toContain('no API key or auth headers for provider "opencode-go"');
		});

		it("resolveFallbackModel reports unset, identical, and missing fallbacks", async () => {
			const runtime = new Runtime();
			const registry = {
				find: vi.fn((provider: string) => (provider === "anthropic" ? { provider: "anthropic", id: "haiku" } : undefined)),
				getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "k" })),
			};

			await expect(runtime.resolveFallbackModel({ model: undefined, modelRegistry: registry, hasUI: false })).resolves.toEqual({
				ok: false,
				reason: "no fallback model configured",
			});

			runtime.config = { ...runtime.config, model: { provider: "anthropic", id: "haiku" }, fallbackModel: { provider: "anthropic", id: "haiku" } };
			await expect(runtime.resolveFallbackModel({ model: undefined, modelRegistry: registry, hasUI: false })).resolves.toEqual({
				ok: false,
				reason: "fallback model anthropic/haiku is identical to the effective primary model",
			});

			runtime.config = { ...runtime.config, model: undefined, fallbackModel: { provider: "anthropic", id: "haiku" } };
			await expect(runtime.resolveFallbackModel({ model: { provider: "anthropic", id: "haiku" }, modelRegistry: registry, hasUI: false })).resolves.toEqual({
				ok: false,
				reason: "fallback model anthropic/haiku is identical to the effective primary model",
			});

			runtime.config = { ...runtime.config, fallbackModel: { ...FALLBACK } };
			await expect(runtime.resolveFallbackModel({ model: undefined, modelRegistry: registry, hasUI: false })).resolves.toEqual({
				ok: false,
				reason: "fallback model opencode-go/deepseek-v4.1-flash not found",
			});
		});

		it("resolveFallbackModel applies the same auth rules as the primary path", async () => {
			const runtime = new Runtime();
			runtime.config = { ...runtime.config, model: { provider: "anthropic", id: "haiku" }, fallbackModel: { ...FALLBACK } };
			const registry = fallbackRegistry({ ok: true, apiKey: "primary" }, { ok: true, headers: { Authorization: "Bearer go" } });

			const result = await runtime.resolveFallbackModel({ model: undefined, modelRegistry: registry, hasUI: false });

			expect(result).toEqual({ ok: true, model: FALLBACK, apiKey: undefined, headers: { Authorization: "Bearer go" } });
		});
	});
});
