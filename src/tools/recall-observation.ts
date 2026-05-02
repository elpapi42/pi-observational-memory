import { Type } from "@mariozechner/pi-ai";
import type { Message, ToolResultMessage } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import {
	recallObservationSources,
	type Entry,
	type RecallObservationMatch,
	type RecallObservationSourcesResult,
} from "../branch.js";
import { renderRecallSourceEntries, renderRecallSourceEntry } from "../serialize.js";
import { estimateEntryTokens } from "../tokens.js";
import type { ObservationRecord } from "../types.js";

export const RECALL_OBSERVATION_TOOL_NAME = "recall";
export const RECALL_OBSERVATION_SOURCE_CHAR_LIMIT = 20_000;

const OBSERVATION_ID_PATTERN = /^[a-f0-9]{12}$/;

type RecallObservationToolStatus =
	| "ok"
	| "invalid_id"
	| "not_found"
	| "no_source"
	| "source_unavailable"
	| "too_large";

type ObservationDetails = Pick<ObservationRecord, "id" | "content" | "timestamp" | "relevance">;

export type RecallSourceEntryDetails = {
	id: string;
	origin: string;
	timestamp: string;
	tokens: number;
	qualifiers: string[];
	content?: string;
};

type RecallObservationMatchDetails = {
	status: RecallObservationMatch["status"];
	observationEntryId: string;
	observation: ObservationDetails;
	sourceEntryIds?: string[];
	sourceEntries?: RecallSourceEntryDetails[];
	missingSourceEntryIds?: string[];
	nonSourceEntryIds?: string[];
	sourceCharacterCount?: number;
};

export type RecallObservationToolDetails = {
	status: RecallObservationToolStatus;
	observationId: string;
	collision: boolean;
	matches: RecallObservationMatchDetails[];
	sourceCharacterLimit: number;
	sourceCharacterCount?: number;
	message?: string;
};

function pad(n: number): string {
	return n.toString().padStart(2, "0");
}

function fmtLocal(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDisplayTimestamp(...values: Array<number | string | undefined>): string {
	for (const v of values) {
		if (v === undefined) continue;
		const d = new Date(v);
		if (!Number.isNaN(d.getTime())) return fmtLocal(d);
	}
	return "Unknown time";
}

function textContentBlocks(content: unknown): Array<Record<string, unknown>> {
	return Array.isArray(content) ? content.filter((block): block is Record<string, unknown> => !!block && typeof block === "object") : [];
}

function uniqueStrings(items: string[]): string[] {
	return Array.from(new Set(items));
}

function sourceOriginAndQualifiers(entry: Entry): { origin: string; timestamp: string; qualifiers: string[] } {
	if (entry.type === "message" && entry.message && typeof entry.message === "object") {
		const msg = entry.message as Message;
		const timestamp = formatDisplayTimestamp(msg.timestamp, entry.timestamp);
		if (msg.role === "user") return { origin: "User", timestamp, qualifiers: [] };
		if (msg.role === "assistant") {
			const toolCalls = uniqueStrings(
				textContentBlocks(msg.content)
					.filter((block) => block.type === "toolCall" && typeof block.name === "string")
					.map((block) => block.name as string),
			);
			return {
				origin: "Assistant",
				timestamp,
				qualifiers: toolCalls.length > 0 ? [`tool calls: ${toolCalls.join(", ")}`] : [],
			};
		}
		const toolName = (msg as ToolResultMessage).toolName;
		return { origin: `Tool result: ${typeof toolName === "string" && toolName ? toolName : "unknown"}`, timestamp, qualifiers: [] };
	}

	if (entry.type === "custom_message") {
		return {
			origin: "Custom message",
			timestamp: formatDisplayTimestamp(entry.timestamp),
			qualifiers: typeof entry.customType === "string" && entry.customType ? [`custom: ${entry.customType}`] : [],
		};
	}

	if (entry.type === "branch_summary") {
		return { origin: "Branch summary", timestamp: formatDisplayTimestamp(entry.timestamp), qualifiers: [] };
	}

	return { origin: entry.type || "Entry", timestamp: formatDisplayTimestamp(entry.timestamp), qualifiers: [] };
}

function renderSourceEntryContentOnly(entry: Entry): string | undefined {
	const rendered = renderRecallSourceEntry(entry);
	return rendered?.replace(/^\[[^\]]+\]:\s?/, "") || undefined;
}

