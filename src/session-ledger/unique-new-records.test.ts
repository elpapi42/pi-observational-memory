import { describe, expect, it } from "vitest";

import { uniqueNewRecords } from "./unique-new-records.js";

describe("uniqueNewRecords", () => {
	it("keeps the first new record for each id in input order", () => {
		const existing = { id: "existing", content: "Already stored" };
		const first = { id: "new-a", content: "First accepted record" };
		const duplicate = { id: "new-a", content: "Conflicting duplicate" };
		const second = { id: "new-b", content: "Second new record" };
		const records = Object.freeze([existing, first, duplicate, second]);
		const existingIds = new Set(["existing"]);

		const result = uniqueNewRecords(records, existingIds);

		expect(result).toEqual([first, second]);
		expect(result[0]).toBe(first);
		expect(records).toEqual([existing, first, duplicate, second]);
		expect([...existingIds]).toEqual(["existing"]);
	});

	it("returns no records for empty input or already stored ids", () => {
		expect(uniqueNewRecords([], [])).toEqual([]);
		expect(uniqueNewRecords([{ id: "stored" }], ["stored"])).toEqual([]);
	});
});
