import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	recallObservationSources,
	type Entry,
	type RecallObservationMatch,
	type RecallObservationSourcesResult,
} from "../branch.js";
import { renderRecallSourceEntries } from "../serialize.js";
import type { ObservationRecord } from "../types.js";

export const RECALL_OBSERVATION_TOOL_NAME = "recall_observation";
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

type RecallObservationMatchDetails = {
	status: RecallObservationMatch["status"];
	observationEntryId: string;
	observation: ObservationDetails;
	sourceEntryIds?: string[];
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

function observationDetails(observation: ObservationRecord): ObservationDetails {
	return {
		id: observation.id,
		content: observation.content,
		timestamp: observation.timestamp,
		relevance: observation.relevance,
	};
}

function matchDetails(match: RecallObservationMatch, sourceText?: string): RecallObservationMatchDetails {
	if (match.status === "ok") {
		return {
			status: "ok",
			observationEntryId: match.observationEntryId,
			observation: observationDetails(match.observation),
			sourceEntryIds: match.sourceEntryIds,
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
			matches: detailsMatches,
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

export const recallObservationTool = defineTool({
	name: RECALL_OBSERVATION_TOOL_NAME,
	label: "Recall observation source",
	description: "Recall exact source entries for an observational-memory observation id on the current branch.",
	promptSnippet: "Recall exact source entries for a compacted observational-memory observation id.",
	promptGuidelines: [
		"Use recall_observation when a compacted observation id needs exact source context or the user asks what supports a remembered claim.",
		"This is not general search: pass a specific observation id from the compacted Observations list.",
		"Do not call recall_observation for broad transcript browsing or off-branch history.",
	],
	parameters: Type.Object({
		id: Type.String({
			pattern: "^[a-f0-9]{12}$",
			description: "12-character lowercase hex observational-memory observation id.",
		}),
	}),
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