function sourceEntryDetails(entry: Entry, includeContent: boolean): RecallSourceEntryDetails {
	const { origin, timestamp, qualifiers } = sourceOriginAndQualifiers(entry);
	const content = renderSourceEntryContentOnly(entry);
	return {
		id: entry.id,
		origin,
		timestamp,
		tokens: estimateEntryTokens(entry),
		qualifiers,
		...(includeContent && content ? { content } : {}),
	};
}

function stripSourceContent(matches: RecallObservationMatchDetails[]): RecallObservationMatchDetails[] {
	return matches.map((match) => ({
		...match,
		sourceEntries: match.sourceEntries?.map((source) => {
			const { content: _content, ...withoutContent } = source;
			return withoutContent;
		}),
	}));
}

function observationDetails(observation: ObservationRecord): ObservationDetails {
	return {
		id: observation.id,
		content: observation.content,
		timestamp: observation.timestamp,
		relevance: observation.relevance,
	};
}

function matchDetails(match: RecallObservationMatch, sourceText?: string, includeSourceContent = true): RecallObservationMatchDetails {
	if (match.status === "ok") {
		return {
			status: "ok",
			observationEntryId: match.observationEntryId,
			observation: observationDetails(match.observation),
			sourceEntryIds: match.sourceEntryIds,
			sourceEntries: match.sourceEntries.map((entry) => sourceEntryDetails(entry, includeSourceContent)),
			sourceCharacterCount: sourceText?.length ?? 0,
		};
	}
	if (match.status === "source_unavailable") {
		return {
			status: "source_unavailable",
			observationEntryId: match.observationEntryId,
			observation: observationDetails(match.observation),
			sourceEntryIds: match.sourceEntryIds,
			missingSourceEntryIds: match.missingSourceEntryIds,
			nonSourceEntryIds: match.nonSourceEntryIds,
		};
	}
	return {
		status: "no_source",
		observationEntryId: match.observationEntryId,
		observation: observationDetails(match.observation),
	};
}

function textResult(text: string, details: RecallObservationToolDetails) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function aggregateStatus(matches: RecallObservationMatch[]): RecallObservationToolStatus {
	if (matches.some((match) => match.status === "ok")) return "ok";
	if (matches.some((match) => match.status === "source_unavailable")) return "source_unavailable";
	return "no_source";
}

function friendlyNoSourceMessage(observationId: string): string {
	return `Observation ${observationId} has no source entries associated with it. This can happen for legacy observations created before source recall was available.`;
}

function friendlySourceUnavailableMessage(match: Extract<RecallObservationMatch, { status: "source_unavailable" }>): string {
	const missing = match.missingSourceEntryIds.length > 0 ? ` missing: ${match.missingSourceEntryIds.join(", ")}` : "";
	const nonSource = match.nonSourceEntryIds.length > 0 ? ` non-source: ${match.nonSourceEntryIds.join(", ")}` : "";
	return `Observation ${match.observation.id} has source entries associated, but some are unavailable on the current branch or are not source-renderable.${missing}${nonSource}`;
}

