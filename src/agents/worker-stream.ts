import type { AssistantMessageEventStream, Context, KnownApi, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getApiProvider, streamSimple as compatStreamSimple } from "@earendil-works/pi-ai/compat";

export type WorkerStreamSimple = (
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/**
 * Duck-typed subset of Pi's extension ModelRegistry.
 *
 * `streamSimple` is the host-composed path (Pi #8964). Until that lands on the
 * facade, `getRegisteredProviderConfig` exposes each `registerProvider`
 * `streamSimple` handler by provider id. Use only the model's exact provider
 * and require matching API metadata as a consistency check.
 */
export type StreamableModelRegistry = {
	streamSimple?: WorkerStreamSimple;
	getRegisteredProviderConfig?: (providerId: string) => {
		api?: string;
		streamSimple?: WorkerStreamSimple;
	} | undefined;
};

// Typed as a Record so a new pi-ai built-in API fails typecheck until listed.
const BUILTIN_APIS: Record<KnownApi, true> = {
	"openai-completions": true,
	"mistral-conversations": true,
	"openai-responses": true,
	"azure-openai-responses": true,
	"openai-codex-responses": true,
	"anthropic-messages": true,
	"bedrock-converse-stream": true,
	"google-generative-ai": true,
	"google-vertex": true,
	"pi-messages": true,
};

/**
 * Resolve the stream function background workers must pass to `agentLoop`.
 *
 * Direct `@earendil-works/pi-ai/compat` `streamSimple` only knows built-in API
 * ids. Custom providers (`cursor-sdk`, `cliproxyapi-*`, commandcode, …) live on
 * Pi's composed runtime. Using compat after a successful foreground turn is
 * what crashes Pi with `No API provider registered for api: …` (#30).
 */
export function resolveWorkerStreamSimple(
	model: Model<any>,
	modelRegistry?: StreamableModelRegistry | null,
	override?: WorkerStreamSimple,
): WorkerStreamSimple {
	if (override) return override;

	// An extension that also registers its custom API id in pi-ai's own registry
	// is declaring the handler for calls outside Pi's conversation. Pi's composed
	// path would route a worker to that extension's conversation provider instead,
	// which may reject the worker's own system prompt.
	if (!Object.hasOwn(BUILTIN_APIS, model.api) && getApiProvider(model.api)) {
		return compatStreamSimple;
	}

	const registryStream = modelRegistry?.streamSimple;
	if (typeof registryStream === "function") {
		return (nextModel, context, options) => registryStream.call(modelRegistry, nextModel, context, options);
	}

	try {
		const config = modelRegistry?.getRegisteredProviderConfig?.(model.provider);
		const composed = config?.streamSimple;
		if (config?.api === model.api && typeof composed === "function") {
			return composed;
		}
	} catch {
		// Incomplete host/test doubles still use the built-in compat dispatcher.
	}

	return compatStreamSimple;
}
