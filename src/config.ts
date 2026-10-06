import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ConfiguredModel {
	provider: string;
	id: string;
	thinking?: ModelThinkingLevel;
}

/**
 * The two ways a token threshold can be expressed.
 *
 * - `"calibrated"` (default): use the static token value directly.
 *   Backwards-compatible with all existing V3 configs.
 *
 * - `"ratio"`: compute the effective threshold as
 *   `floor(model.contextWindow * value)`. This auto-scales the trigger to the
 *   active model's context window, so a 1M context model is not preempted at
 *   the same absolute threshold as a 128K model.
 *
 *   Some models advertise a large context window but lose attention at long
 *   range; users can lower the ratio to fire earlier on such models without
 *   giving up the window on models that stay sharp.
 *
 *   When the active model's `contextWindow` is unavailable (undefined, 0, or
 *   negative), ratio mode falls back to the corresponding default token value
 *   so the trigger still fires safely.
 *
 * The union is deliberately discriminated on `type` so adding a new strategy
 * is a compile-time exhaustive check at every `switch` over it.
 */
export type TokenThresholdType = "calibrated" | "ratio";

export type TokenThreshold =
	| { type: "calibrated"; value: number }
	| { type: "ratio"; value: number };

/** Legacy flat settings keys, still parsed for backwards compatibility. */
export interface LegacyCompactThresholdSettings {
	compactAfterTokensMode?: TokenThresholdType;
	compactAfterTokensRatio?: number;
}

/** The memory-worker stages, each resolved independently. */
export type MemoryStage = "observer" | "reflector" | "reflection-dropper" | "dropper";

export const MEMORY_STAGE_VALUES: readonly MemoryStage[] = ["observer", "reflector", "reflection-dropper", "dropper"] as const;

/**
 * A glob-matched routing rule for the memory-worker model.
 *
 * `match` is a glob (`*` and `?` wildcards) tested against the active session
 * model's `"<provider>/<id>"` key. The first entry in `modelMap` whose
 * `match` matches wins; if none match, `model` (or the session model) is used.
 * `match` never carries a thinking-level predicate: worker thinking is chosen
 * by the `model` field.
 *
 * `stages` narrows an entry to specific stages, so cheap extraction work and
 * expensive distillation can route to different models. Omit it to apply the
 * entry to every stage.
 *
 * `model` is `"<provider>/<id>[:<thinking>]"` and may use substitutions drawn
 * from the active session model: `$provider`, `$id`, `$model` (the full
 * `<provider>/<id>`), and `$thinking` (the session thinking level). The
 * thinking suffix is the last `:`-delimited segment and only counts when it is
 * a valid level, so ids containing colons are preserved.
 */
export interface ModelMapEntry {
	match: string;
	stages?: MemoryStage[];
	model: string;
}

/**
 * A glob-matched warning rule.
 *
 * `match` is tested against the active session model's `"<provider>/<id>"`
 * key, optionally with a trailing `":<thinking>"` predicate, for example
 * `"anthropic/claude-opus-*:high"`. The first matching rule wins; when none
 * match, no warnings are emitted. Use `"*"` as a catch-all default.
 */
export interface WarnAtRule {
	match: string;
	warnAt: (number | TokenThreshold)[];
}

/**
 * Lets the agent compact its own context through the `compact_context` tool.
 * `warnAt` thresholds resolve against the active model's context window and
 * are compared with Pi's live context usage, not source-entry estimates.
 */
export interface SelfCompactConfig {
	enabled: boolean;
	warnAt: WarnAtRule[];
}

/**
 * Local semantic ranking for `recall` queries. The model runs in-process
 * through transformers.js; weights download once into Pi's agent directory.
 * `pooling` and `queryPrefix` must match the model's training recipe.
 */
export interface RecallEmbeddingsConfig {
	enabled: boolean;
	model: string;
	pooling: "cls" | "mean";
	queryPrefix: string;
}

export const RECALL_EMBEDDINGS_DEFAULTS: Readonly<RecallEmbeddingsConfig> = {
	enabled: false,
	model: "Xenova/bge-small-en-v1.5",
	pooling: "cls",
	queryPrefix: "Represent this sentence for searching relevant passages: ",
};

