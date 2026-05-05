# Concepts

This doc explains the vocabulary observational memory uses. Read it once and the rest of the documentation will read clearly.

## The big picture

Pi is an agent framework. Long sessions with any AI agent eventually run up against the model's context window: older messages have to be **compacted** — replaced with a summary, while recent ones stay verbatim. The shape of that summary determines what the agent remembers later in the session, and how well that memory holds up across many compactions in a row.

Observational memory builds the summary from a structured, tiered memory system that's maintained as the session happens, not all at once at compaction time. The summary becomes a mechanical concatenation of two structured pools — reflections and observations — instead of a single fresh LLM rewrite each cycle.

This page defines the vocabulary the rest of the docs use.

## The two memory layers

### Observations

An **observation** is a single timestamped event from the conversation. One short sentence of plain prose, plus source-aware metadata:

- An `id` — a 12-character handle the agent can use with `recall`
- A `timestamp` (`YYYY-MM-DD HH:MM`, local time, to the minute)
- A `content` string (single line, plain prose, no markdown, no emojis, no embedded tags)
- A `relevance` tier — one of `low`, `medium`, `high`, `critical`
- Source entry ids, stored silently on modern observations, that point back to the raw conversation/tool entries the observation came from

Rendered, it looks like this:

```
[d4e5f6a1b2c3] 2026-01-15 14:30 [high] User decided to switch from REST to GraphQL for the public API; motivation was reducing over-fetching on mobile clients.
```

Observations are written **continuously** by a background process called the **observer** as you work. They accumulate in the session tree. Over a long session, you'll have hundreds of them. Legacy observations created before source attribution may not have source ids; `recall` reports that honestly instead of inventing evidence.

### Reflections

A **reflection** is a stable, long-lived fact distilled from observations. It has no timestamp or relevance tier because it names a durable pattern, not a specific event. Modern reflections render with an id handle when recallable:

```
[a1b2c3d4e5f6] User works at Acme Corp building Acme Dashboard on Next.js 15.
```

That id lets the agent recover the observations and raw sources that support the reflection. Older legacy reflections may still appear as plain prose; migrated legacy reflections can have ids but no source provenance, so `recall` will report that no evidence is available rather than inventing it.

### Why two layers?

Different facts have different lifespans. "User confirmed tests pass on auth.ts" is a one-time event — it matters now, will probably be irrelevant in two hours, and definitely won't matter tomorrow. "User uses Postgres" is a fact about the project that will still be true next week.

Observations capture *everything* with timestamps so the agent can reason about *when* things happened. Reflections crystallize the patterns that emerge from those observations and are never paraphrased again.

## The three tiers (the actors that run)

The memory layers above are the *data*. Three separate processes are the *actors* that read and write that data.

### 1. Observer (continuous, asynchronous)

The observer runs in the background as turns complete. Every ~1k tokens of new conversation, it:

1. Reads the recent conversation chunk
2. Reads the existing reflections + observations so it knows what's already captured
3. Distills the new chunk into a batch of new observations
4. Writes them as a silent entry in the session tree

The observer is **fire-and-forget**. The user never waits on it. If a new observer needs to fire while one is already running, the trigger is skipped — tokens accumulate and the next turn picks them up.

### 2. Compaction (synchronous, owned by the extension)

