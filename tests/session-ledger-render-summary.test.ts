import { describe, expect, it } from "vitest";

import { renderSummary, renderSummaryWithBudget } from "../src/session-ledger/index.js";
import { observation, reflection } from "./fixtures/session.js";

describe("session-ledger V3 summary rendering", () => {
	it("renders empty memory as an empty summary", () => {
		expect(renderSummary([], [])).toBe("");
	});

	it("keeps compacted-memory usage instructions", () => {
		const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: "User prefers source-backed memory." });

		const summary = renderSummary([ref], []);

		expect(summary).toContain("These are condensed memories from earlier in this session.");
		expect(summary).toContain("use the recall tool");
	});

	it("renders V3 reflections with ids", () => {
		const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: "User prefers source-backed memory." });

		const summary = renderSummary([ref], []);

		expect(summary).toContain("## Reflections\n[eeeeeeeeeeee] User prefers source-backed memory.");
	});

	it("renders V3 observations with ids, timestamps, relevance, and content", () => {
		const obs = observation("aaaaaaaaaaaa", {
			content: "User confirmed recall should use exact source entry ids.",
			timestamp: "2026-05-02 10:30",
			relevance: "high",
		});

		const summary = renderSummary([], [obs]);

		expect(summary).toContain(
			"## Observations\n[aaaaaaaaaaaa] 2026-05-02 10:30 [high] User confirmed recall should use exact source entry ids.",
		);
	});

	it("keeps raw provenance metadata out of the compact summary", () => {
		const obs = observation("aaaaaaaaaaaa", { sourceEntryIds: ["entry-user", "entry-tool"] });
		const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);

		const summary = renderSummary([ref], [obs]);

		expect(summary).not.toContain("sourceEntryIds");
		expect(summary).not.toContain("supportingObservationIds");
		expect(summary).not.toContain("entry-user");
		expect(summary).not.toContain("entry-tool");
		expect(summary).not.toContain("legacy");
		expect(summary).not.toContain("[object Object]");
	});
});

describe("budgeted summary rendering", () => {
	const reflections = ["e1", "e2", "e3"].map((id, i) => reflection(id.padEnd(12, "e"), ["aaaaaaaaaaaa"], { content: `Reflection ${i + 1} ${"r".repeat(120)}` }));
	const observations = ["a1", "a2", "a3", "a4"].map((id, i) => observation(id.padEnd(12, "a"), { content: `Observation ${i + 1} ${"o".repeat(120)}` }));

	it("renders everything when no budget is given", () => {
		const rendered = renderSummaryWithBudget(reflections, observations);

		expect(rendered.reflections).toHaveLength(3);
		expect(rendered.observations).toHaveLength(4);
		expect(rendered.omittedObservations).toBe(0);
		expect(rendered.text).not.toContain("omitted");
	});

	it("keeps reflections first and the newest observations that fit", () => {
		// Instructions ~250 tokens, each line ~40 tokens: 3 reflections (~120)
		// plus 2 of 4 observations fit a 500-token budget.
		const rendered = renderSummaryWithBudget(reflections, observations, { maxTokens: 500 });

		expect(rendered.reflections).toHaveLength(3);
		expect(rendered.observations.map((obs) => obs.id)).toEqual(["a3aaaaaaaaaa", "a4aaaaaaaaaa"]);
		expect(rendered.omittedReflections).toBe(0);
		expect(rendered.omittedObservations).toBe(2);
		expect(rendered.text).toContain("(2 older observations omitted to fit the summary budget");
		expect(rendered.text).toContain("[a4aaaaaaaaaa]");
		expect(rendered.text).not.toContain("[a1aaaaaaaaaa]");
	});

	it("drops the oldest reflections when reflections alone exceed the budget", () => {
		const rendered = renderSummaryWithBudget(reflections, observations, { maxTokens: 350 });

		expect(rendered.reflections.length).toBeLessThan(3);
		expect(rendered.reflections.at(-1)?.id).toBe("e3eeeeeeeeee");
		expect(rendered.observations).toHaveLength(0);
		expect(rendered.text).toContain("older reflection");
	});

	it("ignores a non-positive budget", () => {
		expect(renderSummary(reflections, observations, { maxTokens: 0 })).toBe(renderSummary(reflections, observations));
	});
});
