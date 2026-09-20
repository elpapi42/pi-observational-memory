import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export type ReflectorStreamStep =
	| {
		toolName: "validate_supporting_observation_ids" | "record_reflections";
		arguments: unknown;
		stopReason?: "toolUse" | "error" | "aborted" | "length";
		errorMessage?: string;
	}
	| { stopReason: "stop" | "error" | "aborted" | "length"; errorMessage?: string };

function assistant(model: any) {
	return {
		role: "assistant",
		content: [] as any[],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

/** Drives the production agentLoop through an exact sequence of reflector tool calls and terminal responses. */
export function scriptedReflectorStream(steps: ReflectorStreamStep[]) {
	let callCount = 0;
	const toolFeedback: Array<{
		role: string;
		toolCallId: string;
		toolName: string;
		text: string;
		details?: unknown;
		isError?: boolean;
	}> = [];
	let capturedMessageCount = 0;

	const streamSimple = (model: any, context: any) => {
		for (const message of context.messages?.slice(capturedMessageCount) ?? []) {
			if (message.role === "toolResult") {
				toolFeedback.push({
					role: message.role,
					toolCallId: message.toolCallId,
					toolName: message.toolName,
					text: (message.content ?? []).map((part: any) => part.text ?? "").join(" "),
					details: message.details,
					isError: message.isError,
				});
			}
		}
		capturedMessageCount = context.messages?.length ?? 0;
		const step = steps[callCount++];
		if (!step) throw new Error(`Unexpected reflector stream call ${callCount}`);
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const output = assistant(model);
			output.errorMessage = step.errorMessage;
			stream.push({ type: "start", partial: output } as any);
			if ("toolName" in step) {
				const toolCall = {
					type: "toolCall",
					id: `tool-${callCount}`,
					name: step.toolName,
					arguments: step.arguments,
				};
				output.content.push(toolCall);
				stream.push({ type: "toolcall_start", contentIndex: 0, partial: output } as any);
				stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(step.arguments), partial: output } as any);
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output } as any);
				output.stopReason = step.stopReason ?? "toolUse";
				stream.push({ type: "done", reason: output.stopReason, message: output } as any);
			} else if (step.stopReason === "error") {
				output.stopReason = "error";
				stream.push({ type: "done", reason: "error", message: output } as any);
			} else {
				const text = { type: "text", text: "Reflection pass complete." };
				output.content.push(text);
				stream.push({ type: "text_start", contentIndex: 0, partial: output } as any);
				stream.push({ type: "text_delta", contentIndex: 0, delta: text.text, partial: output } as any);
				stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial: output } as any);
				output.stopReason = step.stopReason;
				stream.push({ type: "done", reason: step.stopReason, message: output } as any);
			}
			stream.end();
		});
		return stream;
	};

	return { streamSimple, toolFeedback, calls: () => callCount };
}