/**
 * Routes the dropper stage to a System One decision endpoint (TypeSafe's Jev,
 * or any server implementing `POST /v1/systemone`) instead of the tool-calling
 * LLM dropper.
 *
 * The endpoint scores each active observation with typed questions and returns
 * calibrated probabilities; `vetoThreshold` and `dropThreshold` turn those into
 * a ranked candidate list, which still passes through the same budget and
 * tie-break selection the LLM dropper uses.
 */
/**
 * - `off`: the block is inert; the LLM dropper decides.
 * - `shadow`: the endpoint scores every observation but the LLM dropper still
 *   decides. Both are written to the drop-score log, which pairs each score
 *   with the LLM's verdict so a calibration map can be fitted from them.
 * - `primary`: the endpoint decides.
 */
export const SYSTEM_ONE_MODES = ["off", "shadow", "primary"] as const;
export type SystemOneMode = (typeof SYSTEM_ONE_MODES)[number];

export interface SystemOneDropperConfig {
	mode: SystemOneMode;
	/** Classifier provider registered by another extension. Defaults to pi-jev's. */
	provider: string;
	/** Classifier model id within the provider; defaults to the provider's only model. */
	model?: string;
	/**
	 * Keep the observation when P(uniquely carries a preservation-floor item)
	 * reaches this. Deliberately low: losing a user constraint costs far more
	 * than keeping one redundant line.
	 */
	vetoThreshold: number;
	/** Minimum P(safe to drop) before an observation becomes a candidate. */
	dropThreshold: number;
	/**
	 * Questions per request. The API budget is 64k for state plus all questions,
	 * so large pools fan out across several requests against the same state.
	 */
	maxQuestionsPerRequest: number;
	requestTimeoutMs: number;
}

export const SYSTEM_ONE_DROPPER_DEFAULTS: Readonly<SystemOneDropperConfig> = {
	// Scoring without deciding is the safe default: it produces calibration data
	// without changing any drop.
	mode: "shadow",
	provider: "local-jev",
	vetoThreshold: 0.15,
	dropThreshold: 0.75,
	maxQuestionsPerRequest: 250,
	requestTimeoutMs: 60_000,
};

export interface Config {
	observeAfterTokens: number | TokenThreshold;
	reflectAfterTokens: number | TokenThreshold;
	/**
	 * Maximum estimated source tokens serialized into a single observer chunk.
	 * Unset (default) derives the cap from the resolved memory model's context
	 * window; see {@link resolveObserverChunkMaxTokens}.
	 */
	observerChunkMaxTokens?: number;
	compactAfterTokens: number | TokenThreshold;
	observationsPoolMaxTokens: number;
	observationsPoolTargetTokens: number;
	/** Active reflection-token budget maintained by the reflection dropper. */
	reflectionsPoolTargetTokens: number;
	agentMaxTurns: number;
	/**
	 * Maximum output tokens requested for background memory-agent loops
	 * (observer/reflector/dropper). Always clamped to the model's own
	 * `maxTokens` when available. Lower it for local servers with a modest
	 * context window, where concurrent sub-agent requests share KV with the
	 * main session and the default 32K response budget can overflow the slot.
	 */
	agentMaxTokens: number;
	model?: ConfiguredModel;
	/**
	 * Optional model the memory workers fall back to.
	 *
	 * Tried in two places:
	 * - Resolution: when the primary memory model (this `model` when set,
	 *   otherwise the session model) cannot be resolved — absent from Pi's
	 *   registry, or carrying no usable credentials.
	 * - Runtime: when a worker stage (observer/reflector/dropper) fails its
	 *   model call, that one stage is retried once with this model.
	 *
	 * Once the fallback resolves, it is reused for the rest of the consolidation
	 * pass so later stages do not re-pay a known-broken primary. A configured
	 * fallback that also fails leaves the existing skip/fail-safe behavior intact.
	 */
	fallbackModel?: ConfiguredModel;
	showWorkerNotifications: boolean;
	modelMap: ModelMapEntry[];
	selfCompact: SelfCompactConfig;
	recallEmbeddings: RecallEmbeddingsConfig;
	/** Unset leaves the dropper on the tool-calling LLM path. */
	systemOneDropper?: SystemOneDropperConfig;
	passive: boolean;
	debugLog: boolean;
}

/**
 * Numeric fallbacks used when a `"ratio"` threshold cannot be resolved against
 * a model context window. Also the source of the plain-number defaults.
 */
