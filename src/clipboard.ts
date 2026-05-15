import { spawn } from "node:child_process";

export interface ClipboardCommand {
	command: string;
	args: string[];
}

export type ClipboardCommandRunner = (command: ClipboardCommand, text: string) => Promise<boolean>;

export function getClipboardCommands(platform: NodeJS.Platform = process.platform): ClipboardCommand[] {
	switch (platform) {
		case "darwin":
			return [{ command: "pbcopy", args: [] }];
		case "win32":
			return [{ command: "clip", args: [] }];
		default:
			return [
				{ command: "wl-copy", args: [] },
				{ command: "xclip", args: ["-selection", "clipboard"] },
				{ command: "xsel", args: ["--clipboard", "--input"] },
				{ command: "termux-clipboard-set", args: [] },
			];
	}
}

export async function copyTextToClipboard(
	text: string,
	runner: ClipboardCommandRunner = runClipboardCommand,
	commands: ClipboardCommand[] = getClipboardCommands(),
): Promise<boolean> {
	for (const command of commands) {
		if (await runner(command, text)) return true;
	}
	return false;
}

export function runClipboardCommand(command: ClipboardCommand, text: string): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;

		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			resolve(ok);
		};

		const child = spawn(command.command, command.args, {
			stdio: ["pipe", "ignore", "ignore"],
		});

		timeout = setTimeout(() => {
			child.kill();
			finish(false);
		}, 2_000);

		child.on("error", () => finish(false));
		child.on("close", (code) => finish(code === 0));
		child.stdin.on("error", () => undefined);
		child.stdin.end(text, "utf8");
	});
}