function renderFoundResult(result: Extract<RecallObservationSourcesResult, { status: "found" }>): ReturnType<typeof textResult> {
	const sections: string[] = [];
	const detailsMatches: RecallObservationMatchDetails[] = [];
	let sourceCharacterCount = 0;

	if (result.collision) {
		sections.push(`Multiple observations share id ${result.observationId}; returning all matching source results from the current branch.`);
	}

	for (const match of result.matches) {
		if (match.status === "ok") {
			const sourceText = renderRecallSourceEntries(match.sourceEntries);
			sourceCharacterCount += sourceText.length;
			detailsMatches.push(matchDetails(match, sourceText));
			if (sourceText.trim()) sections.push(sourceText);
			else sections.push(`Observation ${match.observation.id} has source entries associated, but they rendered no text content.`);
			continue;
		}

		if (match.status === "source_unavailable") {
			detailsMatches.push(matchDetails(match));
			sections.push(friendlySourceUnavailableMessage(match));
			continue;
		}

		detailsMatches.push(matchDetails(match));
		sections.push(friendlyNoSourceMessage(match.observation.id));
	}

	const text = sections.join("\n\n");
	if (text.length > RECALL_OBSERVATION_SOURCE_CHAR_LIMIT) {
		const message = `Source evidence for observation ${result.observationId} is too large to return safely (${text.length.toLocaleString()} characters; limit ${RECALL_OBSERVATION_SOURCE_CHAR_LIMIT.toLocaleString()}). No partial source content was returned.`;
		return textResult(message, {
			status: "too_large",
			observationId: result.observationId,
			collision: result.collision,
			matches: stripSourceContent(detailsMatches),
			sourceCharacterLimit: RECALL_OBSERVATION_SOURCE_CHAR_LIMIT,
			sourceCharacterCount,
			message,
		});
	}

	return textResult(text, {
		status: aggregateStatus(result.matches),
		observationId: result.observationId,
		collision: result.collision,
		matches: detailsMatches,
		sourceCharacterLimit: RECALL_OBSERVATION_SOURCE_CHAR_LIMIT,
		sourceCharacterCount,
	});
}

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
	return `${n.toLocaleString()} ${n === 1 ? singular : pluralForm}`;
}

function sourceEntriesFromDetails(details: RecallObservationToolDetails): RecallSourceEntryDetails[] {
	return details.matches.flatMap((match) => match.sourceEntries ?? []);
}

function tokenSummary(tokens: number): string {
	return `~${tokens.toLocaleString()} ${tokens === 1 ? "token" : "tokens"}`;
}

function statusIcon(details: RecallObservationToolDetails): string {
	if (details.status === "ok") return details.collision ? "⚠" : "✓";
	return "×";
}

function statusSummary(details: RecallObservationToolDetails): string {
	if (details.status === "invalid_id") return "invalid id";
	if (details.status === "not_found") return "not found";
	if (details.status === "too_large") return "too large";
	if (details.status === "source_unavailable") return "source unavailable";
	if (details.status === "no_source") return "no source";
	return details.collision ? "id collision" : "recalled";
}

export function formatRecallHeaderForTui(details: RecallObservationToolDetails): string {
	const parts = [`${statusIcon(details)} recall ${details.observationId}`];
	if (details.matches.length > 0) parts.push(plural(details.matches.length, "match", "matches"));
	const sources = sourceEntriesFromDetails(details);
	if (sources.length > 0) parts.push(plural(sources.length, "source entry", "source entries"));
	const tokens = sources.reduce((sum, source) => sum + source.tokens, 0);
	if (tokens > 0) parts.push(tokenSummary(tokens));
	if (details.status !== "ok" || details.collision) parts.push(statusSummary(details));
	return parts.join(" · ");
}

function sourceMetadataLine(source: RecallSourceEntryDetails): string {
	const qualifiers = source.qualifiers.length > 0 ? ` · ${source.qualifiers.join(" · ")}` : "";
	return `  • ${source.origin} · ${source.timestamp} · entry ${source.id} · ${tokenSummary(source.tokens)}${qualifiers}`;
}

function observationLine(observation: ObservationDetails): string {
	return `[${observation.relevance}] ${observation.timestamp} · ${observation.content}`;
}

function indentContent(content: string): string {
	return content
		.split("\n")
		.map((line) => `    ${line}`)
		.join("\n");
}

function unavailableSourceLine(match: RecallObservationMatchDetails): string {
	const parts: string[] = [];
	if (match.missingSourceEntryIds && match.missingSourceEntryIds.length > 0) {
		parts.push(`missing: ${match.missingSourceEntryIds.join(", ")}`);
	}
	if (match.nonSourceEntryIds && match.nonSourceEntryIds.length > 0) {
		parts.push(`non-source: ${match.nonSourceEntryIds.join(", ")}`);
	}
	return `  • source unavailable${parts.length > 0 ? ` · ${parts.join(" · ")}` : ""}`;
}