const THRESHOLD_FALLBACKS = {
	observeAfterTokens: 10_000,
	reflectAfterTokens: 20_000,
	compactAfterTokens: 81_000,
} as const;

export const DEFAULTS: Config = {
	observeAfterTokens: THRESHOLD_FALLBACKS.observeAfterTokens,
	reflectAfterTokens: THRESHOLD_FALLBACKS.reflectAfterTokens,
	compactAfterTokens: THRESHOLD_FALLBACKS.compactAfterTokens,
	observationsPoolMaxTokens: 20_000,
	observationsPoolTargetTokens: 10_000,
	reflectionsPoolTargetTokens: 8_000,
	agentMaxTurns: 16,
	agentMaxTokens: 32_000,
	showWorkerNotifications: true,
	modelMap: [],
	selfCompact: { enabled: false, warnAt: [] },
	recallEmbeddings: { ...RECALL_EMBEDDINGS_DEFAULTS },
	passive: false,
	debugLog: false,
};

export const TOKEN_THRESHOLD_TYPE_VALUES: readonly TokenThresholdType[] = ["calibrated", "ratio"] as const;

function isTokenThresholdType(value: unknown): value is TokenThresholdType {
	return typeof value === "string" && (TOKEN_THRESHOLD_TYPE_VALUES as readonly string[]).includes(value);
}

/**
 * Resolve a threshold spec against the active model's context window.
 *
 * Plain numbers pass through unchanged. In `"calibrated"` form the value is
 * used directly; in `"ratio"` form it is `floor(contextWindow * value)`
 * (clamped to a minimum of 1) when `contextWindow` is a positive number, and
 * `fallback` otherwise. Exhaustive over the {@link TokenThreshold} union:
 * adding a variant fails to compile here until handled.
 */
export function resolveTokenThreshold(
	spec: number | TokenThreshold,
	contextWindow: number | undefined,
	fallback: number,
): number {
	if (typeof spec === "number") return spec;
	switch (spec.type) {
		case "calibrated":
			return spec.value;
		case "ratio":
			if (typeof contextWindow === "number" && contextWindow > 0) {
				return Math.max(1, Math.floor(contextWindow * spec.value));
			}
			return fallback;
	}
}

function resolveConfigThreshold(
	spec: number | TokenThreshold,
	contextWindow: number | undefined,
	defaultFallback: number,
): number {
	const fallback = typeof spec === "number" ? spec : defaultFallback;
	return resolveTokenThreshold(spec, contextWindow, fallback);
}

/** Effective observation-run threshold for the given config and model window. */
export function resolveObserveAfterTokens(config: Config, contextWindow: number | undefined): number {
	return resolveConfigThreshold(config.observeAfterTokens, contextWindow, THRESHOLD_FALLBACKS.observeAfterTokens);
}

/** Effective reflection-run threshold for the given config and model window. */
export function resolveReflectAfterTokens(config: Config, contextWindow: number | undefined): number {
	return resolveConfigThreshold(config.reflectAfterTokens, contextWindow, THRESHOLD_FALLBACKS.reflectAfterTokens);
}

/**
 * Resolve the effective proactive-compaction token threshold for the given
 * config and active model context window.
 *
 * See {@link resolveTokenThreshold}; falls back to the default
 * `compactAfterTokens` when a ratio cannot be resolved against a window.
 */
export function resolveCompactAfterTokens(config: Config, contextWindow: number | undefined): number {
	return resolveConfigThreshold(config.compactAfterTokens, contextWindow, THRESHOLD_FALLBACKS.compactAfterTokens);
}

/**
 * Select the warning thresholds for the active session model.
 *
 * `selfCompact.warnAt` is a first-match-wins rule list. A rule's `match` is a
 * glob over `"<provider>/<id>"` with an optional trailing `":<thinking>"`
 * predicate. When no rule matches, no warnings are emitted, so a `"*"` rule is
 * the explicit global default.
 */
export function resolveWarnAt(
	config: Config,
	activeModel: unknown,
	sessionThinking?: ModelThinkingLevel,
): (number | TokenThreshold)[] {
	const key = activeModelKey(activeModel);
	if (!key) return [];
	for (const rule of config.selfCompact.warnAt) {
		const selector = parseMatchSelector(rule.match);
		if (selector.thinking !== undefined && selector.thinking !== sessionThinking) continue;
		if (globToRegExp(selector.glob).test(key)) return rule.warnAt;
	}
	return [];
}

