import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { normalizeTimestamp, parseObservations, parseReflections, parseReflectorOutput } from "./parser.js";
import { renderObservation, renderObservations, renderReflections, PRIORITY_EMOJI } from "./renderer.js";
import { estimateObservationsTokens } from "./tokens.js";
import { isOurDetails } from "./types.js";
import type { Observation } from "./types.js";

// ─── normalizeTimestamp ───────────────────────────────────────────────────────

describe("normalizeTimestamp", () => {
	test("space-separated → ISO with Z", () => {
		assert.equal(normalizeTimestamp("2026-04-16 14:30"), "2026-04-16T14:30Z");
	});

	test("ISO with seconds → strip seconds", () => {
		assert.equal(normalizeTimestamp("2026-04-16T14:30:00Z"), "2026-04-16T14:30Z");
	});

	test("already-canonical form passes through", () => {
		assert.equal(normalizeTimestamp("2026-04-16T14:30Z"), "2026-04-16T14:30Z");
	});

	test("unrecognized string returned unchanged", () => {
		assert.equal(normalizeTimestamp("not-a-timestamp"), "not-a-timestamp");
	});

	test("partial date string returned unchanged", () => {
		assert.equal(normalizeTimestamp("2026-04-16"), "2026-04-16");
	});
});

// ─── parseObservations ───────────────────────────────────────────────────────

describe("parseObservations", () => {
	test("empty string returns empty array", () => {
		assert.deepEqual(parseObservations(""), []);
	});

	test("blank lines are skipped", () => {
		assert.deepEqual(parseObservations("   \n\n  "), []);
	});

	test("🔴 → important priority", () => {
		const result = parseObservations("- 🔴 2026-04-16T14:30Z Something important");
		assert.equal(result.length, 1);
		assert.equal(result[0].priority, "important");
		assert.equal(result[0].text, "Something important");
		assert.equal(result[0].timestamp, "2026-04-16T14:30Z");
		assert.equal(result[0].raw, undefined);
	});

	test("🟡 → maybe priority", () => {
		const result = parseObservations("- 🟡 2026-04-16T10:00Z Watch this");
		assert.equal(result[0].priority, "maybe");
	});

	test("🟢 → info priority", () => {
		const result = parseObservations("- 🟢 2026-04-16T10:00Z Just info");
		assert.equal(result[0].priority, "info");
	});

	test("✅ → completed priority", () => {
		const result = parseObservations("- ✅ 2026-04-16T10:00Z Done");
		assert.equal(result[0].priority, "completed");
	});

	test("space-separated timestamp in line: regex captures only date part as timestamp", () => {
		// OBSERVATION_LINE_RE uses \S+ for the timestamp token, so "2026-04-16 14:30"
		// splits as timestamp="2026-04-16", text="14:30 User logged out"
		const result = parseObservations("- 🟢 2026-04-16 14:30 User logged out");
		assert.equal(result[0].timestamp, "2026-04-16");
		assert.equal(result[0].text, "14:30 User logged out");
	});

	test("normalizes timestamp with seconds inline", () => {
		const result = parseObservations("- 🟡 2026-04-16T14:30:00Z Watch this");
		assert.equal(result[0].timestamp, "2026-04-16T14:30Z");
	});

	test("fallback line gets info priority with raw set", () => {
		const line = "plain unstructured text";
		const result = parseObservations(line);
		assert.equal(result.length, 1);
		assert.equal(result[0].priority, "info");
		assert.equal(result[0].text, line);
		assert.equal(result[0].raw, line);
		// timestamp is "now" — just check it's a string
		assert.equal(typeof result[0].timestamp, "string");
	});

	test("mixed valid and fallback lines", () => {
		const input = [
			"- 🔴 2026-04-16T09:00Z Valid observation",
			"fallback line",
			"- 🟢 2026-04-16T10:00Z Another valid one",
		].join("\n");
		const result = parseObservations(input);
		assert.equal(result.length, 3);
		assert.equal(result[0].priority, "important");
		assert.equal(result[1].raw, "fallback line");
		assert.equal(result[2].priority, "info");
	});

	test("multiple valid lines parsed independently", () => {
		const input = [
			"- 🔴 2026-04-16T08:00Z First",
			"- ✅ 2026-04-16T09:00Z Second",
			"- 🟡 2026-04-16T10:00Z Third",
		].join("\n");
		const result = parseObservations(input);
		assert.equal(result.length, 3);
		assert.deepEqual(
			result.map((o) => o.priority),
			["important", "completed", "maybe"],
		);
	});
});

// ─── parseReflections ────────────────────────────────────────────────────────

