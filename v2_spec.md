# OM — Observational Memory for pi

## Concept

Incremental, mostly-async memory in two tiers. An observer compresses ~1k chunks of raw conversation into silent `om.observation` tree entries (async, every ~1k raw tokens since the last bound). Compaction is owned by the extension: when raw tokens since last compaction reach the threshold, it walks the tree to collect accumulated observations and merges them with prior compaction state. If the observation pool is large enough, two sequential LLM calls run as a unit — first a reflector that crystallizes observations into new reflections, then a pruner that rewrites the observation set down to what is still worth keeping. The two are inseparable: pruning is the consequence of reflection, not an independent cleanup pass. Below the gate, both are skipped and observations carry through untouched. The compaction summary is always a mechanical concatenation of reflections plus observations; LLMs never write the summary directly.

The agent's LLM only ever sees the most recent pi `compaction.summary`. Observations and reflections are never directly visible to it.

## Source of truth

The pi tree is the **only** source of truth. No disk sidecar, no in-memory authority, no closure-level counter caches. Counters are recomputed from a branch walk on every check (pure on-demand).

## Entry shapes

- `om.observation` — `{ content, coversFromId, coversUpToId, tokenCount }`. Append-only `custom` entry written by the observer. Cover IDs are needed here for the async-race filter at the next compaction.
- `compaction.details` — `{ reflections: Reflection[], observations: Observation[] }`. Cumulative branch-local state.
  - `Reflection` and `Observation` (inside `compaction.details`) share the narrow shape: `{ content, tokenCount }`. Cover IDs are intentionally dropped because the pruner LLM may merge or rewrite content.

## Content format

The `content` field of every observation and reflection follows a strict format:

```
YYYY-MM-DD HH:MM <text>
```

The timestamp is the local time at which the entry was generated, to the minute. The text is plain prose. **No emojis, no tags, no priority/importance markers, no structured fields embedded in the text.** The pruner LLM, the reflector LLM, and the summary renderer all rely on this format; outputs from observer, reflector, and pruner LLMs must conform.

## Tiers

| Tier | Trigger | Action | Blocking |
|---|---|---|---|
| Observation | raw tokens since last bound ≥ 1k | observer LLM (chunk + prior observations in prompt) → `om.observation` | async |
| Compaction | raw tokens since last compaction ≥ 50k | own `session_before_compact`; walk observations, merge with prior `details`; if total observations ≥ 30k, run reflector LLM then pruner LLM sequentially; concatenate reflections + observations as summary | sync, **0 or 2 LLM calls** |

Definitions:
- "Raw tokens" = sum of estimated tokens over entries projecting to LLM messages (`message`, `custom_message`).
- **"Last bound"** for observation triggering = the more recent of the most recent `om.observation` and the most recent `compaction` on the branch. Walking only to the last `om.observation` would re-count raw entries already baked into a prior compaction summary; using the more recent of the two prevents that.
- "Raw tokens since last compaction" = walk back to most recent `compaction` on branch, sum raw tokens after it.

## Observer

Fires on `turn_end`. Async, fire-and-forget.

1. Recompute "raw tokens since last bound" from the current branch.
2. If under 1k or `observerInFlight` is `true`, skip.
3. Set `observerInFlight = true`. Capture:
   - `coversFromId` = id of the first raw entry after the last bound.
   - `coversUpToId` = current leaf id at fire time (entries landing during the LLM call are deferred to the next observer).
4. Run observer LLM with: prior observations (full `details.observations` from most recent compaction + every `om.observation` content appended since), and the raw chunk in `[coversFromId, coversUpToId]` rendered as serialized conversation.
5. Append `om.observation` `custom` entry with `{ content, coversFromId, coversUpToId, tokenCount }`. `tokenCount` is the estimated token count of `content`.
6. Emit `om.observation-generated` on `pi.events` (informational; no internal consumer).
7. Clear `observerInFlight`.

