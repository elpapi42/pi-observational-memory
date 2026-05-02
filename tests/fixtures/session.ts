import { OBSERVATION_CUSTOM_TYPE, type ObservationEntryData } from "../../src/types.js";

type TestEntry = {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	message?: unknown;
	content?: unknown;
	customType?: string;
	summary?: unknown;
	data?: unknown;
};

export function messageEntry(
	overrides: Partial<TestEntry> & { id: string; message: unknown },
): TestEntry {
	return {
		type: "message",
		parentId: null,
		timestamp: "2026-05-02T10:00:00.000Z",
		...overrides,
	};
}

export function observationEntry(
	overrides: Partial<TestEntry> & { id: string; data: ObservationEntryData },
): TestEntry {
	return {
		type: "custom",
		parentId: null,
		timestamp: "2026-05-02T10:01:00.000Z",
		customType: OBSERVATION_CUSTOM_TYPE,
		...overrides,
	};
}

export function customMessageEntry(
	overrides: Partial<TestEntry> & { id: string; content: unknown },
): TestEntry {
	return {
		type: "custom_message",
		parentId: null,
		timestamp: "2026-05-02T10:02:00.000Z",
		...overrides,
	};
}

export function branchSummaryEntry(
	overrides: Partial<TestEntry> & { id: string; summary: string },
): TestEntry {
	return {
		type: "branch_summary",
		parentId: null,
		timestamp: "2026-05-02T10:03:00.000Z",
		...overrides,
	};
}
