/**
 * Stable export surface for downstream bridge extensions (U4).
 *
 * Lets companion extensions (e.g. om-to-mem-bridge) read finalized
 * observational-memory state without importing internal source-module
 * paths. Returns a version-neutral record shape so future MemoryDetails
 * format bumps do not break consumers.
 *
 * Usage from a bridge extension (post U4 install):
 *
 *     import {
 *       getMemoryStateFromBranch,
 *       exportFromMemoryDetails,
 *       type BridgeRecord,
 *     } from "pi-observational-memory/bridge";
 *
 *     pi.on("session_compact", (_event, ctx) => {
 *       const entries = ctx.sessionManager.getBranch();
 *       const state = getMemoryStateFromBranch(entries);
 *       const records = exportFromMemoryDetails(state);
 *       // forward `records` to long-term storage
 *     });
 *
 * The bridge surface is intentionally small and read-only:
 *   - Consumers MUST NOT mutate observation/reflection records.
 *   - The bridge does not register any Pi hooks, commands, or tools.
 *   - The bridge does not change OM's compaction summary, prefix-cache
 *     behavior, or recall semantics.
 */

import { existsSync, readFileSync } from "node:fs";

import {
	getMemoryState,
	recallMemorySources,
	type Entry,
	type RecallMemorySourcesResult,
} from "./branch.js";
import {
	isMemoryDetailsV3,
	isMemoryDetailsV4,
	reflectionContent,
	reflectionId,
	type MemoryDetailsV3,
	type MemoryDetailsV4,
	type MemoryReflection,
	type ObservationRecord,
	type Relevance,
	type SupportedMemoryDetails,
} from "./types.js";

/**
 * Version-neutral record returned by the bridge. Both observations and
 * reflections collapse to this shape so bridge consumers can persist them
 * uniformly. Original ObservationRecord / MemoryReflection objects remain
 * available via the lower-level branch API for callers that need the raw
 * shape.
 */
export interface BridgeRecord {
	kind: "observation" | "reflection";
	/** 12-char hex OM id when available. Legacy plain-string reflections may omit this. */
	id?: string;
	content: string;
	relevance?: Relevance;
	/** OM 'YYYY-MM-DD HH:MM' timestamp (observations only). */
	timestamp?: string;
	/** Source entry ids the OM observation was distilled from. */
	sourceEntryIds?: string[];
	/** OM supporting observations for structured reflections. */
	supportingObservationIds?: string[];
}

/**
 * Snapshot of finalized OM memory suitable for bridge export. Mirrors the
 * shape of getMemoryState() but exposes only the fields bridges should
 * read — pendingObs is intentionally excluded from default export paths
 * because uncommitted observations may still be pruned.
 */
export interface BridgeMemorySnapshot {
	observations: ObservationRecord[];
	reflections: MemoryReflection[];
	/** Observations that have not yet been folded into a compaction. */
	pendingObservations: ObservationRecord[];
}

const HIGH_RELEVANCE: ReadonlySet<Relevance> = new Set<Relevance>(["high", "critical"]);

/**
 * Read finalized OM state from a session branch. Thin pass-through to
 * getMemoryState() with bridge-friendly field names. Pending observations
 * are exposed for callers that explicitly opt in via
 * `exportFromSnapshot({ includePending: true })`.
 */
export function getMemoryStateFromBranch(entries: Entry[]): BridgeMemorySnapshot {
	const state = getMemoryState(entries);
	return {
		observations: state.committedObs,
		reflections: state.reflections,
		pendingObservations: state.pendingObs,
	};
}

/**
 * Adapt MemoryDetails (V3 or V4) into a bridge snapshot. Useful when a
 * caller has the compaction details object directly (e.g. from a
 * `session_before_compact` hook) instead of a session branch. V3 details
 * carry only legacy plain-string reflections; the snapshot's
 * `pendingObservations` is always empty for this entry point.
 *
 * Returns null when the input is not a supported MemoryDetails shape.
 */
export function snapshotFromMemoryDetails(
	details: unknown,
): BridgeMemorySnapshot | null {
	if (isMemoryDetailsV4(details)) {
		const v4: MemoryDetailsV4 = details;
		return {
			observations: [...v4.observations],
			reflections: [...v4.reflections],
			pendingObservations: [],
		};
	}
	if (isMemoryDetailsV3(details)) {
		const v3: MemoryDetailsV3 = details;
		return {
			observations: [...v3.observations],
			reflections: [...v3.reflections],
			pendingObservations: [],
		};
	}
	return null;
}

export interface ExportOptions {
	/**
	 * Relevance levels to keep when filtering committed observations.
	 * Defaults to {"high", "critical"}. Pass a custom set or use
	 * `exportAllObservations: true` to bypass entirely.
	 */
	highSignalRelevance?: ReadonlySet<Relevance>;
	/** When true, exports every committed observation regardless of relevance. */
	exportAllObservations?: boolean;
	/** When false, suppresses reflections in the output. Default true. */
	exportReflections?: boolean;
	/**
	 * When true, also exports `pendingObservations`. Off by default because
	 * pending observations may be pruned before becoming durable memory.
	 */
	includePending?: boolean;
}