describe("parseReflections", () => {
	test("empty string returns empty array", () => {
		assert.deepEqual(parseReflections(""), []);
	});

	test("blank-only string returns empty array", () => {
		assert.deepEqual(parseReflections("  \n  \n"), []);
	});

	test("dash-prefixed lines have dash stripped", () => {
		assert.deepEqual(parseReflections("- First\n- Second"), ["First", "Second"]);
	});

	test("lines without dash are kept as-is", () => {
		assert.deepEqual(parseReflections("No dash here"), ["No dash here"]);
	});

	test("dash with extra space stripped correctly", () => {
		assert.deepEqual(parseReflections("-  extra space"), ["extra space"]);
	});

	test("mixed dash and non-dash lines", () => {
		assert.deepEqual(parseReflections("- With dash\nWithout dash"), ["With dash", "Without dash"]);
	});
});

// ─── parseReflectorOutput ────────────────────────────────────────────────────

describe("parseReflectorOutput", () => {
	test("empty string returns empty arrays", () => {
		const result = parseReflectorOutput("");
		assert.deepEqual(result.reflections, []);
		assert.deepEqual(result.observations, []);
	});

	test("no XML tags returns empty arrays", () => {
		const result = parseReflectorOutput("some random text without tags");
		assert.deepEqual(result.reflections, []);
		assert.deepEqual(result.observations, []);
	});

	test("parses reflections tag", () => {
		const xml = "<reflections>\n- User prefers TypeScript\n- Project uses ESM\n</reflections>";
		const result = parseReflectorOutput(xml);
		assert.deepEqual(result.reflections, ["User prefers TypeScript", "Project uses ESM"]);
		assert.deepEqual(result.observations, []);
	});

	test("parses observations tag", () => {
		const xml = "<observations>\n- 🔴 2026-04-16T14:30Z Important thing\n</observations>";
		const result = parseReflectorOutput(xml);
		assert.deepEqual(result.reflections, []);
		assert.equal(result.observations.length, 1);
		assert.equal(result.observations[0].priority, "important");
		assert.equal(result.observations[0].text, "Important thing");
	});

	test("parses both tags together", () => {
		const xml = [
			"<reflections>",
			"- Key insight",
			"</reflections>",
			"<observations>",
			"- 🟢 2026-04-16T10:00Z Minor note",
			"- ✅ 2026-04-16T11:00Z Task done",
			"</observations>",
		].join("\n");
		const result = parseReflectorOutput(xml);
		assert.deepEqual(result.reflections, ["Key insight"]);
		assert.equal(result.observations.length, 2);
		assert.equal(result.observations[0].priority, "info");
		assert.equal(result.observations[1].priority, "completed");
	});

	test("handles extra text around XML tags", () => {
		const xml = "Some preamble\n<reflections>\n- A reflection\n</reflections>\nSome trailing text";
		const result = parseReflectorOutput(xml);
		assert.deepEqual(result.reflections, ["A reflection"]);
	});
});

// ─── renderObservation ───────────────────────────────────────────────────────

describe("renderObservation", () => {
	test("important → red circle emoji", () => {
		const obs: Observation = { timestamp: "2026-04-16T14:30Z", priority: "important", text: "Test" };
		assert.equal(renderObservation(obs), "- 🔴 2026-04-16T14:30Z Test");
	});

	test("maybe → yellow circle emoji", () => {
		const obs: Observation = { timestamp: "2026-04-16T14:30Z", priority: "maybe", text: "Watch" };
		assert.equal(renderObservation(obs), "- 🟡 2026-04-16T14:30Z Watch");
	});

	test("info → green circle emoji", () => {
		const obs: Observation = { timestamp: "2026-04-16T14:30Z", priority: "info", text: "Note" };
		assert.equal(renderObservation(obs), "- 🟢 2026-04-16T14:30Z Note");
	});

	test("completed → checkmark emoji", () => {
		const obs: Observation = { timestamp: "2026-04-16T14:30Z", priority: "completed", text: "Done" };
		assert.equal(renderObservation(obs), "- ✅ 2026-04-16T14:30Z Done");
	});

	test("PRIORITY_EMOJI covers all four priorities", () => {
		assert.equal(PRIORITY_EMOJI.important, "🔴");
		assert.equal(PRIORITY_EMOJI.maybe, "🟡");
		assert.equal(PRIORITY_EMOJI.info, "🟢");
		assert.equal(PRIORITY_EMOJI.completed, "✅");
	});
});

// ─── renderObservations ──────────────────────────────────────────────────────

