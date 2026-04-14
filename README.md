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
2. **Observations** — when raw tokens exceed a threshold, TOM sends the oldest chunk to an observer LLM that produces a dense, factual summary (80–250 words) tagged with a priority (high / med / low).
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
pi.use((api) => tomExtension(api, { T: 40_000, R: 20_000 }));
```

## Configuration

| Parameter | Default | Description |
|---|---|---|
| `S` | `10,000` | Safety buffer — tokens of raw conversation always kept |
| `T` | `50,000` | Raw token threshold that triggers compaction |
| `R` | `30,000` | Observation token threshold that triggers reflection |
| `observerModel` | `google/gemini-2.5-flash` | Model used for observation generation |
| `reflectorModel` | `google/gemini-2.5-flash` | Model used for reflection consolidation |
| `debounceMs` | `2,000` | Minimum ms after last tool call before firing |
| `observerMaxTokens` | `2,048` | Max output tokens for the observer |
| `reflectorMaxTokens` | `4,096` | Max output tokens for the reflector |

## Commands

| Command | Description |
|---|---|
| `/tom-status` | Show tier sizes, token counts, and cycle count |
| `/tom-reflect` | Force a reflection cycle on the next compaction |
| `/tom-dump` | Dump the current TOM state as JSON |

## How the cycle works

1. On every `turn_end`, TOM checks if raw tokens exceed `T` and a debounce period has passed.
2. If so, it triggers pi's compaction flow.
3. During `session_before_compact`, the oldest chunk of messages is sent to the **observer**, which returns a prioritized observation.
4. If total observation tokens exceed `R` (or a manual reflect was requested), the **reflector** runs — consolidating observations into reflections and deciding which observations to keep or drop.
5. The resulting summary (reflections + observations) replaces the discarded conversation chunk in pi's session state.

## License

[MIT](LICENSE)
