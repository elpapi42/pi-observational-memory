# Commands

TOM registers three slash commands. All are read-only inspection or manual triggers; none mutate session data destructively.

## `/tom-status`

Reports current tier sizes and cycle count.

```
TOM status:
  S=10,000  T=50,000  R=30,000
  raw tokens:        38,214
  observations:      4 (6,812 tokens)
  reflections:       1,230 tokens
  cycles this session: 2
```

Fields:

- `raw tokens` — tokens in uncompressed messages since the last compaction. `unknown` if no `turn_end` has fired yet this session.
- `observations` — count and total estimated tokens.
- `reflections` — estimated tokens in the reflections section.
- `cycles this session` — observation cycles fired since the extension loaded (not persisted across restarts).

Use this to verify TOM is firing, to calibrate thresholds, and to sanity-check after long sessions.

## `/tom-reflect`

Forces a reflection cycle on the next compaction.

```
TOM: reflection will run on next compaction
```

This sets an in-memory flag and calls `ctx.compact()` immediately. The resulting cycle will:

1. Run the observer as normal on the oldest batch.
2. After appending the new observation, run the reflector unconditionally (regardless of `R`).
3. Rewrite reflections, drop non-essential observations.

Use cases:

- You want a clean reflections refresh before starting a new task.
- You're debugging reflector output.
- You want to measure the cache impact of a reflection cycle.

## `/tom-dump`

Emits the current `TomState` as formatted JSON.

```json
{
  "version": 1,
  "reflections": "## Goals\n- ...",
  "observations": [
    {
      "id": "lw2jfh-a1b2c3d4",
      "text": "Added rate limiter to auth middleware; picked token-bucket...",
      "tokenCount": 187,
      "priority": "high",
      "createdAt": 1715372840123
    }
  ]
}
```

Use cases:

- Inspect what the observer actually produced.
- Verify reflections after `/tom-reflect`.
- Export state for analysis or external tooling.

Output goes to the UI notification surface. For large states the notification may be paginated depending on your pi UI configuration.
