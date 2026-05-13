import { agentLoop, type AgentContext, type AgentEvent, type AgentLoopConfig, type AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Message, type Model } from "@mariozechner/pi-ai";
import type { Static } from "typebox";
import { debugLog, isDebugLogEnabled } from "./debug-log.js";
import { hashId } from "./ids.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "./model-budget.js";
import { observationsToPromptLines } from "./observer.js";
import { buildPrunerPassGuidance, buildReflectorPassGuidance, CONTEXT_USAGE_INSTRUCTIONS, PRUNER_SYSTEM, REFLECTOR_SYSTEM } from "./prompts.js";
import { truncateRecordContent } from "./serialize.js";
import { estimateStringTokens } from "./tokens.js";
import { reflectionContent, reflectionToPromptLine } from "./types.js";
import type { MemoryReflection, ObservationRecord, ReflectionRecord } from "./types.js";

const REFLECTOR_MAX_PASSES = 3;
const PRUNER_MAX_PASSES = 5;
const PRUNER_TARGET_RATIO = 0.8;

export function observationPoolTokens(observations: ObservationRecord[]): number {
	return estimateStringTokens(observationsToPromptLines(observations).join("\n"));
}

interface LlmArgs {
	model: Model<any>;
	apiKey: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	onEvent?: (event: import("@mariozechner/pi-agent-core").AgentEvent) => void;
	maxToolCalls?: number;
}

function joinReflectionsOrEmpty(items: MemoryReflection[]): string {
	return items.length ? items.map(reflectionToPromptLine).join("\n") : "(none yet)";
}

function joinObservationsOrEmpty(items: ObservationRecord[]): string {
	return items.length ? observationsToPromptLines(items).join("\n") : "(none yet)";
}

function summarizeContentTypes(content: unknown): string | string[] {
	if (!Array.isArray(content)) return typeof content;
	return content.map((block) => {
		if (block && typeof block === "object" && "type" in block) {
			const type = (block as { type?: unknown }).type;
			return typeof type === "string" ? type : typeof type;
		}
		return typeof block;
	});
}

function summarizeAgentMessage(message: unknown): Record<string, unknown> {
	if (!message || typeof message !== "object") return { type: typeof message };
	const record = message as Record<string, unknown>;
	const summary: Record<string, unknown> = {
		role: typeof record.role === "string" ? record.role : "unknown",
	};
	if ("api" in record && typeof record.api === "string") summary.api = record.api;
	if ("provider" in record && typeof record.provider === "string") summary.provider = record.provider;
	if ("model" in record && typeof record.model === "string") summary.model = record.model;
	if ("stopReason" in record && typeof record.stopReason === "string") summary.stopReason = record.stopReason;
	if ("errorMessage" in record && typeof record.errorMessage === "string") summary.errorMessage = record.errorMessage;
	if ("toolName" in record && typeof record.toolName === "string") summary.toolName = record.toolName;
	if ("isError" in record && typeof record.isError === "boolean") summary.isError = record.isError;
	if ("content" in record) summary.contentTypes = summarizeContentTypes(record.content);
	return summary;
}

function finalAssistantSummary(messages: unknown): Record<string, unknown> | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message && typeof message === "object" && (message as { role?: unknown }).role === "assistant") {
			return summarizeAgentMessage(message);
		}
	}
	return undefined;
}

function summarizeToolResults(toolResults: unknown): Record<string, unknown>[] {
	if (!Array.isArray(toolResults)) return [];
	return toolResults.map(summarizeAgentMessage);
}

function summarizeObjectKeys(value: unknown): string[] | undefined {
	return value && typeof value === "object" ? Object.keys(value as Record<string, unknown>).sort() : undefined;
}

