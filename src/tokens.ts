import { estimateTokens as estimateMessageTokens } from "@mariozechner/pi-coding-agent";

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function estimateRawTailTokens(
	entries: Array<{ type: string; message?: unknown; content?: unknown; firstKeptEntryId?: string; id?: string }>,
): number {
	let startIndex = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			const keptId = entries[i].firstKeptEntryId;
			if (keptId) {
				for (let j = 0; j < entries.length; j++) {
					if (entries[j].id === keptId) {
						startIndex = j;
						break;
					}
				}
			} else {
				startIndex = i + 1;
			}
			break;
		}
	}

	let tokens = 0;
	for (let i = startIndex; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type === "message" && entry.message) {
			tokens += estimateMessageTokens(entry.message as Parameters<typeof estimateMessageTokens>[0]);
		} else if (entry.type === "custom_message" && entry.content) {
			const content = entry.content;
			if (typeof content === "string") {
				tokens += Math.ceil(content.length / 4);
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "text" && block.text) tokens += Math.ceil(block.text.length / 4);
				}
			}
		}
	}
	return tokens;
}

export function formatK(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return String(n);
}

export function extractText(response: { content: Array<{ type: string; text?: string }> }): string {
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}
