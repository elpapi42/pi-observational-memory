import type { Message } from "@mariozechner/pi-ai";
import { OBSERVATION_CUSTOM_TYPE, isMemoryDetails, isObservationEntryData, type MemoryDetails, type ObservationEntryData } from "./types.js";
import { estimateEntryTokens } from "./tokens.js";

type Entry = {
	type: string;
	id: string;
	message?: unknown;
	content?: unknown;
	customType?: string;
	data?: unknown;
	details?: unknown;
	firstKeptEntryId?: string;
};

const RAW_TYPES = new Set(["message", "custom_message"]);

function isObservationEntry(entry: Entry): boolean {
	return entry.type === "custom" && entry.customType === OBSERVATION_CUSTOM_TYPE;
}

export function findLastCompactionIndex(entries: Entry[]): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") return i;
	}
	return -1;
}

export function findLastObservationIndex(entries: Entry[]): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (isObservationEntry(entries[i])) return i;
	}
	return -1;
}

export function findLastBoundIndex(entries: Entry[]): number {
	return Math.max(findLastCompactionIndex(entries), findLastObservationIndex(entries));
}

export function rawTokensFromIndex(entries: Entry[], startIndex: number): number {
	let total = 0;
	for (let i = Math.max(0, startIndex); i < entries.length; i++) {
		if (RAW_TYPES.has(entries[i].type)) total += estimateEntryTokens(entries[i]);
	}
	return total;
}

export function rawTokensSinceLastBound(entries: Entry[]): number {
	return rawTokensFromIndex(entries, findLastBoundIndex(entries) + 1);
}

export function rawTokensSinceLastCompaction(entries: Entry[]): number {
	return rawTokensFromIndex(entries, findLastCompactionIndex(entries) + 1);
}

export function firstRawIdAfter(entries: Entry[], afterIndex: number): string | undefined {
	for (let i = Math.max(0, afterIndex + 1); i < entries.length; i++) {
		if (RAW_TYPES.has(entries[i].type)) return entries[i].id;
	}
	return undefined;
}

export function rawMessagesBetween(entries: Entry[], fromId: string, untilId: string): Message[] {
	const fromIdx = entries.findIndex((e) => e.id === fromId);
	const untilIdx = entries.findIndex((e) => e.id === untilId);
	if (fromIdx === -1 || untilIdx === -1 || untilIdx < fromIdx) return [];

	const messages: Message[] = [];
	for (let i = fromIdx; i <= untilIdx; i++) {
		const entry = entries[i];
		if (entry.type === "message" && entry.message) {
			messages.push(entry.message as Message);
		}
	}
	return messages;
}

export function getPriorMemoryDetails(entries: Entry[]): MemoryDetails | undefined {
	const idx = findLastCompactionIndex(entries);
	if (idx === -1) return undefined;
	const details = entries[idx].details;
	return isMemoryDetails(details) ? details : undefined;
}

export function collectObservationsAfter(entries: Entry[], afterIndex: number): ObservationEntryData[] {
	const result: ObservationEntryData[] = [];
	for (let i = afterIndex + 1; i < entries.length; i++) {
		const entry = entries[i];
		if (!isObservationEntry(entry)) continue;
		if (isObservationEntryData(entry.data)) result.push(entry.data);
	}
	return result;
}

export function collectObservationsForCompaction(entries: Entry[], newFirstKeptEntryId: string, prior: MemoryDetails | undefined): ObservationEntryData[] {
	const priorCompactionIdx = findLastCompactionIndex(entries);
	const newKeptIdx = entries.findIndex((e) => e.id === newFirstKeptEntryId);
	if (newKeptIdx === -1) return [];

	const priorFirstKept = priorCompactionIdx >= 0 ? entries[priorCompactionIdx].firstKeptEntryId : undefined;
	const priorFirstKeptIdx = priorFirstKept ? entries.findIndex((e) => e.id === priorFirstKept) : -1;
	const startIdx = priorFirstKeptIdx >= 0 ? priorFirstKeptIdx : priorCompactionIdx + 1;

	const result: ObservationEntryData[] = [];

	for (let i = startIdx; i < newKeptIdx; i++) {
		const entry = entries[i];
		if (!isObservationEntry(entry)) continue;
		const data = entry.data;
		if (!isObservationEntryData(data)) continue;

		if (priorFirstKeptIdx !== -1) {
			const upToIdx = entries.findIndex((e) => e.id === data.coversUpToId);
			if (upToIdx !== -1 && upToIdx < priorFirstKeptIdx) continue;
		}

		result.push(data);
	}
	void prior;
	return result;
}

export function lastRawIdAtOrBefore(entries: Entry[], leafId: string): string | undefined {
	const leafIdx = entries.findIndex((e) => e.id === leafId);
	if (leafIdx === -1) return undefined;
	for (let i = leafIdx; i >= 0; i--) {
		if (RAW_TYPES.has(entries[i].type)) return entries[i].id;
	}
	return undefined;
}