/**
 * Convert a bridge snapshot into version-neutral records. The default
 * filter selects `high` + `critical` observations and includes all
 * reflections; tune via {@link ExportOptions} for other policies.
 */
export function exportFromSnapshot(
	snapshot: BridgeMemorySnapshot,
	opts: ExportOptions = {},
): BridgeRecord[] {
	const filter = opts.highSignalRelevance ?? HIGH_RELEVANCE;
	const exportAll = opts.exportAllObservations === true;
	const includeReflections = opts.exportReflections !== false;
	const includePending = opts.includePending === true;

	const records: BridgeRecord[] = [];

	const addObs = (obs: ObservationRecord): void => {
		if (!exportAll && !filter.has(obs.relevance)) return;
		records.push({
			kind: "observation",
			id: obs.id,
			content: obs.content,
			relevance: obs.relevance,
			timestamp: obs.timestamp,
			sourceEntryIds: obs.sourceEntryIds,
		});
	};

	for (const obs of snapshot.observations) addObs(obs);
	if (includePending) {
		for (const obs of snapshot.pendingObservations) addObs(obs);
	}

	if (includeReflections) {
		for (const reflection of snapshot.reflections) {
			const content = reflectionContent(reflection);
			if (!content || content.trim().length === 0) continue;
			const id = reflectionId(reflection);
			const supportingObservationIds = typeof reflection === "string"
				? undefined
				: reflection.supportingObservationIds;
			records.push({
				kind: "reflection",
				id,
				content,
				supportingObservationIds,
			});
		}
	}

	return records;
}

/**
 * Convenience helper combining {@link snapshotFromMemoryDetails} and
 * {@link exportFromSnapshot}. Returns an empty array when the input is
 * not a supported MemoryDetails shape — bridges should treat that as
 * "no work for this compaction".
 */
export function exportFromMemoryDetails(
	details: unknown,
	opts: ExportOptions = {},
): BridgeRecord[] {
	const snapshot = snapshotFromMemoryDetails(details);
	if (!snapshot) return [];
	return exportFromSnapshot(snapshot, opts);
}

/**
 * Parse a Pi session JSONL file into the OM Entry[] shape recall expects.
 *
 * Lines that fail to JSON-parse are skipped rather than throwing — a
 * partially corrupted session file should still allow recall of any
 * intact entries. Returns null when the file does not exist or cannot
 * be read.
 */
export function loadSessionEntries(sessionFile: string): Entry[] | null {
	if (!sessionFile || sessionFile.length === 0) return null;
	if (!existsSync(sessionFile)) return null;
	let raw: string;
	try {
		raw = readFileSync(sessionFile, "utf-8");
	} catch {
		return null;
	}
	const entries: Entry[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === "object" && typeof parsed.type === "string" && typeof parsed.id === "string") {
				entries.push(parsed as Entry);
			}
		} catch {
			// skip malformed line
		}
	}
	return entries;
}

export interface RecallFromSessionFileResult {
	/** When the session file could be read, the recall result for the given memory id. */
	recall: RecallMemorySourcesResult | null;
	/** Reason recall could not be attempted. */
	unavailableReason?: "missing-session-file" | "unreadable-session-file" | "empty-session-file";
}

/**
 * Resolve exact source evidence for an OM memory id (observation or
 * reflection) by loading the session JSONL file and running OM's
 * existing recall machinery against the parsed entries. Returns an
 * unavailable reason rather than throwing when the session file is
 * missing, unreadable, or empty — cross-session recall callers should
 * surface that to the user with the stored OM record content as a
 * fallback.
 */
export function recallSourcesFromSessionFile(
	sessionFile: string,
	memoryId: string,
): RecallFromSessionFileResult {
	if (!sessionFile || sessionFile.length === 0) {
		return { recall: null, unavailableReason: "missing-session-file" };
	}
	if (!existsSync(sessionFile)) {
		return { recall: null, unavailableReason: "missing-session-file" };
	}
	const entries = loadSessionEntries(sessionFile);
	if (entries === null) {
		return { recall: null, unavailableReason: "unreadable-session-file" };
	}
	if (entries.length === 0) {
		return { recall: null, unavailableReason: "empty-session-file" };
	}
	return { recall: recallMemorySources(entries, memoryId) };
}

/** Re-export commonly used type guards for bridge consumers. */
export { isMemoryDetailsV3, isMemoryDetailsV4 };
export type { MemoryDetailsV3, MemoryDetailsV4, SupportedMemoryDetails, Relevance, ObservationRecord, MemoryReflection };
