# How it works

This is the technical reference for observational memory's runtime behavior. If you haven't read **[concepts.md](concepts.md)** yet, do that first — this doc assumes the vocabulary.

## Contents

- [The problem](#the-problem)
- [The solution at a glance](#the-solution-at-a-glance)
- [The session lifecycle](#the-session-lifecycle)
- [Inside the observer](#inside-the-observer)
- [Inside the compaction hook](#inside-the-compaction-hook)
- [Inside the reflector + pruner](#inside-the-reflector--pruner)
- [Content format](#content-format)
- [Relevance tiers](#relevance-tiers)
- [State persistence](#state-persistence)
- [Cache-friendliness](#cache-friendliness)
- [Async race handling](#async-race-handling)
- [Properties (what's invariant)](#properties-whats-invariant)

---

## The problem

Long agent sessions outgrow the context window. **Compaction** — replacing older messages with a summary so the recent tail still fits — is how every agent framework keeps the session alive past that point. The hard part is the *shape* of that summary, and how well it carries the session forward through many compactions in a row.

This extension provides a structured, mostly-asynchronous memory system. The compaction summary is built incrementally as the session progresses, and at compaction time it's assembled by a deterministic concatenation of two pools — **reflections** (stable long-lived facts) and **observations** (timestamped events). What survives one compaction survives all of them, byte-identical: there's no fresh LLM rewrite each cycle to drift from.

## The solution at a glance

```mermaid
flowchart TD
    subgraph Lifecycle[Session Lifecycle]
        direction TB
        TE([turn_end])
        AE([agent_end])
        SBC([session_before_compact])

        ObsTrigger{raw tokens since last bound<br/>≥ observationThresholdTokens?}
        ObsRun[Observer LLM async<br/>append om.observation entry]

        CompTrigger{raw tokens since last compaction<br/>≥ compactionThresholdTokens?<br/>and agent idle}
        CompCall[await observerPromise<br/>call ctx.compact]

        Await[await observerPromise<br/>refresh branch]
        Gap{raw gap between last<br/>observation bound and<br/>firstKeptEntryId?}
        GapRun[Sync catch-up observer<br/>append om.observation entry]
        GapFail{failed?}
        Cancel([cancel compaction])

        Delta[Collect delta by coversFromId range<br/>add gap observation if any]
        Merge[Merge with prior compaction.details<br/>→ working observation pool]
        Gate{working pool ≥<br/>reflectionThresholdTokens?}
        Reflect[Reflector LLM append-only]
        Prune[Pruner LLM up to 5 passes<br/>drop ids until pool ≤ 80% of budget]
        Render[Mechanically render summary<br/>return compaction payload]

        TE --> ObsTrigger
        ObsTrigger -- yes --> ObsRun
        ObsTrigger -- no --> TEend([skip])

        AE --> CompTrigger
        CompTrigger -- yes --> CompCall
        CompTrigger -- no --> AEend([skip])

        SBC --> Await --> Gap
        Gap -- yes --> GapRun --> GapFail
        GapFail -- yes --> Cancel
        GapFail -- no --> Delta
        Gap -- no --> Delta
        Delta --> Merge --> Gate
        Gate -- yes --> Reflect --> Prune --> Render
        Gate -- no --> Render
    end
```

The actor LLM only ever sees the most recent compaction summary as a normal `compactionSummary` message. Observations and reflections are never injected into the live message stream. The conversation prefix stays stable between compactions, which preserves prefix caching.

## The session lifecycle

Three Pi hooks drive everything:

| Hook | When it fires | What this extension does |
|---|---|---|
| `turn_end` | After each agent turn completes | Maybe fire the observer (async, fire-and-forget) |
| `agent_end` | Once after the full agent loop ends | Maybe trigger compaction (deferred via `setTimeout(0)`) |
| `session_before_compact` | Right before compaction runs | Build the new summary deterministically |

Two hooks are **deliberately not registered**: `session_start` and `session_tree`. With pure on-demand recompute (counters are walked from the branch on every check), there's no closure cache to rebuild on session lifecycle or branch navigation.

## Inside the observer

The observer is the only continuously-running tier. It fires on `turn_end`.

### Trigger logic

1. Recompute "raw tokens since last bound" from the current branch. **"Last bound"** is the more recent of the most recent `om.observation` entry and the most recent `compaction` entry. (Walking only to the last `om.observation` would re-count raw entries already baked into a prior compaction summary; the "more recent of the two" rule prevents that.)
2. If under `observationThresholdTokens` (default 1000), skip.
3. If `observerInFlight` is `true`, skip.
4. Otherwise, set `observerInFlight = true` and fire the observer task.

A skipped trigger is harmless — the counter keeps growing and the next `turn_end` will catch up.

### Observer task

1. Capture `coversFromId` (id of the first raw entry after the last bound) and `coversUpToId` (current leaf id at fire time). Entries that land *during* the LLM call are deferred to the next observer.
2. Build the LLM prompt: prior reflections + prior observations (so the observer doesn't restate facts already captured) plus the raw chunk in `[coversFromId, coversUpToId]`, rendered as serialized conversation.
3. Run the observer LLM. It calls `record_observations` one or more times, emitting batches of `{ timestamp, content, relevance }`. The observer can also choose to emit zero observations if the chunk carried no new information.
4. Write a single `om.observation` `custom` entry with `{ records, coversFromId, coversUpToId, tokenCount }` in `data`.
5. Clear `observerInFlight`.

### What the observer emits

The observer is a structured event recorder, not a summarizer in the traditional sense. It emits **one observation per fact**, splitting compound statements rather than flattening them. The observer's prompt has explicit rules for:

- **Preserving user assertions exactly** ("User stated they have two kids" — not "User wondered if they have two kids", which would lose the assertion).
- **Preserving unusual phrasing in quotes** so future runs can recognize the user's terminology.
- **Using precise action verbs** ("User installed the zod package via pnpm" — not "User got the library").
- **Framing state changes as supersession** ("User will use React Query (switching from SWR)") so the old state is explicit.
- **Marking concrete completions** ("completed: implemented login handler at src/auth/login.ts; user confirmed tests pass") so future runs know not to redo the work.
- **Splitting compound statements** into separate observations so retrieval and pruning operate at fact granularity.

These rules are what make observations downstream-stable across reflector and pruner round-trips.

## Inside the compaction hook

The compaction hook owns the new summary. It runs synchronously during `session_before_compact`.

### Trigger paths

The hook runs whenever Pi's `session_before_compact` fires. Three paths can fire it:

1. **Extension trigger** — raw tokens since the last compaction exceed `compactionThresholdTokens` *and* the agent is idle *and* no observer is in flight. Fired from `agent_end`. This is the proactive path; deferring to `agent_end` minimizes the chance of compaction interrupting an active turn.
2. **Window-pressure trigger** — Pi's safety net, when context approaches `contextWindow − reserveTokens`.
3. **Manual `/compact`** — user-triggered.

The hook runs the same way regardless of which path fired it.

### Hook steps, in order

When `session_before_compact` fires, the hook:

**1. Awaits any in-flight observer and refreshes the branch.** A belt-and-braces re-await catches the case where an observer fired between the trigger's await and the hook running (e.g., a user-initiated `/compact` while an observer was running). After awaiting, the hook re-reads `ctx.sessionManager.getBranch()` so any just-appended `om.observation` entry is visible.

**2. Detects and closes any raw gap.** Even after awaiting the observer, the `keepRecentTokens` window may have advanced *past* the last observation bound, leaving a gap of raw entries between the last `coversUpToId` and the new `firstKeptEntryId`. These are about to be pruned out of context but no observation covers them yet.

The **sync catch-up observer** fills this gap. It runs the same observer LLM synchronously over the gap range and appends a fresh `om.observation`. If this fails, **compaction is cancelled** rather than silently losing information — the next `/compact` (or the next trigger) will retry.

**3. Collects the delta.** Walks the session tree and gathers all `om.observation` records whose `coversFromId` falls inside `[priorFirstKeptEntryId, newFirstKeptEntryId)`. This is **coverage-based**, not tree-position-based. The distinction matters when a pending observation's chunk straddles the upcoming `firstKeptEntryId` — the whole observation is deferred to the next compaction cycle (when its `coversFromId` will fall inside that cycle's range) rather than being half-counted in this one.

**4. Merges with prior compaction state.** Reflections from the most recent prior `compaction.details` are carried forward as-is. Committed observations (from the prior `details.observations`) are unioned with the delta to form the **working observation pool**.

**5. Gates the reflector + pruner.** If the working pool exceeds `reflectionThresholdTokens` (default 30000), runs both LLM agents as an inseparable pair. (See [Inside the reflector + pruner](#inside-the-reflector--pruner) below.) Below the gate, both are skipped and the working sets carry through unchanged.

This means compaction is:
- **0 LLM calls** in early sessions or when the pool is small.
- **1 LLM call** when only the sync catch-up observer fires.
- **≥2 LLM calls** (reflector + one or more pruner passes) in steady state.

**6. Renders the summary.** Mechanical concatenation:

```
<CONTEXT_USAGE_INSTRUCTIONS preamble>

## Reflections
<reflection line>
<reflection line>

## Observations
YYYY-MM-DD HH:MM [relevance] ...
YYYY-MM-DD HH:MM [relevance] ...
```

No LLM is involved at this step. Sections are omitted if empty.

**7. Returns the payload to Pi.** `{ compaction: { summary, firstKeptEntryId, tokensBefore, details } }`. Pi appends a `compaction` entry with these fields. The summary becomes a `compactionSummary` message in the next turn's context; `details` becomes the cumulative state read by the *next* compaction.

## Inside the reflector + pruner

When the working observation pool exceeds the gate, two LLM agents run in sequence. They are **always run together** — see [Properties](#properties-whats-invariant) for why.

### Reflector

- Reads the current reflections + the full working observation pool.
- Calls `record_reflections` (append-only) one or more times to add new reflection lines crystallized from the pool.
- Never modifies or removes existing reflections. Duplicates against both `reflections` and within-run adds are silently discarded.
- Stops when nothing more is stable enough to crystallize.

A reflection is supposed to name a **durable pattern** (identity, hard constraint, durable preference, architectural decision), not a specific event. The reflector's prompt makes the distinction explicit and gives examples of good vs bad reflections.

### Pruner

- Reads the (now augmented) reflections + the full working observation pool.
- Calls `drop_observations` with ids to remove. **Cannot** merge, rewrite, or add observations — only drop by id. This is what keeps kept content byte-identical to what the observer originally wrote.
- Runs up to **5 passes** with a per-pass strategy tier:
  - **Pass 1** — clear-cut drops only. Exact duplicates, near-duplicates (keep the higher-relevance or more recent one), entries directly superseded by a newer one, routine `low` tool-call acks.
  - **Pass 2** — topic compression. Drop `low` observations covered by recent `medium`/`high`, drop `medium` observations whose substance is now in a reflection, collapse repeated tool-call sequences.
  - **Pass 3+** — aggressive age compression. In the older half of the pool, drop all but outcome-bearing entries. Keep the most recent ~30% at higher detail.
- Each pass targets `0.8 * reflectionThresholdTokens`. Passes stop early when:
  - The pool fits under the target, OR
  - A pass returns zero drops (the pruner refuses to force drops it doesn't believe in), OR
  - The LLM fails (the last good kept set is retained).

The pruner has **hard floors** that override pass strategies: `critical` observations are never dropped, user assertions are never dropped (even at `low`), and any observation carrying a unique named identifier, dated event, verbatim error, or rationale for a decision is kept unless an existing reflection captures the same information.

## Content format

Observations and reflections share a strict "single-line plain prose" rule, but their surrounding fields differ.

### Observation

A structured record with separate fields. Rendered as `YYYY-MM-DD HH:MM [relevance] content`.

```
ObservationRecord = {
  id: string           // 12-char hex of SHA-256(content)
  timestamp: string    // "YYYY-MM-DD HH:MM" local, 24h, to the minute
  content: string      // single-line plain prose
  relevance: "low" | "medium" | "high" | "critical"
}
```

Example: `2026-01-15 14:50 [medium] GraphQL migration completed; user confirmed queries working.`

### Reflection

Just a string of plain prose. No timestamp, no relevance tag, no prefix. A reflection names a durable pattern, not a specific event, so temporal metadata would be misleading.

Example: `User works at Acme Corp building Acme Dashboard on Next.js 15.`

### Strict format rules

The `content` string in both is strictly plain prose:
- No emojis
- No priority markers
- No `[tags]`
- No Markdown bullets
- No code fences
- No embedded structured fields ("key: value", JSON, etc.)

Timestamp and relevance live in **dedicated fields**, not inside the content. This strictness exists for three reasons:

1. The pruner must emit ids only, which means kept observations retain their original content, timestamp, and relevance byte-identically. Storing those as fields rather than as prefixes-to-be-re-parsed is what guarantees this.
2. The summary renderer is mechanical — formatting drift in any single entry would visibly leak into the actor's context.
3. Emoji and tag conventions drift across model versions; plain prose is stable.

Observation content is also capped at 10,000 characters; longer strings are truncated with a ` … [truncated N chars]` tail to keep the pool bounded even if the observer misbehaves.

## Relevance tiers

Relevance is assigned by the observer at write time and used by the pruner to decide drop priority.

| Tier | What it means | Drop behavior |
|---|---|---|
| **`critical`** | User identity, explicit corrections, concrete completions | **Never dropped**, regardless of age or budget pressure |
| **`high`** | Non-trivial technical decisions, architectural direction, unresolved blockers, key constraints | Dropped only when clearly superseded or covered by an existing reflection |
| **`medium`** | Task-level context. The default when the observer isn't sure | Dropped when redundant with reflections or other observations, or when the task moved on |
| **`low`** | Routine tool-call acks, repetitive status updates, content re-derivable from recent messages | Dropped first under pressure |

The pruner also honors a **content-level floor** that overrides the relevance tier:

- User assertions are never dropped, even when tagged `low`. ("User stated they are colorblind" stays even if mis-labeled.)
- Any observation carrying a unique named identifier, dated event, verbatim error, or rationale for a decision is kept unless an existing reflection already captures the same information.

## State persistence

The Pi session tree is the **only** source of truth. There is no external database, no on-disk sidecar, no closure cache that needs rebuilding.

Two entry types carry state:

### `om.observation`

A `custom` entry with `customType: "om.observation"`. Written by the observer.

```
data: {
  records: ObservationRecord[]   // observations from this chunk
  coversFromId: string           // first raw entry covered
  coversUpToId: string           // last raw entry covered
  tokenCount: number             // estimated token count
}
```

Append-only. Used by the next compaction's coverage-based delta walk.

### `compaction.details`

A typed payload on the `compaction` entry. Written by the compaction hook.

```
details: {
  type: "observational-memory"
  version: 3
  observations: ObservationRecord[]   // post-pruner kept set
  reflections: string[]               // cumulative, append-only across compactions
}
```

Cumulative branch-local state. Each new compaction reads the most recent prior `details` (the "committed" pool) and writes its own.

### Committed vs pending

These two entry types are how the `/om-status` and `/om-view` commands distinguish state:

- **Committed observations** = the `observations` array inside the most recent `compaction.details`. They've been counted, possibly pruned, and are visible to the actor through the current compaction summary.
- **Pending observations** = `om.observation` entries written since the last compaction. They're in the tree but haven't been folded into a summary yet.

### Branch isolation

Counters are recomputed from the branch on every check (pure on-demand). If you `/tree` to a different branch, each branch carries its own `compaction.details` chain and its own pending `om.observation` entries — memory is naturally branch-local without any extra bookkeeping.

## Cache-friendliness

A deliberate design constraint: **the actor LLM's prompt prefix should stay stable between compactions**.

If observations were injected into every turn (e.g., as a system-prompt suffix or a tail message), each new observation would invalidate the prefix cache and every turn would pay a cold-cache cost.

Instead:
- Observations live in silent tree entries (`om.observation` `custom` type) that the actor never sees.
- Reflections live inside `compaction.details`, also hidden from the actor.
- Both surface to the actor only at the next compaction, packaged into the new `compactionSummary` message.

The prefix shifts exactly once per compaction and then stays stable until the next one. This is the central trade-off versus a "live memory injection" design: the actor sees memory updates only at compaction boundaries, but caching keeps working between them.

## Async race handling

Three concurrency flags guard the system:

| Flag | What it guards |
|---|---|
| `observerInFlight` | Prevents two observers from racing on the same chunk |
| `compactInFlight` | Prevents the proactive trigger from firing twice |
| `compactHookInFlight` | Prevents the hook from re-entering itself |

### Late-landing observations

Observer is fired-and-forgotten. Late observations land in the tree at whatever index Pi assigns them. The next compaction's coverage-based walk (by `coversFromId`) picks them up regardless of where they landed in the tree, so a late landing cannot be dropped or double-counted.

### The two-await pattern at compaction time

Both the trigger and the hook await `observerPromise`:

1. **`turn_end` may launch an observer.** No data is lost; observations batch together.
2. **The compaction trigger awaits the observer first.** When raw tokens since the last compaction cross `compactionThresholdTokens`, the trigger `setTimeout(0)`s a task that awaits `observerPromise`, then re-checks `ctx.isIdle()` and the token count (another compaction may have happened during the wait), and only then calls `ctx.compact()`. `ctx.compact()` is never called with an observer still writing to the tree.
3. **`session_before_compact` awaits again and refreshes the branch.** A belt-and-braces re-await catches the case where an observer fired between the trigger's await and the hook running (e.g., a user-initiated `/compact`). After awaiting, the hook re-reads the branch so any just-appended `om.observation` entry is visible.

After those awaits, one last source of uncovered raw tokens remains: the `keepRecentTokens` window may have advanced *past* the last observation bound. The sync catch-up observer closes that gap. Failure cancels the compaction rather than silently losing information.

### No reflection race

Reflector and pruner run **synchronously** inside `session_before_compact`, on whatever data the branch holds at that moment. The `compactHookInFlight` flag cancels any duplicate hook re-entry. There is no separate reflection race to handle.

## Properties (what's invariant)

These are the load-bearing invariants of the system. If you're modifying the extension, don't break these.

### Pruner output is byte-identical to observer output

The pruner can only emit observation **ids** to drop. Kept observations retain their original `content`, `timestamp`, and `relevance` exactly as the observer wrote them. This is what makes the "what survives one compaction survives all of them verbatim" property hold — there is no paraphrase pass, ever.

### Pruner sees the full observation set, not just the delta

Each compaction is a chance to re-evaluate older observations against newer reflections. An observation that was kept three compactions ago can still be dropped now if a later reflection has captured its substance.

### Reflector and pruner share a single gate

Both run, or neither runs. Pruning is only safe once the long-lived facts in the pool have been crystallized into reflections — running pruner without reflector would lose information. Running reflector without pruner would let the pool grow forever.

### Reflections accumulate without bound

There is no reflection-pruning pass. Long-running sessions will see steady growth in the reflection block of every compaction summary. The design accepts this as the cost of preserving long-term memory and assumes session lifetime is bounded enough that growth stays manageable.

### No closure state survives recomputes

Counters are walked on every check from the current branch. The only closure state is concurrency flags (`observerInFlight`, `compactInFlight`, `compactHookInFlight`) and a promise handle for awaiting an in-flight observer. None of it is correctness-critical — wiping it would not cause memory loss, only momentary concurrency confusion.

### Observations are disjoint by construction

The `observerInFlight` flag prevents two observers from racing on the same chunk. Combined with the deferred coverage of in-flight ranges (`coversUpToId` is captured at fire time, not completion time), this means the unfiltered tree walk at compaction cannot produce duplicate observations.

### The Pi tree is the only source of truth

No external database, no on-disk sidecar, no in-memory authority that needs syncing. If you `/tree` to a branch, that branch's `compaction.details` and pending `om.observation` entries are exactly what observational memory will see — no extra bookkeeping is required.

---

## Where to go next

- **[concepts.md](concepts.md)** — vocabulary reference if any term above was unclear.
- **[configuration.md](configuration.md)** — every setting, what it trades off, and tuning recipes.
