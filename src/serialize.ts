import type { Message, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";

function pad(n: number): string {
	return n.toString().padStart(2, "0");
}

function fmtLocal(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatTimestamp(v: number | string | undefined): string {
	if (v === undefined) return "????-??-?? ??:??";
	const d = new Date(v);
	return Number.isNaN(d.getTime()) ? "????-??-?? ??:??" : fmtLocal(d);
}

export function serializeConversation(messages: Message[]): string {
	return messages
		.map((msg): string | null => {
			const time = formatTimestamp(msg.timestamp);
			if (msg.role === "user") {
				const text =
					typeof msg.content === "string"
						? msg.content
						: msg.content
							.filter((b): b is TextContent => b.type === "text")
							.map((b) => b.text)
							.join("\n");
				return `[User @ ${time}]: ${text}`;
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
				return `[Assistant @ ${time}]: ${body}`;
			}
			const text = msg.content
				.filter((b): b is TextContent => b.type === "text")
				.map((b) => b.text)
				.join("\n");
			return `[Tool result for ${(msg as ToolResultMessage).toolName} @ ${time}]: ${text}`;
		})
		.filter((line): line is string => line !== null)
		.join("\n\n");
}

export function nowTimestamp(): string {
	return fmtLocal(new Date());
}

export const MAX_RECORD_CONTENT_CHARS = 10_000;

export function truncateRecordContent(content: string): string {
	if (content.length <= MAX_RECORD_CONTENT_CHARS) return content;
	const head = content.slice(0, MAX_RECORD_CONTENT_CHARS);
	const dropped = content.length - MAX_RECORD_CONTENT_CHARS;
	return `${head} … [truncated ${dropped} chars]`;
}

type RenderableEntry = {
	type: string;
	timestamp?: string;
	message?: unknown;
	customType?: string;
	content?: unknown;
	summary?: unknown;
};

export function serializeBranchEntries(entries: RenderableEntry[]): string {
	const blocks: string[] = [];
	for (const entry of entries) {
		if (entry.type === "message" && entry.message) {
			const part = serializeConversation([entry.message as Message]);
			if (part) blocks.push(part);
			continue;
		}
		if (entry.type === "custom_message") {
			const time = formatTimestamp(entry.timestamp);
			let text = "";
			if (typeof entry.content === "string") {
				text = entry.content;
			} else if (Array.isArray(entry.content)) {
				text = (entry.content as Array<{ type?: string; text?: string }>)
					.filter((b) => b?.type === "text" && typeof b.text === "string")
					.map((b) => b.text as string)
					.join("\n");
			}
			const tag = entry.customType ? `Custom (${entry.customType})` : "Custom";
			blocks.push(`[${tag} @ ${time}]: ${text}`);
			continue;
		}
		if (entry.type === "branch_summary" && typeof entry.summary === "string") {
			const time = formatTimestamp(entry.timestamp);
			blocks.push(`[Branch summary @ ${time}]: ${entry.summary}`);
		}
	}
	return blocks.join("\n\n");
}