function logAgentLoopEvent(scope: "reflector" | "pruner", pass: number, event: AgentEvent): void {
	switch (event.type) {
		case "agent_start":
		case "turn_start":
			debugLog(`${scope}.agent_loop.${event.type}`, { pass });
			return;
		case "message_start":
		case "message_end":
			debugLog(`${scope}.agent_loop.${event.type}`, { pass, message: summarizeAgentMessage(event.message) });
			return;
		case "message_update":
			debugLog(`${scope}.agent_loop.message_update`, {
				pass,
				message: summarizeAgentMessage(event.message),
				assistantEventType: event.assistantMessageEvent.type,
			});
			return;
		case "turn_end":
			debugLog(`${scope}.agent_loop.turn_end`, {
				pass,
				message: summarizeAgentMessage(event.message),
				toolResultCount: event.toolResults.length,
				toolResults: summarizeToolResults(event.toolResults),
			});
			return;
		case "agent_end":
			debugLog(`${scope}.agent_loop.agent_end`, {
				pass,
				messageCount: event.messages.length,
				finalAssistant: finalAssistantSummary(event.messages),
			});
			return;
		case "tool_execution_start":
			debugLog(`${scope}.agent_loop.tool_execution_start`, {
				pass,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				argsKeys: summarizeObjectKeys(event.args),
			});
			return;
		case "tool_execution_update":
			debugLog(`${scope}.agent_loop.tool_execution_update`, {
				pass,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				argsKeys: summarizeObjectKeys(event.args),
				partialResultKeys: summarizeObjectKeys(event.partialResult),
			});
			return;
		case "tool_execution_end":
			debugLog(`${scope}.agent_loop.tool_execution_end`, {
				pass,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				isError: event.isError,
				resultKeys: summarizeObjectKeys(event.result),
			});
			return;
	}
}

export type ObservationCoverageTag = "uncited" | "cited" | "reinforced";

export interface CoverageTagCounts {
	uncited: number;
	cited: number;
	reinforced: number;
}

export function deriveObservationCoverageTags(
	reflections: MemoryReflection[],
	observations: ObservationRecord[],
): Map<string, ObservationCoverageTag> {
	const activeIds = new Set(observations.map((o) => o.id));
	const counts = new Map<string, number>();
	for (const observation of observations) counts.set(observation.id, 0);

	for (const reflection of reflections) {
		if (typeof reflection === "string" || reflection.legacy === true) continue;
		const citedActiveIds = new Set(reflection.supportingObservationIds.filter((id) => activeIds.has(id)));
		for (const id of citedActiveIds) counts.set(id, (counts.get(id) ?? 0) + 1);
	}

	const tags = new Map<string, ObservationCoverageTag>();
	for (const observation of observations) {
		const count = counts.get(observation.id) ?? 0;
		tags.set(observation.id, count === 0 ? "uncited" : count >= 4 ? "reinforced" : "cited");
	}
	return tags;
}

export function coverageTagCounts(
	reflections: MemoryReflection[],
	observations: ObservationRecord[],
): CoverageTagCounts {
	const tags = deriveObservationCoverageTags(reflections, observations);
	const counts: CoverageTagCounts = { uncited: 0, cited: 0, reinforced: 0 };
	for (const observation of observations) {
		counts[tags.get(observation.id) ?? "uncited"]++;
	}
	return counts;
}

