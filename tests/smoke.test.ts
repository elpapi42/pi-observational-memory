import { describe, expect, it } from "vitest";

import { OBSERVATION_CUSTOM_TYPE, isObservationEntryData } from "../src/types.js";
import { observationEntry } from "./fixtures/session.js";

describe("test harness", () => {
	it("runs TypeScript ESM tests against source files", () => {
		const data = {
			records: [
				{
					id: "abc123def456",
					content: "User confirmed exact source ids are required.",
					timestamp: "2026-05-02 10:00",
					relevance: "high",
				},
			],
			coversFromId: "entry-a",
			coversUpToId: "entry-b",
			tokenCount: 12,
		};

		expect(isObservationEntryData(data)).toBe(true);
		expect(observationEntry({ id: "obs-entry", data }).customType).toBe(OBSERVATION_CUSTOM_TYPE);
	});
});