function matchLines(match: RecallObservationMatchDetails, expanded: boolean): string[] {
	const lines = [observationLine(match.observation), ""];
	if (match.status === "ok") {
		for (const source of match.sourceEntries ?? []) {
			lines.push(sourceMetadataLine(source));
			if (expanded && source.content) {
				lines.push(indentContent(source.content));
				lines.push("");
			}
		}
		return lines;
	}
	if (match.status === "source_unavailable") return [...lines, unavailableSourceLine(match)];
	return [...lines, "  • no source · legacy/unattributed observation"];
}

export function formatRecallResultForTui(result: AgentToolResult<RecallObservationToolDetails>, expanded: boolean): string {
	const details = result.details;
	if (!details) {
		const text = result.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n");
		return text || "recall";
	}

	const lines: string[] = [];
	if (details.matches.length > 0) {
		for (const match of details.matches) {
			if (lines.length > 0) lines.push("");
			lines.push(...matchLines(match, expanded));
		}
	} else if (details.message) {
		lines.push(details.message);
	}
	if (!expanded && details.matches.some((match) => match.status === "ok" && (match.sourceEntries?.length ?? 0) > 0)) {
		lines.push("", "(Ctrl+O to expand)");
	}
	return lines.join("\n").trimEnd();
}

export function formatRecallCallForTui(id: string | undefined, headerLine?: string): string {
	return headerLine ?? `recall ${id ?? "..."}`;
}

type RecallRenderState = {
	headerLine?: string;
};

export const recallObservationTool = defineTool({
	name: RECALL_OBSERVATION_TOOL_NAME,
	label: "Recall observation source",
	description: "Recall exact source entries for an observational-memory observation id on the current branch.",
	promptSnippet: "Recall exact source entries for a compacted observational-memory observation id.",
	promptGuidelines: [
		"Use recall when a compacted observation id needs exact source context or the user asks what supports a remembered claim.",
		"This is not general search: pass a specific observation id from the compacted Observations list.",
		"Do not call recall for broad transcript browsing or off-branch history.",
	],
	parameters: Type.Object({
		id: Type.String({
			pattern: "^[a-f0-9]{12}$",
			description: "12-character lowercase hex observational-memory observation id.",
		}),
	}),
	renderCall(args, _theme, context) {
		const state = context.state as RecallRenderState;
		return new Text(formatRecallCallForTui(args.id, state.headerLine), 0, 0);
	},
	renderResult(result, options, _theme, context) {
		const typedResult = result as AgentToolResult<RecallObservationToolDetails>;
		const state = context.state as RecallRenderState;
		if (typedResult.details) {
			const headerLine = formatRecallHeaderForTui(typedResult.details);
			if (state.headerLine !== headerLine) {
				state.headerLine = headerLine;
				context.invalidate();
			}
		}
		return new Text(formatRecallResultForTui(typedResult, options.expanded), 0, 0);
	},
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const observationId = params.id;
		if (!OBSERVATION_ID_PATTERN.test(observationId)) {
			const message = `Observation id must be 12 lowercase hex characters. Received: ${observationId}`;
			return textResult(message, {
				status: "invalid_id",
				observationId,
				collision: false,
				matches: [],
				sourceCharacterLimit: RECALL_OBSERVATION_SOURCE_CHAR_LIMIT,
				message,
			});
		}

		const branchEntries = ctx.sessionManager.getBranch() as Entry[];
		const result = recallObservationSources(branchEntries, observationId);
		if (result.status === "not_found") {
			const message = `No observation with id ${observationId} was found on the current branch.`;
			return textResult(message, {
				status: "not_found",
				observationId,
				collision: false,
				matches: [],
				sourceCharacterLimit: RECALL_OBSERVATION_SOURCE_CHAR_LIMIT,
				message,
			});
		}

		return renderFoundResult(result);
	},
});

export function registerRecallTool(pi: ExtensionAPI): void {
	pi.registerTool(recallObservationTool);
}