export function renderObservationsForPrunerPrompt(
	observations: ObservationRecord[],
	coverageTags: ReadonlyMap<string, ObservationCoverageTag>,
): string {
	if (observations.length === 0) return "(none yet)";
	return observations
		.map((observation) => {
			const tag = coverageTags.get(observation.id) ?? "uncited";
			return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] [coverage: ${tag}] ${observation.content}`;
		})
		.join("\n");
}

export function migrateLegacyReflections(reflections: MemoryReflection[]): MemoryReflection[] {
	const migrated: MemoryReflection[] = [];
	const contentToIndex = new Map<string, number>();

	for (const reflection of reflections) {
		const rawContent = reflectionContent(reflection).trim();
		const normalizedContent = typeof reflection === "string" ? rawContent.replace(/\s+/g, " ") : rawContent;
		if (!normalizedContent) {
			migrated.push(reflection);
			continue;
		}
		const content = truncateRecordContent(normalizedContent);

		const existingIndex = contentToIndex.get(content);
		if (existingIndex !== undefined) {
			const existing = migrated[existingIndex];
			if (typeof existing !== "string" && existing.legacy === true && typeof reflection !== "string" && reflection.legacy !== true) {
				migrated[existingIndex] = reflection;
			}
			continue;
		}

		if (typeof reflection !== "string") {
			migrated.push(reflection);
			contentToIndex.set(content, migrated.length - 1);
			continue;
		}

		migrated.push({
			id: hashId(content),
			content,
			supportingObservationIds: [],
			legacy: true,
		});
		contentToIndex.set(content, migrated.length - 1);
	}

	return migrated;
}

const RecordReflectionsSchema = Type.Object({
	reflections: Type.Array(
		Type.Object({
			content: Type.String({
				minLength: 1,
				description: "Single-line plain prose reflection. No markdown, no tags, no timestamp, no bullets.",
			}),
			supportingObservationIds: Type.Array(
				Type.String({
					pattern: "^[a-f0-9]{12}$",
					description: "Exact observation id from the current-observations list whose durable meaning is captured by this reflection.",
				}),
				{
					minItems: 1,
					description:
						"Current observation ids whose durable meaning is captured by this reflection and can be treated as covered active-memory detail. " +
						"Do not include observations whose unique exact detail or current task state is not captured. Use only ids shown in the current observations list; never invent ids.",
				},
			),
		}),
		{
			minItems: 1,
			description: "Batch of new reflection proposals with their supporting observation ids.",
		},
	),
});

type RecordReflectionsArgs = Static<typeof RecordReflectionsSchema>;

export function normalizeSupportingObservationIds(
	supportingObservationIds: readonly string[] | undefined,
	allowedObservationIds: readonly string[],
): string[] | undefined {
	if (!supportingObservationIds || supportingObservationIds.length === 0) return undefined;
	const allowedOrder = new Map<string, number>();
	for (let i = 0; i < allowedObservationIds.length; i++) {
		if (!allowedOrder.has(allowedObservationIds[i])) allowedOrder.set(allowedObservationIds[i], i);
	}

	const seen = new Set<string>();
	for (const id of supportingObservationIds) {
		if (!allowedOrder.has(id)) return undefined;
		seen.add(id);
	}
	if (seen.size === 0) return undefined;
	return Array.from(seen).sort((a, b) => (allowedOrder.get(a) ?? 0) - (allowedOrder.get(b) ?? 0));
}

export interface ReflectorPassContext {
	pass: number;
	maxPasses: number;
	minSupportingObservationIds: number;
}

export type ReflectionProposal = {
	content: string;
	supportingObservationIds?: readonly string[];
};

export interface ApplyReflectionProposalsResult {
	reflections: MemoryReflection[];
	accepted: number;
	added: number;
	merged: number;
	promoted: number;
	duplicates: number;
	unsupported: number;
}

export interface ReflectorPassStats {
	pass: number;
	toolCalls: number;
	accepted: number;
	added: number;
	merged: number;
	promoted: number;
	duplicates: number;
	unsupported: number;
	failed: boolean;
}

export interface ReflectorStats {
	passes: ReflectorPassStats[];
	toolCalls: number;
	accepted: number;
	added: number;
	merged: number;
	promoted: number;
	duplicates: number;
	unsupported: number;
	failedPass?: number;
}

export interface ReflectorResult {
	reflections: MemoryReflection[];
	stats: ReflectorStats;
}

function emptyReflectorPassStats(pass: number): ReflectorPassStats {
	return {
		pass,
		toolCalls: 0,
		accepted: 0,
		added: 0,
		merged: 0,
		promoted: 0,
		duplicates: 0,
		unsupported: 0,
		failed: false,
	};
}

function addReflectionProposalStats(target: ReflectorPassStats, result: ApplyReflectionProposalsResult): void {
	target.toolCalls++;
	target.accepted += result.accepted;
	target.added += result.added;
	target.merged += result.merged;
	target.promoted += result.promoted;
	target.duplicates += result.duplicates;
	target.unsupported += result.unsupported;
}

function aggregateReflectorStats(passes: ReflectorPassStats[]): ReflectorStats {
	const stats: ReflectorStats = {
		passes,
		toolCalls: 0,
		accepted: 0,
		added: 0,
		merged: 0,
		promoted: 0,
		duplicates: 0,
		unsupported: 0,
	};
	for (const pass of passes) {
		stats.toolCalls += pass.toolCalls;
		stats.accepted += pass.accepted;
		stats.added += pass.added;
		stats.merged += pass.merged;
		stats.promoted += pass.promoted;
		stats.duplicates += pass.duplicates;
		stats.unsupported += pass.unsupported;
		if (pass.failed && stats.failedPass === undefined) stats.failedPass = pass.pass;
	}
	return stats;
}

function reflectorPassContext(pass: number): ReflectorPassContext {
	return {
		pass,
		maxPasses: REFLECTOR_MAX_PASSES,
		minSupportingObservationIds: pass === 1 ? 2 : 1,
	};
}

function reflectionContentKey(reflection: MemoryReflection): string {
	return reflectionContent(reflection).trim();
}

function normalizeReflectionProposalContent(content: string): string | undefined {
	const normalized = truncateRecordContent(content.trim());
	if (!normalized || /[\r\n]/.test(normalized)) return undefined;
	return normalized;
}

function mergeSupportingObservationIds(
	existing: readonly string[],
	incoming: readonly string[],
	allowedObservationIds: readonly string[],
): string[] | undefined {
	const allowed = new Set(allowedObservationIds);
	const historicalExisting = existing.filter((id) => !allowed.has(id));
	const currentExisting = existing.filter((id) => allowed.has(id));
	const normalizedCurrent = normalizeSupportingObservationIds([...currentExisting, ...incoming], allowedObservationIds);
	if (!normalizedCurrent) return undefined;
	return [...historicalExisting, ...normalizedCurrent];
}

export function renderReflectionsForReflectorPrompt(reflections: MemoryReflection[]): string {
	return joinReflectionsOrEmpty(reflections);
}

export function applyReflectionProposals(
	reflections: MemoryReflection[],
	proposals: readonly ReflectionProposal[],
	allowedObservationIds: readonly string[],
	passContext: Pick<ReflectorPassContext, "minSupportingObservationIds">,
): ApplyReflectionProposalsResult {
	const next = [...reflections];
	let accepted = 0;
	let added = 0;
	let merged = 0;
	let promoted = 0;
	let duplicates = 0;
	let unsupported = 0;

	for (const proposal of proposals) {
		const content = normalizeReflectionProposalContent(proposal.content);
		if (!content) {
			unsupported++;
			continue;
		}
		const supportingObservationIds = normalizeSupportingObservationIds(
			proposal.supportingObservationIds,
			allowedObservationIds,
		);
		if (!supportingObservationIds || supportingObservationIds.length < passContext.minSupportingObservationIds) {
			unsupported++;
			continue;
		}

		const existingIndex = next.findIndex((reflection) => reflectionContentKey(reflection) === content);
		if (existingIndex >= 0) {
			const existing = next[existingIndex];
			if (typeof existing === "string") {
				next[existingIndex] = {
					id: hashId(content),
					content,
					supportingObservationIds,
				};
				accepted++;
				promoted++;
				continue;
			}

			const mergedSupport = mergeSupportingObservationIds(
				existing.supportingObservationIds,
				supportingObservationIds,
				allowedObservationIds,
			);
			if (!mergedSupport) {
				unsupported++;
				continue;
			}
			const hasNewSupport = mergedSupport.length !== existing.supportingObservationIds.length;
			if (existing.legacy === true) {
				next[existingIndex] = {
					id: existing.id,
					content: existing.content,
					supportingObservationIds: mergedSupport,
				};
				accepted++;
				promoted++;
				continue;
			}
			if (hasNewSupport) {
				next[existingIndex] = {
					...existing,
					supportingObservationIds: mergedSupport,
				};
				accepted++;
				merged++;
			} else {
				duplicates++;
			}
			continue;
		}

		next.push({
			id: hashId(content),
			content,
			supportingObservationIds,
		});
		accepted++;
		added++;
	}

	return { reflections: next, accepted, added, merged, promoted, duplicates, unsupported };
}

async function runReflectorPass(
	args: LlmArgs,
	reflections: MemoryReflection[],
	observations: ObservationRecord[],
	passContext: ReflectorPassContext,
): Promise<{ reflections: MemoryReflection[]; stats: ReflectorPassStats }> {
	const allowedObservationIds = observations.map((o) => o.id);
	let currentReflections = reflections;
	const stats = emptyReflectorPassStats(passContext.pass);
	let consecutiveEmptyCalls = 0;
	debugLog("reflector.pass.start", {
		pass: passContext.pass,
		maxPasses: passContext.maxPasses,
		minSupportingObservationIds: passContext.minSupportingObservationIds,
		reflectionCount: reflections.length,
		observationCount: observations.length,
		observationIds: isDebugLogEnabled() ? allowedObservationIds : undefined,
	});

	const recordTool: AgentTool<typeof RecordReflectionsSchema> = {
		name: "record_reflections",
		label: "Record reflections",
		description:
			"Record a batch of reflections crystallized from the observation pool, with supporting ids for observations whose durable meaning is captured. " +
			"May be called multiple times. Stop calling when nothing more is stable enough to crystallize or strengthen for this pass, " +
			"then emit a short plain-text confirmation.",
		parameters: RecordReflectionsSchema,
		execute: async (_id, params: RecordReflectionsArgs) => {
			const result = applyReflectionProposals(
				currentReflections,
				params.reflections,
				allowedObservationIds,
				passContext,
			);
			currentReflections = result.reflections;
			addReflectionProposalStats(stats, result);
			if (result.accepted === 0) {
				consecutiveEmptyCalls++;
			} else {
				consecutiveEmptyCalls = 0;
			}
			const parts: string[] = [];
			parts.push(`Accepted ${result.accepted} reflection proposal${result.accepted === 1 ? "" : "s"}.`);
			if (result.added) parts.push(`${result.added} new.`);
			if (result.merged) parts.push(`${result.merged} merged into existing reflections.`);
			if (result.promoted) parts.push(`${result.promoted} promoted from legacy/no-provenance memory.`);
			if (result.duplicates) parts.push(`${result.duplicates} duplicate/no-op proposal${result.duplicates === 1 ? "" : "s"} skipped.`);
			if (result.unsupported) {
				parts.push(
					`${result.unsupported} unsupported proposal${result.unsupported === 1 ? "" : "s"} rejected for invalid supporting observation ids or this pass's minimum support requirement.`,
				);
			}
			parts.push("Call record_reflections again if more should be crystallized for this pass; otherwise stop and emit a short plain-text confirmation.");
			debugLog("reflector.tool_call", {
				pass: passContext.pass,
				accepted: result.accepted,
				added: result.added,
				merged: result.merged,
				promoted: result.promoted,
				duplicates: result.duplicates,
				unsupported: result.unsupported,
				currentReflectionCount: currentReflections.length,
				proposals: params.reflections.map((reflection: ReflectionProposal) => ({
					content: reflection.content,
					supportingObservationIds: reflection.supportingObservationIds,
				})),
			});
			return {
				content: [{ type: "text", text: parts.join(" ") }],
				details: result,
			};
		},
	};

	const passGuidance = buildReflectorPassGuidance(passContext.pass, passContext.maxPasses);
	const userText = `CURRENT REFLECTIONS:
${renderReflectionsForReflectorPrompt(reflections)}

CURRENT OBSERVATIONS:
${joinObservationsOrEmpty(observations)}

REFLECTOR PASS GUIDANCE:
${passGuidance}

Crystallize long-lived reflections from the full observation pool for this pass. Call record_reflections with batches of reflection proposals, each with supporting observation ids whose durable meaning is captured by that reflection. You may call the tool multiple times as you reason through the pool. To strengthen or promote an existing reflection, repeat the exact existing reflection content with additional valid supporting observation ids. Do not lightly reword existing reflections. Do not attach observations whose unique exact detail or current task state is not captured with equivalent fidelity. When done, stop calling the tool and emit a short plain-text confirmation.`;

	const prompts: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: userText }],
			timestamp: Date.now(),
		},
	];

	const context: AgentContext = {
		systemPrompt: REFLECTOR_SYSTEM,
		messages: [],
		tools: [recordTool as AgentTool<any>],
	};

	const reasoning = (args.model as { reasoning?: unknown }).reasoning;
	const effectiveMaxToolCalls = args.maxToolCalls && args.maxToolCalls > 0 ? args.maxToolCalls : undefined;
	let turnCount = 0;

	const config: AgentLoopConfig = {
		model: args.model as any,
		apiKey: args.apiKey,
		headers: args.headers,
		maxTokens: boundedMaxTokens(args.model, AGENT_LOOP_MAX_TOKENS),
		convertToLlm: (msgs) => msgs as Message[],
		toolExecution: "sequential",
		...(reasoning ? { reasoning: "high" as const } : {}),
		shouldStopAfterTurn: () => {
			turnCount++;
			if (effectiveMaxToolCalls !== undefined && turnCount >= effectiveMaxToolCalls) return true;
			if (consecutiveEmptyCalls >= 2) return true;
			return false;
		},
	};

	let firstEventSeen = false;
	try {
		debugLog("reflector.agent_loop.before_call", { pass: passContext.pass });
		const loop = args.agentLoop ?? agentLoop;
		const stream = loop(prompts, context, config, args.signal);
		debugLog("reflector.agent_loop.stream_created", { pass: passContext.pass });
		for await (const event of stream) {
			if (!firstEventSeen) {
				firstEventSeen = true;
				debugLog("reflector.agent_loop.first_event", { pass: passContext.pass, type: event.type });
			}
			logAgentLoopEvent("reflector", passContext.pass, event);
			args.onEvent?.(event);
		}
		await stream.result();
		debugLog("reflector.pass.result", { pass: passContext.pass, stats, reflectionCount: currentReflections.length });
	} catch (error) {
		stats.failed = true;
		debugLog("reflector.agent_loop.error", {
			pass: passContext.pass,
			firstEventSeen,
			errorMessage: error instanceof Error ? error.message : String(error),
		});
		return { reflections: currentReflections, stats };
	}

	return { reflections: currentReflections, stats };
}

