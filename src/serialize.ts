import type { Message, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { estimateStringTokens } from "./tokens.js";

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

function formatRecallTimestamp(...values: Array<number | string | undefined>): string {
	for (const v of values) {
		if (v === undefined) continue;
		const d = new Date(v);
		if (!Number.isNaN(d.getTime())) return fmtLocal(d);
	}
	return "Unknown time";
}

function textAndPlaceholders(
	content: unknown,
	options: { omitRedactedThinking?: boolean; includeThinking?: boolean } = {},
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "[non-text content omitted]";

	const parts: string[] = [];
	for (const block of content as Array<Record<string, unknown>>) {
		if (!block || typeof block !== "object") {
			parts.push("[non-text content omitted]");
			continue;
		}
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
			continue;
		}
		if (block.type === "thinking") {
			if (options.omitRedactedThinking && block.redacted === true) continue;
			if (options.includeThinking && typeof block.thinking === "string") {
				parts.push(`[thinking: ${block.thinking}]`);
				continue;
			}
			parts.push("[non-text content omitted]");
			continue;
		}
		if (block.type === "toolCall" && typeof block.name === "string") {
			parts.push(`[${block.name}(${JSON.stringify(block.arguments ?? {})})]`);
			continue;
		}
		parts.push("[non-text content omitted]");
	}
	return parts.join("\n");
}

function textOnly(content: unknown): string {
	if (content == null) return "";
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is TextContent => b?.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
}

/** Pi's `bashExecution` message, recorded for a user `!` command (no `content`). */
type BashExecutionMessage = {
	role: "bashExecution";
	command?: unknown;
	output?: unknown;
	exitCode?: unknown;
	cancelled?: unknown;
	truncated?: unknown;
	fullOutputPath?: unknown;
	excludeFromContext?: unknown;
};