When the live tail grows large enough (default: ~50k raw tokens from the latest compaction's `firstKeptEntryId`, or the whole branch before the first compaction), the extension calls Pi's `compact()`. This replaces the older messages in context with a single **compaction summary**.

Crucially: the summary itself is **not** written by an LLM. It's a deterministic concatenation of all current reflections followed by all current observations. This is what eliminates the "summary of a summary of a summary" degradation — kept observations and reflections are carried forward without paraphrase, though observations can still be pruned later.

### 3. Reflector + Pruner (synchronous, runs only at compaction, only above a gate)

If the observation pool is large enough (default: ≥30k tokens), two LLM agents run inside compaction as an inseparable pair:

- The **reflector** runs several focused passes over the full pool and crystallizes new long-lived patterns into reflections with supporting observation ids. It can merge new support into exact-content matches and promote legacy reflections when the same durable fact becomes source-backed.
- The **pruner** drops observations from the pool by id. It runs up to 5 passes, getting more aggressive each time, until the pool fits under ~80% of the budget. It cannot rewrite or merge observations — only drop them. It also sees advisory coverage tags (`uncited`, `cited`, `reinforced`) that indicate whether current reflections cite an observation.

They always run together. Pruning without reflecting first would lose information that hadn't yet been crystallized. Reflecting without pruning would let the observation pool grow forever.

Below the gate, both are skipped. Compaction in that case skips reflector/pruner LLM calls; it only calls a model if sync catch-up observation is needed for uncovered raw history.

## How the actor sees memory

The **actor** is your main coding agent — the one you're talking to. The actor only ever sees the most recent compaction summary, packaged as a normal `compactionSummary` message at the start of context.

Observations and reflections are **never injected into the live message stream**. They're stored quietly in the session tree until the next compaction folds them into a new summary.

This is a deliberate cache-friendliness choice. If we sprinkled fresh observations into every turn, every new observation would change the prompt prefix and invalidate prefix caching. By keeping memory updates batched at compaction boundaries, the prefix stays stable between compactions and prefix caching keeps working.

## Committed vs pending observations

The `/om-status` and `/om-view` commands distinguish two states for observations:

- **Committed observations** are folded into the most recent compaction's `details.observations`. They've already been counted by the reflector + pruner (if those ran) and will appear in the current compaction summary the actor sees.
- **Pending observations** are `om.observation` entries written since the last compaction. They live in the session tree but haven't been folded into a summary yet — they'll be merged into the working pool at the next compaction.

This split exists because the observer keeps writing between compactions. Pending observations are real, just not yet visible to the actor.

## Glossary, in one place

| Term | Meaning |
|---|---|
| **Observation** | One timestamped, relevance-tagged event with an id. Modern observations include source attribution; legacy ones may not. Plain prose content. Written by the observer. |
| **Reflection** | One durable pattern. Modern/migrated reflections may render with an id recall handle; native source-backed records cite supporting observations. |
| **Observer** | Async LLM agent that runs every ~1k raw tokens in the background, writing observations. |
| **Reflector** | LLM agent that runs at compaction (above the gate) to crystallize durable reflections and attach supporting observation ids. |
| **Pruner** | LLM agent that runs after the reflector to drop observations by id. Cannot rewrite, only drop; receives advisory coverage tags. |
| **Compaction** | The act of replacing older messages in context with a summary so the recent tail still fits. Owned by the extension. |
| **Compaction summary** | The text the actor sees in place of the older messages. A mechanical concatenation of reflections + observations. |
| **Actor** | Your main coding agent — the one the user is talking to. |
| **Raw tokens** | Tokens from message and custom_message entries — i.e. everything that projects to LLM messages. |
| **Last bound** | The latest raw entry already covered by an observation. The cutoff the observer trigger walks back to. |
| **Working observation pool** | At compaction time: prior committed observations + delta observations since last compaction + any sync-catch-up gap observation. The pool the reflector and pruner operate on. |
| **Committed observations** | Observations folded into the most recent compaction's `details`. Visible to the actor through the summary. |
| **Pending observations** | Observations written since the last compaction. In the tree, not yet in a summary. |
| **Sync catch-up observer** | A synchronous observer pass run inside compaction to cover any raw entries the async observer hasn't summarized yet. |
| **Gate** | The threshold (`reflectionThresholdTokens`, default 30k) above which the reflector + pruner engage. |
| **Branch** | One path through the session tree (root → leaf). Each branch has its own memory state through `compaction.details`. |
| **Recall** | Agent-facing tool that takes a specific observation/reflection id and returns exact source evidence from the current branch. Not search. |

## Where to go next

- **[how-it-works.md](how-it-works.md)** — the full lifecycle, data shapes, async-race handling, and the invariants the system maintains.
- **[configuration.md](configuration.md)** — every setting, what it trades off, and tuning recipes for common goals (lower cost, longer sessions, etc.).
