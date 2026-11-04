import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { DEFAULTS } from "../src/config.js";
import { REFLECTOR_INCOMPLETE_ATTEMPTS, registerConsolidationTrigger } from "../src/hooks/consolidation-trigger.js";
import { Runtime } from "../src/runtime.js";
import { observation, observationsRecordedEntry, textCustomMessage } from "./fixtures/session.js";

type FauxSteps = Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0];

/** Real reflector loop over scripted faux turns; observation coverage makes only the reflector due. */
function reflectorFixture(steps: FauxSteps, configOverrides: Partial<typeof DEFAULTS> = {}) {
	const faux = createFauxCore({ provider: "faux-om", models: [{ id: "reflector", contextWindow: 200_000, maxTokens: 8_000 }] });
	faux.setResponses(steps);
	const model = faux.getModel();
	const entries = [
		textCustomMessage("raw-1", "User: deploys go out from the release branch every Monday."),
		observationsRecordedEntry("om-obs", {
			observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], content: "Deploys go out from the release branch every Monday." })],
			coversUpToId: "raw-1",
		}),
	];
	const handlers: Record<string, ((event: unknown, ctx: any) => void) | undefined> = {};
	const pi = { on: vi.fn((name: string, cb: (event: unknown, ctx: any) => void) => { handlers[name] = cb; }), appendEntry: vi.fn() };
	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.config = { ...DEFAULTS, observeAfterTokens: 1_000_000, reflectAfterTokens: 1, showWorkerNotifications: false, ...configOverrides };
	runtime.resolveModel = async () => ({ ok: true, model, apiKey: "test-key" });
	registerConsolidationTrigger(pi as any, runtime);
	const ctx = { cwd: "/tmp/project", hasUI: false, model, modelRegistry: { streamSimple: faux.streamSimple }, sessionManager: { getBranch: () => entries, getSessionId: () => "s1" } };
	const turn = async () => {
		handlers.turn_end!(undefined, ctx);
		await runtime.consolidationPromise;
	};
	return { faux, runtime, pi, turn };
}

describe("incomplete reflector runs", () => {
	it("retries a response cut off by the token limit instead of backing off, within a bound", async () => {
		const truncated = () => fauxAssistantMessage("Let me consider which observations are", { stopReason: "length" });
		const { faux, runtime, pi, turn } = reflectorFixture(Array.from({ length: 5 }, () => truncated));

		await turn();
		expect(runtime.reflectorEmptyBackoff).toBeUndefined();
		expect(faux.state.callCount).toBe(1);

		await turn();
		expect(runtime.reflectorEmptyBackoff).toBeDefined();
		expect(faux.state.callCount).toBe(REFLECTOR_INCOMPLETE_ATTEMPTS);
		expect(runtime.reflectorEmptyBackoff).toMatchObject({ observationCoverageId: "raw-1" });
		expect(runtime.lastReflectorError).toContain("cut off by the output-token limit");

		await turn();
		await turn();
		expect(faux.state.callCount).toBe(REFLECTOR_INCOMPLETE_ATTEMPTS);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("retries a turn-capped run whose proposals were all rejected instead of backing off, within a bound", async () => {
		const rejected = () => fauxAssistantMessage(
			[fauxToolCall("record_reflections", { reflections: [{ content: "Deploys happen on Mondays.", supportingObservationIds: ["not-an-observation"] }] })],
			{ stopReason: "toolUse" },
		);
		const { faux, runtime, pi, turn } = reflectorFixture(Array.from({ length: 5 }, () => rejected), { agentMaxTurns: 1 });

		await turn();
		expect(runtime.reflectorEmptyBackoff).toBeUndefined();
		expect(faux.state.callCount).toBe(1);

		await turn();
		expect(runtime.reflectorEmptyBackoff).toBeDefined();
		expect(faux.state.callCount).toBe(REFLECTOR_INCOMPLETE_ATTEMPTS);
		expect(runtime.reflectorEmptyBackoff).toMatchObject({ observationCoverageId: "raw-1" });
		expect(runtime.lastReflectorError).toContain("turn cap");

		await turn();
		await turn();
		expect(faux.state.callCount).toBe(REFLECTOR_INCOMPLETE_ATTEMPTS);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("backs off at once after a run that finishes with a text-only reply", async () => {
		const { faux, runtime, turn } = reflectorFixture([fauxAssistantMessage("Nothing durable yet."), fauxAssistantMessage("Nothing durable yet.")]);

		await turn();
		await turn();

		expect(faux.state.callCount).toBe(1);
		expect(runtime.reflectorEmptyBackoff).toMatchObject({ observationCoverageId: "raw-1" });
		expect(runtime.lastReflectorError).toBeUndefined();
	});
});
