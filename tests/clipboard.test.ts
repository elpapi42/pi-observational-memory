import { describe, expect, it, vi } from "vitest";

import { copyTextToClipboard, getClipboardCommands, type ClipboardCommand } from "../src/clipboard.js";

describe("clipboard", () => {
	it("uses pbcopy on macOS", () => {
		expect(getClipboardCommands("darwin")).toEqual([{ command: "pbcopy", args: [] }]);
	});

	it("tries common Linux clipboard commands", () => {
		expect(getClipboardCommands("linux").map((command) => command.command)).toEqual([
			"wl-copy",
			"xclip",
			"xsel",
			"termux-clipboard-set",
		]);
	});

	it("stops after the first successful clipboard command", async () => {
		const commands: ClipboardCommand[] = [
			{ command: "first", args: [] },
			{ command: "second", args: [] },
			{ command: "third", args: [] },
		];
		const runner = vi.fn(async (command: ClipboardCommand) => command.command === "second");

		await expect(copyTextToClipboard("text", runner, commands)).resolves.toBe(true);
		expect(runner.mock.calls.map(([command]) => command.command)).toEqual(["first", "second"]);
	});

	it("returns false when all clipboard commands fail", async () => {
		const commands: ClipboardCommand[] = [
			{ command: "first", args: [] },
			{ command: "second", args: [] },
		];
		const runner = vi.fn(async () => false);

		await expect(copyTextToClipboard("text", runner, commands)).resolves.toBe(false);
		expect(runner).toHaveBeenCalledTimes(2);
	});
});
