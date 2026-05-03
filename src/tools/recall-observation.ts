import { Type } from "@mariozechner/pi-ai";
import type { Message, ToolResultMessage } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import {
	recallMemorySources,
	type Entry,
	type RecallMemoryObservation,
	type RecallMemorySourcesResult,
} from "../branch.js";
import { renderRecallSourceEntries, renderRecallSourceEntry } from "../serialize.js";
import { estimateEntryTokens } from "../tokens.js";
import type { ObservationRecord, ReflectionRecord } from "../types.js";

export const RECALL_OBSERVATION_TOOL_NAME = "recall";

const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/;

type RecallObservationToolStatus =
	| "ok"
	| "partial"
	| "invalid_id"
	| "not_found"
	| "no_source"
	| "source_unavailable"
	| "no_provenance";

type ObservationDetails = Pick<ObservationRecord, "id" | "content" | "timestamp" | "relevance">;
type ReflectionDetails = Pick<ReflectionRecord, "id" | "content" | "supportingObservationIds" | "legacy"> & { reflectionIndex: number };

export type RecallSourceEntryDetails = {
	id: string;
	origin: string;
	timestamp: string;
	tokens: number;
	qualifiers: string[];
	content?: string;
};

type RecallObservationMatchDetails = {
	status: RecallMemoryObservation["status"];
	observationEntryId: string;
	observationRecordIndex: number;
	observation: ObservationDetails;
	sourceEntryIds?: string[];
	sourceEntries?: RecallSourceEntryDetails[];
	missingSourceEntryIds?: string[];
	nonSourceEntryIds?: string[];
	sourceCharacterCount?: number;
};

type RecallUnavailableSupportingObservationDetails = {
	reflectionId: string;
	reflectionIndex: number;
	observationId: string;
};

type RecallUnavailableReflectionProvenanceDetails = {
	reflectionId: string;
	reflectionIndex: number;
	reason: "legacy";
};

