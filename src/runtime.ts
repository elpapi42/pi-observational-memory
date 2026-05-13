import { type Config, DEFAULTS, loadConfig } from "./config.js";

export type ResolveResult =
	| { ok: true; model: unknown; apiKey: string; headers?: Record<string, string> }
	| { ok: false; reason: string };

type NotifyLevel = "warning" | "info" | "error";
type Notify = (message: string, type?: NotifyLevel) => void;

export interface ResolveCtx {
	model: unknown;
	modelRegistry: any;
	hasUI: boolean;
	ui?: { notify: Notify };
}

export interface LaunchCtx {
	hasUI: boolean;
	ui?: { notify: Notify };
}

export class Runtime {
	config: Config = { ...DEFAULTS };
	configLoaded = false;
	observerInFlight = false;
	observerPromise: Promise<void> | null = null;
	compactInFlight = false;
	compactHookInFlight = false;
	bypassNextCompactionHook = false;
	resolveFailureNotified = false;

	ensureConfig(cwd: string): void {
		if (this.configLoaded) return;
		this.config = loadConfig(cwd);
		this.configLoaded = true;
	}

	async resolveModel(ctx: ResolveCtx): Promise<ResolveResult> {
		let model = ctx.model;
		if (this.config.compactionModel) {
			const configured = ctx.modelRegistry.find(this.config.compactionModel.provider, this.config.compactionModel.id);
			if (configured) {
				model = configured;
			} else if (ctx.hasUI && ctx.ui) {
				ctx.ui.notify(
					`Observational memory: configured model ${this.config.compactionModel.provider}/${this.config.compactionModel.id} not found, using session model`,
					"warning",
				);
			}
		}
		if (!model) return { ok: false, reason: "no model available (session has no model and no compactionModel configured)" };
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			const provider = (model as { provider?: string }).provider ?? "unknown";
			return { ok: false, reason: `no API key for provider "${provider}"` };
		}
		return { ok: true, model, apiKey: auth.apiKey as string, headers: auth.headers as Record<string, string> | undefined };
	}

	launchObserverTask(ctx: LaunchCtx, label: string, work: () => Promise<void>): Promise<void> {
		this.observerInFlight = true;
		// Capture ctx properties synchronously — after `await work()` the extension ctx
		// may be stale (e.g. after ctx.newSession/fork/switchSession/reload), and accessing
		// ctx.hasUI or ctx.ui on a stale proxy throws.
		const hasUI = ctx.hasUI;
		const ui = ctx.ui;
		let promise!: Promise<void>;
		promise = (async () => {
			try {
				await work();
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				if (hasUI && ui) ui.notify(`Observational memory: ${label} failed: ${msg}`, "warning");
			} finally {
				this.observerInFlight = false;
				if (this.observerPromise === promise) this.observerPromise = null;
			}
		})();
		this.observerPromise = promise;
		return promise;
	}
}