export const THINKING_LEVEL_VALUES: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Observer chunk cap used when no config is set and the model's context window is unknown. */
export const OBSERVER_CHUNK_FALLBACK_MAX_TOKENS = 60_000;

/** Smallest useful observer chunk: enough for labels, omission markers, and source context. */
export const OBSERVER_CHUNK_MIN_TOKENS = 256;

/**
 * Fraction of the memory model's context window used for the derived observer
 * chunk cap. Chunk sizes are estimated at ~4 chars/token, which can undercount
 * real tokens by up to ~4x on non-ASCII content, so 0.2 keeps even the worst
 * case at ~80% of the window with room left for the system prompt, prior
 * memory, and the response.
 */
export const OBSERVER_CHUNK_CONTEXT_RATIO = 0.2;

/**
 * Resolve the maximum estimated tokens the observer serializes into one chunk.
 *
 * An explicit `observerChunkMaxTokens` config value always wins. Otherwise the
 * cap is `floor(contextWindow * OBSERVER_CHUNK_CONTEXT_RATIO)` for the resolved
 * memory model, falling back to {@link OBSERVER_CHUNK_FALLBACK_MAX_TOKENS} when
 * the context window is unavailable.
 *
 * Without a cap, a backlog that outgrows the model's context window (e.g.
 * after repeated observer failures, or when the extension is enabled mid-way
 * into a long session) makes every observer call fail, so coverage never
 * advances and the session can never recover. With the cap, oversized backlogs
 * are drained oldest-first across successive runs.
 */
export function resolveObserverChunkMaxTokens(config: Config, contextWindow: number | undefined): number {
	if (config.observerChunkMaxTokens !== undefined && config.observerChunkMaxTokens > 0) {
		return Math.max(OBSERVER_CHUNK_MIN_TOKENS, config.observerChunkMaxTokens);
	}
	if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
		return Math.max(
			OBSERVER_CHUNK_MIN_TOKENS,
			Math.floor(contextWindow * OBSERVER_CHUNK_CONTEXT_RATIO),
		);
	}
	return OBSERVER_CHUNK_FALLBACK_MAX_TOKENS;
}

const SETTINGS_KEY = "observational-memory";
const PASSIVE_ENV = "PI_OBSERVATIONAL_MEMORY_PASSIVE";

function positiveIntegerOrUndefined(value: unknown): number | undefined {
	return Number.isInteger(value) && typeof value === "number" && value > 0 ? value : undefined;
}

function validTargetOrUndefined(value: unknown, maxTokens: number): number | undefined {
	const target = positiveIntegerOrUndefined(value);
	return target !== undefined && target < maxTokens ? target : undefined;
}

function derivedObservationPoolTarget(maxTokens: number): number {
	return Math.floor(maxTokens / 2);
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return typeof value === "string" && (THINKING_LEVEL_VALUES as readonly string[]).includes(value);
}


/**
 * A valid ratio is a finite number strictly between 0 and 1.
 * 0 would never trigger; >= 1 would compact at/after the full window with no
 * room left for the response.
 */
function validRatioOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1 ? value : undefined;
}

/**
 * Parse a threshold setting: a plain positive-integer token count, or an
 * object form where `value` must be a positive integer in `"calibrated"`
 * form and a finite ratio in (0, 1) in `"ratio"` form. Anything else yields
 * undefined so callers can reject or ignore the setting.
 */
