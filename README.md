# pi-observational-memory

> **Make long sessions feel endless.** A Pi extension that keeps your agent in hour six knowing what you decided in hour one.

---

## The cliff

Every long AI session has a cliff.

You're three hours in. The context window fills up. Compaction runs. Suddenly the agent doesn't remember what you decided in hour one. You start repeating yourself. The session that was flowing now feels like a new conversation with an amnesiac.

Worse, compaction often hits *mid-work* — right when you were about to ask the next question. Whatever the summary captured (and didn't) becomes what the agent knows from now on.

This is a universal problem for AI agents. Context windows are finite, sessions aren't, and the bridge between the two is fragile. Compactions are necessary, but they're also where memory degrades — the more you do, the further you drift from what was actually said and decided early in the session.

## What this gives you

`pi-observational-memory` runs an **observer** silently in the background while you work, summarizing the conversation in ~1k token chunks into a structured event log. When compaction runs, the extension assembles that log — plus stable long-term **reflections** crystallized from it — into the new summary.

What the agent sees after compaction looks like this:

```
## Reflections
[a1b2c3d4e5f6] User works at Acme Corp building Acme Dashboard on Next.js 15 with Supabase auth.
[b2c3d4e5f6a1] Hard constraint: ship by January 22nd 2026.
[c3d4e5f6a1b2] Public API uses GraphQL (switched from REST to reduce mobile over-fetching).

## Observations
[d4e5f6a1b2c3] 2026-01-15 14:30 [high] User decided to switch from REST to GraphQL for the public API; motivation was reducing over-fetching on mobile clients.
[e5f6a1b2c3d4] 2026-01-15 14:35 [medium] Agent scaffolded GraphQL schema in src/schema.ts.
[f6a1b2c3d4e5] 2026-01-15 14:50 [medium] GraphQL migration completed; user confirmed queries working.
[a6b1c2d3e4f5] 2026-01-15 15:10 [critical] User wants rate limiting on all public endpoints; prefers token bucket algorithm at 100 req/min per API key.
```

Two layers of memory, two different jobs:

- **Reflections** are durable patterns — who you are, what you've decided, hard constraints. They render as plain prose with an id handle when recallable, and persist across future compactions.
- **Observations** are timestamped events with an id and a per-entry relevance tier (`low` / `medium` / `high` / `critical`). They're written near-real-time, then pruned over time — but never paraphrased.

Those ids are not decoration. When the agent needs exact evidence behind a compacted memory item, it can call the agent-facing `recall` tool with a reflection or observation id. The TUI shows a compact evidence summary, while the agent receives the full raw source context that produced the memory.

Hour six should feel like hour one. The agent knows who you are, what you've built together, and what's left to do.

## What you actually get from it

- **Continuity across many compactions.** The summary is built by mechanical concatenation, not an LLM rewrite. Kept observations and reflections are carried forward without paraphrase; observations may be pruned later, but they are never rewritten into summary-of-summary drift.
- **Temporal reasoning.** Every observation carries a per-minute timestamp. The agent can reason about *when* something happened, not just *that* it happened.
- **Source-backed recall.** Observation and reflection ids let the agent recover the exact prior conversation/tool evidence behind compacted memory when precision matters.
- **Relevance-aware pruning.** Four relevance tiers drive what gets dropped first when the observation pool grows. Trivia goes; user assertions, decisions, and verbatim errors stay.
- **Reflections that crystallize.** Identity, constraints, and durable preferences settle into a separate layer that doesn't get re-paraphrased on each compaction.
- **Predictable token cost.** Properly configured for your use case, this can save real money. The reflector + pruner only run above a configurable gate, so below-gate compactions skip those LLM calls; they only call a model if sync catch-up observation is needed. The observer can be pointed at a cheap fast model independently of your main coding model.
- **Cache-friendly by design.** Memory updates are batched at compaction boundaries instead of injected into every turn, so prompt prefix caching keeps working between compactions.
- **Fewer mid-work surprises.** The extension proactively triggers compaction when the agent is idle, and this will not affect your current work as after compaction you still keep the tail of your session intact.

## Install

```bash
pi install npm:pi-observational-memory
```

Or from GitHub:

```bash
pi install git:github.com/elpapi42/pi-observational-memory
```

That's it. The extension hooks into Pi's lifecycle automatically. Defaults work well for most sessions — no config file needed to start.

## How it works (60-second version)

Three tiers, two of them mostly asynchronous:

```mermaid
flowchart TD
    Conv([Conversation accumulates])
    Obs[Observer<br/>async, fire-and-forget<br/>compresses each chunk into timestamped,<br/>relevance-tagged observations<br/>stored as silent tree entries]
    Comp[Compaction<br/>extension-owned; merges accumulated<br/>observations with prior compaction state]
    RP[Reflector + Pruner<br/>Reflector runs two focused passes<br/>to crystallize durable patterns<br/>Pruner drops observations by id<br/>across up to 2 passes]
    Sum[Summary mechanically assembled<br/>## Reflections<br/>&nbsp;&nbsp;[id] durable insight<br/>## Observations<br/>&nbsp;&nbsp;[id] YYYY-MM-DD HH:MM relevance ...<br/>Becomes the compactionSummary<br/>the agent sees on the next turn]

    Conv -->|every ~1k raw tokens since last bound| Obs
    Obs -->|live tail reaches ~50k raw tokens| Comp
    Comp -->|observation pool ≥ 30k tokens| RP
    RP --> Sum
    Comp -.->|pool below gate — skip reflector/pruner| Sum
```

- **Observer** runs in the background as turns complete. The user never waits on it.
- **Compaction** is owned by the extension. The summary is *mechanically concatenated* from current reflections + current observations — never an LLM rewrite. This is what eliminates the summary-of-a-summary problem.
- **Reflector + Pruner** run as an inseparable pair, and only when there's enough material to crystallize. Below the gate, those roles are skipped; compaction only calls a model if sync catch-up observation is needed for uncovered raw history.

The agent only ever sees the most recent compaction summary, packaged as a normal `compactionSummary` message. Observations and reflections are never injected into the live message stream — that would invalidate prefix caching with every observation. By batching memory updates at compaction boundaries, the prefix stays stable between compactions and prefix caching keeps working.

For the full picture, read on:

- **[docs/concepts.md](docs/concepts.md)** — vocabulary and mental model. Start here if you're new.
- **[docs/how-it-works.md](docs/how-it-works.md)** — the full lifecycle, data shapes, and async-race handling.
- **[docs/configuration.md](docs/configuration.md)** — every setting, what it trades off, and tuning recipes.

## Configuration in 30 seconds

Settings live in Pi's `settings.json` — globally at `~/.pi/agent/settings.json` or per-project at `.pi/settings.json` (project values override global).

```json
{
  "observational-memory": {
    "observationThresholdTokens": 1000,
    "compactionThresholdTokens": 50000,
    "reflectionThresholdTokens": 30000,
    "passive": false
  },
  "compaction": {
    "keepRecentTokens": 20000
  }
}
```

To run the background memory work (observer, reflector, pruner) on a cheaper / faster model than your main coding agent — often the single biggest cost lever the extension exposes — add `compactionModel`:

```json
{
  "observational-memory": {
    "compactionModel": { "provider": "openrouter", "id": "google/gemma-4-31b-it" }
  }
}
```

Nested agent-loop turns default to `16` for each memory role. To tune them (useful for controlling cost on large observation pools):

```json
{
  "observational-memory": {
    "observerMaxTurnsPerRun": 8,
    "reflectorMaxTurnsPerPass": 12,
    "prunerMaxTurnsPerPass": 12
  }
}
```

A turn is one assistant/model response cycle inside Pi's nested agent loop. These caps are checked after a turn finishes; they are not hard mid-stream interrupts and are not literal tool-call counters.

For memory model calls, you can also tune thinking effort with one unified setting. Valid values are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`; the default is `low`.

```json
{
  "observational-memory": {
    "thinkingLevel": "low"
  }
}
```

The settings most worth knowing:

| Setting | Default | What it controls |
|---|---|---|
| `observationThresholdTokens` | `1,000` | How often the observer fires in the background |
| `compactionThresholdTokens` | `50,000` | How often the extension proactively triggers compaction |
| `reflectionThresholdTokens` | `30,000` | The observation pool size at which reflector + pruner engage |
| `passive` | `false` | Disables proactive observation and extension-triggered compaction while keeping manual/Pi compaction and commands active |
| `compactionModel` | session model | Which model runs the observer / reflector / pruner — point at a cheaper one to save cost |
| `observerMaxTurnsPerRun` | `16` | Assistant-turn cap for each observer run |
| `reflectorMaxTurnsPerPass` | `16` | Assistant-turn cap for each reflector pass |
| `prunerMaxTurnsPerPass` | `16` | Assistant-turn cap for each pruner pass |
| `thinkingLevel` | `low` | Thinking effort for observer, reflector, and pruner calls; `off` omits Pi's reasoning option |
| `compaction.keepRecentTokens` | `20,000` | How much recent conversation Pi keeps verbatim post-compaction (Pi setting; structural to the extension) |

For shell/session-level control, `PI_OBSERVATIONAL_MEMORY_PASSIVE` overrides global and project settings. Use `1`, `true`, `yes`, or `on` to enable passive mode; use `0`, `false`, `no`, or `off` to force it off.

For the full list and tuning recipes, see **[docs/configuration.md](docs/configuration.md)**.

> **Upgrading from `pi-observational-memory@1.x`?** The config keys changed: v1's `observationThreshold` is now `compactionThresholdTokens`, v1's `reflectionThreshold` is now `reflectionThresholdTokens`, and `observationThresholdTokens` is new. Old v1 keys are silently ignored — update your `settings.json`.

## Commands and agent tool

| Surface | What it does |
|---|---|
| `/om-status` | Memory totals, percent-to-threshold for each gate, passive-mode status, and in-flight flags for observer and compaction |
| `/om-view` | Full dump of memory state: every reflection, every committed observation, every pending observation. Reflection and observation ids shown here can be used with `recall` |
| `recall` agent tool | Recovers exact source evidence for a specific reflection or observation id on the current branch. It is for agent self-recovery and provenance, not a user command, semantic search, or transcript browser |

## Credits

Inspired by [Mastra's Observational Memory](https://mastra.ai/blog/observational-memory) research (94.87% on LongMemEval). This is an independent implementation built for Pi's extension system.

## License

MIT
