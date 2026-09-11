import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

interface Waiter {
	predicate: (output: string) => boolean;
	resolve: (output: string) => void;
	reject: (error: Error) => void;
}


/**
 * Minimal PTY client for a real OMP TUI process.
 *
 * The smoke suite has no native-pty dependency. `tui-pty.py` allocates a
 * controlling pseudo-terminal with Python's standard `pty` module, while this
 * client drives the TUI through its stdin and matches stable notification text.
 */
export class TuiHost {
	readonly proc: ChildProcessWithoutNullStreams;
	private output = "";
	private closed = false;
	private readonly waiters: Waiter[] = [];
	private readonly stderrChunks: string[] = [];

	constructor(ptyProxyPath: string, ompBin: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
		this.proc = spawn("python3", [ptyProxyPath, ompBin, ...args], {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc.stdout.on("data", (chunk: Buffer) => {
			this.output += chunk.toString("utf8");
			for (let i = this.waiters.length - 1; i >= 0; i--) {
				const waiter = this.waiters[i];
				if (!waiter.predicate(this.output)) continue;
				this.waiters.splice(i, 1);
				waiter.resolve(this.output);
			}
		});
		this.proc.stderr.on("data", (chunk: Buffer) => this.stderrChunks.push(chunk.toString("utf8")));
		this.proc.on("exit", () => {
			this.closed = true;
			const error = new Error(`OMP TUI exited before the expected output. stderr:\n${this.stderrText()}`);
			for (const waiter of this.waiters.splice(0)) waiter.reject(error);
		});
	}

	stderrText(): string {
		return this.stderrChunks.join("");
	}

	async waitFor(predicate: (output: string) => boolean, timeoutMs = 30_000, label = "TUI output"): Promise<string> {
		if (predicate(this.output)) return this.output;
		if (this.closed) throw new Error(`OMP TUI exited while waiting for ${label}. stderr:\n${this.stderrText()}`);
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		let timer: NodeJS.Timeout;
		const waiter: Waiter = {
			predicate,
			resolve: (output) => {
				clearTimeout(timer);
				resolve(output);
			},
			reject: (error) => {
				clearTimeout(timer);
				reject(error);
			},
		};
		timer = setTimeout(() => {
			const index = this.waiters.indexOf(waiter);
			if (index >= 0) this.waiters.splice(index, 1);
			const tail = this.output.slice(-4_000);
			reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${label}. output tail:\n${tail}\nstderr:\n${this.stderrText()}`));
		}, timeoutMs);
		this.waiters.push(waiter);
		return promise;
	}

	has(text: string): boolean {
		return this.output.includes(text);
	}
	outputLength(): number {
		return this.output.length;
	}

	async waitForAfter(
		offset: number,
		predicate: (output: string) => boolean,
		timeoutMs = 30_000,
		label = "new TUI output",
	): Promise<string> {
		return this.waitFor(
			(output) => output.length > offset && predicate(output.slice(offset)),
			timeoutMs,
			label,
		);
	}

	send(text: string): void {
		this.proc.stdin.write(`${text}\r`);
	}

	async stop(): Promise<void> {
		if (this.closed) return;
		this.proc.kill("SIGTERM");
		const { promise, resolve } = Promise.withResolvers<void>();
		this.proc.once("exit", () => resolve());
		setTimeout(resolve, 3_000);
		await promise;
	}
}

export function spawnTuiHost(
	ptyProxyPath: string,
	ompBin: string,
	extensionPaths: string[],
	env: NodeJS.ProcessEnv,
	cwd: string,
): TuiHost {
	const args = ["--no-session", "--no-extensions", "--model", "om-smoke/om-smoke-model"];
	for (const path of extensionPaths) args.push("--extension", path);
	return new TuiHost(ptyProxyPath, ompBin, args, env, cwd);
}
