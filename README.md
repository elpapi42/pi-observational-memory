# pi-observational-memory

**Make Pi sessions feel endless.**

Every session has a cliff. You're three hours in, the context window fills up, compaction runs, and suddenly the agent doesn't remember what you decided in hour one. You start repeating yourself. The session that was flowing now feels like a new conversation with an amnesiac.

pi-observational-memory pushes that cliff out far enough that you stop thinking about it. It runs an **observer** continuously in the background while you work, summarizing the conversation in ~1k token chunks into a structured event log. When Pi compacts, the extension assembles that log — plus stable long-term **reflections** crystallized from it — into the compaction summary. The agent carries forward *what* you decided, *when*, *why*, and what's already done. Not as prose that degrades with each compaction cycle, but as structured memory that stays sharp.

```
## Reflections
User works at Acme Corp building Acme Dashboard on Next.js 15 with Supabase auth.
Hard constraint: ship by January 22nd 2026.
Public API uses GraphQL (switched from REST to reduce mobile over-fetching).

## Observations
2026-01-15 14:30 [high] User decided to switch from REST to GraphQL for the public API; motivation was reducing over-fetching on mobile clients.
2026-01-15 14:35 [medium] Agent scaffolded GraphQL schema in src/schema.ts.
2026-01-15 14:50 [medium] GraphQL migration completed; user confirmed queries working.
2026-01-15 15:10 [critical] User wants rate limiting on all public endpoints; prefers token bucket algorithm at 100 req/min per API key.
```

Observations carry a per-entry relevance tier (`low` / `medium` / `high` / `critical`) that drives pruning. Reflections are plain prose without timestamps — each one names a durable pattern, not a specific event.

Hour six should feel like hour one. The agent knows who you are, what you've built together, and what's left to do.

Pi's built-in compaction handles most sessions well — it tracks file operations, manages split turns, and keeps recent messages intact. This extension is for the sessions where "most" isn't enough: long builds, multi-feature sprints, and the kind of deep work where breaking flow to start a new session costs you more than the tokens.