export async function runReflector(
	args: LlmArgs,
	reflections: MemoryReflection[],
	observations: ObservationRecord[],
	onPassStart?: (pass: number, maxPasses: number) => void,
): Promise<ReflectorResult> {
	debugLog("reflector.start", {
		reflectionCount: reflections.length,
		observationCount: observations.length,
		observations: isDebugLogEnabled()
			? observations.map((observation) => ({
				id: observation.id,
				timestamp: observation.timestamp,
				relevance: observation.relevance,
				content: observation.content,
				sourceEntryIds: observation.sourceEntryIds,
			}))
			: undefined,
	});
	let currentReflections = reflections;
	const passes: ReflectorPassStats[] = [];

	for (let pass = 1; pass <= REFLECTOR_MAX_PASSES; pass++) {
		onPassStart?.(pass, REFLECTOR_MAX_PASSES);
		const result = await runReflectorPass(args, currentReflections, observations, reflectorPassContext(pass));
		currentReflections = result.reflections;
		passes.push(result.stats);
		if (result.stats.failed) break;
	}

	const result = { reflections: currentReflections, stats: aggregateReflectorStats(passes) };
	debugLog("reflector.result", {
		stats: result.stats,
		reflectionCount: result.reflections.length,
		reflections: isDebugLogEnabled()
			? result.reflections.map((reflection) => typeof reflection === "string" ? { legacyString: true, content: reflection } : reflection)
			: undefined,
	});
	return result;
}