describe("renderObservations", () => {
	test("empty array returns empty string", () => {
		assert.equal(renderObservations([]), "");
	});

	test("single observation renders correctly", () => {
		const obs: Observation = { timestamp: "2026-04-16T10:00Z", priority: "info", text: "Single" };
		assert.equal(renderObservations([obs]), "- 🟢 2026-04-16T10:00Z Single");
	});

	test("observations are sorted by timestamp ascending", () => {
		const observations: Observation[] = [
			{ timestamp: "2026-04-16T12:00Z", priority: "info", text: "Later" },
			{ timestamp: "2026-04-16T08:00Z", priority: "important", text: "Earlier" },
			{ timestamp: "2026-04-16T10:00Z", priority: "maybe", text: "Middle" },
		];
		const result = renderObservations(observations);
		const lines = result.split("\n");
		assert.equal(lines.length, 3);
		assert.ok(lines[0].includes("Earlier"));
		assert.ok(lines[1].includes("Middle"));
		assert.ok(lines[2].includes("Later"));
	});

	test("does not mutate original array", () => {
		const observations: Observation[] = [
			{ timestamp: "2026-04-16T12:00Z", priority: "info", text: "Later" },
			{ timestamp: "2026-04-16T08:00Z", priority: "important", text: "Earlier" },
		];
		const original = [...observations];
		renderObservations(observations);
		assert.deepEqual(observations, original);
	});

	test("multiple observations joined by newlines", () => {
		const observations: Observation[] = [
			{ timestamp: "2026-04-16T08:00Z", priority: "important", text: "A" },
			{ timestamp: "2026-04-16T09:00Z", priority: "info", text: "B" },
		];
		const result = renderObservations(observations);
		assert.ok(result.includes("\n"));
		assert.equal(result.split("\n").length, 2);
	});
});

// ─── renderReflections ───────────────────────────────────────────────────────

describe("renderReflections", () => {
	test("empty array returns empty string", () => {
		assert.equal(renderReflections([]), "");
	});

	test("single reflection rendered with dash prefix", () => {
		assert.equal(renderReflections(["Key insight"]), "- Key insight");
	});

	test("multiple reflections joined by newlines with dash prefix", () => {
		assert.equal(renderReflections(["First", "Second"]), "- First\n- Second");
	});
});

// ─── estimateObservationsTokens ──────────────────────────────────────────────

describe("estimateObservationsTokens", () => {
	test("empty array returns 0", () => {
		assert.equal(estimateObservationsTokens([]), 0);
	});

	test("returns a positive integer for non-empty observations", () => {
		const obs: Observation[] = [
			{ timestamp: "2026-04-16T10:00Z", priority: "info", text: "Some text here" },
		];
		const tokens = estimateObservationsTokens(obs);
		assert.ok(typeof tokens === "number");
		assert.ok(tokens > 0);
		assert.ok(Number.isInteger(tokens));
	});

	test("more text produces more tokens", () => {
		const short: Observation[] = [
			{ timestamp: "2026-04-16T10:00Z", priority: "info", text: "Short" },
		];
		const long: Observation[] = [
			{ timestamp: "2026-04-16T10:00Z", priority: "info", text: "A".repeat(200) },
		];
		assert.ok(estimateObservationsTokens(long) > estimateObservationsTokens(short));
	});

	test("token count is roughly text-length divided by 4", () => {
		const obs: Observation[] = [
			{ timestamp: "2026-04-16T10:00Z", priority: "important", text: "Hello world" },
		];
		const rendered = renderObservations(obs);
		const expectedTokens = Math.ceil(rendered.length / 4);
		assert.equal(estimateObservationsTokens(obs), expectedTokens);
	});
});

// ─── isOurDetails ────────────────────────────────────────────────────────────

describe("isOurDetails", () => {
	test("valid object returns true", () => {
		assert.ok(
			isOurDetails({ type: "observational-memory", observations: [], reflections: [] }),
		);
	});

	test("null returns false", () => {
		assert.ok(!isOurDetails(null));
	});

	test("undefined returns false", () => {
		assert.ok(!isOurDetails(undefined));
	});

	test("wrong type field returns false", () => {
		assert.ok(!isOurDetails({ type: "wrong", observations: [], reflections: [] }));
	});

	test("missing observations returns false", () => {
		assert.ok(!isOurDetails({ type: "observational-memory", reflections: [] }));
	});

	test("missing reflections returns false", () => {
		assert.ok(!isOurDetails({ type: "observational-memory", observations: [] }));
	});

	test("observations not an array returns false", () => {
		assert.ok(!isOurDetails({ type: "observational-memory", observations: "not-array", reflections: [] }));
	});

	test("reflections not an array returns false", () => {
		assert.ok(!isOurDetails({ type: "observational-memory", observations: [], reflections: "not-array" }));
	});

	test("empty object returns false", () => {
		assert.ok(!isOurDetails({}));
	});

	test("primitive returns false", () => {
		assert.ok(!isOurDetails(42));
	});
});