Inspired by [Mastra's Observational Memory](https://mastra.ai/blog/observational-memory) research (94.87% on LongMemEval). This is an independent implementation built for Pi's extension system and compaction model.

## Why this matters

Pi's default compaction summarizes old messages into prose and tracks which files were read and modified. This works well for short-to-medium sessions. But prose summaries are inherently lossy in ways that compound over time — the third compaction summarizes a summary of a summary, and specific decisions, timestamps, and completion states get flattened.

Observational memory uses a different format that's designed to survive repeated compaction cycles:

| What you get | Why it matters |
|---|---|
| Per-minute timestamps | Temporal reasoning — agent knows *when* things happened |
| Continuous incremental summarization | Observations are written near-real-time, not all at once at compaction |
| Relevance tiers | Each observation is tagged `low` / `medium` / `high` / `critical`; the pruner keeps load-bearing entries and drops trivia |
| Reflections tier | Identity, decisions, and constraints crystallize and persist across compactions |
| Pruner pass | Multi-pass id-based drops remove outdated observations; reflections and user assertions survive |
| Mechanical summary assembly | The compaction summary is a deterministic concatenation, not an LLM rewrite — no compounding paraphrase loss |
| User assertions preserved | Statements about you ("I work at Acme") survive compression and aren't invalidated by later questions |
| Strict prose format | No emoji noise, no tag drift across model versions — just timestamped text |

## How it works

Three independent tiers, two of them mostly asynchronous:

```mermaid
flowchart TD
    Conv([Conversation accumulates])
    Obs[Observer<br/>async, fire-and-forget<br/>compresses chunk into timestamped,<br/>relevance-tagged observations<br/>stored as silent tree entries]
    Comp[Compaction<br/>sync catch-up observer over any<br/>uncovered raw gap, then merges<br/>delta observations with prior<br/>compaction state]
    RP[Reflector + Pruner<br/>Reflector appends new reflections<br/>crystallized from the pool<br/>Pruner drops observations by id<br/>across up to 5 passes — clear-cut,<br/>topic compression, aggressive age<br/>compression — until ≤ ~80% of budget<br/>No merge, no rewrite; only drop]
    Sum[Compaction summary mechanical<br/>## Reflections<br/>&nbsp;&nbsp;plain prose lines<br/>## Observations<br/>&nbsp;&nbsp;YYYY-MM-DD HH:MM relevance ...<br/>Becomes the compactionSummary<br/>the agent sees on the next turn]

    Conv -->|every ~1k raw tokens since last bound| Obs
    Obs -->|every ~50k raw tokens since last compaction| Comp
    Comp -->|observation pool ≥ 30k tokens| RP
    RP --> Sum
    Comp -.->|pool below gate — skip LLM calls| Sum
```

**Observer** is async and runs in the background as turns complete — the user never waits on it. **Compaction** is synchronous and owned by the extension; when the working observation pool is small, no reflector/pruner LLM call runs at all (compaction is then 0 LLM calls). When it's above the gate, the reflector and pruner run as an inseparable pair — pruning is the consequence of reflection, not a separate cleanup step.

The actor LLM sees the latest compaction summary as a normal `compactionSummary` message — observations and reflections are never injected into the live message stream. This is a deliberate cache-friendliness choice: the conversation prefix stays stable until the next compaction, so prefix caching keeps working between turns.

For the full technical breakdown — entry shapes, async-race handling, summary assembly, configuration interactions — see **[docs/how-it-works.md](docs/how-it-works.md)**.

## Install

```bash
pi install npm:pi-observational-memory
```

Or from GitHub:

```bash
pi install git:github.com/elpapi42/pi-observational-memory
```

That's it. The extension hooks into Pi's lifecycle automatically. No config file needed to start — defaults work well for most sessions.

## Configuration

Observational memory's behavior is shaped by settings in Pi's `settings.json` — globally at `~/.pi/agent/settings.json`, or per-project at `.pi/settings.json`. Project values override global. Two namespaces matter: the extension's own keys under `observational-memory`, and one of Pi's built-in compaction keys (`keepRecentTokens`) that is structural to how the extension works.

```json
{
  "observational-memory": {
    "observationThresholdTokens": 1000,
    "compactionThresholdTokens": 50000,
    "reflectionThresholdTokens": 30000
  },
  "compaction": {
    "keepRecentTokens": 20000
  }
}
```

### `observationThresholdTokens` — default `1,000`

Raw conversation tokens that accumulate since the last observation (or compaction, whichever is more recent) before the observer fires asynchronously on `turn_end`. This is also roughly the size of the chunk each observer call digests.

Lower values mean finer-grained observations and more frequent background LLM calls. Higher values mean coarser, denser observations at lower cost, but also longer stretches of raw conversation with no running summary — if a compaction hits in that window, the sync catch-up observer at compaction time picks up the slack.

### `compactionThresholdTokens` — default `50,000`

Raw conversation tokens that accumulate since the last compaction before the extension proactively calls `ctx.compact()` on `agent_end`. The trigger waits until the agent is idle and any in-flight observer has completed.

Lower values compact more often — more chances for the reflector + pruner to crystallize and clean up, but more LLM cost over a session. Higher values let observations pool up longer; if Pi's own auto-compaction fires first under window pressure (see `reserveTokens`), the extension's hook still handles the summary.

### `reflectionThresholdTokens` — default `30,000`

Working observation pool token size (committed + delta observations, measured at compaction time) at which the reflector + pruner pair engages inside a compaction. Below this gate, both are skipped and the pool carries through unchanged — compaction is **0 LLM calls**. At or above it, the reflector appends new reflections and the pruner drops ids across up to 5 passes until the pool fits under ~80% of this budget — compaction is **≥2 LLM calls**.

Lower values crystallize reflections earlier and keep the observation pool tight. Higher values let the pool grow before cleaning it up — cheaper per compaction, but larger summaries in the interim.

### `compactionModel` — default: session model

Optional `{ "provider": "...", "id": "..." }` override for the observer, reflector, and pruner. All three background roles share this setting — they don't need the same capabilities as your main coding agent, so pointing them at a cheaper, faster model is usually the right move.

```json
{
  "observational-memory": {
    "compactionModel": { "provider": "openrouter", "id": "google/gemma-4-31b-it" }
  }
}
```

### `keepRecentTokens` — Pi setting under `compaction`; default `20,000`

Tokens of recent conversation Pi keeps **verbatim** during compaction — the raw tail that is *not* replaced by the compaction summary. This defines the `firstKeptEntryId` cutoff Pi passes to `session_before_compact`.

This setting is structural to the extension, not just a tuning knob:

- It determines the **raw gap** the sync catch-up observer has to cover at each compaction (entries between the last observation bound and `firstKeptEntryId` — raw content about to be pruned that no observation covers yet).
- It determines which **pending observations get deferred** to the next cycle (those whose chunks straddle `firstKeptEntryId`; they'll be collected when their `coversFromId` falls inside the next cycle's range).
- It determines how much **raw conversation the agent still sees** alongside the compaction summary.

Higher values leave more conversation verbatim (smaller gap, fewer deferred observations, but less context room for the summary). Lower values compress more aggressively and rely more heavily on observations and reflections to carry continuity.

### `reserveTokens` — Pi setting under `compaction`; default `16,384`

Tokens Pi reserves for the LLM response. Pi auto-compacts when the context exceeds `contextWindow − reserveTokens`. For the extension this is the safety net: if `compactionThresholdTokens` hasn't been crossed yet when window pressure hits, Pi will trigger compaction anyway, and the extension's `session_before_compact` hook runs the same way.

### How Pi and the extension cooperate

Pi and the extension are independent triggers into the same `session_before_compact` hook:

1. **Extension trigger** — raw tokens since the last compaction exceed `compactionThresholdTokens`, the agent is idle, and no observer is in flight.
2. **Pi auto-compaction** — context approaches `contextWindow − reserveTokens`.
3. **Manual `/compact`** — user-triggered.

The extension's hook fully replaces Pi's default LLM summarizer regardless of which side triggered. Pi owns *when* to keep messages raw (`keepRecentTokens`) and *when* to force-compact under window pressure (`reserveTokens`); the extension owns *how* to compact (mechanical summary assembly), *when to proactively trigger* (`compactionThresholdTokens`), *how often observations are captured* (`observationThresholdTokens`), *when reflection + pruning engage* (`reflectionThresholdTokens`), and *which model* drives observer/reflector/pruner (`compactionModel`).

> Upgrading from `pi-observational-memory@1.x`? The config keys changed: v1's `observationThreshold` is now `compactionThresholdTokens`, v1's `reflectionThreshold` is now `reflectionThresholdTokens`, and `observationThresholdTokens` is new. Old v1 keys are silently ignored — update your `settings.json`.

## Commands

| Command | Description |
|---|---|
| `/om-status` | Memory totals (reflections, committed vs pending observations, relevance histogram) plus activity counters: tokens since last bound / last compaction / current observation pool, percent-to-threshold for each gate, and in-flight flags for the observer and compaction |
| `/om-view` | Full dump of memory state: reflections, committed observations (folded into the last compaction), and pending observations (recorded since). Each observation line is `[id] YYYY-MM-DD HH:MM [relevance] content`. |

## Design decisions

**Why three tiers instead of two.** Observer, reflector, and pruner are separated by cadence: observation runs continuously (and cheaply) so the working set is always fresh; reflection and pruning run only at compaction time and only when there's enough material to crystallize. This keeps per-turn latency low and makes compaction itself usually a no-LLM operation.

**Why the summary is mechanical.** Each compaction summary is a deterministic concatenation of `details.reflections` + `details.observations`, never an LLM rewrite. This eliminates the compounding-paraphrase problem of nested summaries — what survives one compaction survives all subsequent ones verbatim, until the pruner explicitly drops it by id. The pruner cannot rewrite observations, which is what makes this property hold.

**Why reflector and pruner always run together.** Pruning is only safe once the long-lived facts in the observation pool have been crystallized into reflections. Running pruner without reflector would lose information; running reflector without pruner would let the observation pool grow forever. They share a single gate (`reflectionThresholdTokens`) and either both run or neither does.

**Why the actor doesn't see live observations.** Injecting fresh observations into every turn would invalidate prefix caching with each new entry — every turn would be a cold cache for the prompt. By keeping observations out of the live message stream and only surfacing them through the next compaction summary, the prefix stays stable between compactions and caching keeps working.

**Why memory lives in the session tree.** State is stored in Pi's session entries — `om.observation` custom entries for the delta and `compaction.details` for the cumulative reflection + observation set. No external database, no filesystem state, no separate sync. The Pi tree is the only source of truth; closure state is just a handful of concurrency flags (observer in-flight, compaction trigger in-flight, compaction hook in-flight) and a promise handle for awaiting an in-flight observer. If you `/tree` to a branch, each branch carries its own memory state through `compaction.details`.

## License

MIT
