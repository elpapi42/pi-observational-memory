# pi-observational-memory

Tiered Observational Memory (TOM) — a cache-friendly replacement for pi's default compaction.

Instead of a single summary that gets rewritten on every cycle, TOM maintains three memory tiers inside a single `CompactionEntry`:

- **Short-term** — recent raw messages, always kept verbatim (floor `S` tokens).
- **Mid-term** — observations, append-only dense summaries of older conversation.
- **Long-term** — reflections, a stable document rewritten only when observations accumulate past `R` tokens.

The ordering is deliberate: stable content is placed before volatile content so that prompt-prefix caches (Anthropic, OpenAI, Gemini) stay warm across compaction cycles.

## Documentation

- **[concepts.md](concepts.md)** — The three-tier memory model. Why this layout is cache-friendly. What changes cause full vs. partial cache misses.
- **[architecture.md](architecture.md)** — How TOM plugs into pi. Event wiring, state persistence, summary assembly, interaction with `session_before_compact`.
- **[configuration.md](configuration.md)** — `S`, `T`, `B`, `R` parameters. Profile presets. Observer/reflector model selection.
- **[commands.md](commands.md)** — `/tom-status`, `/tom-reflect`, `/tom-dump`.
- **[troubleshooting.md](troubleshooting.md)** — Diagnosing trigger issues, cache-hit verification, observer/reflector failures.

## Quickstart

### 1. Install dependencies

```bash
cd pi-observational-memory
npm install
```

### 2. Disable pi's default compaction

In `~/.pi/agent/settings.json` (global) or `<project>/.pi/settings.json`:

```json
{
  "compaction": { "enabled": false }
}
```

This is required. TOM owns the trigger decision; pi's built-in threshold must be off.

### 3. Load the extension

**Ad-hoc** (recommended for first runs):

```bash
pi -e /path/to/pi-observational-memory/src/index.ts
```

**Persistent**: symlink into `~/.pi/agent/extensions/`:

```bash
ln -s /path/to/pi-observational-memory/src/index.ts ~/.pi/agent/extensions/tom.ts
```

### 4. Verify

Run pi interactively, start a session, use `/tom-status` to see current tier sizes. After the first compaction fires you should see a `TOM cycle #1: +1 observation …` notification.

## Requirements

- pi (`@mariozechner/pi-coding-agent`) ≥ 0.66
- Valid credentials for the observer/reflector provider (default: Google Gemini via `GOOGLE_API_KEY`). Swap via [configuration.md](configuration.md).

## Project layout

```
pi-observational-memory/
  src/
    index.ts       main extension entry, event wiring
    config.ts      TomConfig + DEFAULT_CONFIG, batchSize()
    state.ts       TomState, Observation, loadState/serializeState
    summary.ts     buildSummary with cache-stable prefix invariant
    observer.ts    LLM call that produces one observation per cycle
    reflector.ts   LLM call that rewrites reflections + prunes observations
    trigger.ts     turn_end threshold + debounce + chunk selection
    commands.ts    /tom-status, /tom-reflect, /tom-dump
  test/
    state.test.ts      state round-trip, marker discipline
    summary.test.ts    prefix-stability invariants
    trigger.test.ts    threshold + debounce + inflight
  docs/            this directory
```

## Running the tests

```bash
npm test          # vitest --run
npm run typecheck # tsc --noEmit
```

The tests assert the core contract: `buildSummary` is prefix-stable across observation cycles, which is what TOM's cache behavior depends on. If you change `summary.ts` these tests must still pass.