export type PrunerStopReason = "empty" | "under_target" | "fell_back" | "zero_drops" | "max_passes";

export interface PrunerPassStats {
	pass: number;
	poolTokens: number;
	targetTokens: number;
	deltaTokens: number;
	dropped: number;
	remaining: number;
	fellBack: boolean;
}

export interface PrunerResult {
	observations: ObservationRecord[];
	droppedIds: string[];
	fellBack: boolean;
	passes: PrunerPassStats[];
	stopReason: PrunerStopReason;
}

const DropObservationsSchema = Type.Object({
	ids: Type.Array(
		Type.String({
			pattern: "^[a-f0-9]{12}$",
			description: "12-character hex observation id from the current-observations list.",
		}),
		{
			minItems: 1,
			description: "Ids of observations to remove from the kept set.",
		},
	),
	reason: Type.Optional(
		Type.String({ description: "Optional short note explaining why these observations were dropped." }),
	),
});

type DropObservationsArgs = Static<typeof DropObservationsSchema>;

interface PrunerPassContext {
	poolTokens: number;
	targetTokens: number;
	deltaTokens: number;
	pass: number;
	maxPasses: number;
	coverageTags: ReadonlyMap<string, ObservationCoverageTag>;
}

interface PrunerPassResult {
	kept: ObservationRecord[];
	droppedIds: string[];
	fellBack: boolean;
}

