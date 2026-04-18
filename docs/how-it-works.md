# How Observational Memory Works

## The Problem

Pi agents lose context when the conversation grows beyond the model's context window. Pi handles this through **compaction** — summarizing older messages so recent ones fit. The default compaction produces a flat LLM-written summary that loses structure, priority, and temporal ordering. Worse, each subsequent compaction summarizes a summary of a summary, and specific decisions, timestamps, and completion states get flattened with each cycle.

This extension replaces the LLM-written summary with a structured, mostly-asynchronous memory system. The compaction summary becomes a deterministic concatenation of two pools — **reflections** (stable long-lived facts) and **observations** (timestamped events) — both produced incrementally as the session progresses.

## The Solution: Three Tiers, Mostly Async

```
┌─────────────────────────────────────────────────────────┐
│                   Session Lifecycle                     │
│                                                         │
│  turn_end ──▶ Observer (async, every ~1k raw tokens)    │
│                  └──▶ append om.observation tree entry  │
│                                                         │
│  agent_end ─▶ Compaction trigger (every ~50k raw)       │
│                  └──▶ ctx.compact()                     │
│                                                         │
│  session_before_compact ──▶ assemble summary:           │
│        1. walk om.observation entries since last        │
│           compaction                                    │
│        2. merge with prior compaction.details           │
│        3. if observation pool ≥ 30k:                    │
│              run Reflector LLM                          │
│              run Pruner LLM                             │
│        4. mechanically render summary                   │
└─────────────────────────────────────────────────────────┘
```

The actor LLM only ever sees the most recent compaction summary as a normal `compactionSummary` message. Observations and reflections are never injected into the live message stream. The conversation prefix stays stable between compactions, which preserves prefix caching.

## The Three Tiers

### 1. Observer (continuous, async)

Fires on `turn_end`. Cheap. Runs in the background.

After each agent turn, the extension walks the current branch and counts raw tokens since the **last bound** — defined as the more recent of the last `om.observation` tree entry or the last `compaction` entry. When this exceeds `observationThresholdTokens` (default 1000), an observer LLM call fires asynchronously.

The observer receives:
- All current reflections from the most recent compaction's `details`.
- All current observations: those in the most recent compaction's `details`, plus every `om.observation` content appended since.
- The new chunk of raw conversation (filtered to message entries between the last bound and the current leaf, with inline timestamps).

It produces one or more new observations in the strict format `YYYY-MM-DD HH:MM <prose>`. The output is written to the tree as a single `om.observation` `custom` entry with `{ content, coversFromId, coversUpToId, tokenCount }`.

Observer is fire-and-forget. The user never waits on it. A concurrency flag (`observerInFlight`) prevents two observers from racing — if a turn ends while an observer is still running, the trigger is skipped and the next turn picks up the accumulated tokens.

### 2. Compaction Trigger (every ~50k raw tokens)

Fires on `agent_end`. Synchronous intent, deferred via `setTimeout(0)` so `ctx.compact()` runs outside the agent loop (mid-loop compaction is unsafe in Pi).

The extension recomputes raw tokens since the most recent `compaction` entry on the branch. If it exceeds `compactionThresholdTokens` (default 50000) and the agent is idle, `ctx.compact()` is called. This kicks off Pi's compaction flow, which then fires the `session_before_compact` event.

### 3. Compaction Assembly (`session_before_compact`)

This is where the summary is built. The extension owns this hook entirely — Pi's default LLM summarizer is bypassed.

1. **Walk the delta.** Collect every `om.observation` entry between the prior compaction's `firstKeptEntryId` and the new compaction's `firstKeptEntryId`. Filter out any whose `coversUpToId` precedes the prior `firstKeptEntryId` — this guards against late-landing observers whose range is already baked into the prior summary.

2. **Merge with prior state.** The cumulative state lives in `compaction.details = { reflections: [], observations: [] }`. Reflections from the prior compaction are carried forward as-is. Observations from the prior compaction are unioned with the delta observations to form the working observation pool.

3. **Gate the reflector + pruner.** If the working observation pool exceeds `reflectionThresholdTokens` (default 30000), run two LLM calls as an inseparable pair:
   - **Reflector.** Given current reflections + working observations, produce *new* reflection lines that crystallize stable, long-lived patterns (user identity, project decisions, constraints). Reflector never modifies existing reflections — it only appends.
   - **Pruner.** Given the updated reflection set + working observations, produce the kept observation set. The pruner may drop redundant, contradicted, or trivial observations, and may merge or rewrite observations for clarity. Its output replaces the working observation set.

   Below the gate, both calls are skipped and the working sets carry through unchanged. This means compaction is **0 LLM calls** in early sessions and **2 LLM calls** in steady state — never 1.

