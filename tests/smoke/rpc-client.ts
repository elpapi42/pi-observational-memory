import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Minimal client for OMP's `--mode rpc` JSONL protocol (docs/rpc.md).
 *
 * Framing is strict newline-delimited JSON; this uses `readline` on stdout,
 * which OMP's own docs call out as *not* protocol-compliant for arbitrary
 * binary framing but is sufficient here because every RPC line OMP emits is
 * itself a complete `\n`-terminated JSON object with no embedded raw
 * newlines.
 */
export type RpcEvent = Record<string, unknown>;

export class RpcHost {
	readonly proc: ChildProcessWithoutNullStreams;
	private readonly events: RpcEvent[] = [];
	private readonly waiters: Array<{ predicate: (e: RpcEvent) => boolean; resolve: (e: RpcEvent) => void }> = [];
	private readonly stderrChunks: string[] = [];
	private nextRequestId = 0;
	private closed = false;

	constructor(piBin: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
		this.proc = spawn(piBin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		this.proc.on("exit", () => {
			this.closed = true;
		});
		this.proc.stderr.on("data", (chunk: Buffer) => this.stderrChunks.push(chunk.toString("utf8")));
		const rl = createInterface({ input: this.proc.stdout });
		rl.on("line", (line) => {
			if (!line.trim()) return;
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (!event || typeof event !== "object") return;
			const record = event as RpcEvent;
			this.events.push(record);
			for (let i = this.waiters.length - 1; i >= 0; i--) {
				if (this.waiters[i].predicate(record)) {
					const [waiter] = this.waiters.splice(i, 1);
					waiter.resolve(record);
				}
			}
		});
	}

	stderrText(): string {
		return this.stderrChunks.join("");
	}

	send(message: Record<string, unknown>): void {
		this.proc.stdin.write(`${JSON.stringify(message)}\n`);
	}

	/**
	 * Resolve with the first *future* event matching `predicate`, or reject on
	 * timeout. Deliberately ignores already-recorded history: callers invoke
	 * this immediately after `send()`, and matching stale history would let a
	 * second `compact`/`new_session`/`agent_settled` wait resolve instantly
	 * against a previous round-trip's response instead of the new one.
	 */
	async waitFor<T extends RpcEvent = RpcEvent>(
		predicate: (event: RpcEvent) => boolean,
		timeoutMs = 30_000,
		label = "event",
	): Promise<T> {
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const timer = setTimeout(() => {
			const recentTypes = this.events.slice(-20).map((event) => String(event.type)).join(", ");
			reject(new Error(`Timed out after ${timeoutMs}ms waiting for RPC ${label}. recent events: ${recentTypes}. stderr:\n${this.stderrText()}`));
		}, timeoutMs);
		const resolveWrapped = (event: RpcEvent) => {
			clearTimeout(timer);
			resolve(event as T);
		};
		this.waiters.push({ predicate, resolve: resolveWrapped });
		return promise;
	}

	/** Send a prompt and wait for the corresponding command/agent completion. */
	async promptAndSettle(text: string, timeoutMs = 30_000): Promise<{ notifications: string[] }> {
		const notifications: string[] = [];
		const startIndex = this.events.length;
		const id = `smoke-prompt-${++this.nextRequestId}`;
		this.send({ id, type: "prompt", message: text });
		await this.waitFor(
			(e) => e.type === "response" && e.command === "prompt" && e.id === id,
			timeoutMs,
			"prompt response",
		);
		if (!text.startsWith("/")) {
			await this.waitFor((e) => e.type === "agent_settled" || e.type === "agent_end", timeoutMs, "agent completion");
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 250);
		await promise;
		for (const event of this.events.slice(startIndex)) {
			if (event.type === "extension_ui_request" && event.method === "notify") {
				notifications.push(String(event.message));
			}
		}
		return { notifications };
	}

	async compact(timeoutMs = 30_000): Promise<{ summary: string; details: unknown }> {
		this.send({ type: "compact" });
		const response = await this.waitFor(
			(e) => e.type === "response" && e.command === "compact",
			timeoutMs,
			"compact response",
		);
		if (response.success !== true) {
			throw new Error(`compact RPC failed: ${JSON.stringify(response)}`);
		}
		const data = response.data as Record<string, unknown> | undefined;
		return { summary: typeof data?.summary === "string" ? data.summary : "", details: data?.details ?? null };
	}

	async newSession(timeoutMs = 30_000): Promise<void> {
		this.send({ type: "new_session" });
		await this.waitFor(
			(e) => e.type === "response" && e.command === "new_session",
			timeoutMs,
			"new_session response",
		);
	}

	async stop(): Promise<void> {
		if (this.closed) return;
		this.proc.kill("SIGTERM");
		const { promise, resolve } = Promise.withResolvers<void>();
		this.proc.once("exit", () => resolve());
		setTimeout(resolve, 3000);
		await promise;
	}
}

export function spawnRpcHost(
	piBin: string,
	extensionPaths: string[],
	env: NodeJS.ProcessEnv,
	cwd: string,
): RpcHost {
	const args = ["--mode", "rpc", "--no-session", "--no-extensions", "--model", "om-smoke/om-smoke-model"];
	for (const path of extensionPaths) args.push("--extension", path);
	return new RpcHost(piBin, args, env, cwd);
}
