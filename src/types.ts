export const OBSERVATION_CUSTOM_TYPE = "om.observation";

export type Relevance = "low" | "medium" | "high" | "critical";

export const RELEVANCE_VALUES: readonly Relevance[] = ["low", "medium", "high", "critical"] as const;

export const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/;

export interface ObservationRecord {
	id: string;
	content: string;
	timestamp: string;
	relevance: Relevance;
	sourceEntryIds?: string[];
}

export type LegacyReflection = string;

export interface ReflectionRecord {
	id: string;
	content: string;
	supportingObservationIds: string[];
}

export type MemoryReflection = LegacyReflection | ReflectionRecord;

/**
 * Current runtime reflection alias used by pre-v4 consumers. Later producer/consumer
 * steps should migrate surfaces that need id-bearing records to MemoryReflection.
 */
export type Reflection = LegacyReflection;

export interface MemoryDetailsV3 {
	type: "observational-memory";
	version: 3;
	observations: ObservationRecord[];
	reflections: LegacyReflection[];
}

export interface MemoryDetailsV4 {
	type: "observational-memory";
	version: 4;
	observations: ObservationRecord[];
	reflections: MemoryReflection[];
}

export type SupportedMemoryDetails = MemoryDetailsV3 | MemoryDetailsV4;

export type MemoryDetails = MemoryDetailsV3;

export interface ObservationEntryData {
	records: ObservationRecord[];
	coversFromId: string;
	coversUpToId: string;
	tokenCount: number;
}

function isRelevance(v: unknown): v is Relevance {
	return typeof v === "string" && (RELEVANCE_VALUES as readonly string[]).includes(v);
}

function isObservationRecord(v: unknown): v is ObservationRecord {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	if (
		typeof o.id !== "string" ||
		typeof o.content !== "string" ||
		typeof o.timestamp !== "string" ||
		!isRelevance(o.relevance)
	) {
		return false;
	}
	if (o.sourceEntryIds === undefined) return true;
	return isNonEmptyStringArray(o.sourceEntryIds);
}

function isNonEmptyStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.length > 0 && v.every((id) => typeof id === "string" && id.length > 0);
}

export function isReflectionRecord(v: unknown): v is ReflectionRecord {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.id === "string" &&
		MEMORY_ID_PATTERN.test(o.id) &&
		typeof o.content === "string" &&
		o.content.trim().length > 0 &&
		!/[\r\n]/.test(o.content) &&
		isNonEmptyStringArray(o.supportingObservationIds)
	);
}

export function isMemoryReflection(v: unknown): v is MemoryReflection {
	return typeof v === "string" || isReflectionRecord(v);
}

export function reflectionContent(reflection: MemoryReflection): string {
	return typeof reflection === "string" ? reflection : reflection.content;
}

export function reflectionId(reflection: MemoryReflection): string | undefined {
	return typeof reflection === "string" ? undefined : reflection.id;
}

export function reflectionToPromptLine(reflection: MemoryReflection): string {
	return typeof reflection === "string" ? reflection : `[${reflection.id}] ${reflection.content}`;
}

export function isMemoryDetailsV3(d: unknown): d is MemoryDetailsV3 {
	if (!d || typeof d !== "object") return false;
	const o = d as Record<string, unknown>;
	if (o.type !== "observational-memory" || o.version !== 3) return false;
	if (!Array.isArray(o.observations) || !Array.isArray(o.reflections)) return false;
	if (!o.observations.every(isObservationRecord)) return false;
	return o.reflections.every((r) => typeof r === "string");
}

export function isMemoryDetailsV4(d: unknown): d is MemoryDetailsV4 {
	if (!d || typeof d !== "object") return false;
	const o = d as Record<string, unknown>;
	if (o.type !== "observational-memory" || o.version !== 4) return false;
	if (!Array.isArray(o.observations) || !Array.isArray(o.reflections)) return false;
	if (!o.observations.every(isObservationRecord)) return false;
	return o.reflections.every(isMemoryReflection);
}

export function isSupportedMemoryDetails(d: unknown): d is SupportedMemoryDetails {
	return isMemoryDetailsV3(d) || isMemoryDetailsV4(d);
}

export function isMemoryDetails(d: unknown): d is MemoryDetails {
	return isMemoryDetailsV3(d);
}

export function isObservationEntryData(d: unknown): d is ObservationEntryData {
	if (!d || typeof d !== "object") return false;
	const o = d as Record<string, unknown>;
	return (
		Array.isArray(o.records) &&
		o.records.every(isObservationRecord) &&
		typeof o.coversFromId === "string" &&
		typeof o.coversUpToId === "string" &&
		typeof o.tokenCount === "number"
	);
}
