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
    "agentMaxTurns": 16,
    "model": {
      "provider": "openrouter",
      "id": "google/gemma-4-31b-it",
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
| `agentMaxTurns` | positive integer | `16` | Shared nested-agent turn cap for observer, reflector, and dropper. |
| `agentMaxTokens` | positive integer | `32000` | Maximum output tokens requested for memory-agent loops. Clamped to the model's own `maxTokens` when available. Lower it for local servers with a modest context window. |
| `model` | object | unset | Optional model override for observer, reflector, and dropper. |
| `model.provider` | string | unset | Provider name in Pi's model registry. Required when `model` is set. |
| `model.id` | string | unset | Model id in Pi's model registry. Required when `model` is set. |
| `model.thinking` | enum | unset; workers fall back to `low` | Optional reasoning/thinking level for memory workers. |
| `showWorkerNotifications` | boolean | `true` | Shows routine observer, reflector, and dropper progress notifications. |
| `passive` | boolean | `false` | Disables proactive background memory and auto-compaction triggers. |
| `debugLog` | boolean | `false` | Writes best-effort per-session extension debug events to Pi's agent directory. |

Valid `model.thinking` values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

Invalid values are ignored. Positive-integer settings must be finite integers greater than zero. `observationsPoolTargetTokens` must also be below `observationsPoolMaxTokens`; if omitted or invalid, it is derived as `Math.floor(observationsPoolMaxTokens / 2)`.

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

## `showWorkerNotifications`

Default: `true`.

When `false`, the extension hides routine observer, reflector, and dropper progress notifications (including deliberate-empty observer info messages). Model fallback/unavailability, worker failures (including observer stream errors), compaction notifications, and explicit `/om:*` command output remain visible.

## `passive`

Default: `false`.

When `true`, the extension does not proactively run the observer, reflector/dropper lane, or auto-compaction trigger. Manual/Pi compaction hooks, `/om:status`, `/om:view`, and `recall` remain available.

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

Each row includes event metadata such as `sessionId`, `sessionFile`, `runId`, `cwd`, and event-specific `data`. `runId` identifies one consolidation pipeline inside a session file, so you can filter a session log to a single observer/reflector/dropper pass.

Dropper diagnostics are especially useful when the active observation pool is over target but no drops are appended. For example:

```bash
grep '"event":"dropper' ~/.pi/agent/observational-memory/debug/<session-id>.ndjson | tail -n 50
```

Look for `dropper.result`: `no_tool_call` means the model chose not to drop anything, `all_filtered` means proposed ids were unusable, and `selected_nonempty` means usable drops were selected before append handling.

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