4. **Render the summary.** Mechanical concatenation:
   ```
   <preamble explaining what these blocks are>

   <reflections>
   YYYY-MM-DD HH:MM ...
   YYYY-MM-DD HH:MM ...
   </reflections>

   <observations>
   YYYY-MM-DD HH:MM ...
   YYYY-MM-DD HH:MM ...
   </observations>
   ```
   No LLM is involved at this step. The summary is deterministic given the inputs.

5. **Return to Pi.** The hook returns `{ compaction: { summary, firstKeptEntryId, tokensBefore, details } }`. Pi appends a `compaction` entry with these fields and auto-marks `fromHook: true`. The summary becomes a `compactionSummary` message in the next turn's context.

## Content Format

Every observation and reflection follows a strict format:

```
YYYY-MM-DD HH:MM <plain prose>
```

The timestamp is local time, 24-hour, to the minute. The text is plain prose — no emojis, no priority markers, no `[tags]`, no Markdown bullets, no code fences, no embedded structured fields.

This strictness exists for three reasons:
1. The pruner LLM round-trips the observation set, so it must emit content the parser can re-split into entries. The timestamp prefix is the only delimiter.
2. The summary renderer is mechanical — formatting drift in any single entry would visibly leak into the actor's context.
3. Emoji and tag conventions drift across model versions; plain prose is stable.

Example reflection: `2026-01-15 10:00 User works at Acme Corp building Acme Dashboard on Next.js 15.`

Example observation: `2026-01-15 14:50 GraphQL migration completed; user confirmed queries working.`

## State Persistence

The Pi session tree is the only source of truth. There is no external database, no on-disk sidecar, no closure cache that needs rebuilding.

Two entry types carry state:

- **`om.observation`** (`custom` entry) — written by the observer. Holds `{ content, coversFromId, coversUpToId, tokenCount }`. Append-only. Used by the next compaction's walk.
- **`compaction.details`** (typed payload on the `compaction` entry) — holds `{ type: "observational-memory", version: 2, observations: Observation[], reflections: Reflection[] }`. Cumulative branch-local state. Each new compaction reads the most recent prior `details` and writes its own.

In-memory closure state in v2 is minimal: the loaded config, an `observerInFlight` flag, and a `compactInFlight` flag. Counters (raw tokens since last bound, raw tokens since last compaction) are recomputed on every check from a branch walk — there is no incremental cache to invalidate.

This means session resume, branch switching, and tree navigation are all transparent — there is no state to rebuild, because there is no cached state.

## Async Race Handling

The observer is fire-and-forget, so observations can land out of order with respect to compaction:

- If `ctx.compact()` runs while an observer is still in flight, the in-flight observer's `om.observation` entry will land *after* the new compaction. Its `coversUpToId` will reference an entry that's now before the new `firstKeptEntryId` — i.e., its content describes raw entries already baked into the new compaction's `details.observations`. The next compaction's walk filters such entries out by checking `coversUpToId` against the prior `firstKeptEntryId`.

- If two `turn_end` events fire while an observer is running, the second is dropped (the `observerInFlight` flag is set). The accumulated raw tokens are picked up by the next `turn_end` after the in-flight observer completes. No data is lost; observations just batch together.

There is no separate reflection race because reflection happens synchronously inside compaction, on whatever data the branch holds at that moment.

## Cache-Friendliness

A deliberate design constraint: the actor LLM's prompt prefix should stay stable between compactions. If we injected fresh observations into every turn (e.g., as a system-prompt suffix or a tail message), each new observation would invalidate the prefix cache and every turn would pay a cold-cache cost.

Instead, observations live in silent tree entries that the actor never sees. Reflections live inside `compaction.details`. Both surface to the actor only at the next compaction, packaged into the new `compactionSummary` message — at which point the prefix shifts exactly once and then stays stable until the next compaction.

This is the central trade-off versus a "live memory injection" design: the actor sees memory updates only at compaction boundaries, but caching keeps working between them.

## Configuration

Observational memory behavior is controlled by two separate configuration surfaces: **Pi's built-in compaction settings** and the **extension's own config**.

### Pi compaction settings

Configured in `~/.pi/agent/settings.json` (or `.pi/settings.json` per project):

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

| Setting | Default | Effect |
|---------|---------|--------|
| `enabled` | `true` | Whether Pi's auto-compaction triggers. Manual `/compact` still works when disabled. |
| `reserveTokens` | `16384` | Tokens reserved for the LLM response. Pi triggers auto-compaction when context exceeds `contextWindow - reserveTokens`. |
| `keepRecentTokens` | `20000` | How many tokens of recent conversation are kept verbatim during compaction — these messages are **not** summarized. |

The `keepRecentTokens` setting controls the size of the raw tail the actor sees alongside the compaction summary. Higher means more uncompressed conversation at the cost of less room for the summary. Lower compresses more aggressively, relying more on observations and reflections.