export function parseTokenThreshold(value: unknown): number | TokenThreshold | undefined {
	const plain = positiveIntegerOrUndefined(value);
	if (plain !== undefined) return plain;
	if (!isRecord(value)) return undefined;
	if (!isTokenThresholdType(value.type)) return undefined;
	if (value.type === "ratio") {
		const ratio = validRatioOrUndefined(value.value);
		return ratio !== undefined ? { type: "ratio", value: ratio } : undefined;
	}
	const tokens = positiveIntegerOrUndefined(value.value);
	return tokens !== undefined ? { type: "calibrated", value: tokens } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeModel(value: unknown): ConfiguredModel | undefined {
	if (!isRecord(value)) return undefined;
	const provider = nonEmptyString(value.provider);
	const id = nonEmptyString(value.id);
	if (!provider || !id) return undefined;
	const model: ConfiguredModel = { provider, id };
	if (isThinkingLevel(value.thinking)) model.thinking = value.thinking;
	return model;
}

function isMemoryStage(value: unknown): value is MemoryStage {
	return typeof value === "string" && (MEMORY_STAGE_VALUES as readonly string[]).includes(value);
}

function normalizeStages(value: unknown): MemoryStage[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const stages = value.filter(isMemoryStage);
	return stages.length > 0 ? [...new Set(stages)] : undefined;
}

function normalizeModelMapEntry(value: unknown): ModelMapEntry | undefined {
	if (!isRecord(value)) return undefined;
	const match = nonEmptyString(value.match);
	const model = nonEmptyString(value.model);
	if (!match || !model || !model.includes("/")) return undefined;
	const entry: ModelMapEntry = { match, model };
	// A present-but-unusable `stages` rejects the entry rather than widening it to
	// every stage: a misspelled stage would otherwise silently route the costly
	// reflector model to observer and dropper too.
	const stages = normalizeStages(value.stages);
	if (value.stages !== undefined && !stages) return undefined;
	if (stages) entry.stages = stages;
	return entry;
}

function normalizeModelMap(value: unknown): ModelMapEntry[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const entries = value.map(normalizeModelMapEntry).filter((entry): entry is ModelMapEntry => entry !== undefined);
	return entries.length > 0 ? entries : undefined;
}

/**
 * Translate a `match` glob (`*` = any run of characters, `?` = one character)
 * into an anchored, case-insensitive RegExp.
 */
function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

/**
 * Split a selector into its glob part and an optional exact thinking-level
 * predicate. Only the final `:`-delimited segment counts, so a model id such as
 * `synthetic/syn:large:text` and a suffix like `:free` stay part of the glob.
 */
export function parseMatchSelector(selector: string): { glob: string; thinking?: ModelThinkingLevel } {
	const lastColon = selector.lastIndexOf(":");
	if (lastColon !== -1) {
		const suffix = selector.slice(lastColon + 1);
		if (isThinkingLevel(suffix)) return { glob: selector.slice(0, lastColon), thinking: suffix };
	}
	return { glob: selector };
}

/**
 * Resolve a `"<provider>/<id>[:<thinking>]"` model reference, substituting
 * `$provider`, `$id`, `$model`, and `$thinking` from the active session model.
 *
 * An unresolved `$thinking` drops its `:` separator, leaving thinking unset. Any
 * other leftover `$token` makes the reference invalid, so a rule that cannot be
 * resolved never routes a worker to a literal `$provider` model id.
 */
export function resolveModelString(
	model: string,
	session: { provider?: string; id?: string; thinking?: ModelThinkingLevel },
): ConfiguredModel | undefined {
	let text = model.trim();
	if (!text) return undefined;
	if (session.provider !== undefined) text = text.replaceAll("$provider", session.provider);
	if (session.id !== undefined) text = text.replaceAll("$id", session.id);
	if (session.provider !== undefined && session.id !== undefined) {
		text = text.replaceAll("$model", `${session.provider}/${session.id}`);
	}
	if (session.thinking !== undefined) text = text.replaceAll("$thinking", session.thinking);
	else text = text.replace(/:\$thinking/g, "").replace(/\$thinking/g, "");
	if (text.includes("$provider") || text.includes("$id") || text.includes("$model") || text.includes("$thinking")) {
		return undefined;
	}
	const parsed = parseMatchSelector(text);
	const slash = parsed.glob.indexOf("/");
	if (slash <= 0 || slash === parsed.glob.length - 1) return undefined;
	const provider = parsed.glob.slice(0, slash);
	const id = parsed.glob.slice(slash + 1);
	if (!provider || !id) return undefined;
	const resolved: ConfiguredModel = { provider, id };
	if (parsed.thinking !== undefined) resolved.thinking = parsed.thinking;
	return resolved;
}

/**
 * Build the `"<provider>/<id>"` key used to match `modelMap` entries against
 * the active session model. Returns undefined if the model lacks either field.
 */
export function activeModelKey(model: unknown): string | undefined {
	if (!isRecord(model)) return undefined;
	const provider = nonEmptyString(model.provider);
	const id = nonEmptyString(model.id);
	return provider && id ? `${provider}/${id}` : undefined;
}

/**
 * Resolve the memory-worker model routing for the given active session model:
 * the first `modelMap` entry whose `match` glob matches `"<provider>/<id>"` and
 * whose `stages` admits `stage`, falling back to the static `model` config if
 * none match. An entry without `stages` applies to every stage; a caller
 * without a `stage` only matches unrestricted entries.
 *
 * `sessionThinking` feeds `$thinking` substitution in an entry's `model`; it is
 * not a routing filter.
 */
export function resolveConfiguredModel(
	config: Config,
	activeModel: unknown,
	stage?: MemoryStage,
	sessionThinking?: ModelThinkingLevel,
): ConfiguredModel | undefined {
	const key = activeModelKey(activeModel);
	if (key) {
		const slash = key.indexOf("/");
		const session = {
			provider: key.slice(0, slash),
			id: key.slice(slash + 1),
			thinking: sessionThinking,
		};
		for (const entry of config.modelMap) {
			if (entry.stages && (!stage || !entry.stages.includes(stage))) continue;
			if (!globToRegExp(entry.match).test(key)) continue;
			const resolved = resolveModelString(entry.model, session);
			if (resolved) return resolved;
		}
	}
	return config.model;
}

/** A malformed rule is dropped; thresholds inside a rule are dropped individually. */
function normalizeWarnAtRule(value: unknown): WarnAtRule | undefined {
	if (!isRecord(value)) return undefined;
	const match = nonEmptyString(value.match);
	if (!match || !Array.isArray(value.warnAt)) return undefined;
	const warnAt = value.warnAt.map(parseTokenThreshold).filter((threshold) => threshold !== undefined);
	return { match, warnAt };
}

/** Malformed `warnAt` rules are dropped individually; a non-object block is ignored. */
export function normalizeSelfCompact(value: unknown): SelfCompactConfig | undefined {
	if (!isRecord(value)) return undefined;
	const warnAt = Array.isArray(value.warnAt)
		? value.warnAt.map(normalizeWarnAtRule).filter((rule): rule is WarnAtRule => rule !== undefined)
		: [];
	return { enabled: value.enabled === true, warnAt };
}

/** Malformed fields fall back to defaults; a non-object block is ignored. */
export function normalizeRecallEmbeddings(value: unknown): RecallEmbeddingsConfig | undefined {
	if (!isRecord(value)) return undefined;
	return {
		enabled: value.enabled === true,
		model: nonEmptyString(value.model) ?? RECALL_EMBEDDINGS_DEFAULTS.model,
		pooling: value.pooling === "cls" || value.pooling === "mean" ? value.pooling : RECALL_EMBEDDINGS_DEFAULTS.pooling,
		queryPrefix: typeof value.queryPrefix === "string" ? value.queryPrefix : RECALL_EMBEDDINGS_DEFAULTS.queryPrefix,
	};
}

/** A probability threshold must be a finite number within [0, 1]. */
function probabilityOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

/**
 * Absent or non-object config leaves the dropper on the LLM path. Individual
 * malformed fields fall back to their default rather than rejecting the block,
 * so a bad threshold does not silently disable a configured endpoint.
 */
export function normalizeSystemOneDropper(value: unknown): SystemOneDropperConfig | undefined {
	if (!isRecord(value)) return undefined;
	const mode = (SYSTEM_ONE_MODES as readonly unknown[]).includes(value.mode)
		? value.mode as SystemOneMode
		: SYSTEM_ONE_DROPPER_DEFAULTS.mode;
	return {
		mode,
		provider: nonEmptyString(value.provider) ?? SYSTEM_ONE_DROPPER_DEFAULTS.provider,
		model: nonEmptyString(value.model),
		vetoThreshold: probabilityOrUndefined(value.vetoThreshold) ?? SYSTEM_ONE_DROPPER_DEFAULTS.vetoThreshold,
		dropThreshold: probabilityOrUndefined(value.dropThreshold) ?? SYSTEM_ONE_DROPPER_DEFAULTS.dropThreshold,
		maxQuestionsPerRequest: positiveIntegerOrUndefined(value.maxQuestionsPerRequest)
			?? SYSTEM_ONE_DROPPER_DEFAULTS.maxQuestionsPerRequest,
		requestTimeoutMs: positiveIntegerOrUndefined(value.requestTimeoutMs)
			?? SYSTEM_ONE_DROPPER_DEFAULTS.requestTimeoutMs,
	};
}

function normalizeSettingsConfig(value: Record<string, unknown>): Partial<Config> {
	const normalized: Partial<Config> = {};
	const numberKeys = [
		"observerChunkMaxTokens",
		"observationsPoolMaxTokens",
		"observationsPoolTargetTokens",
		"reflectionsPoolTargetTokens",
		"agentMaxTurns",
		"agentMaxTokens",
	] as const;
	const thresholdKeys = [
		"observeAfterTokens",
		"reflectAfterTokens",
		"compactAfterTokens",
	] as const;
	const modelMap = normalizeModelMap(value.modelMap);
	if (modelMap) normalized.modelMap = modelMap;
	const selfCompact = normalizeSelfCompact(value.selfCompact);
	if (selfCompact) normalized.selfCompact = selfCompact;
	const recallEmbeddings = normalizeRecallEmbeddings(value.recallEmbeddings);
	if (recallEmbeddings) normalized.recallEmbeddings = recallEmbeddings;
	const systemOneDropper = normalizeSystemOneDropper(value.systemOneDropper);
	if (systemOneDropper) normalized.systemOneDropper = systemOneDropper;
	for (const key of numberKeys) {
		const normalizedValue = positiveIntegerOrUndefined(value[key]);
		if (normalizedValue !== undefined) normalized[key] = normalizedValue;
	}
	for (const key of thresholdKeys) {
		const normalizedValue = parseTokenThreshold(value[key]);
		if (normalizedValue !== undefined) normalized[key] = normalizedValue;
	}
	// Legacy flat keys (`compactAfterTokensMode` + `compactAfterTokensRatio`)
	// map onto the object form. In legacy semantics the ratio applied whenever
	// the mode said so, even alongside a plain-number `compactAfterTokens`
	// (which served only as the no-window fallback), so only a new-form object
	// takes precedence over it.
	const legacyRatio = validRatioOrUndefined(value.compactAfterTokensRatio);
	if (
		value.compactAfterTokensMode === "ratio"
		&& legacyRatio !== undefined
		&& !isRecord(value.compactAfterTokens)
	) {
		normalized.compactAfterTokens = { type: "ratio", value: legacyRatio };
	}
	if (typeof value.showWorkerNotifications === "boolean") normalized.showWorkerNotifications = value.showWorkerNotifications;
	if (typeof value.passive === "boolean") normalized.passive = value.passive;
	if (typeof value.debugLog === "boolean") normalized.debugLog = value.debugLog;
	const model = normalizeModel(value.model);
	if (model) normalized.model = model;
	const fallbackModel = normalizeModel(value.fallbackModel);
	if (fallbackModel) normalized.fallbackModel = fallbackModel;
	return normalized;
}

export function readEnvConfig(env: NodeJS.ProcessEnv = process.env): Partial<Config> {
	const rawPassive = env[PASSIVE_ENV];
	if (rawPassive === undefined) return {};
	const passive = rawPassive.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(passive)) return { passive: true };
	if (["0", "false", "no", "off"].includes(passive)) return { passive: false };
	return {};
}

function readNamespacedConfig(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		const nested = raw[SETTINGS_KEY];
		return isRecord(nested) ? normalizeSettingsConfig(nested) : {};
	} catch {
		return {};
	}
}

export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): Config {
	const globalPath = join(getAgentDir(), "settings.json");
	const projectPath = join(cwd, ".pi", "settings.json");
	const globalConfig = readNamespacedConfig(globalPath);
	const projectConfig = readNamespacedConfig(projectPath);
	const envConfig = readEnvConfig(env);
	const merged = {
		...DEFAULTS,
		observationsPoolTargetTokens: undefined,
		...globalConfig,
		...projectConfig,
		...envConfig,
	};
	const target = validTargetOrUndefined(
		merged.observationsPoolTargetTokens,
		merged.observationsPoolMaxTokens,
	) ?? derivedObservationPoolTarget(merged.observationsPoolMaxTokens);

	return {
		...merged,
		observationsPoolTargetTokens: target,
	};
}
