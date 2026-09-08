import { type Config, DEFAULTS, loadConfig } from "./config.js";
import { debugLog } from "./debug-log.js";

export type ResolveResult =
	| { ok: true; model: unknown; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string>; baseUrl?: string }
	| { ok: false; reason: string };

/**
 * Mirrors pi's own request-auth acceptance rule (`AgentSession._getRequiredRequestAuth`):
 * resolved auth is usable when it carries an apiKey OR at least one header value.
 * OAuth providers (kimi-coding, xai, openai-codex, anthropic OAuth, …) authenticate via
 * `toAuth()` returning `{ headers: { Authorization: "Bearer …" } }` with no apiKey, and
 * pi-ai providers accept a caller-supplied Authorization header in place of an apiKey.
 *
 * NOTE: a `false` result does NOT mean "unauthenticated" — see `resolveModel`. Providers
 * that authenticate at request time (Amazon Bedrock SigV4 from AWS_PROFILE/SSO, Google
 * Vertex ADC) legitimately expose neither an apiKey nor a header, because pi signs their
 * requests itself.
 */
function hasUsableAuth(auth: { apiKey?: unknown; headers?: unknown }): boolean {
	if (typeof auth.apiKey === "string" && auth.apiKey.length > 0) return true;
	return countUsableHeaders(auth.headers) > 0;
}

/** How many headers the auth payload carries at all (diagnostics only, never values). */
function countHeaders(headers: unknown): number {
	return headers && typeof headers === "object" ? Object.keys(headers as Record<string, unknown>).length : 0;
}

/** How many headers carry a non-empty string value — the ones pi could actually send. */
function countUsableHeaders(headers: unknown): number {
	if (!headers || typeof headers !== "object") return 0;
	return Object.values(headers as Record<string, unknown>).filter(
		(value) => typeof value === "string" && value.length > 0,
	).length;
}

/**
 * How long to wait for the availability re-check in `recheckProviderCredential`, and how
 * long before the same provider may be re-checked again.
 *
 * The re-check is network-free and measured at ~1ms on a warm Bedrock/SSO host, but
 * `checkAuth` can block on a provider's own credential resolution, so it is bounded. The
 * re-arm interval keeps an unauthenticated host from paying the cost on every
 * consolidation while still recovering within a session when credentials are renewed out
 * of band (`aws sso login` in another terminal, `gcloud auth application-default login`).
 */
const AVAILABILITY_RECHECK_TIMEOUT_MS = 5_000;
const AVAILABILITY_RECHECK_REARM_MS = 60_000;

type NotifyLevel = "warning" | "info" | "error";
type Notify = (message: string, type?: NotifyLevel) => void;
export type ConsolidationPhase = "observer" | "reflector" | "dropper";

/**
 * Whether pi positively reports a working credential source for this model's provider.
 *
 * `ModelRegistry.hasConfiguredAuth(model)` is true when pi's availability check
 * (`ModelRuntime.checkAuth`) resolved *something* for the provider — an API key, a
 * stored credential, or an ambient source such as `AWS_PROFILE` / `AWS_ACCESS_KEY_ID`
 * / gcloud ADC. Combined with `auth.ok === true` and an auth payload that carries
 * nothing, that is the signature of a provider pi signs at request time:
 *
 *   pi has a credential source, and deliberately hands the caller nothing to attach.
 *
 * Measured on a Bedrock/SSO host (pi 0.84.2), with `AWS_PROFILE` exported:
 *   checkAuth("amazon-bedrock") -> { source: "AWS_PROFILE", type: "api_key" }
 *   hasConfiguredAuth(model)    -> true
 *   getApiKeyAndHeaders(model)  -> { ok: true, apiKey: undefined, headers: undefined }
 * `googleVertexProvider`'s ADC branch returns the same empty-auth resolution.
 *
 * The inverse case — `hasConfiguredAuth === false` with an empty auth payload — is a
 * provider pi could not authenticate at all (no key, no ambient source). That must
 * keep failing: it is the ordinary "not logged in" state, not ambient auth.
 *
 * Defensive: older pi versions and partial test doubles may not expose this, and an
 * unknown answer must not be read as "authenticated".
 */
