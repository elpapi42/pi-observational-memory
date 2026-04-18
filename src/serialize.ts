import type { Message, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";

function fmt(epochMs: number): string {
	if (!Number.isFinite(epochMs)) return "????-??-?? ??:??";
	return new Date(epochMs).toISOString().slice(0, 16).replace("T", " ");
}

export function serializeConversation(messages: Message[]): string {
	return messages
		.map((msg): string | null => {
			const time = fmt(msg.timestamp);
			if (msg.role === "user") {
				const text =
					typeof msg.content === "string"
						? msg.content
						: msg.content
							.filter((b): b is TextContent => b.type === "text")
							.map((b) => b.text)
							.join("\n");
				return `[User @ ${time} UTC]: ${text}`;
			}
			if (msg.role === "assistant") {
				const parts = msg.content.map((b) => {
					if (b.type === "text") return b.text;
					if (b.type === "thinking") return b.redacted ? "" : `[thinking: ${b.thinking}]`;
					if (b.type === "toolCall") return `[${b.name}(${JSON.stringify(b.arguments)})]`;
					return "";
				});
				const body = parts.filter(Boolean).join("\n");
				if (!body) return null;
				return `[Assistant @ ${time} UTC]: ${body}`;
			}
			const text = msg.content
				.filter((b): b is TextContent => b.type === "text")
				.map((b) => b.text)
				.join("\n");
			return `[Tool result for ${(msg as ToolResultMessage).toolName} @ ${time} UTC]: ${text}`;
		})
		.filter((line): line is string => line !== null)
		.join("\n\n");
}

export function nowTimestamp(): string {
	return new Date().toISOString().slice(0, 16).replace("T", " ");
}
