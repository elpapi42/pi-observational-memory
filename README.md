# pi-observational-memory

Tiered Observational Memory (TOM) — a [pi](https://github.com/mariozechner/pi-coding-agent) extension that replaces naive context compaction with structured, three-tier memory.

## The problem

AI coding agents have finite context windows. Long sessions force old conversation to be discarded. Naive compaction loses important context — architectural decisions, user preferences, blockers — and the agent starts repeating mistakes or asking questions it already resolved.

## How TOM works

TOM compresses conversation history into progressively denser tiers:

```
Raw conversation  →  Observations  →  Reflections
(live messages)      (dense per-chunk   (stable session
                      summaries)         knowledge)
```

1. **Raw** — the live conversation (tool calls, user messages, agent responses).
2. **Observations** — when raw tokens exceed a threshold, TOM sends the older messages (everything pi marks for compaction) to an observer LLM that produces a dense, factual summary (80–250 words) tagged with a priority (high / med / low).
3. **Reflections** — when accumulated observations grow too large, a reflector LLM consolidates them into a stable document of durable facts: goals, constraints, architectural decisions, user preferences. Absorbed observations are dropped; still-relevant ones are kept.

The result: sessions can run indefinitely without losing load-bearing context.

## Installation

```bash
npm install pi-observational-memory
```

In your pi configuration, register the extension:

```ts
import tomExtension from "pi-observational-memory";

// with defaults
pi.use(tomExtension);

// or with overrides
pi.use((api) => tomExtension(api, { T: 40_000 }));
```

## Configuration

TOM parameters are configured in `~/.pi/agent/extensions/tom.json` (global) or `.pi/tom.json` (project override):

| Parameter | Default | Description |
|---|---|---|
| `T` | `50,000` | Raw token threshold that triggers compaction |
| `R` | `30,000` | Observation token threshold that triggers reflection |
| `observerModel` | `google/gemini-2.5-flash` | Model used for observation generation |
| `reflectorModel` | `google/gemini-2.5-flash` | Model used for reflection consolidation |
| `debounceMs` | `2,000` | Minimum ms after last tool call before firing |
| `observerMaxTokens` | `2,048` | Max output tokens for the observer |
| `reflectorMaxTokens` | `4,096` | Max output tokens for the reflector |

### keepRecentTokens (from pi)

TOM reads pi's `compaction.keepRecentTokens` setting from `~/.pi/agent/settings.json` (or `.pi/settings.json`). This controls how many recent tokens pi preserves verbatim during compaction — everything older is given to TOM for observation. Default: `20,000`.

```json
{
  "compaction": {
    "keepRecentTokens": 20000
  }
}
```

`T` should always be greater than `keepRecentTokens`, otherwise TOM would trigger compaction but have no messages to observe.

## Commands

| Command | Description |
|---|---|
| `/tom-status` | Show tier sizes, token counts, and cycle count |
| `/tom-reflect` | Force a reflection cycle on the next compaction |
| `/tom-dump` | Dump the current TOM state as JSON |

## How the cycle works

1. On every `turn_end`, TOM checks if raw tokens exceed `T` and a debounce period has passed.
2. If so, it triggers pi's compaction flow.
3. Pi determines a cut point using `keepRecentTokens` — recent messages are kept verbatim, older messages are passed to TOM.
4. During `session_before_compact`, TOM sends all older messages to the **observer**, which returns a prioritized observation.
5. If total observation tokens exceed `R` (or a manual reflect was requested), the **reflector** runs — consolidating observations into reflections and deciding which observations to keep or drop.
6. The resulting summary (reflections + observations) replaces the discarded conversation in pi's session state.

## License

[MIT](LICENSE)