function hasConfiguredProviderCredential(registry: unknown, model: unknown): boolean {
	try {
		return (registry as { hasConfiguredAuth?: (m: unknown) => unknown }).hasConfiguredAuth?.(model) === true;
	} catch {
		return false;
	}
}

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
	consolidationInFlight = false;
	consolidationPromise: Promise<void> | null = null;
	consolidationPhase: ConsolidationPhase | undefined;
	compactInFlight = false;
	compactHookInFlight = false;
	resolveFailureNotified = false;
	lastObserverError: string | undefined;
	lastReflectorError: string | undefined;
	lastDropperError: string | undefined;
	/** provider -> epoch ms of the last availability re-check (see `recheckProviderCredential`). */
	availabilityRecheckedAt = new Map<string, number>();
	/** Deliberate-empty backoff (#23): skip observer re-fires over the same span until enough new tokens arrive. */
	observerEmptyBackoff: {
		sessionIdentity: string | undefined;
		coverageId: string | undefined;
		tokensAtEmpty: number;
	} | undefined;

	ensureConfig(cwd: string): void {
		if (this.configLoaded) return;
		this.config = loadConfig(cwd);
		this.configLoaded = true;
	}

	async resolveModel(ctx: ResolveCtx): Promise<ResolveResult> {
		let model = ctx.model;
		if (this.config.model) {
			const configured = ctx.modelRegistry.find(this.config.model.provider, this.config.model.id);
			if (configured) {
				model = configured;
			} else if (ctx.hasUI && ctx.ui) {
				ctx.ui.notify(
					`Observational memory: configured model ${this.config.model.provider}/${this.config.model.id} not found, using session model`,
					"warning",
				);
			}
		}
		if (!model) return { ok: false, reason: "no model available (session has no model and no observational-memory model configured)" };
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		const provider = (model as { provider?: string }).provider ?? "unknown";
		const isOAuth = ctx.modelRegistry.isUsingOAuth?.(model) === true;
		// `auth.ok === false` is the only unambiguous failure: pi returns it when a
		// provider requires a request auth header and no credential resolved.
		//
		// `auth.ok === true` with neither apiKey nor headers, for a provider pi DOES
		// report a credential source for, is not a failure — it is how pi describes a
		// provider that authenticates at request time: Amazon Bedrock signing SigV4 from
		// ambient AWS credentials (`bedrockAuth.resolve` returns `{ auth: {}, source:
		// "AWS_PROFILE" }`), Google Vertex using ADC (same empty resolution). pi's own
		// native streaming path forwards no apiKey either, and its pre-prompt gate is
		// merely `hasConfiguredAuth(provider) || checkAuth(provider) !== undefined` —
		// om's pre-flight check must not be stricter than pi's own. Treating it as "no
		// auth" aborted consolidation before the model was ever called, disabling
		// observational memory silently — no error, no cost, no latency — on such hosts.
		//
		// Three cases deliberately keep failing: OAuth providers, where an empty
		// resolution means the credentials no longer resolve and the user must log in
		// again; a credential that resolved to an empty *string* key, which is a
		// misconfiguration rather than ambient auth; and a provider pi reports no
		// credential source for at all, which is simply unauthenticated.
		const usable = hasUsableAuth(auth);
		const resolvedEmptyApiKey = typeof auth.apiKey === "string" && auth.apiKey.length === 0;
		let providerCredentialConfigured = hasConfiguredProviderCredential(ctx.modelRegistry, model);
		// pi's gate has TWO halves and never trusts the snapshot alone (agent-session.js):
		//
		//   hasConfiguredAuth(provider) || (await checkAuth(provider)) !== undefined
		//
		// `hasConfiguredAuth` reads `snapshot.configuredProviders`, which is populated by an
		// availability pass — and left untouched when that pass is skipped
		// (`refreshOnCreate: false`), aborted, or FAILS (its catch records `availabilityError`
		// and returns). A provider whose credential could not be checked at startup — an
		// expired SSO token, say — is therefore absent from the snapshot for the rest of the
		// session, even after the user renews it out of band. pi recovers on the next turn
		// because its second half re-checks live; reading only the snapshot half would leave
		// consolidation dead for the whole session, which is the same silent-failure class as
		// the bug this gate was fixed for.
		//
		// The facade exposes no `checkAuth`, but `refresh({ providers })` performs the same
		// live check and then updates the snapshot, so re-reading afterwards is equivalent.
		// Only attempted when everything else already looks like the ambient shape, so an
		// ordinary unauthenticated provider still fails on the first call.
		if (auth.ok === true && !usable && !isOAuth && !resolvedEmptyApiKey && !providerCredentialConfigured) {
			providerCredentialConfigured = await this.recheckProviderCredential(ctx.modelRegistry, model, provider);
		}
		const signsAtRequestTime =
			auth.ok === true && !isOAuth && !resolvedEmptyApiKey && providerCredentialConfigured;
		if (!auth.ok || (!usable && !signsAtRequestTime)) {
			const reason = isOAuth
				? `authentication failed for provider "${provider}" — OAuth credentials may have expired; run '/login ${provider}' to re-authenticate`
				: `no API key or auth headers for provider "${provider}"`;
			// The reason string alone cannot tell `ok: false` from `ok: true` with nothing to
			// carry, which is what made the ambient-credential outage un-diagnosable from the
			// debug log. Record the decision inputs — booleans and counts only, never values.
			debugLog("resolve.rejected", {
				provider,
				reason,
				authOk: auth.ok === true,
				hasApiKey: typeof auth.apiKey === "string" && auth.apiKey.length > 0,
				resolvedEmptyApiKey,
				headerCount: countHeaders(auth.headers),
				usableHeaderCount: countUsableHeaders(auth.headers),
				isOAuth,
				providerCredentialConfigured,
				signsAtRequestTime,
			});
			return { ok: false, reason };
		}
		if (!usable) {
			debugLog("resolve.request_time_signing", { provider, providerCredentialConfigured });
		}
		// Match pi's request model: OAuth may route to an account-specific endpoint
		// (e.g. Copilot Business). Do not mutate the shared session/registry model.
		const requestModel = auth.baseUrl ? { ...(model as object), baseUrl: auth.baseUrl } : model;
		return {
			ok: true,
			model: requestModel,
			apiKey: auth.apiKey as string | undefined,
			headers: auth.headers as Record<string, string> | undefined,
			env: auth.env as Record<string, string> | undefined,
			baseUrl: auth.baseUrl as string | undefined,
		};
	}

	/**
	 * Re-check one provider's credential live, then re-read pi's snapshot.
	 *
	 * Implements the second half of pi's own auth gate for the only case that needs it: an
	 * otherwise-ambient-looking resolution whose provider is missing from a stale or never
	 * populated availability snapshot. Bounded and rate-limited; never throws.
	 */
	private async recheckProviderCredential(registry: unknown, model: unknown, provider: string): Promise<boolean> {
		const last = this.availabilityRecheckedAt.get(provider);
		const now = Date.now();
		if (last !== undefined && now - last < AVAILABILITY_RECHECK_REARM_MS) return false;
		this.availabilityRecheckedAt.set(provider, now);

		const refresh = (registry as { refresh?: (options?: unknown) => Promise<unknown> }).refresh;
		if (typeof refresh !== "function") {
			debugLog("resolve.availability_recheck", { provider, refreshed: false, reason: "registry exposes no refresh()" });
			return false;
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), AVAILABILITY_RECHECK_TIMEOUT_MS);
		let refreshError: string | undefined;
		let timedOut = false;
		try {
			// allowNetwork:false — a credential re-check must not wait on a model-catalog fetch.
			// providers:[provider] — scope the work, and the snapshot writes, to the one provider.
			//
			// Both are honoured from pi 0.84; on pi 0.81 the facade is `refresh()` with no
			// parameters, delegating to `runtime.reloadConfig()`, which reloads models.json and
			// then runs a FULL, network-permitted availability pass. Passing the options is
			// harmless there, but the work is wider and slower — hence the race below rather
			// than relying on the abort signal, which that version never sees.
			await Promise.race([
				refresh.call(registry, { allowNetwork: false, providers: [provider], signal: controller.signal }),
				new Promise<void>((resolve) => {
					controller.signal.addEventListener("abort", () => {
						timedOut = true;
						resolve();
					});
				}),
			]);
		} catch (error) {
			refreshError = error instanceof Error ? error.message : String(error);
		} finally {
			clearTimeout(timer);
		}

		// Re-read even when the refresh reported an error or timed out: a scoped pass can
		// update the snapshot for this provider and still fail elsewhere.
		const recovered = hasConfiguredProviderCredential(registry, model);
		debugLog("resolve.availability_recheck", {
			provider,
			refreshed: refreshError === undefined && !timedOut,
			recovered,
			elapsedMs: Date.now() - now,
			timedOut,
			...(refreshError === undefined ? {} : { refreshError }),
		});
		return recovered;
	}

	launchConsolidationTask(ctx: LaunchCtx, work: () => Promise<void>): Promise<void> {
		this.consolidationInFlight = true;
		this.consolidationPhase = undefined;
		this.lastObserverError = undefined;
		this.lastReflectorError = undefined;
		this.lastDropperError = undefined;
		const promise = this.launchTrackedTask(ctx, "consolidation", work, () => {
			this.consolidationInFlight = false;
			this.consolidationPhase = undefined;
			if (this.consolidationPromise === promise) this.consolidationPromise = null;
		});
		this.consolidationPromise = promise;
		return promise;
	}

	recordConsolidationStageError(ctx: LaunchCtx, phase: ConsolidationPhase, error: unknown): string {
		const message = error instanceof Error ? error.message : String(error);
		if (phase === "observer") this.lastObserverError = message;
		if (phase === "reflector") this.lastReflectorError = message;
		if (phase === "dropper") this.lastDropperError = message;
		if (ctx.hasUI && ctx.ui) ctx.ui.notify(`Observational memory: ${phase} failed: ${message}`, "warning");
		return message;
	}

	private launchTrackedTask(
		ctx: LaunchCtx,
		label: string,
		work: () => Promise<void>,
		onFinally: (error: string | undefined) => void,
	): Promise<void> {
		const hasUI = ctx.hasUI;
		const ui = ctx.ui;
		return (async () => {
			let errorMessage: string | undefined;
			try {
				await work();
			} catch (error) {
				errorMessage = error instanceof Error ? error.message : String(error);
				if (hasUI && ui) ui.notify(`Observational memory: ${label} failed: ${errorMessage}`, "warning");
			} finally {
				onFinally(errorMessage);
			}
		})();
	}
}