async function runPrunerPass(
	args: LlmArgs,
	reflections: MemoryReflection[],
	observations: ObservationRecord[],
	passContext: PrunerPassContext,
): Promise<PrunerPassResult> {
	const idSet = new Set(observations.map((o) => o.id));
	const dropped = new Set<string>();
	let consecutiveEmptyCalls = 0;
	debugLog("pruner.pass.start", {
		pass: passContext.pass,
		maxPasses: passContext.maxPasses,
		poolTokens: passContext.poolTokens,
		targetTokens: passContext.targetTokens,
		deltaTokens: passContext.deltaTokens,
		observationCount: observations.length,
		reflectionCount: reflections.length,
		observationIds: isDebugLogEnabled() ? observations.map((observation) => observation.id) : undefined,
	});

	const dropTool: AgentTool<typeof DropObservationsSchema> = {
		name: "drop_observations",
		label: "Drop observations",
		description:
			"Remove one or more observations from the kept set by id. May be called multiple times. " +
			"Stop calling when no further drops are warranted, then emit a short plain-text confirmation.",
		parameters: DropObservationsSchema,
		execute: async (_id, params: DropObservationsArgs) => {
			const valid: string[] = [];
			const unknown: string[] = [];
			const already: string[] = [];
			for (const id of params.ids) {
				if (!idSet.has(id)) {
					unknown.push(id);
					continue;
				}
				if (dropped.has(id)) {
					already.push(id);
					continue;
				}
				dropped.add(id);
				valid.push(id);
			}
			if (valid.length === 0) {
				consecutiveEmptyCalls++;
			} else {
				consecutiveEmptyCalls = 0;
			}
			const remaining = idSet.size - dropped.size;
			const parts: string[] = [];
			parts.push(`Dropped ${valid.length} observation${valid.length === 1 ? "" : "s"}.`);
			if (unknown.length) parts.push(`Unknown ids ignored: ${unknown.join(", ")}.`);
			if (already.length) parts.push(`Already dropped: ${already.join(", ")}.`);
			parts.push(`Remaining kept: ${remaining} of ${idSet.size}.`);
			parts.push("Call drop_observations again if more should be removed; otherwise stop and emit a short plain-text confirmation.");
			debugLog("pruner.tool_call", {
				pass: passContext.pass,
				requestedIds: params.ids,
				dropped: valid,
				unknown,
				already,
				remaining,
				reason: params.reason,
			});
			return {
				content: [{ type: "text", text: parts.join(" ") }],
				details: { dropped: valid, unknown, already, remaining },
			};
		},
	};

	const pressureLine =
		passContext.deltaTokens > 0
			? `Pool ~${passContext.poolTokens.toLocaleString()} tokens, target ~${passContext.targetTokens.toLocaleString()} tokens, still need to cut at least ~${passContext.deltaTokens.toLocaleString()} tokens.`
			: `Pool ~${passContext.poolTokens.toLocaleString()} tokens, target ~${passContext.targetTokens.toLocaleString()} tokens (already under budget) — drop only clear redundancies.`;

	const passGuidance = buildPrunerPassGuidance(passContext.pass, passContext.maxPasses);

	const userText = `CURRENT REFLECTIONS:
${joinReflectionsOrEmpty(reflections)}

CURRENT OBSERVATIONS:
${renderObservationsForPrunerPrompt(observations, passContext.coverageTags)}

${pressureLine}

${passGuidance}

Decide which observations to remove from the kept set. Call drop_observations with the ids you want to drop. You may call the tool multiple times as you reason through the pool. When satisfied, stop calling the tool and emit a short plain-text confirmation to end the run.`;

	const prompts: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: userText }],
			timestamp: Date.now(),
		},
	];

	const context: AgentContext = {
		systemPrompt: PRUNER_SYSTEM,
		messages: [],
		tools: [dropTool as AgentTool<any>],
	};

	const reasoning = (args.model as { reasoning?: unknown }).reasoning;
	const effectiveMaxToolCalls = args.maxToolCalls && args.maxToolCalls > 0 ? args.maxToolCalls : undefined;
	let turnCount = 0;

	const config: AgentLoopConfig = {
		model: args.model as any,
		apiKey: args.apiKey,
		headers: args.headers,
		maxTokens: boundedMaxTokens(args.model, AGENT_LOOP_MAX_TOKENS),
		convertToLlm: (msgs) => msgs as Message[],
		toolExecution: "sequential",
		...(reasoning ? { reasoning: "high" as const } : {}),
		shouldStopAfterTurn: () => {
			turnCount++;
			if (effectiveMaxToolCalls !== undefined && turnCount >= effectiveMaxToolCalls) return true;
			if (consecutiveEmptyCalls >= 2) return true;
			return false;
		},
	};

	let agentLoopCalled = false;
	let streamCreated = false;
	let firstEventSeen = false;
	try {
		debugLog("pruner.agent_loop.before_call", { pass: passContext.pass });
		const loop = args.agentLoop ?? agentLoop;
		agentLoopCalled = true;
		const stream = loop(prompts, context, config, args.signal);
		streamCreated = true;
		debugLog("pruner.agent_loop.stream_created", { pass: passContext.pass });
		for await (const event of stream) {
			if (!firstEventSeen) {
				firstEventSeen = true;
				debugLog("pruner.agent_loop.first_event", { pass: passContext.pass, type: event.type });
			}
			logAgentLoopEvent("pruner", passContext.pass, event);
			args.onEvent?.(event);
		}
		await stream.result();
	} catch (error) {
		debugLog("pruner.agent_loop.error", {
			pass: passContext.pass,
			agentLoopCalled,
			streamCreated,
			firstEventSeen,
			errorMessage: error instanceof Error ? error.message : String(error),
		});
		return { kept: observations, droppedIds: [], fellBack: true };
	}

	const kept = observations.filter((o) => !dropped.has(o.id));
	const droppedIds = Array.from(dropped);
	debugLog("pruner.pass.result", {
		pass: passContext.pass,
		droppedIds,
		dropped: droppedIds.length,
		remaining: kept.length,
		agentLoopCalled,
		streamCreated,
		firstEventSeen,
	});
	return { kept, droppedIds, fellBack: false };
}

