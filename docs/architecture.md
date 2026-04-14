# Architecture

How TOM integrates with pi's extension system, where state lives, and the full request flow.

## Integration points

TOM uses four pi extension hooks and two context APIs:

| Hook / API | Purpose |
|---|---|
| `pi.on("turn_end")` | Read context usage, decide whether to fire a cycle |
| `pi.on("tool_execution_start" / "tool_execution_end")` | Track last tool activity for debounce |
| `pi.on("session_before_compact")` | Run the observer (and optionally reflector), emit the new summary |
| `pi.registerCommand(...)` | Expose `/tom-status`, `/tom-reflect`, `/tom-dump` |
| `ctx.getContextUsage()` | Get current token count for the active model |
| `ctx.compact({ customInstructions })` | Programmatically trigger `session_before_compact` |
| `ctx.modelRegistry.find / getApiKeyAndHeaders` | Resolve observer / reflector model + auth |

Nothing else is touched. TOM does **not** register tools, does not modify tool calls, does not intercept messages, does not alter rendering.

## Where state lives

TOM state is a JSON object stored in `CompactionEntry.details`:

```ts
{
  marker: "tom-v1",
  version: 1,
  reflections: string,
  observations: Observation[]
}
```

Every compaction cycle writes a new `CompactionEntry`. Only one compaction entry is active at a time in pi's prompt assembly (the latest one absorbs all prior ones), so TOM reads the latest entry's details on each cycle and overwrites with the updated state.

In-memory per-session state (not persisted):

- `trig.lastToolCallAt` — monotonic timestamp for debounce.
- `trig.inFlight` — prevents re-entrant cycles while a compaction is running.
- `forceReflectNext` — set by `/tom-reflect`, consumed on the next `session_before_compact`.
- `cycleCount`, `lastRawTokens` — diagnostics for `/tom-status`.

## Request flow

### Normal turn (no cycle)

```
user types → turn_end fires →
  ctx.getContextUsage() → raw = total - observations - reflections
  shouldFire(raw, cfg, trig, now) = false
  return
```

Pi proceeds to the next turn. No API calls from TOM.

### Observation cycle (raw > T)

```
turn_end fires →
  raw > T, debounce passed, not in-flight →
  trig.inFlight = true
  ctx.compact({ customInstructions: "tom-observe" })
    └→ pi fires session_before_compact with preparation
        ↓
  TOM handler:
    prior = loadState(branchEntries)       ← read latest CompactionEntry.details
    allMessages = messagesToSummarize + turnPrefixMessages
    chunk, firstKeptIndex = selectChunk(allMessages, cfg)
    observation = await runObserver(chunk, prior, cfg, ctx, signal)
    next = { ...prior, observations: [...prior.observations, observation] }
    if observationsTokenTotal(next) > R: next = await runReflector(next, ...)
    summary = buildSummary(next)
    return { compaction: { summary, firstKeptEntryId, tokensBefore, details: serializeState(next) } }
    ↓
  pi writes the new CompactionEntry with details containing tom-v1 state
  trig.inFlight = false via onComplete
```

The kept messages (those not in `chunk`) stay in the session as raw entries; pi uses `firstKeptEntryId` to know where they start.

### Reflection cycle (observations > R, or forced)

Occurs inside the observation cycle above, after the new observation is appended:

```
shouldReflect = forceReflectNext || observationsTokenTotal(next) > R
if shouldReflect:
  reflected = await runReflector(next, cfg, ctx, signal)
  if reflected: next = reflected
```

The reflector returns a new `reflections` string and a `keepIds` set. Observations not in `keepIds` are dropped. Token counts are recomputed.

## Summary assembly

`buildSummary(state)` produces:

```
## Reflections
{state.reflections}

## Observations

{obs[0].text}

{obs[1].text}

...

{obs[n].text}
```

Rules enforced by the test suite:

1. Appending an observation to `state.observations` must make the new output start with the old output as a byte-exact prefix.
2. Rewriting reflections must break that prefix (acceptable — this is the reflection cycle).
3. Reordering observations must break the prefix (forbidden — guards against accidental mutation).

When pi renders this summary into the prompt, it's wrapped as:

```
The conversation history before this point was compacted into the following summary:

<summary>
{buildSummary output}
</summary>
```

The wrapping is pi's, not TOM's. TOM does not control it. The closing `</summary>` shifts position each observation cycle — a 2–5-token friction on cache matching. Negligible relative to the thousands of cached tokens TOM preserves.

## Module map

```
index.ts
  └── registers turn_end, tool_execution_*, session_before_compact handlers
  └── registers commands via commands.ts
  └── orchestrates observer + reflector on each cycle

trigger.ts
  shouldFire(rawTokens, cfg, state, now)   decision predicate
  selectChunk(messagesToSummarize, cfg)    picks oldest B tokens
  sumMessageTokens                         uses pi's estimateTokens()

state.ts
  loadState(branchEntries)                 finds latest tom-v1 entry
  serializeState(state)                    adds marker for persistence
  isTomDetails(details)                    type guard
  observationsTokenTotal(state)            for R threshold check
  newObservationId()                       base36 + random for ordering

summary.ts
  buildSummary(state)                      the cache-critical assembler

observer.ts
  runObserver(chunk, state, cfg, ctx, signal)
  parseObservation(raw)                    extracts PRIORITY tag

reflector.ts
  runReflector(state, cfg, ctx, signal)
  parseReflectorOutput(raw)                extracts <reflections> and <keep-ids>

commands.ts
  /tom-status  /tom-reflect  /tom-dump

config.ts
  TomConfig, DEFAULT_CONFIG, batchSize(cfg)
```

## Extension points for future work

- **Async background mode.** TOM's observer runs synchronously — the user waits during the LLM call. An async mode could run the observer on a worker while new messages buffer, swapping in the new summary when ready.
- **Observation-level cache breakpoints.** Pi currently places cache breakpoints only on system prompt and last user message. An upstream PR to add a third breakpoint after the compaction summary would give reflections and observations independent cache lifetimes.
- **Priority-weighted reflection.** Today the reflector receives all observations equally. Weighting by priority (high/med/low) in the prompt could yield better reflections.
- **Per-session config overrides.** Currently config lives in the extension factory; surfacing it via settings.json would let users tune per-project without code changes.
