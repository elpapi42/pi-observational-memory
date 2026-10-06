/**
 * pi classifier plumbing for the System One dropper.
 *
 * The endpoint is registered once by pi-jev's provider extension as classifier
 * provider `local-jev`; the dropper reaches it through
 * `ctx.modelRegistry.classify(model, { state, questions })` instead of holding an
 * endpoint, key and HTTP client of its own.
 */
import type {
	ClassifierApi,
	ClassifierBoolQuestion,
	ClassifierChoiceQuestion,
	ClassifierModel,
	ClassifierResult,
	ClassifierScoreQuestion,
	JsonObject,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export type { ClassifierAnswer, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";

/**
 * pi-ai types `instructions` as a plain string, but the System One wire also
 * accepts a structured object, and this dropper sends `{ observation_id,
 * question }` so the server binds each question to one observation. Only that
 * field is widened; the rest of the question shape is pi's.
 */
export type ClassifierInstructions = string | Record<string, unknown>;
export type ClassifierQuestion =
	| (Omit<ClassifierBoolQuestion, "instructions"> & { instructions: ClassifierInstructions })
	| (Omit<ClassifierScoreQuestion, "instructions"> & { instructions: ClassifierInstructions })
	| (Omit<ClassifierChoiceQuestion, "instructions"> & { instructions: ClassifierInstructions });

/** The slice of pi's ModelRegistry the dropper uses. */
export type ClassifierRegistry = Pick<ModelRegistry, "classify" | "getModelsOfType" | "findOfType">;

export type Classifier = (
	state: JsonObject,
	questions: Record<string, ClassifierQuestion>,
	signal?: AbortSignal,
) => Promise<{ answers: ClassifierResult["answers"]; usage?: ClassifierResult["usage"] }>;

export interface ClassifierSelection {
	provider?: string;
	model?: string;
}

/** pi-jev registers this provider; see pi-jev's `extensions/provider.ts`. */
export const DEFAULT_CLASSIFIER_PROVIDER = "local-jev";

/** The classifier model the dropper should use, or undefined when none is registered. */
export function findClassifierModel(
	registry: ClassifierRegistry | undefined,
	selection: ClassifierSelection,
): ClassifierModel<ClassifierApi> | undefined {
	if (!registry) return undefined;
	const provider = selection.provider ?? DEFAULT_CLASSIFIER_PROVIDER;
	if (selection.model) {
		return registry.findOfType("classifier", provider, selection.model)
			?? registry.getModelsOfType("classifier", provider).find((model) => model.id === selection.model);
	}
	return registry.getModelsOfType("classifier", provider)[0];
}

/**
 * Bind a model and timeout into the classify call the dropper uses.
 *
 * `undefined` means no classifier is registered; the caller decides whether that
 * is fatal (primary) or just skips scoring (shadow).
 */
export function resolveClassifier(
	registry: ClassifierRegistry | undefined,
	selection: ClassifierSelection,
	timeoutMs: number,
): Classifier | undefined {
	const model = findClassifierModel(registry, selection);
	if (!model || !registry) return undefined;
	return async (state, questions, signal) => {
		// The widened `instructions` is the only place this diverges from pi's type;
		// the transport passes questions through untouched.
		const result = await registry.classify(
			model,
			{ state, questions: questions as Parameters<ModelRegistry["classify"]>[1]["questions"] },
			{ signal, timeoutMs },
		);
		if (result.stopReason !== "stop") {
			throw new Error(
				`System One classification via ${model.provider}/${model.id} failed: ${result.errorMessage ?? result.stopReason}`,
			);
		}
		return { answers: result.answers, usage: result.usage };
	};
}