`observerInFlight` is required: back-to-back agent loops or fast turn cadence can otherwise race two observers against the same range. The skipped trigger is harmless — the counter keeps growing and the next `turn_end` will catch up.

## Compaction trigger

Fires on `agent_end`. Sync intent, but defers via `setTimeout(..., 0)` so `ctx.compact()` runs outside the agent loop (per pi gotcha: mid-loop compaction is unsafe).

1. If `compactInFlight` is `true`, skip.
2. Recompute "raw tokens since last compaction" from the current branch.
3. If under 50k, return.
4. Set `compactInFlight = true`. Defer; on the next tick check `ctx.isIdle()`. If still idle, call `ctx.compact()` with `onComplete`/`onError` clearing the flag.

## Compaction assembly

On `session_before_compact`:

1. Read pi's proposed `firstKeptEntryId` from `event.preparation`.
2. Find prior `compaction` entry on branch (or root).
3. Walk `[prior.firstKeptEntryId, new.firstKeptEntryId)` collecting `om.observation` entries. Filter any whose `coversUpToId` precedes prior's `firstKeptEntryId` (async-race guard for late observer landings).
4. Merge with prior `compaction.details`:
   - working reflection set = prior.reflections (carried forward as-is)
   - working observation set = prior.observations ∪ delta observations (each delta observation contributes a new `{ content, tokenCount }` entry; cover IDs from the tree entry are dropped at this point)
5. **If working observation token count ≥ 30k**, run reflector and pruner as an inseparable pair:
   - **Reflector LLM call**: input = working reflections + working observations (rendered as prose blocks). Output = new reflection prose blocks (delimited by blank lines). Each new reflection is appended to the working reflection set as `{ content, tokenCount }`.
   - **Pruner LLM call**: input = updated working reflections + working observations (rendered as prose blocks). Output = the kept observations as verbatim prose blocks in the strict format. The LLM may merge or rewrite observations freely. Replace the working observation set with the parsed output.

   Below the gate (observations < 30k): skip both calls; working sets carry through unchanged.
6. New `details = { reflections: working reflection set, observations: working observation set }`.
7. Render `details` to `summary`: mechanical concatenation under section headers — reflections (as-is) followed by observations. No LLM involved at this step.
8. Return `{ compaction: { summary, firstKeptEntryId, tokensBefore, details } }`. Pi auto-sets `fromHook=true` when persisting; we do not include it in the payload.

Compaction is therefore one of two shapes per fire: 0 LLM calls (early sessions, sparse observations) or 2 LLM calls (steady state). Never 1.

## Hook wiring

- `turn_end` — observation trigger; fire-and-forget observer if threshold met and `observerInFlight` is false.
- `agent_end` — compaction trigger; defers `ctx.compact()` via `setTimeout` if threshold met and `compactInFlight` is false.
- `session_before_compact` — own it; perform compaction assembly above.
- `pi.events.emit('om.observation-generated', ...)` — emitted after observer lands. Informational only; no internal consumer.

`session_start` and `session_tree` are deliberately not registered. With pure on-demand recompute there is no closure cache to rebuild on session lifecycle or tree navigation.

## Model selection

A single model is used for observer, reflector, and pruner. Default is `ctx.model` (the active session model). Override is `config.compactionModel = { provider, id }` resolved against `ctx.modelRegistry`. If the configured override is missing at runtime, log via `ctx.ui.notify` and fall back to `ctx.model`.

## Async race handling

Observer is fired-and-forgotten. Late observations land in the tree with `coversUpToId` set; the next compaction walk filters out any whose range is already baked into prior `details`. No locks needed beyond `observerInFlight`.

There is no separate reflection race because reflection happens synchronously inside compaction, on the data it has at that moment.

## Commands

- `/om-status` — print counters: raw tokens since last bound, raw tokens since last compaction, current `details.observations` and `details.reflections` token totals, configured thresholds, pi `keepRecentTokens`.
- `/om-view` — print full `details.reflections` and `details.observations` from the most recent compaction. `--full` additionally dumps the raw uncompacted tail.

