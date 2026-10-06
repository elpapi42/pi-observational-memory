> [!IMPORTANT]
> **V3 update notice:** this extension now uses the new V3 memory model. If you used V2, update your `observational-memory` settings before running this version. V3 does **not** read the old V2 settings or memory format, and you should start a new clean Pi session after upgrading. See [Migrating from V2](#migrating-from-v2).

> [!NOTE]
> The `master` branch is the active development branch and may include unreleased or unstable changes. For stable versions, install the published npm package with `pi install npm:pi-observational-memory`.

# pi-observational-memory

> **Make Pi sessions feel endless.**

`pi-observational-memory` is a Pi extension that keeps long agent sessions coherent across compactions, handoffs, and days of work.

It helps Pi remember what matters while you work, so your agent does not lose the thread when the session gets long.

Built for engineers who use Pi for real coding work: multi-day refactors, deep debugging sessions, architecture exploration, migrations, product implementation, and long-running branches where context matters.

---

## The problem

Long AI coding sessions eventually hit a wall.

Not because the agent stops being useful. Not because the work is too complex. But because the session starts getting compressed.

A compaction summarizes the session. Later, another compaction summarizes that summary. Then another. After enough cycles, your agent is no longer carrying the real working context. It is carrying a compressed version of a compressed version of a compressed version.

That is when the small but important details start disappearing:

* why a design decision was made
* what approaches were already rejected
* which constraint mattered most
* what the current branch is trying to achieve
* what the user already clarified
* what the agent already investigated
* what should not be reopened

The session is still alive, but it no longer feels connected to the work that came before.

For engineers, that is painful. Long coding sessions are built out of accumulated decisions. When those decisions lose their rationale, the agent starts drifting.

---

## The second problem: slow compaction

Compaction can also break flow.

You are deep in a coding session, the agent needs to compact, and suddenly you wait while a model rewrites the past. In large sessions, that pause can take minutes.

That interruption is costly because it happens exactly when the session is already complex and you most need continuity.

`pi-observational-memory` changes the experience: memory work happens as the session progresses, so when compaction time arrives, Pi can move forward quickly.

The goal is simple:

> When compaction happens, you should barely notice.

---

## What this extension gives you

`pi-observational-memory` continuously captures useful session memory while you work.

It focuses on two simple concepts:

### Observations

Observations are concrete things that happened or were established during the session.

Examples:

* the user decided to switch from REST to GraphQL
* the migration was completed and validated
* a bug was traced to a specific module
* a branch is focused on replacing one implementation with another
* a deadline, constraint, or preference was stated

Observations keep the session grounded in actual work.

### Reflections

Reflections are durable facts distilled from observations.

Examples:

* the user is building a Next.js 15 dashboard with Supabase auth
* the current implementation must ship by a specific date
* the project prefers minimal abstractions over framework-heavy patterns
* the branch is about improving long-session agent memory

Reflections help the agent stay oriented over time. The reflector treats coverage as stewardship: every active observation it reviews includes a `none`, `partial`, or `strong` coverage tier, but those tiers are review context rather than quotas. When the reflector emits a durable reflection, its support ids should cover all and only the observations whose durable meaning is actually preserved, because those ids later become dropper coverage evidence.

Reflections are also bounded. Facts about you and your project stay durable, but a reflection about a specific task, bug, or migration stops being orientation once that work is done and the session moves on. The reflection dropper removes superseded, contradicted, closed-scope, and redundant reflections so the durable layer does not grow for the life of the session.

Together, observations and reflections let Pi carry the important parts of the session forward without depending on fragile summary chains.

---

## What it feels like

With `pi-observational-memory`, long sessions feel less like racing against the context window and more like working with an agent that can stay with you.

You can keep a session alive across many compactions. You can come back after a long break. You can hand work across sessions with less context loss. The agent has a better chance of remembering what was decided, what matters, and why the work is shaped the way it is.

This extension was built from real long-session usage, including Pi sessions that lasted for weeks without feeling close to the end of the usable working context.

The promise is not magic infinite memory.

The promise is practical continuity:

> Your agent keeps understanding the work, even after days of iteration.

---

## Why it works

Traditional compaction asks a model to rewrite the past at the moment the context window needs relief.

`pi-observational-memory` does the important memory work earlier, while the session is still happening.

As you work, the extension captures observations and distills reflections in the background. When Pi needs to compact, the memory is already prepared. Compaction becomes a fast rendering step instead of a slow summarization event.

That gives you two big benefits:

1. **Less coherence loss** — important context is preserved as observations and reflections instead of repeatedly compressed through summary chains.
2. **Faster compaction** — the expensive memory work happens before compaction, not while you are waiting.

---

## Example

At compaction time, Pi may receive memory like this:

```md
These are condensed memories from earlier in this session.

- Reflections: stable, long-lived facts about the user, project, decisions, and constraints. New reflection lines may include ids in brackets.
- Observations: timestamped events from the conversation history, in chronological order. Observation lines include ids in brackets.

Treat these as past records. When entries conflict, the most recent observation reflects the latest known state. Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.

When exact source context is needed for precision or traceability, use the recall tool with the relevant observation or reflection id. This is especially useful when a reflection materially affects a decision or is too compressed to continue confidently. When a needed detail is missing from these memories, search earlier context with recall and a query. Recall only when the result changes the next action.

## Reflections
[a1b2c3d4e5f6] User works at Acme Corp building Acme Dashboard on Next.js 15 with Supabase auth.
[b2c3d4e5f6a1] Hard constraint: ship by January 22nd 2026.

## Observations
[d4e5f6a1b2c3] 2026-01-15 14:30 [high] User decided to switch from REST to GraphQL for the public API; motivation was reducing over-fetching on mobile clients.
[e5f6a1b2c3d4] 2026-01-15 14:50 [medium] GraphQL migration completed; user confirmed queries working.
```

The IDs are useful because the agent-facing `recall` tool can recover source evidence for a specific observation or reflection.

That means memory is not just a vague statement. The agent can look back at the evidence behind it.

---

## Who this is for

Use `pi-observational-memory` if you use Pi for:

* long coding sessions
* multi-day feature work
* architecture exploration
* large refactors
* production debugging
* repository migrations
* agent-assisted planning
* sessions that need to survive many compactions
* workflows where handoff quality matters

This extension is especially useful when the session contains decisions that should survive over time.

---

## Install

Requires Pi 0.81.0 or newer. Proactive compaction uses the `agent_settled` lifecycle event introduced in that release.

```bash
pi install npm:pi-observational-memory
```

Or install from GitHub/local development:

```bash
pi install git:github.com/elpapi42/pi-observational-memory
# or, from a local checkout:
pi install /absolute/path/to/pi-observational-memory
```

Pi loads the extension from `src/index.ts` through the package `pi.extensions` entry.

---

## Quick configuration

Settings live under the `observational-memory` namespace in either:

* `~/.pi/agent/settings.json`
* project-local `.pi/settings.json`

Project settings override global settings.

`PI_OBSERVATIONAL_MEMORY_PASSIVE` can override only `passive`.

A typical config:

```json
{
  "observational-memory": {
    "observeAfterTokens": 10000,
    "reflectAfterTokens": 20000,
    "compactAfterTokens": { "type": "calibrated", "value": 81000 },
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

Most users can start with the defaults and tune only if they have a specific reason.

If your memory model is a local llama.cpp server, size `agentMaxTokens` so that a worst-case request (observer chunk + prior memory + system prompt + the full response budget) fits inside the server's context: slot KV is shared between the main session's retained cache and concurrent sub-agent requests, so an over-budget sub-agent request fails with `500 "Context size has been exceeded."` and the affected memory run aborts. For example, on a 64K-slot server, pairing `"agentMaxTokens": 8192` with a low `observerChunkMaxTokens` keeps sub-agent requests well inside the window.

### Token thresholds: plain numbers or `{ type, value }` objects

`observeAfterTokens`, `reflectAfterTokens`, and `compactAfterTokens` each accept
either a plain positive-integer token count or a threshold object:

```json
{ "type": "calibrated", "value": 81000 }
```

```json
{ "type": "ratio", "value": 0.68 }
```

A plain number is shorthand for the `"calibrated"` object form.

### Scaling thresholds to the model's context window

By default thresholds are calibrated: the trigger uses the fixed token value
(`compactAfterTokens` is 81,000 by default). This preserves the pre-PR #40
compaction metric for typical ~128K–200K context models.

On a large-context model (e.g. 1M tokens) the calibrated default preempts
compaction at ~81K, wasting most of the window. Switch to ratio form to let the
trigger scale with the active model's `contextWindow`:

```json
{
  "observational-memory": {
    "compactAfterTokens": { "type": "ratio", "value": 0.5 }
  }
}
```

In ratio form the effective threshold is
`floor(model.contextWindow * value)` (clamped to a minimum of 1). With the
example above, a 1,000,000-token window compacts after about 500,000 estimated
source-entry tokens after the latest compaction boundary; a 200,000-token
window uses about 100,000. The threshold counts source entries, not Pi's system
prompt, tool schemas, or provider accounting. Pi's native window-pressure
compaction remains independent.

The ratio is user-tunable precisely because **context window ≠ attention**. Some
models advertise a large window but degrade at long range; set a lower ratio
(e.g. `0.4`) to compact earlier on those, or a higher ratio (e.g. `0.7`) on
models that stay sharp.

In ratio form, when the active model's `contextWindow` is unavailable (undefined,
0, or negative), the threshold falls back to its built-in default token value
(10,000 observe / 20,000 reflect / 81,000 compact) so the trigger still fires
safely. `/om:status` shows the resolved threshold for all three triggers
regardless of form.

Legacy flat keys (`compactAfterTokensMode` + `compactAfterTokensRatio`) are
still parsed and map onto the ratio object form.

### Defaults

| Setting                     | Default       | Meaning                                                                                           |
| --------------------------- | ------------- | ------------------------------------------------------------------------------------------------- |
| `observeAfterTokens`        | `10000`       | Raw/source token threshold for observation runs. Accepts a number or `{ type, value }` threshold object (see above). |
| `observerChunkMaxTokens`    | derived       | Max estimated tokens serialized into one observer chunk (minimum `256`). Unset: `floor(contextWindow * 0.2)` of the resolved memory model, or `60000` when the window is unknown. Larger backlogs drain oldest-first; a single over-budget source is sent as a marked head/tail excerpt while the original source remains in the session ledger. |
| `reflectAfterTokens`        | `20000`       | Raw/source token threshold for reflection runs; successful reflection creates dropper opportunities. Accepts a number or threshold object. |
| `compactAfterTokens`        | `81000`       | Estimated source-entry threshold for proactive auto-compaction, counted after the latest compaction boundary. Accepts a number or threshold object. |
| `observationsPoolMaxTokens` | `20000`       | Observation-token budget used for compaction full-fold pressure.                                  |
| `observationsPoolTargetTokens` | half of max | Active observation target used by post-reflection dropper maintenance.                            |
| `reflectionsPoolTargetTokens` | `8000`      | Active reflection target maintained by the reflection dropper.                                    |
| `agentMaxTurns`             | `16`          | Shared turn cap for background memory-agent loops.                                                |
| `agentMaxTokens`            | `32000`       | Maximum output tokens requested for memory-agent loops (observer/reflector/dropper), clamped to the model's own `maxTokens` when available. Lower it for local servers with a modest context window, e.g. `8192`. |
| `model`                     | session model | Optional memory-worker model override: `{ provider, id, thinking }`.                              |
| `fallbackModel`             | unset         | Optional second memory-worker model: `{ provider, id, thinking }`. Used when the primary memory model fails to resolve, and to retry a worker stage once when its model call errors. |
| `showWorkerNotifications`   | `true`        | Shows routine observer, reflector, reflection dropper, and dropper progress notifications. Warnings and errors are unaffected. |
| `passive`                   | `false`       | Disables proactive background observation, reflection, maintenance, and auto-compaction triggers. |
| `debugLog`                  | `false`       | Writes opt-in per-session extension debug events to Pi's agent directory.                         |

Valid `model.thinking` values are:

* `off`
* `minimal`
* `low`
* `medium`
* `high`
* `xhigh`
* `max`

If no `model` is configured, memory workers use the session model, including custom `pi.registerProvider` APIs such as `cursor-sdk`. You do not need a second built-in provider (OpenAI, OpenRouter, …) for observational memory to run. Set `model` only when you want cheaper or faster workers than the coding agent.

Set `fallbackModel` when the memory model may be unavailable: it is tried when the primary memory model cannot be resolved (unknown provider/model or no usable credentials), and a worker stage that errors mid-call is retried once with it. Once the fallback is used, it stays active for the rest of the consolidation pass. With no `fallbackModel` configured, a failed memory model skips or fails safely exactly as before.

Set `showWorkerNotifications` to `false` to hide routine worker start and completion messages (including deliberate-empty observer info messages). Model fallback/unavailability, worker failures (including observer stream errors), compaction notifications, and explicit `/om:*` command output remain visible.

### Routing the memory-worker model by active session model (local patch)

`modelMap` selects the memory-worker model based on the active session model, matched by glob against `"<provider>/<id>"`. The first matching entry wins; if none match, `model` (or the session model) is used as before.

```json
{
  "observational-memory": {
    "modelMap": [
      { "match": "claude-bridge/claude-opus-*", "model": "claude-bridge/claude-sonnet-5" },
      { "match": "synthetic/syn:large:*", "model": "synthetic/syn:small:text" }
    ]
  }
}
```

`model` is `"<provider>/<id>[:<thinking>]"`. The thinking suffix is the last `:`-separated segment and only counts when it is a valid level, so model ids containing colons (`syn:large:text`, OpenRouter's `:free`) are preserved.

A `model` may reuse parts of the active session model with substitutions: `$provider`, `$id`, `$model` (the full `<provider>/<id>`), and `$thinking` (the session thinking level). This lets one rule pin worker thinking without retyping the model:

```json
{
  "observational-memory": {
    "modelMap": [
      { "match": "claude-bridge/*", "model": "$model:low" },
      { "match": "claude-bridge/*", "stages": ["reflector"], "model": "$model:medium" }
    ]
  }
}
```

With `$thinking` and no known session thinking, the `:` separator is dropped and the worker thinking stays unset. Any other unresolved `$token` invalidates the entry.

An entry may set `stages` to narrow it to any of `observer`, `reflector`, `reflection-dropper`, `dropper`, so the cheap extraction stages and the expensive distillation stage can use different models. An entry without `stages` serves every stage, so order a stage-specific entry before the general one:

```json
{
  "observational-memory": {
    "reflectAfterTokens": 50000,
    "modelMap": [
      { "match": "*", "stages": ["reflector"], "model": "claude-bridge/claude-sonnet-5:high" },
      { "match": "*", "model": "synthetic/syn:small:text" }
    ]
  }
}
```

Stage names are validated: an entry whose `stages` contains no recognized stage is discarded rather than treated as unrestricted, so a misspelled stage cannot silently route the reflector's model to every stage. Each stage resolves its model independently, once per consolidation run.

This is a local patch (`src/config.ts`, `src/runtime.ts`, `src/hooks/consolidation-trigger.ts`) on top of upstream `master` and is not part of the published package.

`observationsPoolMaxTokens` and `observationsPoolTargetTokens` intentionally describe different pools. Max tokens control when compaction performs a full fold over visible memory. Target tokens control the folded active observation pool that the dropper maintains after successful reflection. If the target is omitted, it defaults to half of max.

Dropper pruning balances age, relevance, and reflection coverage. Relevance is importance/resistance, not a permanent active-memory pin: `critical` observations require the strongest evidence but can be dropped when they are older and safely represented by reflections, superseded by newer memory, redundant, or obsolete. Dropper input annotates each active observation with deterministic coverage evidence: `none`, `partial`, or `strong`; coverage guides model judgment and is not an automatic drop rule. Dropping removes observations from active memory, not ledger history.

`reflectionsPoolTargetTokens` bounds the durable layer the same way. Reflections are re-rendered into every compacted context, so an unbounded reflection pool becomes a permanent tax on every context after compaction. The reflection dropper runs when the reflector clock is due and the active reflection pool is over target, and it does not wait for same-run reflector output: reflections go stale exactly when the session moves to new work, which is when the reflector has nothing new to record. It drops only superseded, contradicted, closed-scope, or redundant reflections, and never edits or merges them. Each candidate is annotated with deterministic evidence derived from its supporting observations: last evidence time, active/dropped support counts, and orphan risk (supporting observations already dropped from active memory that no other active reflection carries). Dropped reflections stay recallable by id.

When `debugLog` is enabled, debug events are written as local NDJSON files under Pi's agent directory. Normal sessions write to `observational-memory/debug/<session-id>.ndjson`; contexts without a session id fall back to `observational-memory/debug.ndjson`. Debug rows include `sessionId` and per-consolidation `runId`, so a session file can still be filtered to one observer/reflector/dropper run.

For details and tuning guidance, see [`docs/configuration.md`](docs/configuration.md).

---

## Commands and agent tool

| Surface             | What it does                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `/om:status`        | Shows memory counts, plain `+N` / `-N` visible/full drift suffixes, progress clocks, visible and active observation pool pressure, visible and active reflection pool pressure, passive/in-flight state, and last worker errors. |
| `/om:view`          | Shows current visible memory and attempts to copy the rendered memory text to the clipboard.                                                   |
| `/om:view full`     | Shows the full current memory state for the branch and attempts to copy the rendered memory text to the clipboard.                             |
| `/om:consolidate`   | Runs observation, reflection, and pruning now, ignoring token thresholds. Works in passive mode. Blocks with a footer spinner showing the running stage, then reports what changed. |
| `recall` agent tool | Searches observations, reflections, and transcript hidden by compaction by keyword, or recovers source evidence for a memory id (12 hex) or transcript entry id (8 hex) on the current branch. |

`/om:view` copies only the rendered memory content. The success/failure line shown in Pi is not included in the clipboard text. If clipboard support is unavailable, the command still prints the memory view and shows a warning. Before the first V3 compaction, visible memory can be empty because nothing has been folded into `om.folded` details; use `/om:view full` to inspect recorded branch memory.

---

## How it works in 60 seconds

```mermaid
flowchart TD
    Turn[turn_end]
    Observe[Capture observations]
    Reflect[Distill reflections]
    Prune[Prune stale reflections]
    AgentSettled[agent_settled]
    Trigger[auto-compaction trigger]
    Compact[session_before_compact]
    Summary[visible memory for Pi]

    Turn -->|observation due| Observe
    Turn -->|reflection due| Reflect
    Reflect -->|reflection pool over target| Prune
    AgentSettled -->|compactAfterTokens and idle| Trigger --> Compact --> Summary
```

The high-level lifecycle:

1. Pi session continues normally.
2. The extension captures observations from the session as work happens.
3. Durable reflections are distilled in the background.
4. When compaction time arrives, Pi receives prepared memory quickly.
5. The agent continues with a compact but useful view of the work so far.

The important part: compaction does not need to rethink the whole session from scratch.

The proactive compaction threshold counts estimated source-entry tokens after
the latest compaction boundary. It includes source entries retained by
`firstKeptEntryId` and newer source entries, while memory ledger entries and
compaction metadata contribute zero. `/om:status` uses the same metric. Pi's
own window-pressure compaction remains independent.

---

## Current V3 behavior

Current behavior:

* **Observation-centered memory.** The extension records useful session observations while you work.
* **Durable reflections.** The extension distills stable facts that help the agent stay oriented over time.
* **Fast compaction.** When prepared V3 memory exists, `session_before_compact` renders it without calling a model or waiting for background workers. An empty V3 projection delegates to Pi's native summarizer instead of replacing prior context with an empty summary.
* **Background memory work.** Observation and reflection work run from `turn_end` when their token clocks are due; dropper work runs only after successful reflection and prunes the folded active observation ledger toward `observationsPoolTargetTokens`.
* **Source-backed recall.** Observations and reflections can be traced back through the `recall` tool.
* **Visible/full views.** `/om:view` shows visible memory and `/om:view full` shows the full current memory state. Use `/om:status` for visible-vs-full drift and for the separate visible observation pool vs active observation pool.
* **No V2 compatibility layer.** Old V2 settings and memory entries are ignored rather than migrated.

---

## Migrating from V2

V3 is **not backwards compatible** with V2 memory or settings.

What this means in practice:

1. **Update your settings.** V2 keys are silently ignored by V3. Keeping the old names will make V3 fall back to defaults.
2. **Start a new clean Pi session after upgrading.** Existing sessions may still contain old visible compaction-summary text until a new V3 compaction replaces what the agent sees, so a clean session is the safest migration path.
3. **Do not expect rollback continuity.** If you create V3 memory entries and then roll back to V2, V2 will not understand the V3 memory format. Treat that as memory reset/visibility loss.

### Settings migration table

| V2 setting                   | V3 setting                                              | What to do                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `observationThresholdTokens` | `observeAfterTokens`                                    | Rename. Same rough role: observation cadence based on raw/source tokens.                                                                       |
| `compactionThresholdTokens`  | `compactAfterTokens`                                    | Rename. Same rough role: proactive compaction cadence.                                                                                         |
| `reflectionThresholdTokens`  | `reflectAfterTokens`, `observationsPoolMaxTokens`, and/or `observationsPoolTargetTokens` | Split. Use `reflectAfterTokens` for reflection scheduling, `observationsPoolMaxTokens` for compaction full-fold pressure, and `observationsPoolTargetTokens` for dropper active observation maintenance. |
| `compactionModel`            | `model`                                                 | Move `{ provider, id }` to `model`.                                                                                                            |
| `thinkingLevel`              | `model.thinking`                                        | Move under `model`.                                                                                                                            |
| `observerMaxTurnsPerRun`     | `agentMaxTurns`                                         | Replace with the shared memory-agent turn cap.                                                                                                 |
| `reflectorMaxTurnsPerPass`   | `agentMaxTurns`                                         | Replace with the shared memory-agent turn cap.                                                                                                 |
| `prunerMaxTurnsPerPass`      | `agentMaxTurns`                                         | Replace with the shared memory-agent turn cap.                                                                                                 |
| `compactionMaxToolCalls`     | none                                                    | Remove. There is no V3 alias.                                                                                                                  |
| `passive`                    | `passive`                                               | Keep if desired.                                                                                                                               |
| `debugLog`                   | `debugLog`                                              | Keep if desired.                                                                                                                               |

Example V2 config:

```json
{
  "observational-memory": {
    "observationThresholdTokens": 1000,
    "compactionThresholdTokens": 50000,
    "reflectionThresholdTokens": 30000,
    "compactionModel": { "provider": "openrouter", "id": "google/gemma-4-31b-it" },
    "thinkingLevel": "low",
    "observerMaxTurnsPerRun": 8,
    "reflectorMaxTurnsPerPass": 12,
    "prunerMaxTurnsPerPass": 12,
    "passive": false
  }
}
```

V3 equivalent:

```json
{
  "observational-memory": {
    "observeAfterTokens": 10000,
    "reflectAfterTokens": 20000,
    "compactAfterTokens": 81000,
    "observationsPoolMaxTokens": 20000,
    "observationsPoolTargetTokens": 10000,
    "agentMaxTurns": 12,
    "model": {
      "provider": "openrouter",
      "id": "google/gemma-4-31b-it",
      "thinking": "low"
    },
    "passive": false
  }
}
```

---

## More docs

* [`docs/concepts.md`](docs/concepts.md) — vocabulary and V3 mental model.
* [`docs/how-it-works.md`](docs/how-it-works.md) — lifecycle, memory shapes, projections, and recall flow.
* [`docs/configuration.md`](docs/configuration.md) — all V3 settings and migration notes.

---

## Credits

Inspired by [Mastra's Observational Memory](https://mastra.ai/blog/observational-memory) research.

This is an independent implementation built for Pi's extension system.

---

## License

MIT
