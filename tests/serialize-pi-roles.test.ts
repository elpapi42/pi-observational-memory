import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { DEFAULTS } from "../src/config.js";
import { registerConsolidationTrigger } from "../src/hooks/consolidation-trigger.js";
import { Runtime } from "../src/runtime.js";
import { renderRecallSourceEntry, serializeSourceAddressedBranchEntries } from "../src/serialize.js";
import { textCustomMessage } from "./fixtures/session.js";

const TIMESTAMP = "2026-05-02T10:00:00.000Z";

/** What pi's AgentSession.recordBashResult stores for a user `!` command. */
function bashEntry(id: string, overrides: Record<string, unknown> = {}) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: TIMESTAMP,
		message: {
			role: "bashExecution",
			command: "npm test -- --grep checkout",
			output: "1 failing: checkout total rounds half-cents down",
			exitCode: 1,
			cancelled: false,
			truncated: false,
			timestamp: Date.parse(TIMESTAMP),
			...overrides,
		},
	};
}

function messageEntry(id: string, message: Record<string, unknown>) {
	return { type: "message", id, parentId: null, timestamp: TIMESTAMP, message: { timestamp: Date.parse(TIMESTAMP), ...message } };
}

describe("Pi message roles beyond user, assistant and tool result", () => {
	it("renders a user ! command's command, output and exit code into the observer chunk", () => {
		const { text, sourceEntryIds } = serializeSourceAddressedBranchEntries([bashEntry("bash-1")]);

		expect(sourceEntryIds).toEqual(["bash-1"]);
		expect(text).toContain("Ran `npm test -- --grep checkout`");
		expect(text).toContain("1 failing: checkout total rounds half-cents down");
		expect(text).toContain("Command exited with code 1");
		expect(text).not.toContain("undefined");
	});

	it("matches pi's bashExecutionToText for empty, cancelled and truncated runs", () => {
		const { text } = serializeSourceAddressedBranchEntries([
			bashEntry("bash-empty", { output: "", exitCode: 0 }),
			bashEntry("bash-cancelled", { cancelled: true, exitCode: null }),
			bashEntry("bash-truncated", { exitCode: 0, truncated: true, fullOutputPath: "/tmp/pi-bash-1.log" }),
		]);

		expect(text).toContain("Ran `npm test -- --grep checkout`\n(no output)");
		expect(text).toContain("(command cancelled)");
		expect(text).toContain("[Output truncated. Full output: /tmp/pi-bash-1.log]");
	});

	it("leaves out a !! command, which pi excludes from the model's context", () => {
		const { text, sourceEntryIds } = serializeSourceAddressedBranchEntries([
			bashEntry("bash-private", { excludeFromContext: true, output: "secret-looking output" }),
			textCustomMessage("raw-1", "User: after the private command."),
		]);

		expect(sourceEntryIds).toEqual(["raw-1"]);
		expect(text).not.toContain("secret-looking output");
	});

	it("skips system prompt sections in observation input and recall", () => {
		const entry = messageEntry("system-1", { role: "system", sections: { tools: "tool declarations" } });
		const { text, sourceEntryIds } = serializeSourceAddressedBranchEntries([entry]);

		expect(sourceEntryIds).toEqual([]);
		expect(text).toBe("");
		expect(renderRecallSourceEntry(entry)).toBeNull();
	});

	it("renders a user ! command for recall, and not a !! command", () => {
		const recalled = renderRecallSourceEntry(bashEntry("bash-1"));

		expect(recalled).toContain("Ran `npm test -- --grep checkout`");
		expect(recalled).toContain("1 failing: checkout total rounds half-cents down");
		expect(recalled).not.toContain("Tool result");
		expect(renderRecallSourceEntry(bashEntry("bash-private", { excludeFromContext: true }))).toBeNull();
	});

	it("sends a user ! command's command and output to the observer model", async () => {
		const prompts: string[] = [];
		const faux = createFauxCore({ provider: "faux-om", models: [{ id: "observer", contextWindow: 200_000, maxTokens: 8_000 }] });
		faux.setResponses([
			(context) => {
				for (const message of context.messages) {
					if (message.role !== "user") continue;
					for (const block of message.content as Array<{ type: string; text?: string }>) if (block.type === "text") prompts.push(block.text ?? "");
				}
				return fauxAssistantMessage("Nothing to record.");
			},
		]);
		const model = faux.getModel();
		const entries = [bashEntry("bash-1")];
		const handlers: Record<string, ((event: unknown, ctx: any) => void) | undefined> = {};
		const pi = { on: vi.fn((name: string, cb: (event: unknown, ctx: any) => void) => { handlers[name] = cb; }), appendEntry: vi.fn() };
		const runtime = new Runtime();
		runtime.configLoaded = true;
		runtime.config = { ...DEFAULTS, observeAfterTokens: 1, reflectAfterTokens: 1_000_000, showWorkerNotifications: false };
		runtime.resolveModel = async () => ({ ok: true, model, apiKey: "test-key" });
		registerConsolidationTrigger(pi as any, runtime);

		handlers.turn_end!(undefined, { cwd: "/tmp/project", hasUI: false, model, modelRegistry: { streamSimple: faux.streamSimple }, sessionManager: { getBranch: () => entries } });
		await runtime.consolidationPromise;

		const observerInput = prompts.join("\n");
		expect(observerInput).toContain("[Source entry id: bash-1]");
		expect(observerInput).toContain("Ran `npm test -- --grep checkout`");
		expect(observerInput).toContain("1 failing: checkout total rounds half-cents down");
	});
});
