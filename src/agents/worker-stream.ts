import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple as compatStreamSimple } from "@earendil-works/pi-ai/compat";

export type WorkerStreamSimple = (
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/**
 * Duck-typed subset of Pi's extension ModelRegistry.
 *
 * `streamSimple` is the host-composed path (Pi #8964). Until that lands on the
 * facade, `getRegisteredProviderConfig` still exposes each `registerProvider`
 * `streamSimple` handler, keyed by the extension provider id — match on
 * `config.api === model.api`.
 */
export type StreamableModelRegistry = {
	streamSimple?: WorkerStreamSimple;
	getRegisteredProviderIds?: () => readonly string[];
	getRegisteredProviderConfig?: (providerId: string) => {
		api?: string;
		streamSimple?: WorkerStreamSimple;
	} | undefined;
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

	const registryStream = modelRegistry?.streamSimple;
	if (typeof registryStream === "function") {
		return (nextModel, context, options) => registryStream(nextModel, context, options);
	}

	try {
		if (
			typeof modelRegistry?.getRegisteredProviderIds === "function"
			&& typeof modelRegistry?.getRegisteredProviderConfig === "function"
		) {
			for (const providerId of modelRegistry.getRegisteredProviderIds()) {
				const config = modelRegistry.getRegisteredProviderConfig(providerId);
				const composed = config?.streamSimple;
				if (config?.api === model.api && typeof composed === "function") {
					return composed;
				}
			}
		}
	} catch {
		// Incomplete host/test doubles still use the built-in compat dispatcher.
	}

	return compatStreamSimple;
}
