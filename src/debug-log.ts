import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export const DEBUG_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEBUG_LOG_RELATIVE_PATH = join("observational-memory", "debug.ndjson");

interface DebugLogContext {
	enabled: boolean;
	cwd?: string;
	runId?: string;
}

const storage = new AsyncLocalStorage<DebugLogContext>();

export function withDebugLogContext<T>(context: DebugLogContext, fn: () => T): T {
	const parent = storage.getStore();
	return storage.run({ ...parent, ...context }, fn);
}

export function isDebugLogEnabled(): boolean {
	return storage.getStore()?.enabled === true;
}

export function debugLog(event: string, data: Record<string, unknown> = {}): void {
	const context = storage.getStore();
	if (context?.enabled !== true) return;

	try {
		const path = join(getAgentDir(), DEBUG_LOG_RELATIVE_PATH);
		mkdirSync(dirname(path), { recursive: true });
		rotateIfNeeded(path);
		const payload = {
			ts: new Date().toISOString(),
			event,
			cwd: context.cwd,
			runId: context.runId,
			data,
		};
		appendFileSync(path, `${JSON.stringify(payload)}\n`, "utf-8");
	} catch {
		// Debug logging must never affect memory behavior.
	}
}

function rotateIfNeeded(path: string): void {
	if (!existsSync(path)) return;
	if (statSync(path).size < DEBUG_LOG_MAX_BYTES) return;
	const backupPath = `${path}.1`;
	if (existsSync(backupPath)) unlinkSync(backupPath);
	renameSync(path, backupPath);
}
