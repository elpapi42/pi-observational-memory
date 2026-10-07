import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { expect, it } from "vitest";

import { ObserverStreamError, runObserver } from "../src/agents/observer/agent.js";
import { ReflectorStreamError, runReflector } from "../src/agents/reflector/agent.js";
import type { WorkerStreamSimple } from "../src/agents/worker-stream.js";
import { observation } from "./fixtures/session.js";

const MODEL = {
	id: "schema-probe",
	name: "Schema probe",
	provider: "anthropic",
	api: "anthropic-messages",
	baseUrl: "http://127.0.0.1:1",
	reasoning: false,
	input: ["text"],
	contextWindow: 200_000,
	maxTokens: 8_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies Model<"anthropic-messages">;

const REQUEST_SCHEMA = Type.Object({
	tools: Type.Array(
		Type.Object({
			name: Type.String(),
			input_schema: Type.Object({
				type: Type.Literal("object"),
				properties: Type.Record(Type.String(), Type.Unknown()),
				required: Type.Array(Type.String()),
			}),
		}),
	),
});

interface CapturedToolFields {
	name: string;
	properties: string[];
	required: string[];
}

it.each([
	["observer", "record_observations", "observations"],
	["reflector", "record_reflections", "reflections"],
] as const)("preserves %s tool fields through the real Anthropic adapter", async (worker, toolName, recordField) => {
	const captured: CapturedToolFields[] = [];
	const captureStream: WorkerStreamSimple = (...[, context, options]) =>
		streamAnthropic(MODEL, normalizeContext(context), {
			...options,
			onPayload(payload) {
				if (!Value.Check(REQUEST_SCHEMA, payload)) {
					throw new Error("Provider schema capture: malformed tool declaration");
				}
				for (const tool of payload.tools) {
					captured.push({
						name: tool.name,
						properties: Object.keys(tool.input_schema.properties).sort(),
						required: [...tool.input_schema.required].sort(),
					});
				}
				throw new Error("Provider schema capture: stopped before the HTTP request");
			},
		});
	const common = { model: MODEL, apiKey: "local-test-only", streamSimple: captureStream, maxTurns: 1 };
	const result =
		worker === "observer"
			? runObserver({
					...common,
					priorReflections: [],
					priorObservations: [],
					chunk: "[Source entry id: raw-1]\nUseful source fact.",
					allowedSourceEntryIds: ["raw-1"],
				})
			: runReflector({ ...common, observations: [observation("aaaaaaaaaaaa")], reflections: [] });

	await expect(result).rejects.toBeInstanceOf(worker === "observer" ? ObserverStreamError : ReflectorStreamError);
	expect(captured).toEqual([
		{
			name: toolName,
			properties: ["complete", recordField].sort(),
			required: ["complete", recordField].sort(),
		},
	]);
});