export type RecallObservationToolDetails = {
	status: RecallObservationToolStatus;
	memoryId: string;
	observationId: string;
	collision: boolean;
	partial: boolean;
	reflections: ReflectionDetails[];
	directObservationMatches: RecallObservationMatchDetails[];
	observations: RecallObservationMatchDetails[];
	matches: RecallObservationMatchDetails[];
	sourceEntries: RecallSourceEntryDetails[];
	unavailableSupportingObservations: RecallUnavailableSupportingObservationDetails[];
	unavailableReflectionProvenance: RecallUnavailableReflectionProvenanceDetails[];
	missingSourceEntryIds: string[];
	nonSourceEntryIds: string[];
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

function observationDetails(observation: ObservationRecord): ObservationDetails {
	return {
		id: observation.id,
		content: observation.content,
		timestamp: observation.timestamp,
		relevance: observation.relevance,
	};
}

function reflectionDetails(reflection: ReflectionRecord, reflectionIndex: number): ReflectionDetails {
	return {
		id: reflection.id,
		content: reflection.content,
		supportingObservationIds: reflection.supportingObservationIds,
		...(reflection.legacy === true ? { legacy: true } : {}),
		reflectionIndex,
	};
}

function observationMatchDetails(match: RecallMemoryObservation, includeSourceContent = true): RecallObservationMatchDetails {
	if (match.status === "ok") {
		return {
			status: "ok",
			observationEntryId: match.observationEntryId,
			observationRecordIndex: match.observationRecordIndex,
			observation: observationDetails(match.observation),
			sourceEntryIds: match.sourceEntryIds,
			sourceEntries: match.sourceEntries.map((entry) => sourceEntryDetails(entry, includeSourceContent)),
			sourceCharacterCount: renderRecallSourceEntries(match.sourceEntries).length,
		};
	}
	if (match.status === "source_unavailable") {
		return {
			status: "source_unavailable",
			observationEntryId: match.observationEntryId,
			observationRecordIndex: match.observationRecordIndex,
			observation: observationDetails(match.observation),
			sourceEntryIds: match.sourceEntryIds,
			...(includeSourceContent
				? {
						sourceEntries: match.sourceEntries.map((entry) => sourceEntryDetails(entry, true)),
						sourceCharacterCount: renderRecallSourceEntries(match.sourceEntries).length,
					}
				: {}),
			missingSourceEntryIds: match.missingSourceEntryIds,
			nonSourceEntryIds: match.nonSourceEntryIds,
		};
	}
	return {
		status: "no_source",
		observationEntryId: match.observationEntryId,
		observationRecordIndex: match.observationRecordIndex,
		observation: observationDetails(match.observation),
	};
}

function textResult(text: string, details: RecallObservationToolDetails) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function emptyDetails(status: RecallObservationToolStatus, memoryId: string, message: string): RecallObservationToolDetails {
	return {
		status,
		memoryId,
		observationId: memoryId,
		collision: false,
		partial: false,
		reflections: [],
		directObservationMatches: [],
		observations: [],
		matches: [],
		sourceEntries: [],
		unavailableSupportingObservations: [],
		unavailableReflectionProvenance: [],
		missingSourceEntryIds: [],
		nonSourceEntryIds: [],
		message,
	};
}

function aggregateStatus(details: Omit<RecallObservationToolDetails, "status">): RecallObservationToolStatus {
	const observationOnly = details.reflections.length === 0 && details.unavailableSupportingObservations.length === 0 && details.unavailableReflectionProvenance.length === 0;
	if (observationOnly && details.observations.some((match) => match.status === "ok")) return "ok";
	if (observationOnly && details.observations.some((match) => match.status === "source_unavailable")) return "source_unavailable";
	if (observationOnly && details.observations.length > 0) return "no_source";
	if (details.unavailableReflectionProvenance.length > 0 && details.observations.length === 0 && details.sourceEntries.length === 0) return "no_provenance";
	if (details.partial) return "partial";
	if (details.sourceEntries.length > 0) return "ok";
	if (details.reflections.length > 0) return "ok";
	if (details.observations.length > 0) return "no_source";
	return "not_found";
}

function friendlyNoSourceMessage(memoryId: string): string {
	return `Observation ${memoryId} has no source entries associated with it. This can happen for legacy observations created before source recall was available.`;
}

function friendlySourceUnavailableMessage(match: RecallObservationMatchDetails): string {
	const missing = match.missingSourceEntryIds && match.missingSourceEntryIds.length > 0 ? ` missing: ${match.missingSourceEntryIds.join(", ")}` : "";
	const nonSource = match.nonSourceEntryIds && match.nonSourceEntryIds.length > 0 ? ` non-source: ${match.nonSourceEntryIds.join(", ")}` : "";
	return `Observation ${match.observation.id} has source entries associated, but some are unavailable on the current branch or are not source-renderable.${missing}${nonSource}`;
}

function reflectionLineText(reflection: ReflectionDetails): string {
	return `[${reflection.id}] ${reflection.content}`;
}

function observationLineText(observation: ObservationDetails): string {
	return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`;
}

function renderObservationOnlyTextFromResult(result: Extract<RecallMemorySourcesResult, { status: "found" }>): string {
	const sections: string[] = [];
	if (result.collision) {
		sections.push(`Multiple observations share id ${result.memoryId}; returning all matching source results from the current branch.`);
	}
	for (const match of result.directObservationMatches) {
		if (match.status === "ok") {
			const sourceText = renderRecallSourceEntries(match.sourceEntries);
			if (sourceText.trim()) sections.push(sourceText);
			else sections.push(`Observation ${match.observation.id} has source entries associated, but they rendered no text content.`);
			continue;
		}
		if (match.status === "source_unavailable") {
			sections.push(friendlySourceUnavailableMessage(observationMatchDetails(match, false)));
			continue;
		}
		sections.push(friendlyNoSourceMessage(match.observation.id));
	}
	return sections.join("\n\n");
}

function unavailableSupportingLineText(item: RecallUnavailableSupportingObservationDetails): string {
	return `Supporting observation ${item.observationId} for reflection ${item.reflectionId} is unavailable on the current branch.`;
}

function unavailableReflectionProvenanceLineText(item: RecallUnavailableReflectionProvenanceDetails): string {
	return `Reflection ${item.reflectionId} was migrated from legacy memory created before reflection provenance was recorded, so no supporting observations or raw sources are available.`;
}

function unavailableObservationSourceLineText(match: RecallMemoryObservation): string {
	return `Observation ${match.observation.id} has no source entries associated. This can happen for legacy observations created before source recall was available.`;
}

function renderMemoryText(result: Extract<RecallMemorySourcesResult, { status: "found" }>): string {
	const sections: string[] = [];
	if (result.collision) {
		sections.push(`Memory id ${result.memoryId} matched multiple observations/reflections; returning all available evidence from the current branch.`);
	}
	if (result.reflectionMatches.length > 0) {
		sections.push(`Reflections:\n${result.reflectionMatches.map((match) => reflectionLineText(reflectionDetails(match.reflection, match.reflectionIndex))).join("\n")}`);
	}
	if (result.observations.length > 0) {
		sections.push(`Observations:\n${result.observations.map((match) => observationLineText(match.observation)).join("\n")}`);
	}
	if (result.unavailableSupportingObservations.length > 0) {
		sections.push(
			`Unavailable supporting observations:\n${result.unavailableSupportingObservations
				.map((item) => unavailableSupportingLineText({
					reflectionId: item.reflection.id,
					reflectionIndex: item.reflectionIndex,
					observationId: item.observationId,
				}))
				.join("\n")}`,
		);
	}
	if (result.unavailableReflectionProvenance.length > 0) {
		sections.push(
			`Unavailable reflection provenance:\n${result.unavailableReflectionProvenance
				.map((item) => unavailableReflectionProvenanceLineText({
					reflectionId: item.reflection.id,
					reflectionIndex: item.reflectionIndex,
					reason: item.reason,
				}))
				.join("\n")}`,
		);
	}
	const noSourceObservations = result.observations.filter((match) => match.status === "no_source");
	if (noSourceObservations.length > 0) {
		sections.push(`Unavailable observation sources:\n${noSourceObservations.map(unavailableObservationSourceLineText).join("\n")}`);
	}
	if (result.missingSourceEntryIds.length > 0 || result.nonSourceEntryIds.length > 0) {
		const parts: string[] = [];
		if (result.missingSourceEntryIds.length > 0) parts.push(`missing: ${result.missingSourceEntryIds.join(", ")}`);
		if (result.nonSourceEntryIds.length > 0) parts.push(`non-source: ${result.nonSourceEntryIds.join(", ")}`);
		sections.push(`Unavailable source entries: ${parts.join("; ")}`);
	}
	const sourceText = renderRecallSourceEntries(result.sourceEntries);
	if (sourceText.trim()) sections.push(`Sources:\n${sourceText}`);
	if (sections.length === 0) sections.push(`Memory ${result.memoryId} was found, but no source evidence rendered.`);
	return sections.join("\n\n");
}

function resultDetails(result: Extract<RecallMemorySourcesResult, { status: "found" }>, includeSourceContent = true): RecallObservationToolDetails {
	const reflections = result.reflectionMatches.map((match) => reflectionDetails(match.reflection, match.reflectionIndex));
	const memoryLayerRecall = result.reflectionMatches.length > 0 || result.unavailableSupportingObservations.length > 0;
	const includeObservationSources = (match: RecallMemoryObservation) => includeSourceContent && (memoryLayerRecall || match.status !== "source_unavailable");
	const observations = result.observations.map((match) => observationMatchDetails(match, includeObservationSources(match)));
	const directObservationMatches = result.directObservationMatches.map((match) => observationMatchDetails(match, includeObservationSources(match)));
	const sourceEntries = memoryLayerRecall ? result.sourceEntries.map((entry) => sourceEntryDetails(entry, includeSourceContent)) : [];
	const unavailableSupportingObservations = result.unavailableSupportingObservations.map((item) => ({
		reflectionId: item.reflection.id,
		reflectionIndex: item.reflectionIndex,
		observationId: item.observationId,
	}));
	const unavailableReflectionProvenance = result.unavailableReflectionProvenance.map((item) => ({
		reflectionId: item.reflection.id,
		reflectionIndex: item.reflectionIndex,
		reason: item.reason,
	}));
	const partial = result.partial;
	const detailWithoutStatus = {
		memoryId: result.memoryId,
		observationId: result.memoryId,
		collision: result.collision,
		partial,
		reflections,
		directObservationMatches,
		observations,
		matches: directObservationMatches,
		sourceEntries,
		unavailableSupportingObservations,
		unavailableReflectionProvenance,
		missingSourceEntryIds: result.missingSourceEntryIds,
		nonSourceEntryIds: result.nonSourceEntryIds,
		sourceCharacterCount: renderRecallSourceEntries(result.sourceEntries).length,
	};
	return {
		status: aggregateStatus(detailWithoutStatus),
		...detailWithoutStatus,
	};
}

function isObservationOnly(details: RecallObservationToolDetails): boolean {
	return details.reflections.length === 0 && details.unavailableSupportingObservations.length === 0 && details.unavailableReflectionProvenance.length === 0;
}

function renderFoundResult(result: Extract<RecallMemorySourcesResult, { status: "found" }>): ReturnType<typeof textResult> {
	const details = resultDetails(result);
	const text = isObservationOnly(details) ? renderObservationOnlyTextFromResult(result) : renderMemoryText(result);
	return textResult(text, details);
}

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
	return `${n.toLocaleString()} ${n === 1 ? singular : pluralForm}`;
}

function sourceEntriesFromDetails(details: RecallObservationToolDetails): RecallSourceEntryDetails[] {
	if (!isObservationOnly(details)) return details.sourceEntries;
	return details.matches.flatMap((match) => match.sourceEntries ?? []);
}

function tokenSummary(tokens: number): string {
	return `~${tokens.toLocaleString()} ${tokens === 1 ? "token" : "tokens"}`;
}

function statusIcon(details: RecallObservationToolDetails): string {
	if (details.status === "ok") return details.collision ? "⚠" : "✓";
	if (details.status === "partial") return "⚠";
	return "×";
}

function statusSummary(details: RecallObservationToolDetails): string {
	if (details.status === "invalid_id") return "invalid id";
	if (details.status === "not_found") return "not found";
	if (details.status === "source_unavailable") return "source unavailable";
	if (details.status === "no_source") return "no source";
	if (details.status === "no_provenance") return "no provenance";
	if (details.collision && details.partial) return "recalled · id collision · partial";
	if (details.collision) return "recalled · id collision";
	if (details.partial) return "recalled · partial";
	return "recalled";
}

export function formatRecallHeaderForTui(details: RecallObservationToolDetails): string {
	const parts = [`${statusIcon(details)} ${statusSummary(details)}`];
	if (isObservationOnly(details)) {
		if (details.matches.length > 0) parts.push(plural(details.matches.length, "match", "matches"));
	} else {
		if (details.reflections.length > 0) parts.push(plural(details.reflections.length, "reflection"));
		if (details.observations.length > 0) parts.push(plural(details.observations.length, "observation"));
	}
	const sources = sourceEntriesFromDetails(details);
	if (sources.length > 0) parts.push(plural(sources.length, "source entry", "source entries"));
	const tokens = sources.reduce((sum, source) => sum + source.tokens, 0);
	if (tokens > 0) parts.push(tokenSummary(tokens));
	return parts.join(" · ");
}

function sourceLabel(source: RecallSourceEntryDetails): string {
	return source.origin ? `${source.origin[0].toLowerCase()}${source.origin.slice(1)}` : "entry";
}

function sourceMetadataLine(source: RecallSourceEntryDetails): string {
	const qualifiers = source.qualifiers.length > 0 ? ` · ${source.qualifiers.join(" · ")}` : "";
	return `✓ ${sourceLabel(source)} · ${source.timestamp} · entry ${source.id} · ${tokenSummary(source.tokens)}${qualifiers}`;
}

function observationLine(observation: ObservationDetails): string {
	return `✓ observation · ${observation.timestamp} · [${observation.relevance}] · ${observation.content}`;
}

function reflectionLine(reflection: ReflectionDetails): string {
	return `✓ reflection · ${reflection.id} · ${reflection.content}`;
}

function indentContent(content: string): string {
	return content
		.split("\n")
		.map((line) => `    ${line}`)
		.join("\n");
}

function unavailableSourceLine(details: { missingSourceEntryIds?: string[]; nonSourceEntryIds?: string[] }): string {
	const parts: string[] = [];
	if (details.missingSourceEntryIds && details.missingSourceEntryIds.length > 0) {
		parts.push(`missing: ${details.missingSourceEntryIds.join(", ")}`);
	}
	if (details.nonSourceEntryIds && details.nonSourceEntryIds.length > 0) {
		parts.push(`non-source: ${details.nonSourceEntryIds.join(", ")}`);
	}
	return `× source unavailable${parts.length > 0 ? ` · ${parts.join(" · ")}` : ""}`;
}

function unavailableSupportingLine(item: RecallUnavailableSupportingObservationDetails): string {
	return `× supporting observation unavailable · reflection ${item.reflectionId} · observation ${item.observationId}`;
}

function unavailableReflectionProvenanceLine(item: RecallUnavailableReflectionProvenanceDetails): string {
	return `× reflection provenance unavailable · reflection ${item.reflectionId} · legacy migrated reflection`;
}

function noSourceObservationLine(match: RecallObservationMatchDetails): string {
	return `× no source · observation ${match.observation.id} · legacy/unattributed observation`;
}

function observationOnlyMatchLines(match: RecallObservationMatchDetails, expanded: boolean): string[] {
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
	if (match.status === "source_unavailable") {
		const sources = match.sourceEntries ?? [];
		for (const source of sources) {
			lines.push(sourceMetadataLine(source));
			if (expanded && source.content) {
				lines.push(indentContent(source.content));
				lines.push("");
			}
		}
		lines.push(unavailableSourceLine(match));
		return lines;
	}
	return [...lines, "× no source · legacy/unattributed observation"];
}

function memoryLines(details: RecallObservationToolDetails, expanded: boolean): string[] {
	const lines: string[] = [];
	for (const reflection of details.reflections) lines.push(reflectionLine(reflection));
	if (details.reflections.length > 0 && details.observations.length > 0) lines.push("");
	for (const observation of details.observations) lines.push(observationLine(observation.observation));
	if ((details.reflections.length > 0 || details.observations.length > 0) && (details.sourceEntries.length > 0 || details.unavailableSupportingObservations.length > 0 || details.unavailableReflectionProvenance.length > 0 || details.missingSourceEntryIds.length > 0 || details.nonSourceEntryIds.length > 0)) lines.push("");
	for (const item of details.unavailableSupportingObservations) lines.push(unavailableSupportingLine(item));
	for (const item of details.unavailableReflectionProvenance) lines.push(unavailableReflectionProvenanceLine(item));
	for (const observation of details.observations) {
		if (observation.status === "no_source") lines.push(noSourceObservationLine(observation));
	}
	if (details.missingSourceEntryIds.length > 0 || details.nonSourceEntryIds.length > 0) lines.push(unavailableSourceLine(details));
	for (const source of details.sourceEntries) {
		lines.push(sourceMetadataLine(source));
		if (expanded && source.content) {
			lines.push(indentContent(source.content));
			lines.push("");
		}
	}
	return lines;
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
	if (isObservationOnly(details)) {
		if (details.matches.length > 0) {
			for (const match of details.matches) {
				if (lines.length > 0) lines.push("");
				lines.push(...observationOnlyMatchLines(match, expanded));
			}
		} else if (details.message) {
			lines.push(details.message);
		}
	} else {
		lines.push(...memoryLines(details, expanded));
	}

	if (!expanded && sourceEntriesFromDetails(details).length > 0) {
		lines.push("", "(Ctrl+O to expand)");
	}
	return lines.join("\n").trimEnd();
}

export function formatRecallCallForTui(id: string | undefined): string {
	return `recall ${id ?? "..."}`;
}

export function formatRecallRenderedResultForTui(result: AgentToolResult<RecallObservationToolDetails>, expanded: boolean): string {
	const body = formatRecallResultForTui(result, expanded);
	const header = result.details ? formatRecallHeaderForTui(result.details) : undefined;
	if (header && body) return `\n${header}\n\n${body}`;
	if (header) return `\n${header}`;
	return body ? `\n${body}` : "";
}

export const recallObservationTool = defineTool({
	name: RECALL_OBSERVATION_TOOL_NAME,
	label: "Recall memory evidence",
	description:
		"Recover exact evidence and source context behind a compacted observational-memory observation or reflection id on the current branch. " +
		"Use when compressed memory is important and original source context is needed before acting.",
	promptSnippet: "Use recall(<id>) to recover exact source context behind compacted memory observations/reflections when precision matters.",
	promptGuidelines: [
		"Use recall before making an important decision that depends on a compacted observation or reflection whose details are unclear.",
		"Use recall when you need exact wording, rationale, file paths, commands, errors, commits, user constraints, or provenance behind a remembered claim.",
		"Use recall when a broad reflection is relevant but you need its supporting observations or raw sources to continue safely.",
		"Use recall when the user asks why you believe something, what supports a memory, or what was decided earlier.",
		"Do not use recall as semantic search or transcript browsing; you must already have a specific 12-character memory id.",
		"Do not recall every id preemptively. Recall only when exact source context will materially improve the next action.",
	],
	parameters: Type.Object({
		id: Type.String({
			pattern: "^[a-f0-9]{12}$",
			description:
				"12-character lowercase hex observation or reflection id shown in compacted memory, /om-view, or a previous recall result. " +
				"Must be a specific id; this tool does not search by topic.",
		}),
	}),
	renderCall(args) {
		return new Text(formatRecallCallForTui(args.id), 0, 0);
	},
	renderResult(result, options) {
		return new Text(formatRecallRenderedResultForTui(result as AgentToolResult<RecallObservationToolDetails>, options.expanded), 0, 0);
	},
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const memoryId = params.id;
		if (!MEMORY_ID_PATTERN.test(memoryId)) {
			const message = `Memory id must be 12 lowercase hex characters. Received: ${memoryId}`;
			return textResult(message, emptyDetails("invalid_id", memoryId, message));
		}

		const branchEntries = ctx.sessionManager.getBranch() as Entry[];
		const result = recallMemorySources(branchEntries, memoryId);
		if (result.status === "not_found") {
			const message = `No observation or reflection with id ${memoryId} was found on the current branch.`;
			return textResult(message, emptyDetails("not_found", memoryId, message));
		}

		return renderFoundResult(result);
	},
});

export function registerRecallTool(pi: ExtensionAPI): void {
	pi.registerTool(recallObservationTool);
}
