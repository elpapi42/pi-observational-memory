export type TestEntry = {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	message?: unknown;
	content?: unknown;
	customType?: string;
	summary?: unknown;
	data?: unknown;
	details?: unknown;
	firstKeptEntryId?: string;
	fromId?: string;
};

export type TestObservation = {
	id: string;
	content: string;
	timestamp: string;
	relevance: "low" | "medium" | "high" | "critical";
	sourceEntryIds: string[];
	tokenCount: number;
};

export type TestReflection = {
	id: string;
	content: string;
	supportingObservationIds: string[];
	tokenCount: number;
};

export const V3_OBSERVATIONS_RECORDED = "om.observations.recorded";
export const V3_OBSERVATIONS_NONE = "om.observations.none";
export const V3_REFLECTIONS_RECORDED = "om.reflections.recorded";
export const V3_OBSERVATIONS_DROPPED = "om.observations.dropped";
export const V3_FOLDED = "om.folded";
export const V2_OBSERVATION = "om.observation";
export const V2_DETAILS_TYPE = "observational-memory";

const DEFAULT_TIMESTAMP = "2026-05-02T10:00:00.000Z";

export function rawMessage(
	id: string,
	text: string,
	overrides: Partial<TestEntry> = {},
): TestEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		message: { role: "user", content: [{ type: "text", text }] },
		...overrides,
	};
}

export function customMessage(
	id: string,
	content: unknown,
	overrides: Partial<TestEntry> = {},
): TestEntry {
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		content,
		...overrides,
	};
}

export function textCustomMessage(
	id: string,
	text: string,
	overrides: Partial<TestEntry> = {},
): TestEntry {
	return customMessage(id, text, overrides);
}

export function branchSummary(
	id: string,
	summary: string,
	overrides: Partial<TestEntry> = {},
): TestEntry {
	return {
		type: "branch_summary",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		summary,
		...overrides,
	};
}

export function compactionEntry(
	id: string,
	args: { firstKeptEntryId?: string; details?: unknown; summary?: string } = {},
	overrides: Partial<TestEntry> = {},
): TestEntry {
	return {
		type: "compaction",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		firstKeptEntryId: args.firstKeptEntryId,
		summary: args.summary ?? "compacted memory",
		details: args.details,
		...overrides,
	};
}

export function memoryDetails(
	args: {
		fullFold?: boolean;
		observations?: TestObservation[];
		reflections?: TestReflection[];
	} = {},
): unknown {
	return {
		type: V3_FOLDED,
		version: 1,
		fullFold: args.fullFold ?? false,
		observations: args.observations ?? [],
		reflections: args.reflections ?? [],
	};
}

export function observation(
	id: string,
	overrides: Partial<TestObservation> = {},
): TestObservation {
	return {
		id,
		content: `Observation ${id}`,
		timestamp: DEFAULT_TIMESTAMP,
		relevance: "medium",
		sourceEntryIds: ["raw-1"],
		tokenCount: 10,
		...overrides,
	};
}

export function reflection(
	id: string,
	supportingObservationIds: string[] = ["obs-1"],
	overrides: Partial<TestReflection> = {},
): TestReflection {
	return {
		id,
		content: `Reflection ${id}`,
		supportingObservationIds,
		tokenCount: 5,
		...overrides,
	};
}

export function observationsRecordedEntry(
	id: string,
	args: { observations: TestObservation[]; coversUpToId: string },
	overrides: Partial<TestEntry> = {},
): TestEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		customType: V3_OBSERVATIONS_RECORDED,
		data: args,
		...overrides,
	};
}

export function reflectionsRecordedEntry(
	id: string,
	args: { reflections: TestReflection[]; coversUpToId: string },
	overrides: Partial<TestEntry> = {},
): TestEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		customType: V3_REFLECTIONS_RECORDED,
		data: args,
		...overrides,
	};
}

export function observationsDroppedEntry(
	id: string,
	args: { observationIds: string[]; coversUpToId: string },
	overrides: Partial<TestEntry> = {},
): TestEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		customType: V3_OBSERVATIONS_DROPPED,
		data: args,
		...overrides,
	};
}

export function observationsNoneEntry(
	id: string,
	args: { coversUpToId: string },
	overrides: Partial<TestEntry> = {},
): TestEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		customType: V3_OBSERVATIONS_NONE,
		data: args,
		...overrides,
	};
}

export function oldV2ObservationEntry(
	id: string,
	args: { records?: unknown[]; coversFromId?: string; coversUpToId?: string; tokenCount?: number } = {},
	overrides: Partial<TestEntry> = {},
): TestEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		customType: V2_OBSERVATION,
		data: {
			records: args.records ?? [observation("v2-obs")],
			coversFromId: args.coversFromId ?? "raw-1",
			coversUpToId: args.coversUpToId ?? "raw-1",
			tokenCount: args.tokenCount ?? 10,
		},
		...overrides,
	};
}

export function oldV2CompactionDetails(
	args: { observations?: unknown[]; reflections?: unknown[] } = {},
): unknown {
	return {
		type: V2_DETAILS_TYPE,
		version: 4,
		observations: args.observations ?? [observation("v2-obs")],
		reflections: args.reflections ?? [],
	};
}

export function fakeSessionContext(initialEntries: TestEntry[] = []) {
	let entries = [...initialEntries];
	return {
		appended: [] as Array<{ customType: string; data: unknown }>,
		sessionManager: {
			getBranch: () => entries,
			setBranch: (next: TestEntry[]) => {
				entries = next;
			},
			getLeafId: () => entries.at(-1)?.id,
		},
		appendEntry(customType: string, data: unknown) {
			this.appended.push({ customType, data });
			const entry = {
				type: "custom",
				id: `appended-${this.appended.length}`,
				parentId: entries.at(-1)?.id ?? null,
				timestamp: DEFAULT_TIMESTAMP,
				customType,
				data,
			};
			entries = [...entries, entry];
			return entry.id;
		},
	};
}

export function fakeCompactionContext(entries: TestEntry[]) {
	return {
		cwd: "/tmp/pi-observational-memory-test",
		sessionManager: {
			getBranch: () => entries,
		},
		isIdle: () => true,
		compactCalls: [] as unknown[],
		compact(arg?: unknown) {
			this.compactCalls.push(arg ?? true);
		},
	};
}
