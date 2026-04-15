# pi-observational-memory

**Make Pi sessions feel endless.**

Every session has a cliff. You're three hours in, the context window fills up, compaction runs, and suddenly the agent doesn't remember what you decided in hour one. You start repeating yourself. The session that was flowing now feels like a new conversation with an amnesiac.

pi-observational-memory pushes that cliff out far enough that you stop thinking about it. It replaces Pi's compaction summary with a two-tier memory system — **observations** (a timestamped, priority-tagged event log) and **reflections** (stable long-term facts) — so the agent carries forward *what* you decided, *when*, *why*, and what's already done. Not as prose that degrades with each compaction cycle, but as structured memory that stays sharp.

```
<reflections>
- User works at Acme Corp, building "Acme Dashboard"
- Stack: Next.js 15, Supabase auth, server components with client-side hydration
- Hard constraint: ship by January 22nd 2026
</reflections>

<observations>
Date: 2026-01-15
- 🔴 14:30 User decided to switch from REST to GraphQL for the public API
  - 🟡 14:32 Motivation: reduce over-fetching on mobile clients
- 🟢 14:35 Agent scaffolded GraphQL schema in src/schema.ts
- ✅ 14:50 GraphQL migration completed — user confirmed queries working
- 🔴 15:10 User wants rate limiting on all public endpoints
  - 🟡 15:12 Prefers token bucket algorithm, 100 req/min per API key
</observations>
```

Hour six should feel like hour one. The agent knows who you are, what you've built together, and what's left to do.

Pi's built-in compaction handles most sessions well — it tracks file operations, manages split turns, and keeps recent messages intact. This extension is for the sessions where "most" isn't enough: long builds, multi-feature sprints, and the kind of deep work where breaking flow to start a new session costs you more than the tokens.

Inspired by [Mastra's Observational Memory](https://mastra.ai/blog/observational-memory) research (94.87% on LongMemEval). This is an independent implementation built for Pi's extension system and compaction model.

## Why this matters

Pi's default compaction summarizes old messages into prose and tracks which files were read and modified. This works well for short-to-medium sessions. But prose summaries are inherently lossy in ways that compound over time — the third compaction summarizes a summary of a summary, and specific decisions, timestamps, and completion states get flattened.

Observational memory uses a different format that's designed to survive repeated compaction cycles:

| What you get | Why it matters |
|---|---|
| 🔴 Priority tags | Agent knows what's important vs. what's noise |
| Timestamps | Temporal reasoning — agent knows *when* things happened |
| ✅ Completion markers | Agent won't redo finished work |
| State change tracking | "Switched from A to B" — no stale decisions |
| User quotes preserved | Your exact words survive compression |
| Reflections tier | Identity and constraints never get pruned |

## How it works

Two LLM passes intercept Pi's compaction to produce structured output instead of prose:

```
Raw messages accumulate
        │
        ▼  exceeds observationThreshold (default: 50k tokens)
   ┌─────────┐
   │ Observer │──▶ Compresses messages into timestamped,
   └─────────┘    priority-tagged observations. Append-only.
        │
        ▼  observations exceed reflectionThreshold (default: 30k tokens)
  ┌───────────┐
  │ Reflector │──▶ Promotes stable facts to reflections.
  └───────────┘    Prunes only what it's certain is dead.
        │
        ▼
  ┌──────────────────────────────┐
  │ Agent context:               │
  │  1. System prompt            │
  │  2. Reflections (stable)     │
  │  3. Observations (event log) │
  │  4. Recent raw messages      │
  └──────────────────────────────┘
```

The observer is aggressive — it compresses everything into dense observations. The reflector is conservative — it only prunes what's clearly dead. Between reflector runs, no information is lost.

For the full technical breakdown — compaction lifecycle, state persistence, configuration interactions — see **[docs/how-it-works.md](docs/how-it-works.md)**.

## Install

```bash
pi install npm:pi-observational-memory
```

Or from GitHub:

```bash
pi install git:github.com/elpapi42/pi-observational-memory
```

That's it. The extension hooks into Pi's compaction lifecycle automatically. No config file needed to start — defaults work well for most sessions.

## Configuration

### Extension settings

Create `~/.pi/agent/observational-memory.json` (or `.pi/observational-memory.json` per project):

```json
{
  "observationThreshold": 50000,
  "reflectionThreshold": 30000
}
```

| Setting | Default | What it controls |
|---|---|---|
| `observationThreshold` | `50,000` tokens | How much raw conversation accumulates before the observer runs |
| `reflectionThreshold` | `30,000` tokens | How large observations grow before the reflector promotes and prunes |
| `compactionModel` | session model | Optional — use a cheaper model for observer/reflector passes |

### Using a cheaper model for compaction

The observer and reflector don't need the same capabilities as your coding agent. Offload them to something fast and cheap:

```json
{
  "compactionModel": { "provider": "openrouter", "id": "google/gemma-4-31b-it" }
}
```

### Pi compaction settings

The extension works with Pi's built-in compaction settings in `~/.pi/agent/settings.json`:

```json
{
  "compaction": {
    "keepRecentTokens": 20000
  }
}
```

| Setting | Default | What it controls |
|---|---|---|
| `keepRecentTokens` | `20,000` | Tokens of recent conversation kept verbatim (not summarized) |
| `reserveTokens` | `16,384` | Headroom for LLM response; Pi auto-compacts when context exceeds `window - reserveTokens` |

**How they interact:** Pi decides *when* to compact and *how many recent messages to keep raw*. The extension decides *how* to compact (observations + reflections instead of a flat summary) and *when to proactively trigger* compaction before the window fills. Both paths end up at the same `session_before_compact` hook.

## Commands

| Command | Description |
|---|---|
| `/om-status` | Token counts, thresholds, and when the next observer/reflector pass will trigger |
| `/om-view` | Print current reflections and observations |
| `/om-view --full` | Same as above, plus the raw kept messages |

## Design decisions

**Why observations are append-only.** Between reflector runs, nothing is lost. The observer only compresses new messages — it doesn't decide what to keep. This keeps the observer simple and predictable.

**Why the reflector is conservative.** It only prunes what it's certain is dead: completed tasks no longer referenced, superseded information, exact duplicates. Being old or low-priority is not a reason to prune. If in doubt, it keeps.

**Why user messages are captured near-verbatim.** When the context window shrinks, observations become the only record of what you said. Short messages are preserved exactly; long ones are summarized with key phrases quoted.

**Why state changes are explicit.** When you say "switching from A to B," the observation notes both the new state and what it replaces. This prevents the agent from acting on stale information after compaction.

**Why memory lives in the session.** State is stored in Pi's session entries as compaction `details` — no external database, no filesystem state, no separate sync. On session resume, the extension walks backward through entries to restore memory. If you use `/tree` to branch, each branch gets its own memory state.

## License

MIT
