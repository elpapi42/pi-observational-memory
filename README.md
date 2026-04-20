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
User works at Acme Corp building Acme Dashboard on Next.js 15 with Supabase auth.
Hard constraint: ship by January 22nd 2026.
Public API uses GraphQL (switched from REST to reduce mobile over-fetching).

## Observations
2026-01-15 14:30 [high] User decided to switch from REST to GraphQL for the public API; motivation was reducing over-fetching on mobile clients.
2026-01-15 14:35 [medium] Agent scaffolded GraphQL schema in src/schema.ts.
2026-01-15 14:50 [medium] GraphQL migration completed; user confirmed queries working.
2026-01-15 15:10 [critical] User wants rate limiting on all public endpoints; prefers token bucket algorithm at 100 req/min per API key.
```

Two layers of memory, two different jobs:

- **Reflections** are durable patterns — who you are, what you've decided, hard constraints. Plain prose, no timestamps. They crystallize once and persist across every future compaction.
- **Observations** are timestamped events with a per-entry relevance tier (`low` / `medium` / `high` / `critical`). They're written near-real-time, then pruned over time — but never paraphrased.

Hour six should feel like hour one. The agent knows who you are, what you've built together, and what's left to do.

## What you actually get from it

- **Continuity that survives many compactions.** The summary is built by mechanical concatenation, not an LLM rewrite. What survives one compaction survives all of them, byte-identical — there's no compounding drift across cycles.
- **Temporal reasoning.** Every observation carries a per-minute timestamp. The agent can reason about *when* something happened, not just *that* it happened.
- **Relevance-aware pruning.** Four relevance tiers drive what gets dropped first when the observation pool grows. Trivia goes; user assertions, decisions, and verbatim errors stay.
- **Reflections that crystallize.** Identity, constraints, and durable preferences settle into a separate layer that doesn't get re-paraphrased on each compaction.
- **Predictable token cost.** Properly configured for your use case, this can save real money. The reflector + pruner only run above a configurable gate, so most compactions cost **zero LLM calls** — just bookkeeping. The observer can be pointed at a cheap fast model independently of your main coding model.
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
    RP[Reflector + Pruner<br/>Reflector appends new reflections<br/>crystallized from the pool<br/>Pruner drops observations by id<br/>across up to 5 passes]
    Sum[Summary mechanically assembled<br/>## Reflections<br/>&nbsp;&nbsp;plain prose lines<br/>## Observations<br/>&nbsp;&nbsp;YYYY-MM-DD HH:MM relevance ...<br/>Becomes the compactionSummary<br/>the agent sees on the next turn]

    Conv -->|every ~1k raw tokens since last bound| Obs
    Obs -->|every ~50k raw tokens since last compaction| Comp
    Comp -->|observation pool ≥ 30k tokens| RP
    RP --> Sum
    Comp -.->|pool below gate — skip LLM calls| Sum
```

- **Observer** runs in the background as turns complete. The user never waits on it.
- **Compaction** is owned by the extension. The summary is *mechanically concatenated* from current reflections + current observations — never an LLM rewrite. This is what eliminates the summary-of-a-summary problem.
- **Reflector + Pruner** run as an inseparable pair, and only when there's enough material to crystallize. Below the gate, compaction does **zero LLM calls**.

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
    "reflectionThresholdTokens": 30000
  },
  "compaction": {
    "keepRecentTokens": 20000
  }
}
```

The five settings most worth knowing:

| Setting | Default | What it controls |
|---|---|---|
| `observationThresholdTokens` | `1,000` | How often the observer fires in the background |
| `compactionThresholdTokens` | `50,000` | How often the extension proactively triggers compaction |
| `reflectionThresholdTokens` | `30,000` | The observation pool size at which reflector + pruner engage |
| `compactionModel` | session model | Which model runs the observer / reflector / pruner — point at a cheaper one to save cost |
| `compaction.keepRecentTokens` | `20,000` | How much recent conversation Pi keeps verbatim post-compaction (Pi setting; structural to the extension) |

For the full list and tuning recipes, see **[docs/configuration.md](docs/configuration.md)**.

> **Upgrading from `pi-observational-memory@1.x`?** The config keys changed: v1's `observationThreshold` is now `compactionThresholdTokens`, v1's `reflectionThreshold` is now `reflectionThresholdTokens`, and `observationThresholdTokens` is new. Old v1 keys are silently ignored — update your `settings.json`.

## Commands

| Command | What it does |
|---|---|
| `/om-status` | Memory totals, percent-to-threshold for each gate, and in-flight flags for observer and compaction |
| `/om-view` | Full dump of memory state: every reflection, every committed observation, every pending observation. Each observation line is `[id] YYYY-MM-DD HH:MM [relevance] content` |

## Credits

Inspired by [Mastra's Observational Memory](https://mastra.ai/blog/observational-memory) research (94.87% on LongMemEval). This is an independent implementation built for Pi's extension system.

## License

MIT