export async function runPruner(
	args: LlmArgs,
	reflections: MemoryReflection[],
	observations: ObservationRecord[],
	budgetTokens: number,
	onPassStart?: (pass: number, maxPasses: number) => void,
): Promise<PrunerResult> {
	debugLog("pruner.start", {
		reflectionCount: reflections.length,
		observationCount: observations.length,
		budgetTokens,
	});
	if (observations.length === 0) {
		const result: PrunerResult = { observations: [], droppedIds: [], fellBack: false, passes: [], stopReason: "empty" };
		debugLog("pruner.result", {
			stopReason: result.stopReason,
			fellBack: result.fellBack,
			droppedIds: result.droppedIds,
			dropped: result.droppedIds.length,
			passes: result.passes,
			finalObservationCount: result.observations.length,
		});
		return result;
	}

	const target = Math.max(1, Math.floor(budgetTokens * PRUNER_TARGET_RATIO));
	const coverageTags = deriveObservationCoverageTags(reflections, observations);
	let pool = observations;

	const allDropped: string[] = [];
	const passes: PrunerPassStats[] = [];
	let fellBack = false;
	let stopReason: PrunerStopReason | undefined;

	for (let pass = 1; pass <= PRUNER_MAX_PASSES; pass++) {
		const poolTokens = observationPoolTokens(pool);
		if (poolTokens <= target) {
			stopReason = "under_target";
			debugLog("pruner.under_target", { pass, poolTokens, targetTokens: target, observationCount: pool.length });
			break;
		}

		onPassStart?.(pass, PRUNER_MAX_PASSES);
		const deltaTokens = poolTokens - target;
		const result = await runPrunerPass(args, reflections, pool, {
			poolTokens,
			targetTokens: target,
			deltaTokens,
			pass,
			maxPasses: PRUNER_MAX_PASSES,
			coverageTags,
		});
		passes.push({
			pass,
			poolTokens,
			targetTokens: target,
			deltaTokens,
			dropped: result.droppedIds.length,
			remaining: result.kept.length,
			fellBack: result.fellBack,
		});

		if (result.fellBack) {
			fellBack = true;
			stopReason = "fell_back";
			break;
		}
		if (result.droppedIds.length === 0) {
			stopReason = "zero_drops";
			break;
		}

		pool = result.kept;
		allDropped.push(...result.droppedIds);
	}

	stopReason ??= observationPoolTokens(pool) <= target ? "under_target" : "max_passes";
	const result = { observations: pool, droppedIds: allDropped, fellBack, passes, stopReason };
	debugLog("pruner.result", {
		stopReason: result.stopReason,
		fellBack: result.fellBack,
		droppedIds: result.droppedIds,
		dropped: result.droppedIds.length,
		passes: result.passes,
		finalObservationCount: result.observations.length,
	});
	return result;
}

export function renderSummary(reflections: MemoryReflection[], observations: ObservationRecord[]): string {
	if (reflections.length === 0 && observations.length === 0) return "";

	const parts: string[] = [CONTEXT_USAGE_INSTRUCTIONS];

	if (reflections.length > 0) {
		parts.push(`## Reflections\n${reflections.map(reflectionToPromptLine).join("\n")}`);
	}
	if (observations.length > 0) {
		const body = observationsToPromptLines(observations).join("\n");
		parts.push(`## Observations\n${body}`);
	}

	return parts.join("\n\n");
}
