import type { Message, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";

function pad(n: number): string {
	return n.toString().padStart(2, "0");
}

function fmtLocal(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmt(epochMs: number): string {
	if (!Number.isFinite(epochMs)) return "????-??-?? ??:??";
	return fmtLocal(new Date(epochMs));
}

function fmtIso(iso: string | undefined): string {
	if (!iso) return "????-??-?? ??:??";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? "????-??-?? ??:??" : fmtLocal(d);
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

type RenderableEntry = {
	type: string;
	timestamp?: string;
	message?: unknown;
	customType?: string;
	content?: unknown;
	summary?: unknown;
};

function extractPreviewText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return (content as Array<{ type?: string; text?: string }>)
			.filter((b) => b?.type === "text" && typeof b.text === "string")
			.map((b) => b.text as string)
			.join("");
	}
	return "";
}

export function renderBranchEntryOneLine(entry: RenderableEntry): string {
	const maxLen = 200;
	const normalize = (s: string) => s.replace(/[\n\t]/g, " ").trim();
	const truncate = (s: string) => (s.length > maxLen ? `${s.slice(0, maxLen)}…` : s);

	if (entry.type === "message" && entry.message) {
		const msg = entry.message as { role: string; content?: unknown; stopReason?: string; toolName?: string; command?: string };
		if (msg.role === "user") {
			return `user: ${truncate(normalize(extractPreviewText(msg.content)))}`;
		}
		if (msg.role === "assistant") {
			const text = normalize(extractPreviewText(msg.content));
			if (!text) return `assistant: ${msg.stopReason === "aborted" ? "(aborted)" : "(no content)"}`;
			return `assistant: ${truncate(text)}`;
		}
		if (msg.role === "toolResult") {
			return `[tool: ${msg.toolName ?? "tool"}]`;
		}
		if (msg.role === "bashExecution") {
			return `[bash]: ${truncate(normalize(msg.command ?? ""))}`;
		}
		return `[${msg.role}]`;
	}
	if (entry.type === "custom_message") {
		return `[${entry.customType ?? "custom"}]: ${truncate(normalize(extractPreviewText(entry.content)))}`;
	}
	if (entry.type === "branch_summary") {
		const summary = typeof entry.summary === "string" ? entry.summary : "";
		return `[branch summary]: ${truncate(normalize(summary))}`;
	}
	return `[${entry.type}]`;
}

export function serializeBranchEntries(entries: RenderableEntry[]): string {
	const blocks: string[] = [];
	for (const entry of entries) {
		if (entry.type === "message" && entry.message) {
			const part = serializeConversation([entry.message as Message]);
			if (part) blocks.push(part);
			continue;
		}
		if (entry.type === "custom_message") {
			const time = fmtIso(entry.timestamp);
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
			const time = fmtIso(entry.timestamp);
			blocks.push(`[Branch summary @ ${time}]: ${entry.summary}`);
		}
	}
	return blocks.join("\n\n");
}