## Properties and known characteristics

- **Pruner output is a list of observations** in the same strict format, not a prose blob. The LLM may merge or rewrite observations as it sees fit.
- **Pruner sees the full observation set**, not just the delta. Each compaction is a chance to re-evaluate older observations against newer reflections.
- **Reflector and pruner share a single gate** (`observations ≥ 30k`). They always run as a pair, never independently.
- **Reflections accumulate without bound** in `details.reflections`. There is no reflection-pruning pass. Long-running sessions will see steady growth in the reflection block of every compaction summary; the design accepts this as the cost of preserving long-term memory and assumes session lifetime is bounded enough that growth stays manageable.
- **No closure state survives recomputes.** Counters are walked on every check. `observerInFlight` and `compactInFlight` are the only non-trivial closure flags, and they only guard concurrency, not correctness.

---

# Appendix: pi concepts referenced

A short cheat sheet of the pi APIs and concepts this spec leans on. See pi extension reference for full details.

## Tree model

pi sessions are append-only trees of typed entries, each with `{ type, id, parentId, timestamp }`. `parentId === null` is root. A **branch** is the path from any leaf back to root via `parentId` walk. Entries are **immutable** — there is no edit or delete API. State changes are new entries.

`buildSessionContext` projects a branch into LLM messages: it emits the **most recent** `compaction` entry's summary first (as a `compactionSummary` role message), then the kept tail starting at `firstKeptEntryId`. Prior compactions are not emitted — each new compaction must carry forward whatever long-term content needs to survive.

## Entry types used

- **`message`** — projected to LLM as user / assistant / toolResult / custom / bashExecution. Counts toward "raw tokens."
- **`custom_message`** — extension-controlled message projected to LLM with `custom` role. Also counts toward "raw tokens."
- **`compaction`** — `{ summary, firstKeptEntryId, tokensBefore, details?, fromHook? }`. Substitutes everything before `firstKeptEntryId` with `summary` in the LLM message stream. The `details: T` slot is a typed extension-controlled payload, hidden from the LLM, persisted, branch-local. This spec uses it as the canonical store of accumulated reflections + observations. `fromHook` is auto-set to `true` by pi when the payload comes from `session_before_compact`.
- **`custom`** — `{ customType, data? }`. Pure extension state, never reaches LLM. This spec uses it for `om.observation` only.

## Hooks used

- **`turn_end`** — fires after each agent turn completes. Used here as the observer trigger.
- **`agent_end`** — fires once after the full agent loop ends. Used here as the compaction trigger; defers `ctx.compact()` via `setTimeout` to keep it outside the loop.
- **`session_before_compact`** — fires before pi's compaction LLM call. Returning `{ compaction: { summary, firstKeptEntryId, tokensBefore, details } }` fully replaces pi's default summarizer. This spec owns this hook.

## Write APIs used

- **`pi.appendEntry(customType, data?)`** — appends a `custom` entry. Used for `om.observation`.
- **Return value of `session_before_compact`** — the structured `compaction` payload. Pi persists it and auto-sets `fromHook=true`.

## Read APIs used

- **`getBranch(leafId?)`** — returns the path from leaf to root. Used for counter recomputation and the compaction-assembly walk.
- **`getLeafId()` / `getLeafEntry()`** — current branch tip; used to capture `coversUpToId` at observer fire time.

## Inter-extension event bus

- **`pi.events.emit / on`** — used to publish `om.observation-generated` after an observer call completes. Informational; no internal consumer in this spec.

## Key invariants leaned on

- Entries are immutable → "pruning" cannot delete observation entries; it operates on the working set in `compaction.details`.
- `compaction.details<T>` is branch-local and hidden from LLM → safe canonical store.
- Only the most recent `compaction.summary` is shown to the LLM → each new compaction must carry forward all surviving long-term content.
- Tool calls and their tool results must stay adjacent in message context (not relevant to OM directly since we never inject into the message stream, but worth noting if injection ever becomes necessary).
