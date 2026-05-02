import { describe, expect, it } from "vitest";

import { renderSummary } from "../src/compaction.js";
import { CONTEXT_USAGE_INSTRUCTIONS } from "../src/prompts.js";
import type { ObservationRecord } from "../src/types.js";

const observation: ObservationRecord = {
	id: "abc123def456",
	timestamp: "2026-05-02 10:30",
	relevance: "high",
	content: "User confirmed recall should use exact supporting source entry ids.",
	sourceEntryIds: ["entry-user", "entry-tool"],
};

describe("renderSummary", () => {
	it("renders compacted observations with ids for recall", () => {
		const summary = renderSummary(["User values exact source traceability."], [observation]);

		expect(summary).toContain("## Reflections\nUser values exact source traceability.");
		expect(summary).toContain(
			"## Observations\n[abc123def456] 2026-05-02 10:30 [high] User confirmed recall should use exact supporting source entry ids.",
		);
	});

	it("keeps raw source metadata out of compact summaries", () => {
		const summary = renderSummary([], [observation]);

		expect(summary).not.toContain("sourceEntryIds");
		expect(summary).not.toContain("entry-user");
		expect(summary).not.toContain("entry-tool");
	});

	it("includes concise on-demand recall guidance in compact memory instructions", () => {
		expect(CONTEXT_USAGE_INSTRUCTIONS).toContain("Observation lines include ids in brackets.");
		expect(CONTEXT_USAGE_INSTRUCTIONS).toContain("recall_observation");
		expect(CONTEXT_USAGE_INSTRUCTIONS).toContain("Do not use recall as broad search");
	});
});
