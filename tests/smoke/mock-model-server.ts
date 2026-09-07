import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";

/**
 * Deterministic local model fixture for the real-host smoke test (#14).
 *
 * Implements just enough of the Anthropic Messages streaming protocol (SSE)
 * for OMP's real `anthropic-messages` client to parse successfully. No
 * external network access and no real credentials are required — the
 * provider extension (`fixture-provider.ts`) registers this server's URL
 * with a literal dummy API key.
 *
 * Responses are computed purely from the request body text, so the same
 * server instance can serve multiple independent OMP host processes at
 * once (parent, independent RPC session, passive-lockout session) without
 * any shared mutable routing state.
 */

export interface RecordedRequest {
	marker: string | undefined;
	toolNames: string[];
	rawBody: string;
}

export type ScriptFn = (info: RecordedRequest) => string;

function sse(events: Array<[string, unknown]>): string {
	return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

/** A plain end-turn text response. */
export function textStream(text: string): string {
	return sse([
		["message_start", {
			type: "message_start",
			message: {
				id: "msg_smoke",
				type: "message",
				role: "assistant",
				model: "om-smoke-model",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		}],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }],
		["message_stop", { type: "message_stop" }],
	]);
}

/** A single tool_use response that ends the turn on `stop_reason: "tool_use"`. */
export function toolUseStream(toolName: string, toolInput: unknown, toolCallId: string): string {
	return sse([
		["message_start", {
			type: "message_start",
			message: {
				id: "msg_smoke",
				type: "message",
				role: "assistant",
				model: "om-smoke-model",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		}],
		["content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: toolCallId, name: toolName, input: {} },
		}],
		["content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: JSON.stringify(toolInput) },
		}],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }],
		["message_stop", { type: "message_stop" }],
	]);
}

export async function startMockModelServer(
	script: ScriptFn,
): Promise<{ server: Server; baseUrl: string; requests: RecordedRequest[] }> {
	const requests: RecordedRequest[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const rawBody = Buffer.concat(chunks).toString("utf8");
			let toolNames: string[] = [];
			let markerSource = rawBody;
			try {
				const parsed = JSON.parse(rawBody) as { tools?: Array<{ name?: string }>; system?: unknown };
				toolNames = Array.isArray(parsed.tools) ? parsed.tools.map((t) => t.name ?? "").filter(Boolean) : [];
				markerSource = typeof parsed.system === "string"
					? parsed.system
					: Array.isArray(parsed.system)
						? parsed.system.map((s: { text?: string }) => s.text ?? "").join("\n")
						: rawBody;
			} catch {
				// Non-JSON body: fall back to raw-text marker search below.
			}
			const markerMatch = /SMOKE_MARKER:\s*(\S+)/.exec(markerSource) ?? /SMOKE_MARKER:\s*(\S+)/.exec(rawBody);
			const info: RecordedRequest = { marker: markerMatch?.[1], toolNames, rawBody };
			requests.push(info);
			const body = script(info);
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "close",
			});
			res.end(body);
		});
	});
	const { promise: listening, resolve: onListening } = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", onListening);
	await listening;
	const { port } = server.address() as AddressInfo;
	return { server, baseUrl: `http://127.0.0.1:${port}`, requests };
}

/**
 * Default deterministic behavior shared by every real-host smoke scenario:
 *
 * - A request whose history already contains `SMOKE_TASK_DONE` (our own task
 *   tool's result marker) always gets a plain acknowledgement — this is what
 *   terminates the tool-calling turn and prevents an infinite task-call loop.
 * - The first request containing the literal directive `SMOKE_ACTION: call_task`
 *   invokes the registered `smoke_task` fixture tool with a fixed delegation
 *   prompt; later requests in the same fixture run are acknowledged normally.
 * - A request offering the observer's `record_observations` tool extracts
 *   real `[Source entry id: ...]` markers OMP's observer embeds in the
 *   chunk it sends, and records one observation against the first one. This
 *   works against genuine session entry ids instead of guessed values.
 * - Everything else is a plain end-turn acknowledgement (ordinary prompts,
 *   reflector calls that never fire because `reflectAfterTokens` is huge,
 *   and native/child compaction summarization).
 */
let taskDispatched = false;
const observedSourceIds = new Set<string>();

export function defaultScript(info: RecordedRequest): string {
	if (info.rawBody.includes("SMOKE_TASK_DONE")) {
		return textStream("Acknowledged task completion.");
	}
	if (!taskDispatched && info.rawBody.includes("SMOKE_ACTION: call_task")) {
		taskDispatched = true;
		const taskToolName = info.toolNames.includes("_smoke_task") ? "_smoke_task" : "smoke_task";
		return toolUseStream(taskToolName, {
			task: "Attempt /om and a recall call for id 000000000000, then report a one-line status update. SMOKE_ACTION: child_status",
		}, "call_task_1");
	}
	if (info.rawBody.includes("SMOKE_ACTION: call_task") && taskDispatched) {
		return textStream("Acknowledged task completion.");
	}
	if (info.toolNames.includes("record_observations") || info.toolNames.includes("_record_observations")) {
		const sourceIds = Array.from(new Set(
			Array.from(info.rawBody.matchAll(/\[Source entry id:\s*([^\]]+)\]/g)).map((m) => m[1].trim()),
		));
		const sourceId = sourceIds[0];
		const recordTool = info.toolNames.includes("_record_observations") ? "_record_observations" : "record_observations";
		if (!sourceId) return textStream("No new content to observe.");
		if (observedSourceIds.has(sourceId)) return textStream("Observation recorded.");
		observedSourceIds.add(sourceId);
		return toolUseStream(recordTool, {
			observations: [{
				timestamp: "2026-09-07 12:00",
				content: "Smoke-test observation recorded against the real host fixture.",
				relevance: "high",
				sourceEntryIds: [sourceId],
			}],
		}, "call_observe_1");
	}
	return textStream("Acknowledged.");
}
