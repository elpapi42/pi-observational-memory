# How Observational Memory Works

## The Problem

Pi agents lose context when the conversation grows beyond the model's context window. Pi handles this through **compaction** — summarizing older messages so recent ones fit. The default compaction produces a flat summary that loses structure, priority, and temporal ordering. Over long sessions, the agent forgets what matters.

## The Solution: Two-Tier Memory

This extension replaces Pi's default compaction with a two-tier system:

```
┌─────────────────────────────────────────────┐
│              Agent Context                  │
│                                             │
│  ┌────────────────────────────────────────┐ │
│  │ System prompt                          │ │
│  └────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────┐ │
│  │ Reflections (stable long-term facts)   │ │
│  │ - User identity, preferences           │ │
│  │ - Architectural decisions              │ │
│  │ - Permanent constraints                │ │
│  └────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────┐ │
│  │ Observations (timestamped event log)   │ │
│  │ - Priority-tagged entries              │ │
│  │ - Grouped by date                      │ │
│  │ - Append-only until reflector runs     │ │
│  └────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────┐ │
│  │ Recent raw messages (kept by Pi)       │ │
│  └────────────────────────────────────────┘ │
│                                             │
└─────────────────────────────────────────────┘
```

The agent always sees three layers: reflections at the top, observations in the middle, and the most recent uncompacted messages at the bottom.

## Compaction Lifecycle

### 1. Trigger

After each agent turn, the extension estimates the token count of raw messages accumulated since the last compaction. When this exceeds the `observationThreshold` (default: 50,000 tokens), compaction is triggered — but only if the agent is idle, to avoid interrupting active work.

### 2. Observer Pass

An LLM reads the conversation messages being compacted and compresses them into **observations**: concise, timestamped, priority-tagged entries.

```
Date: 2025-04-15
- 🔴 14:30 User decided to switch from REST to GraphQL for the public API
  - 🟡 14:32 Motivation: reduce over-fetching on mobile clients
- 🟢 14:35 Agent scaffolded GraphQL schema in src/schema.ts
- ✅ 14:50 GraphQL migration completed — user confirmed queries working
```

Priority levels:
- **🔴 Important** — goals, decisions, constraints, errors
- **🟡 Maybe important** — questions, preferences, config details
- **🟢 Info** — routine operations, minor details
- **✅ Completed** — resolved tasks (prevents the agent from re-doing finished work)

New observations are **appended** to existing ones. Nothing is lost at this stage.

### 3. Reflector Pass

The reflector only runs when accumulated observations exceed the `reflectionThreshold` (default: 30,000 tokens). It performs three operations:

- **Promote**: Observations that represent stable, long-lived facts (user identity, project architecture, permanent constraints) are promoted to reflections. The original observation is kept.
- **Prune**: Observations that are clearly dead — completed tasks no longer referenced, superseded information, exact duplicates — are removed.
- **Keep**: Everything else survives. The reflector is intentionally conservative; being old or low-priority is not a reason to prune.

This means observations grow freely between reflector runs, and the reflector acts as a garbage collector that only removes what it's confident is no longer needed.

### 4. Summary Injection

The resulting `<reflections>` and `<observations>` block becomes Pi's compaction summary, injected at the top of the agent's context on the next turn. Pi still keeps recent raw messages (controlled by its `keepRecentTokens` setting), so the agent sees structured memory plus recent conversation.

## State Persistence

Memory state is stored in Pi's session entries as compaction `details`. On session start, the extension walks backward through session entries to find the last compaction with observational-memory details and restores from it. No external database or filesystem state is needed — memory lives inside the session itself.

## Design Principles

**Observations are append-only.** Between reflector runs, no information is lost. This makes the observer simple — it only needs to compress new messages, not decide what to keep.

**The reflector is conservative.** It only prunes what it's certain is dead. Completion markers (✅) are preserved so the agent knows what's already done. User assertions ("I work at Acme") always take precedence over questions about the same topic.

**User messages are captured near-verbatim.** When the context window shrinks, observations become the only record of what the user said. Short messages are preserved exactly; long ones are summarized with key phrases quoted.

**State changes are explicit.** When a user changes something ("switching from A to B"), the observation notes both the new state and what it replaces, so the agent doesn't act on stale information.

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

The `keepRecentTokens` setting is especially important: it controls the size of the "Recent raw messages" block in the agent context diagram above. A higher value means the agent retains more uncompressed conversation at the cost of less room for the compaction summary. A lower value compresses more aggressively, relying more heavily on observations and reflections.

### Extension config

Configured under the `observational-memory` key in Pi's `settings.json` — globally at `~/.pi/agent/settings.json`, or per-project at `.pi/settings.json`. Project values override global.

```json
{
  "observational-memory": {
    "observationThreshold": 50000,
    "reflectionThreshold": 30000
  }
}
```

| Parameter | Default | Effect |
|-----------|---------|--------|
| `observationThreshold` | `50,000` tokens | How much raw conversation accumulates before the extension triggers compaction via `ctx.compact()`. |
| `reflectionThreshold` | `30,000` tokens | How large observations grow before the reflector pass runs. |
| `compactionModel` | session model | Optional `{ "provider": "...", "id": "..." }` to use a different model for observer/reflector passes. |

### How the two interact

Pi's auto-compaction and the extension's own trigger are independent:

1. **Extension trigger** — after each agent turn, the extension checks if raw message tokens exceed `observationThreshold`. If so, it calls `ctx.compact()`, which starts Pi's compaction flow.
2. **Pi's auto-compaction** — Pi independently triggers compaction when context approaches the window limit (governed by `reserveTokens`). This can fire before the extension's threshold is reached if the context window is small.

In both cases, once compaction starts, Pi calls the `session_before_compact` event. The extension intercepts this event and runs its observer/reflector passes instead of Pi's default summarizer.

The split means:
- **Pi decides** how many recent messages to keep raw (`keepRecentTokens`) and when the context is critically full (`reserveTokens`).
- **The extension decides** when to proactively compact (`observationThreshold`), when to promote observations to reflections (`reflectionThreshold`), and what model to use.

Lower `observationThreshold` values mean more frequent compaction (more LLM calls, tighter memory). Higher values let more raw conversation accumulate before compression. The `compactionModel` option lets you offload compaction to a cheaper or faster model, since the observer and reflector don't need the same capabilities as the main coding agent.