/** Pi's `bashExecutionToText` (core/messages.js): the user text `convertToLlm` sends the model. */
function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${String(msg.command ?? "")}\`\n`;
	text += typeof msg.output === "string" && msg.output ? `\`\`\`\n${msg.output}\n\`\`\`` : "(no output)";
	if (msg.cancelled === true) {
		text += "\n\n(command cancelled)";
	} else if (typeof msg.exitCode === "number" && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated === true && typeof msg.fullOutputPath === "string" && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

/**
 * Render a message role other than user, assistant and tool result the way
 * Pi's `convertToLlm` presents it to the model. Null when Pi sends the model
 * no conversation for it: a `!!` command (`excludeFromContext`), or a system
 * message, which carries prompt sections rather than conversation (Pi's own
 * compaction serializer skips it too). Undefined for the roles callers render.
 */
function renderPiMessageRole(msg: Record<string, unknown>, time: string, text: (content: unknown) => string): string | null | undefined {
	switch (msg.role) {
		case "user":
		case "assistant":
		case "toolResult":
			return undefined;
		case "bashExecution":
			if (msg.excludeFromContext === true) return null;
			return `[User @ ${time}]: ${bashExecutionToText(msg as BashExecutionMessage)}`;
		case "system":
			return null;
		default: {
			const body = text(msg.content);
			return body ? `[${String(msg.role)} @ ${time}]: ${body}` : null;
		}
	}
}

export function serializeConversation(messages: Message[]): string {
	return messages
		.map((msg): string | null => {
			const time = formatTimestamp(msg.timestamp);
			if (msg.role === "user") {
				const text = textOnly(msg.content);
				return `[User @ ${time}]: ${text}`;
			}
			if (msg.role === "assistant") {
				const body = textAndPlaceholders(msg.content, {
					includeThinking: true,
					omitRedactedThinking: true,
				})
					.split("\n")
					.filter(Boolean)
					.join("\n");
				if (!body) return null;
				return `[Assistant @ ${time}]: ${body}`;
			}
			const other = renderPiMessageRole(msg as unknown as Record<string, unknown>, time, textOnly);
			if (other !== undefined) return other;
			const text = textOnly(msg.content);
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

export type RenderableEntry = {
	type: string;
	id?: string;
	timestamp?: string;
	message?: unknown;
	customType?: string;
	content?: unknown;
	summary?: unknown;
};

function renderCustomMessage(entry: RenderableEntry, options: { recallFormat: boolean }): string {
	const time = options.recallFormat ? formatRecallTimestamp(entry.timestamp) : formatTimestamp(entry.timestamp);
	const text = options.recallFormat
		? textAndPlaceholders(entry.content)
		: typeof entry.content === "string"
			? entry.content
			: Array.isArray(entry.content)
				? (entry.content as Array<{ type?: string; text?: string }>)
						.filter((b) => b?.type === "text" && typeof b.text === "string")
						.map((b) => b.text as string)
						.join("\n")
				: "";
	if (options.recallFormat) {
		const origin = entry.customType ? `Custom message (${entry.customType})` : "Custom message";
		return `[${origin} @ ${time}]: ${text}`;
	}
	const tag = entry.customType ? `Custom (${entry.customType})` : "Custom";
	return `[${tag} @ ${time}]: ${text}`;
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
			blocks.push(renderCustomMessage(entry, { recallFormat: false }));
			continue;
		}
		if (entry.type === "branch_summary" && typeof entry.summary === "string") {
			const time = formatTimestamp(entry.timestamp);
			blocks.push(`[Branch summary @ ${time}]: ${entry.summary}`);
		}
	}
	return blocks.join("\n\n");
}

export type SourceAddressedSerialization = {
	text: string;
	sourceEntryIds: string[];
	estimatedTokens: number;
	truncatedSourceEntryIds: string[];
};

export type SourceAddressedSerializationOptions = {
	/** Maximum estimated tokens in the final source-addressed text. */
	maxTokens?: number;
};

const SOURCE_OMISSION_MARKER =
	"\n\n[… middle omitted: source exceeds observer input budget; original source remains in the session ledger …]\n\n";

function truncateSourceBlockToTokenBudget(label: string, rendered: string, maxTokens: number): string | undefined {
	const required = `${label}\n${SOURCE_OMISSION_MARKER}`;
	if (estimateStringTokens(required) > maxTokens) return undefined;
	const full = `${label}\n${rendered}`;
	if (estimateStringTokens(full) <= maxTokens) return full;
	const maxChars = Math.max(1, maxTokens * 4);
	const fixed = `${label}\n${SOURCE_OMISSION_MARKER}`;
	const retainedChars = maxChars - fixed.length;
	const headChars = Math.ceil(retainedChars / 2);
	const tailChars = retainedChars - headChars;
	return `${label}\n${rendered.slice(0, headChars)}${SOURCE_OMISSION_MARKER}${tailChars > 0 ? rendered.slice(-tailChars) : ""}`;
}

function isSourceRenderableEntry(entry: RenderableEntry): boolean {
	return entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary";
}

/**
 * Serialize complete source entries up to the token budget. If the first entry
 * alone exceeds the budget, include a clearly marked head/tail excerpt so one
 * pathological tool result cannot permanently block observation coverage.
 * The original ledger entry is never modified and remains recallable by id.
 */
export function serializeSourceAddressedBranchEntries(
	entries: RenderableEntry[],
	options: SourceAddressedSerializationOptions = {},
): SourceAddressedSerialization {
	const blocks: string[] = [];
	const sourceEntryIds: string[] = [];
	const truncatedSourceEntryIds: string[] = [];
	let estimatedTokens = 0;

	for (const entry of entries) {
		if (!entry.id || !isSourceRenderableEntry(entry)) continue;
		const rendered = serializeBranchEntries([entry]);
		if (!rendered.trim()) continue;
		const label = `[Source entry id: ${entry.id}]`;
		const block = `${label}\n${rendered}`;
		const separator = blocks.length > 0 ? "\n\n" : "";
		const blockTokens = estimateStringTokens(`${separator}${block}`);
		const maxTokens = options.maxTokens;

		if (maxTokens !== undefined && estimatedTokens + blockTokens > maxTokens) {
			if (blocks.length > 0) break;
			const excerpt = truncateSourceBlockToTokenBudget(label, rendered, maxTokens);
			if (!excerpt) break;
			blocks.push(excerpt);
			sourceEntryIds.push(entry.id);
			truncatedSourceEntryIds.push(entry.id);
			estimatedTokens = estimateStringTokens(excerpt);
			break;
		}

		blocks.push(block);
		sourceEntryIds.push(entry.id);
		estimatedTokens += blockTokens;
	}

	const text = blocks.join("\n\n");
	return { text, sourceEntryIds, estimatedTokens: estimateStringTokens(text), truncatedSourceEntryIds };
}

function renderRecallMessage(entry: RenderableEntry): string | null {
	if (!entry.message || typeof entry.message !== "object") return null;
	const msg = entry.message as Message;
	const time = formatRecallTimestamp(msg.timestamp, entry.timestamp);
	if (msg.role === "user") {
		return `[User @ ${time}]: ${textAndPlaceholders(msg.content)}`;
	}
	if (msg.role === "assistant") {
		const body = textAndPlaceholders(msg.content, {
			includeThinking: true,
			omitRedactedThinking: true,
		})
			.split("\n")
			.filter(Boolean)
			.join("\n");
		if (!body) return null;
		return `[Assistant @ ${time}]: ${body}`;
	}
	const other = renderPiMessageRole(msg as unknown as Record<string, unknown>, time, (content) => textAndPlaceholders(content));
	if (other !== undefined) return other;
	return `[Tool result: ${(msg as ToolResultMessage).toolName} @ ${time}]: ${textAndPlaceholders(msg.content)}`;
}

export function renderRecallSourceEntry(entry: RenderableEntry): string | null {
	if (entry.type === "message") return renderRecallMessage(entry);
	if (entry.type === "custom_message") return renderCustomMessage(entry, { recallFormat: true });
	if (entry.type === "branch_summary" && typeof entry.summary === "string") {
		const time = formatRecallTimestamp(entry.timestamp);
		return `[Branch summary @ ${time}]: ${entry.summary}`;
	}
	return null;
}

export function renderRecallSourceEntries(entries: RenderableEntry[]): string {
	return entries
		.map(renderRecallSourceEntry)
		.filter((block): block is string => block !== null && block.trim().length > 0)
		.join("\n\n");
}
