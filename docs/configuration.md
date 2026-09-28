# Configuration

This page documents the current V3 configuration for `pi-observational-memory`.

V3 keeps the existing `observational-memory` settings namespace, but the setting names changed. Old V2 keys are not aliases; they are ignored. If you are upgrading, read [Migrating from V2](#migrating-from-v2).

## Where settings live

Pi reads settings from:

1. Global settings: `~/.pi/agent/settings.json`
2. Project settings: `<project>/.pi/settings.json`
3. Environment override: `PI_OBSERVATIONAL_MEMORY_PASSIVE`

Project settings override global settings. `PI_OBSERVATIONAL_MEMORY_PASSIVE` overrides only `passive` when set to a recognized value.

All extension-owned settings live under:

```json
{
  "observational-memory": {}
}
```

The extension loads config once for its runtime. After changing settings, restart Pi or reload the extension so the new values are picked up.

## Full V3 example

```json
{
  "observational-memory": {
    "observeAfterTokens": 10000,
    "reflectAfterTokens": 20000,
    "observerChunkMaxTokens": 60000,
    "compactAfterTokens": 81000,
    "observationsPoolMaxTokens": 20000,
    "observationsPoolTargetTokens": 10000,
    "reflectionsPoolTargetTokens": 8000,
    "agentMaxTurns": 16,
    "model": {
      "provider": "openrouter",
      "id": "google/gemma-4-31b-it",
      "thinking": "low"
    },
    "fallbackModel": {
      "provider": "opencode-go",
      "id": "deepseek-v4.1-flash",
      "thinking": "low"
    },
    "showWorkerNotifications": true,
    "passive": false,
    "debugLog": false
  }
}
```

You can omit everything. Defaults work for ordinary sessions, and if `model` is unset the memory workers use the current session model.

## Settings reference

| Setting | Type | Default | What it controls |
| --- | ---: | ---: | --- |
| `observeAfterTokens` | positive integer | `10000` | Raw/source token threshold for observer runs. |
| `reflectAfterTokens` | positive integer | `20000` | Raw/source token threshold for reflector runs; successful reflection creates dropper maintenance opportunities. |
| `observerChunkMaxTokens` | positive integer | derived; minimum `256` | Maximum estimated tokens sent to one observer run. Unset: 20% of the resolved memory model's context window, or `60000` when unknown. |
| `compactAfterTokens` | positive integer | `81000` | Estimated source-entry threshold for proactive auto-compaction, counted after the latest compaction boundary. |
| `observationsPoolMaxTokens` | positive integer | `20000` | Normal compaction-projection observation-token pressure that makes compaction do a full fold. |
| `observationsPoolTargetTokens` | positive integer below max | half of `observationsPoolMaxTokens` | Folded active observation target used by post-reflection dropper maintenance. |
| `reflectionsPoolTargetTokens` | positive integer | `8000` | Folded active reflection target used by the reflection dropper. |
| `agentMaxTurns` | positive integer | `16` | Shared nested-agent turn cap for observer, reflector, reflection dropper, and dropper. |
| `agentMaxTokens` | positive integer | `32000` | Maximum output tokens requested for memory-agent loops. Clamped to the model's own `maxTokens` when available. Lower it for local servers with a modest context window. |
| `model` | object | unset | Optional model override for observer, reflector, reflection dropper, and dropper. |
| `model.provider` | string | unset | Provider name in Pi's model registry. Required when `model` is set. |
| `model.id` | string | unset | Model id in Pi's model registry. Required when `model` is set. |
| `model.thinking` | enum | unset; workers fall back to `low` | Optional reasoning/thinking level for memory workers. |
| `fallbackModel` | object | unset | Optional model the memory workers fall back to when the primary memory model fails to resolve or a worker call errors. |
| `fallbackModel.provider` | string | unset | Provider name in Pi's model registry. Required when `fallbackModel` is set. |
| `fallbackModel.id` | string | unset | Model id in Pi's model registry. Required when `fallbackModel` is set. |
| `fallbackModel.thinking` | enum | unset; falls back to `model.thinking` then `low` | Optional reasoning/thinking level used when the fallback is active. |
| `selfCompact.enabled` | boolean | `false` | Gives the agent the `compact_context` tool so it can compact at a breakpoint it chooses. |
| `selfCompact.warnAt` | array of thresholds | `[]` | Context-usage levels at which the agent is asked to call `compact_context`. Same number or `{ type, value }` forms as other thresholds. |
| `recallEmbeddings.enabled` | boolean | `false` | Adds local semantic ranking to `recall` queries. |
| `recallEmbeddings.model` | string | `Xenova/bge-small-en-v1.5` | transformers.js feature-extraction model id. |
| `recallEmbeddings.pooling` | `cls` \| `mean` | `cls` | Pooling the model was trained with. |
| `recallEmbeddings.queryPrefix` | string | BGE retrieval prefix | Text prepended to queries, as the model's recipe requires. |
| `systemOneDropper` | object | unset | Routes the dropper stage to a System One decision endpoint instead of the tool-calling LLM dropper. |
| `systemOneDropper.mode` | `off` \| `shadow` \| `primary` | `shadow` | `shadow` scores without deciding, `primary` lets the endpoint decide, `off` makes the block inert. |
| `systemOneDropper.endpoint` | string | `https://api.typesafe.ai` | Base URL; `/v1/systemone` is appended. |
| `systemOneDropper.model` | string | `jev-latest` | Sent as the request's `model` field. |
| `systemOneDropper.apiKeyEnv` | string | `TYPESAFE_API_KEY` | Environment variable holding the bearer token. Omitted from the request when unset. |
| `systemOneDropper.vetoThreshold` | number in [0, 1] | `0.15` | Keep the observation when the preservation-floor probability reaches this. |
| `systemOneDropper.dropThreshold` | number in [0, 1] | `0.75` | Minimum combined drop probability before an observation becomes a candidate. |
| `systemOneDropper.maxQuestionsPerRequest` | positive integer | `250` | Questions per request; larger pools fan out across several requests. |
| `systemOneDropper.requestTimeoutMs` | positive integer | `60000` | Per-request timeout. |
| `showWorkerNotifications` | boolean | `true` | Shows routine observer, reflector, reflection dropper, and dropper progress notifications. |
| `passive` | boolean | `false` | Disables proactive background memory and auto-compaction triggers. |
| `debugLog` | boolean | `false` | Writes best-effort per-session extension debug events to Pi's agent directory. |

Valid `model.thinking` values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

Invalid values are ignored. Positive-integer settings must be finite integers greater than zero. `observationsPoolTargetTokens` must also be below `observationsPoolMaxTokens`; if omitted or invalid, it is derived as `Math.floor(observationsPoolMaxTokens / 2)`. An omitted or invalid `reflectionsPoolTargetTokens` falls back to its default.

## `observeAfterTokens`

Default: `10000`.

The observer runs from Pi's `turn_end` hook. It counts raw/source tokens after the latest `om.observations.recorded.data.coversUpToId` marker. When the count reaches `observeAfterTokens`, the observer receives source entries after that marker and may append a non-empty `om.observations.recorded` ledger entry.

Lower values create smaller chunks and more frequent model calls. Higher values reduce model-call frequency but let unobserved raw conversation accumulate longer. If the observer deliberately emits no observations, no ledger entry is written; the same range remains uncovered, and the observer retries after another `observeAfterTokens` of source tokens accumulate.

## `observerChunkMaxTokens`

Default: derived as 20% of the resolved memory model's context window, or `60000` when that window is unavailable.

This caps the source-addressed text sent to one observer run. Complete source entries are added oldest-first while they fit; remaining entries stay eligible for later runs. If the oldest entry alone exceeds the budget, the observer receives a clearly marked head/tail excerpt instead of an over-context request. The original session entry is not modified, and observations still cite its original source id so the source remains traceable in the session ledger.

Set an explicit value when a provider exposes a context window that differs from Pi's model metadata. Values below `256` are clamped to `256` so a chunk can always carry a complete source label, omission marker, and useful context. Keep room for the observer system prompt, prior observations/reflections, tool schemas, and output; setting this equal to the full model window will usually fail.

## `reflectAfterTokens`

Default: `20000`.

The reflector uses this raw/source-token threshold. Reflector progress is counted after the latest `om.reflections.recorded.data.coversUpToId` marker.

The dropper no longer uses `reflectAfterTokens` as its own launch threshold. Dropper work is gated by successful reflection: after the reflector records non-empty reflections in a consolidation pass, the dropper may run if the folded active observation ledger is over `observationsPoolTargetTokens`. It can see same-turn new reflections before deciding what to prune.

Lower values distill reflections more often and therefore create more opportunities for post-reflection dropper maintenance. Higher values reduce reflector model calls but leave more observations between reflection and dropper opportunities.

## `compactAfterTokens`

Default: `81000`.

The auto-compaction trigger runs from Pi's `agent_settled` hook, after retries, automatic compaction, and queued continuation finish. It counts estimated source-entry tokens after the latest compaction boundary. The count starts at `firstKeptEntryId` when Pi provides that boundary, so retained source entries remain part of the metric. Memory ledger entries and compaction metadata contribute zero. If the count reaches `compactAfterTokens`, the extension defers with `setTimeout(0)`, checks that Pi is idle, re-checks the same metric, and calls `ctx.compact()`. Pi's provider context usage is not used for this threshold.

This trigger does not wait for observer, reflector, or dropper work. Actual compaction summary creation happens later in `session_before_compact`. A non-empty V3 projection is rendered deterministically and model-free; an empty projection delegates to Pi's native summarizer so prior context is not replaced by an empty summary.

Pi's own window-pressure compaction and manual compaction can still happen independently of this proactive trigger.

## `observationsPoolMaxTokens`

Default: `20000`.

This controls V3's full-fold pressure. During compaction, the extension builds the normal compaction projection: observations whose `coversUpToId` reaches the compaction boundary, with reflection/drop effects held stable from the latest full fold. If there is no previous full fold, normal compaction includes observations only. If that projection's active observation tokens are at or above `observationsPoolMaxTokens`, compaction performs a full fold through the compaction boundary and applies observations, reflections, and drops by coverage marker. Otherwise, it keeps reflection/drop effects stable from the latest full fold and projects only observations through the new boundary.

This is not the active observation dropper target and not a scheduling threshold for the reflector. Use `observationsPoolTargetTokens` for dropper active observation maintenance and `reflectAfterTokens` for reflector cadence.

## `observationsPoolTargetTokens`

Default: half of `observationsPoolMaxTokens`.

This controls the folded active observation target used by the dropper. If folded active observation tokens are at or below this target, the dropper has no maintenance work. If they are over target, the dropper can run only after the reflector records non-empty reflections in the same consolidation pass.

With the defaults, `observationsPoolMaxTokens` is `20000` and `observationsPoolTargetTokens` is `10000`. If the active observation pool reaches about `20000` tokens, the dropper computes a maximum count intended to move it back toward about `10000` tokens, but the model may drop fewer or none.

When the dropper runs, it computes how many tokens are over target, converts that token excess to an approximate observation-count maximum using average active observation size, and passes that maximum to the model as a hard upper bound. The model may drop fewer or none, and code still rejects invalid or duplicate candidates.

Dropper input includes deterministic reflection coverage evidence for every active observation: `none` means no current reflection supports the observation id, `partial` means one reflection supports it, and `strong` means two or more reflections support it. Coverage is evidence for the model, not an automatic drop rule. Relevance is importance/resistance rather than an absolute lock: `critical` observations require the strongest evidence, but older covered/superseded critical observations may leave active memory when semantic safety is clear. Dropping does not delete ledger history; known ids remain recallable.

This target does not affect compaction full-fold pressure. Visible compaction pressure remains based on `observationsPoolMaxTokens`.

## `reflectionsPoolTargetTokens`

Default: `8000`.

This bounds the durable layer. Reflections are re-rendered into every compacted context, so without a target they accumulate for the life of a session and become a permanent tax on every context after compaction.

The reflection dropper runs when the reflector clock is due and folded active reflection tokens are over this target. It deliberately does not require same-run reflector output: reflections go stale exactly when the session moves to new work, which is when the reflector has nothing new to record.

Pool tokens are measured from the rendered line (`[id] content`), not the stored `tokenCount`, because the id prefix is part of what every future context pays for.

The maximum drop count is derived the same way as for observations: tokens over target converted to an approximate reflection count, passed to the model as a hard upper bound. The model may drop fewer or none. Effort scales with pressure while the safety bar does not: a pool far over target tells the dropper to work the whole candidate list rather than stopping after the obvious few, but every individual drop still has to be clearly superseded, obsolete, or redundant.

Like the observer, the reflector is not told about pool pressure. Both producers emit on the merits of what they see, and each pool is bounded by its own dropper.

Reflections carry no timestamp, so the dropper annotates each candidate with deterministic evidence derived from its supporting observations:

- **last evidence** — timestamp of the newest supporting observation, including observations already dropped from active memory. This dates the reflection's evidence, not its importance.
- **support** — how many supporting observations are still active versus dropped.
- **orphan risk** — supporting observations that are already dropped and cited by no other active reflection. Those observations were pruned because this reflection preserved their meaning, so dropping it would remove that meaning from active memory entirely. Code ranks orphan-free candidates ahead of orphan-risk candidates, then prefers older evidence.

Reflection drops are tombstones, not deletions: dropped reflections stay recallable by id. Because a reflection id is a hash of its content, a tombstone is permanent for that exact wording, so the reflector treats tombstoned ids as duplicates rather than re-recording them.

This target does not affect compaction full-fold pressure, which remains based on `observationsPoolMaxTokens` and counts observation tokens only.

## `agentMaxTurns`

Default: `16`.

This is the shared nested-agent turn cap for the observer, reflector, and dropper. A turn is one assistant/model response cycle inside Pi's agent loop. The cap is not a token budget and not a literal tool-call counter.

Use lower values to bound background memory-worker cost. Too low can reduce observation coverage or reflection/drop quality.

## `agentMaxTokens`

Default: `32000`.

This is the maximum number of output tokens the extension requests for each memory-agent loop (observer, reflector, dropper). It is always clamped to the model's own `maxTokens` when the model advertises one.

Lower it when the memory model is a local server with a modest context window (for example, a llama.cpp server with a 64K slot). Slot KV is shared between the main session's retained cache and concurrent sub-agent requests, so a request whose combined input and response budget exceeds the window fails with `500 "Context size has been exceeded."` and the affected memory run aborts. Pairing a smaller `agentMaxTokens` (e.g. `8192`) with a low `observerChunkMaxTokens` keeps sub-agent requests inside the window.

## `model`

Default: unset, meaning memory workers use the session model.

Set `model` when you want the observer, reflector, and dropper to use a cheaper or faster model than the main coding agent:

```json
{
  "observational-memory": {
    "model": {
      "provider": "openrouter",
      "id": "google/gemma-4-31b-it",
      "thinking": "low"
    }
  }
}
```

`provider` and `id` must both be non-empty strings. `thinking` is optional. If the configured model cannot be resolved, the runtime attempts to fall back to the current session model and notifies once. Memory workers accept either an API key or OAuth-style auth headers (e.g. `Authorization: Bearer …`), so OAuth-authenticated providers work without an API key. If no usable model or credentials are available, the relevant background worker skips/fails safely rather than inventing memory.

Workers stream through Pi's composed provider runtime, not `@earendil-works/pi-ai/compat` alone. Session models whose `api` id comes from `pi.registerProvider` (`cursor-sdk`, CLIProxyAPI, commandcode, and other custom APIs) work without a second built-in provider. `model` remains optional: set it only when you want cheaper/faster workers than the coding agent. Leaving it unset is the Cursor-only setup.

## `fallbackModel`

Default: unset, meaning there is no fallback and a failed memory model behaves exactly as before (the worker skips or fails safely).

Set `fallbackModel` to give the memory workers a second model when the primary one is unavailable:

```json
{
  "observational-memory": {
    "model": {
      "provider": "anthropic",
      "id": "claude-haiku-4-5-20251001",
      "thinking": "low"
    },
    "fallbackModel": {
      "provider": "opencode-go",
      "id": "deepseek-v4.1-flash",
      "thinking": "low"
    }
  }
}
```

The fallback is tried in two places:

1. **Resolution.** When the primary memory model cannot be resolved — not in Pi's registry, or carrying no usable API key/auth headers — the fallback is resolved and used. The notification names both the primary failure and the fallback that took over.
2. **Runtime.** When a worker stage (observer, reflector, or dropper) errors during its model call, that one stage is retried once with the fallback model. The retry is per-stage and per-pass; a successful retry is logged and notified.

Once the fallback resolves, it is reused for the rest of the consolidation pass, so later stages do not re-pay a known-broken primary. If the primary model itself resolved through the fallback, no further runtime retry is attempted for that pass.

If the fallback advertises a smaller context window than the primary, the observer chunk is capped to the smaller window before the run, so a fallback retry is never handed a prompt sized only for a larger primary. `fallbackModel.thinking`, when set, is the thinking level used for the fallback call.

`provider` and `id` must both be non-empty strings, exactly as for `model`. A `fallbackModel` identical to the effective primary memory model — the configured `model` when it resolves, otherwise the session model — is rejected as a misconfiguration. A fallback that also fails leaves the existing skip/fail-safe behavior intact: no memory is invented, coverage does not advance, and the failure is surfaced (worker failure notification, `/om:status`, debug log).

## `selfCompact`

Default: `{ "enabled": false }`.

When enabled, the agent gets a `compact_context` tool. Calling it ends the current run; once Pi settles, the extension compacts through the normal V3 hook, so memory is rendered without a model call and recent turns stay in the retained tail. The required `resume` note states the current task and next step, or what the agent is waiting on. After compaction a short message starts the next turn and points the agent at the note, which stays in the retained tail as part of the tool call. A failed compaction is reported in that message, which repeats the note so the agent can continue without compacting.

Input that arrives before the compaction starts cancels it. Proactive `compactAfterTokens` compaction keeps working as a backstop.

`warnAt` asks the agent to compact as context fills. Each threshold is compared with Pi's live context usage, which includes the system prompt and tool schemas, unlike `compactAfterTokens`. Each level is sent once per compaction cycle. The highest level asks the agent to compact before starting new work, and lower levels ask for the next clean breakpoint. A warning raised mid-run is steered into the current run. One raised after the final reply is attached to your next prompt instead of starting a turn. Warnings are not treated as session content by the observer.

```json
{
  "observational-memory": {
    "compactAfterTokens": { "type": "ratio", "value": 0.35 },
    "selfCompact": {
      "enabled": true,
      "warnAt": [{ "type": "ratio", "value": 0.2 }, { "type": "ratio", "value": 0.28 }]
    }
  }
}
```

## `recallEmbeddings`

Default: `{ "enabled": false }`.

When enabled, `recall` queries fuse keyword ranking with semantic similarity (reciprocal rank fusion over the top 50 semantic candidates). This finds matches that share no words with the query. The model runs in-process through the optional `@huggingface/transformers` dependency. No embedding API is called. The weights download once into `observational-memory/models` under Pi's agent directory. The default model is about 33 MB.

Indexing runs in the background at session start and after each agent run. It embeds memory and hidden transcript chunks that have no vector yet, and stores the vectors per session under `observational-memory/embeddings`. Queries never wait for indexing. Documents not embedded yet compete on keyword rank alone. A long session with a few thousand chunks takes about a minute of CPU the first time. If the runtime or model cannot load, recall falls back to keyword search and shows one warning.

Changing `model` rebuilds the index, because stored vectors are tied to the model. Set `pooling` and `queryPrefix` to match the new model. For `Xenova/all-MiniLM-L6-v2`, use `"pooling": "mean"` and `"queryPrefix": ""`.

## `systemOneDropper`

Unset by default, which leaves the dropper on the tool-calling LLM path.

### Modes

A configured block defaults to `shadow`, which is the mode you want first. The endpoint scores every active observation, the LLM dropper still decides, and both land in the drop-score log. Nothing about which observations get dropped changes, so it is safe to leave on while you gather data. If the endpoint is unreachable, scoring is skipped and the run proceeds normally.

`primary` hands the decision to the endpoint. Move to it once the exported scores show the endpoint agreeing with the LLM dropper often enough to trust.

`off` keeps your endpoint and threshold tuning in the file while falling back entirely to the LLM dropper.

The dropper is the one memory stage that generates nothing: it returns a subset of the active observation ids. That makes it a fit for a System One decision model, which evaluates typed questions against a state in a single non-autoregressive pass and returns calibrated probabilities instead of text. Point this at TypeSafe's Jev, or at any server implementing `POST /v1/systemone`, such as a local [open-jev](https://github.com/daseinlabs/open-jev).

```json
{
  "observational-memory": {
    "systemOneDropper": {
      "endpoint": "https://api.typesafe.ai",
      "model": "jev-latest",
      "apiKeyEnv": "TYPESAFE_API_KEY"
    }
  }
}
```

A local endpoint usually needs no key, so leave `apiKeyEnv` pointing at an unset variable:

```json
{
  "observational-memory": {
    "systemOneDropper": {
      "endpoint": "http://localhost:8000",
      "model": "gemma-3-4b-it"
    }
  }
}
```

### How the decision is made

Each active observation gets five questions, all evaluated against one state carrying the whole pool plus current reflections:

| Signal | Type | Asks |
| --- | --- | --- |
| `floor` | noul | Is this the only place carrying a user constraint, concrete completion, identifier, exact error, decision, date, open blocker, or non-standard term? |
| `redundant` | noul | Is its durable meaning already captured by a reflection with equivalent fidelity? |
| `superseded` | noul | Does a later observation clearly replace it? |
| `lowSignal` | noul | Is it a routine acknowledgement or progress update with nothing actionable? |
| `safety` | score | How safe is it to remove, on a three-level rubric? |

`floor` is a hard veto at `vetoThreshold`. Survivors are scored as `max(redundant, superseded, lowSignal) × safety`, so an observation must both look removable for a concrete reason and be judged safe overall. Anything at or above `dropThreshold` becomes a candidate, ranked by that probability, and then passes through the same budget and coverage/relevance/age tie-breaks the LLM dropper uses. An observation the endpoint did not fully answer is never dropped.

The two thresholds are deliberately asymmetric. Losing a user constraint costs far more than keeping one redundant line, so `vetoThreshold` sits low: a 15% chance an observation uniquely carries something important is enough to keep it. Raise `dropThreshold` if the pool is being pruned too eagerly; raise `vetoThreshold` if it is barely pruned at all.

### Verifying before you trust it

Run with `debugLog` enabled and read `dropper.system_one.result`. It reports `vetoedCount`, `belowThresholdCount`, `missingSignalsCount`, and the ten highest-probability candidates with their per-signal values, so you can see which signal carried each decision before tuning a threshold.

### The drop-score log

Whenever the mode is not `off`, every scored observation is appended to:

```txt
~/.pi/agent/observational-memory/drop-scores/<session-id>.ndjson
```

This is a data product rather than a diagnostic, so it is written regardless of `debugLog` and is never rotated away. Each row carries the observation id, its relevance and coverage tier, the five signal probabilities, the combined drop probability, what the endpoint would have decided, what the LLM dropper actually decided in shadow mode, and the rank the existing coverage/relevance/age heuristic would have assigned.

Rows are written for the whole pool, including observations the endpoint could not score. A map fitted only on candidates that cleared `dropThreshold` sees one tail of the distribution and comes out wrong in a way that looks fine, so the log deliberately keeps both sides.

Content is not written to this file. `/om:export-drops` rejoins the rows with observation text from the local session file when you are ready to label.

## `/om:export-drops`

```txt
/om:export-drops [path]
```

Joins the drop-score log for the current session with the full memory projection and writes JSONL to `om-drop-scores.jsonl`, or to a path you give. Each row adds the observation's text and timestamp, the reflections that cite it, and an empty `label` field.

The command reports how many rows carry an LLM dropper verdict and how often the endpoint agreed, which is the number that tells you whether `primary` mode is worth trying.

The export supports two different jobs. The `llmDecision` field is a distillation label: run in shadow mode for a while and you can fit a calibration map against the LLM dropper's judgement without labelling anything by hand. That caps you at the LLM dropper's quality and inherits its mistakes, so it is a bootstrap rather than ground truth. The empty `label` column is there for when you want to hand-label instead, which is the only way to find cases where both the LLM dropper and the endpoint are wrong together.

The `heuristicRank` field is in every row so you can check something cheaper first: whether `selectDropCandidates`, which already ranks by coverage tier, relevance and age, picks the same drops without any model at all.

## `showWorkerNotifications`

Default: `true`.

When `false`, the extension hides routine observer, reflector, and dropper progress notifications (including deliberate-empty observer info messages). Model fallback/unavailability, worker failures (including observer stream errors), compaction notifications, and explicit `/om:*` command output remain visible.

## `passive`

Default: `false`.

When `true`, the extension does not proactively run the observer, reflector/dropper lane, or auto-compaction trigger. Manual/Pi compaction hooks, `/om:status`, `/om:view`, `/om:consolidate`, and `recall` remain available. Passive disables scheduled work, not explicit commands, so `/om:consolidate` is how you keep memory current in a passive session.

Environment override:

```bash
PI_OBSERVATIONAL_MEMORY_PASSIVE=true pi
```

Truthy values: `1`, `true`, `yes`, `on`.

Falsy values: `0`, `false`, `no`, `off`.

Unrecognized values are ignored.

## `debugLog`

Default: `false`.

When enabled, the extension writes best-effort NDJSON debug events under Pi's agent directory. Normal Pi sessions write to a per-session file:

```txt
observational-memory/debug/<session-id>.ndjson
```

Contexts without a usable session id fall back to the legacy global file:

```txt
observational-memory/debug.ndjson
```

Each row includes event metadata such as `sessionId`, `sessionFile`, `runId`, `cwd`, and event-specific `data`. `runId` identifies one consolidation pipeline inside a session file, so you can filter a session log to a single observer/reflector/dropper pass. Automatic runs use a `consolidation-` prefix and `/om:consolidate` runs use a `manual-` prefix.

Dropper diagnostics are especially useful when the active observation pool is over target but no drops are appended. For example:

```bash
grep '"event":"dropper' ~/.pi/agent/observational-memory/debug/<session-id>.ndjson | tail -n 50
```

Look for `dropper.result`: `no_tool_call` means the model chose not to drop anything, `all_filtered` means proposed ids were unusable, and `selected_nonempty` means usable drops were selected before append handling.

Reflection-dropper events use the `reflection_dropper.` prefix and the same `result` reasons, plus `reflector_not_due` and `not_ready` when the stage is skipped:

```bash
grep '"event":"reflection_dropper' ~/.pi/agent/observational-memory/debug/<session-id>.ndjson | tail -n 50
```

`reflection_dropper.agent_start` also carries an `evidenceSummary` with orphan-risk and support-id totals for the whole pool.

Debug logs are opt-in local debugging artifacts. By default, diagnostic events should record aggregate counts, token totals, ids, file paths, errors, and project details rather than observation/reflection content, prompts, model responses, or raw model-proposed drop ids. Treat debug files as sensitive local artifacts.

Debug-log write failures do not change memory behavior.

## Migrating from V2

V3 is not backwards compatible with V2 settings. Old keys are silently ignored and do not act as aliases.

| V2 setting | V3 setting | Migration note |
| --- | --- | --- |
| `observationThresholdTokens` | `observeAfterTokens` | Rename. Same rough observer-cadence role. |
| `compactionThresholdTokens` | `compactAfterTokens` | Rename. Same rough proactive-compaction role. |
| `reflectionThresholdTokens` | `reflectAfterTokens`, `observationsPoolMaxTokens`, and/or `observationsPoolTargetTokens` | Split. Use `reflectAfterTokens` for reflector cadence, `observationsPoolMaxTokens` for compaction full-fold pressure, and `observationsPoolTargetTokens` for dropper active observation maintenance. |
| `compactionModel` | `model` | Move `{ provider, id }` under `model`. |
| `thinkingLevel` | `model.thinking` | Move under `model`. |
| `observerMaxTurnsPerRun` | `agentMaxTurns` | Replace with one shared cap. |
| `reflectorMaxTurnsPerPass` | `agentMaxTurns` | Replace with one shared cap. |
| `prunerMaxTurnsPerPass` | `agentMaxTurns` | Replace with one shared cap; V3 calls the role the dropper. |
| `compactionMaxToolCalls` | none | Remove. No V3 replacement. |
| `passive` | `passive` | Keep if desired. |
| `debugLog` | `debugLog` | Keep if desired. |

Old V2 memory entries and old V2 compaction details are ignored by V3. Start a new clean Pi session after upgrading to V3 so old visible summaries and old memory formats do not confuse the transition.

## Tuning recipes

### Lower background cost

```json
{
  "observational-memory": {
    "observeAfterTokens": 20000,
    "reflectAfterTokens": 50000,
    "agentMaxTurns": 8,
    "model": { "provider": "openrouter", "id": "a-cheaper-model", "thinking": "off" }
  }
}
```

Tradeoff: fewer background model calls, but memory updates lag longer, observation chunks are larger, and reflection/drop cleanup happens less often.

### More responsive memory

```json
{
  "observational-memory": {
    "observeAfterTokens": 750,
    "reflectAfterTokens": 3000,
    "agentMaxTurns": 16,
    "model": { "provider": "openrouter", "id": "a-fast-model", "thinking": "low" }
  }
}
```

Tradeoff: more background model calls.

### Disable proactive work temporarily

```json
{
  "observational-memory": {
    "passive": true
  }
}
```

Or for one shell:

```bash
PI_OBSERVATIONAL_MEMORY_PASSIVE=1 pi
```

## See also

- [concepts.md](concepts.md) — vocabulary and mental model.
- [how-it-works.md](how-it-works.md) — lifecycle and data shapes.
- [../README.md](../README.md) — quick start and V2 migration summary.
