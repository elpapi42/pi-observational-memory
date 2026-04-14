# Concepts

## The three tiers

```
┌─────────────────────────────────┐
│ System prompt                   │  stable, always cached
├─────────────────────────────────┤
│ Reflections (long-term)         │  rarely rewritten
├─────────────────────────────────┤
│ Observations (mid-term)         │  append-only between reflections
├─────────────────────────────────┤
│ Raw messages (short-term)       │  grows until T, then slides
└─────────────────────────────────┘
```

Content is ordered most-stable-first. Every layer below can change; layers above stay untouched. This matches how prompt-prefix caches hash tokens: from the start forward, stopping at the first divergence.

| Tier | Lives in | Rewrite frequency |
|---|---|---|
| Raw messages | Direct pi session entries | Appended every turn |
| Observations | `summary` string of the latest `CompactionEntry`, appended | Appended every observation cycle |
| Reflections | Top section of that same `summary` string | Rewritten only when observations exceed `R` |

All three tiers coexist inside **one** `CompactionEntry` because pi only renders one compaction summary into the prompt at a time. The distinction between mid-term and long-term is structural (sections within a string) rather than two separate entries.

## Parameters

| Symbol | Name | Default | Role |
|---|---|---|---|
| `S` | short-term floor | 10 000 | Minimum raw tokens always kept uncompressed |
| `T` | trigger threshold | 50 000 | Observation fires when raw > `T` |
| `B` | batch size | `T − S` = 40 000 | Tokens compressed per cycle |
| `R` | reflection threshold | 30 000 | Reflection fires when observations exceed `R` |

`B` is derived, not independently configurable. See [configuration.md](configuration.md) for tuning guidance.

## Lifecycle

### Normal turns

New raw messages append to the tail. Everything above is unchanged. Full cache hit on every byte up to the newest message.

### Observation cycle

1. On `turn_end`, TOM computes raw tokens (total context minus observations + reflections).
2. If raw > `T` and debounce passed, TOM calls `ctx.compact()`.
3. In `session_before_compact`, TOM selects the oldest `B` tokens of raw messages, feeds them to the observer model, appends the returned observation to `state.observations`.
4. The new summary string is built with reflections + all observations (including the new one).
5. Raw messages from the cut point forward stay uncompressed — typically leaving ~`S` tokens raw.

**Cache impact**: the `summary` text grows by one observation at the end. Everything before it (system prompt, reflections, earlier observations) is byte-identical, so prefix caching extends all the way through the last stable observation. Only the appended tail + kept raw messages are re-tokenized.

### Reflection cycle

Fires when `sum(observation.tokenCount) > R`, or manually via `/tom-reflect`.

1. The reflector model receives current reflections + all observations.
2. It returns: updated reflections (absorbing durable info) and a `keep-ids` list.
3. Observations not in `keep-ids` are dropped.
4. The new summary string has a new reflections section.

**Cache impact**: the entire `summary` text diverges. Only the system prompt survives. This is intentional and rare — think of it as TOM's periodic "garbage collection." Tune `R` so reflection fires infrequently relative to observation cycles.

## Why this maps onto pi's cache model

Pi uses prompt-prefix caching (Anthropic `cache_control`, OpenAI `prompt_cache_key`, Gemini implicit). All three match on the token prefix of an API request; the first divergence ends the cache hit.

Pi injects compaction summaries as a user message with content:

```
The conversation history before this point was compacted into the following summary:

<summary>
{summary}
</summary>
```

The wrapping text is constant. The `{summary}` interior is TOM's responsibility. If TOM keeps that interior append-only between reflection cycles, the token prefix through the last stable observation stays identical — and the cache extends through it even though the `</summary>` closing tag shifts a few tokens later.

TOM's cache contract is enforced in code by the `buildSummary` prefix-stability tests in `test/summary.test.ts`. Any change that breaks that invariant breaks cache behavior in production.

## Non-obvious invariants

- **Observations are append-only within a reflection generation.** Never reorder or rewrite existing observations. The reflector is the only actor allowed to drop them — and when it does, it simultaneously rewrites reflections, accepting a full cache miss.
- **The reflections section always precedes observations.** Reflections change less often than observations, so they belong higher in the prefix.
- **`details` on the `CompactionEntry` is the source of truth.** The `summary` string is derived from `details` every cycle. If the two ever drift, details wins.
- **Timestamps and ids never appear in the `summary` text.** They live on JS objects but would break byte stability if serialized.
- **A `tom-v1` marker in `details` distinguishes TOM entries from pi's default ones.** TOM only resumes from its own entries; a foreign compaction entry resets to `EMPTY_STATE`.