### Extension config

Configured under the `observational-memory` key in the same `settings.json`. Project values override global.

```json
{
  "observational-memory": {
    "observationThresholdTokens": 1000,
    "compactionThresholdTokens": 50000,
    "reflectionThresholdTokens": 30000
  }
}
```

| Parameter | Default | Effect |
|-----------|---------|--------|
| `observationThresholdTokens` | `1,000` tokens | Raw conversation tokens accumulated since the last `om.observation` or `compaction` entry before the observer fires asynchronously on `turn_end`. |
| `compactionThresholdTokens` | `50,000` tokens | Raw conversation tokens accumulated since the last `compaction` entry before the extension triggers `ctx.compact()` on `agent_end`. |
| `reflectionThresholdTokens` | `30,000` tokens | Working observation pool token size at which the reflector + pruner pair runs inside compaction. Below this, both are skipped. |
| `compactionModel` | session model | Optional `{ "provider": "...", "id": "..." }` to use a different model for observer/reflector/pruner passes. |

The same model is used for all three roles when `compactionModel` is set. Observer, reflector, and pruner don't need the same capabilities as the main coding agent, so a smaller/cheaper model is usually appropriate.

### How the two interact

Pi's auto-compaction and the extension's own trigger are independent paths into the same hook:

1. **Extension trigger** — after each agent loop ends, the extension checks if raw tokens since the last compaction exceed `compactionThresholdTokens`. If so, it defers a call to `ctx.compact()`.
2. **Pi auto-compaction** — Pi independently triggers compaction when context approaches the window limit (governed by `reserveTokens`). This can fire before the extension's threshold is reached if the context window is small.
3. **Manual `/compact`** — the user can trigger compaction at any time.

In all three cases, Pi calls `session_before_compact`. The extension intercepts this event, runs its assembly logic, and returns the structured payload — fully replacing Pi's default LLM summarizer.

The split means:
- **Pi decides** how many recent messages to keep raw (`keepRecentTokens`) and when the context is critically full (`reserveTokens`).
- **The extension decides** how often the observer fires (`observationThresholdTokens`), when to proactively compact (`compactionThresholdTokens`), when the reflector + pruner pair engages (`reflectionThresholdTokens`), and what model to use (`compactionModel`).

Lower `compactionThresholdTokens` values mean more frequent compactions (more chances for the reflector + pruner to crystallize and clean up, but more LLM calls). Lower `observationThresholdTokens` means more frequent observer fires (more granular observations, but more background LLM cost). Lower `reflectionThresholdTokens` means the reflector + pruner pair engages on smaller observation pools (more frequent crystallization vs. letting observations accumulate longer before pruning).

## Migration from v1

v2 is a major rewrite. Update your `settings.json` after upgrading:

| v1 setting | v2 setting | Notes |
|---|---|---|
| `observationThreshold` (50000) | `compactionThresholdTokens` (50000) | Same semantics — when to call `ctx.compact()`. Renamed to reflect that this triggers compaction, not observation. |
| `reflectionThreshold` (30000) | `reflectionThresholdTokens` (30000) | Same semantics — observation pool size at which the reflector engages. Renamed for symmetry with the other two keys. |
| *(none)* | `observationThresholdTokens` (1000) | New in v2. Controls how often the async observer fires between compactions. |
| `compactionModel` | `compactionModel` | Unchanged. Now also applies to the pruner pass. |

Old v1 keys are silently ignored in v2 — they won't break anything, but they also won't apply.

Behavioral changes:

- **Observer is now incremental and asynchronous.** v1 ran the observer once per compaction (synchronous). v2 runs it in the background after each turn that crosses the chunk threshold. Compaction itself is now mostly assembly work with no LLM call when the observation pool is small.
- **Pruner is new.** v1 had a single reflector pass that promoted observations to reflections and pruned in the same step. v2 splits this into a reflector (crystallizes new reflections only, never deletes anything) followed by a pruner (rewrites the observation set; may drop or merge entries). Both run as a pair when the gate fires.
- **Format is plain timestamped prose.** v1 used emojis (🔴/🟡/🟢/✅) and Markdown bullets. v2 forbids them — every entry is a single line `YYYY-MM-DD HH:MM <prose>`. The format is strict so the pruner can round-trip the set and the summary stays deterministic.
- **The actor never sees observations or reflections directly.** Only the compaction summary, which is a mechanical concatenation. v1 was structurally similar but without the new pruner; v2 makes the cache-preservation choice explicit and load-bearing.
- **State management is simpler.** v1 maintained closure state that was rebuilt on `session_start`. v2 does pure on-demand recompute from the tree on every check — no hooks needed for cache rebuilds, no state to drift.
