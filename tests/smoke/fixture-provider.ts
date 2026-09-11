import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Real-host smoke test fixture provider (#14).
 *
 * Registers a custom pi provider pointed at the local `mock-model-server.ts`
 * HTTP fixture (`OM_SMOKE_BASE_URL`, set by `run.ts` before spawning the
 * host). The API key is a literal dummy string — the fixture server never
 * checks it — so the smoke path needs no real provider credentials.
 */

export const OM_SMOKE_PROVIDER_ID = "om-smoke";
export const OM_SMOKE_MODEL_ID = "om-smoke-model";

export default function fixtureProvider(pi: ExtensionAPI): void {
	const baseUrl = process.env.OM_SMOKE_BASE_URL;
	if (!baseUrl) {
		throw new Error("OM_SMOKE_BASE_URL must be set before loading tests/smoke/fixture-provider.ts");
	}
	pi.registerProvider(OM_SMOKE_PROVIDER_ID, {
		name: "OM Smoke Fixture",
		baseUrl,
		apiKey: "smoke-fixture-dummy-key",
		api: "anthropic-messages",
		models: [
			{
				id: OM_SMOKE_MODEL_ID,
				name: "OM Smoke Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 256,
			},
		],
	});
}
