# Configuration

## Parameters

```ts
interface TomConfig {
  S: number;                                       // short-term floor
  T: number;                                       // trigger threshold
  R: number;                                       // reflection threshold
  observerModel: { provider: string; id: string };
  reflectorModel: { provider: string; id: string };
  debounceMs: number;                              // suppress fire during rapid tool sequences
  observerMaxTokens: number;
  reflectorMaxTokens: number;
}
```

### Defaults

```ts
{
  S: 10_000,
  T: 50_000,
  R: 30_000,
  observerModel: { provider: "google", id: "gemini-2.5-flash" },
  reflectorModel: { provider: "google", id: "gemini-2.5-flash" },
  debounceMs: 2_000,
  observerMaxTokens: 2_048,
  reflectorMaxTokens: 4_096,
}
```

These are tuned for a coding-agent workload on Gemini 2.5 Flash. Adjust for your use case — see profiles below.

### How parameters interact

- `B` (batch size) is derived as `T − S` — the extension does not accept it as an input. Enlarging `T` while holding `S` grows `B`, which gives the observer more context per call and typically produces denser observations.
- `S` is a **floor**, not a cap. Raw tokens can exceed `S` any amount up to `T` between cycles.
- `R` is measured against `sum(observation.tokenCount)` only — reflections size does not trigger reflection.
- `debounceMs` throttles the cycle during rapid tool loops. If the model is making back-to-back tool calls, firing compaction in the middle of that burst corrupts context. The debounce resets on every `tool_execution_start`/`end`.

## Profiles

### Coding agent (default)

```ts
{ S: 10_000, T: 50_000, R: 30_000 }
```

Long sessions with heavy tool output. Large batch (~40k) compresses well because tool results (file contents, command output) are highly compressible.

### Chat companion

```ts
{ S: 4_000, T: 15_000, R: 20_000 }
```

Casual, long-running. Small raw window is fine because messages are low-density. Observations become the dominant memory — fits the conversational tone.

### Research agent

```ts
{ S: 20_000, T: 80_000, R: 40_000 }
```

Needs lots of raw context for synthesis. Trigger threshold fills big context windows. Massive compression ratio from web-page-dump chunks.

### Support bot

```ts
{ S: 3_000, T: 10_000, R: 8_000 }
```

Short sessions. Tight cost control. Observation may never fire during a single ticket. Smallest footprint.

## Applying overrides

Currently configuration is code-level. In your own extension entry file:

```ts
import tomExtension from "pi-observational-memory";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  tomExtension(pi, {
    S: 20_000,
    T: 80_000,
    R: 40_000,
    observerModel: { provider: "anthropic", id: "claude-haiku-4-5-20251001" },
  });
}
```

Then load your wrapper file: `pi -e ./your-wrapper.ts`.

## Observer / reflector model selection

Both model fields accept any provider/model registered in pi's model registry. The extension calls `ctx.modelRegistry.find(provider, id)` — if that returns undefined, the cycle aborts with a warning.

### Choosing a model

The observer runs every `B` tokens of conversation. Its output is at most ~250 words. Characteristics that matter:

- **Low latency.** You're blocking the user during the call.
- **Solid summarization quality.** Nothing exotic — any modern small model handles this.
- **Cheap.** Fires dozens of times in a long session.

Good picks:

| Provider | Model | Notes |
|---|---|---|
| Google | `gemini-2.5-flash` | Default. Fast, cheap, strong at long-context summarization. |
| Anthropic | `claude-haiku-4-5-20251001` | Fast and high quality. Higher cost than Flash. |
| OpenAI | `gpt-4o-mini` | Fine for English-heavy workloads. |

The reflector runs rarely (once per ~`R`-worth of observations) but its output is load-bearing. You can use the same model as the observer, or something stronger (e.g., Sonnet for reflections, Flash for observations).

### Auth

TOM uses `ctx.modelRegistry.getApiKeyAndHeaders(model)` — the same path pi uses. Your provider credentials must be configured in pi's usual way (`GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, etc., or `pi login`). TOM does not add any new auth surface.

## Required setting change

`compaction.enabled` **must** be `false` in pi's settings. Put this in `~/.pi/agent/settings.json` or the per-project `.pi/settings.json`:

```json
{
  "compaction": { "enabled": false }
}
```

If it's `true`, pi's default threshold will fire compactions that write non-TOM `CompactionEntry` records, which TOM cannot resume from. Cache behavior degrades and you lose observations.

## Sanity checks

- `T` > `S` (the extension does not enforce this — if equal, `B = 0` and no messages get compressed).
- `R` ≥ 3× typical observation size. Too small and reflection fires every cycle.
- `observerMaxTokens` ≥ 1024. Less and observations get truncated.
- `reflectorMaxTokens` ≥ 2048. Reflections need room to grow.
