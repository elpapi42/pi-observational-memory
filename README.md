# pi-observational-memory

Observational memory extension for [Pi](https://github.com/mariozechner/pi). Replaces Pi's default compaction with a two-tier system of **observations** (timestamped event log) and **reflections** (stable long-term facts), giving the agent persistent memory across long conversations.

Inspired by [Mastra's Observational Memory](https://mastra.ai/blog/observational-memory#how-it-works) concept. This is an independent implementation adapted for Pi's extension system and compaction model.

## How it works

When Pi's context window fills up, this extension intercepts the compaction event and runs two LLM passes:

1. **Observer** — reads recent conversation messages and compresses them into concise, timestamped observations with priority levels (🔴 important, 🟡 maybe important, 🟢 info, ✅ completed).
2. **Reflector** — when observations grow past a threshold, promotes stable facts to reflections and prunes dead observations.

The resulting `<reflections>` + `<observations>` block becomes the compaction summary that Pi injects at the top of the agent's context. Pi still keeps the most recent raw messages (controlled by `keepRecentTokens`), so the agent sees both structured memory and recent conversation.

## Install

```bash
npm install pi-observational-memory
```

Then symlink or copy the package into Pi's extensions directory:

```bash
ln -s $(npm root)/pi-observational-memory ~/.pi/extensions/pi-observational-memory
```

Pi will discover it on next session start.

## Configuration

Create `~/.pi/agent/observational-memory.json`:

```json
{
  "observationThreshold": 50000,
  "reflectionThreshold": 30000
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `observationThreshold` | `50000` | Token count that triggers the observer |
| `reflectionThreshold` | `30000` | Observation token count that triggers the reflector |
| `compactionModel` | session model | Optional `{ "provider": "...", "id": "..." }` to use a different model for observation/reflection |

### Custom model example

```json
{
  "observationThreshold": 6000,
  "reflectionThreshold": 1000,
  "compactionModel": { "provider": "openrouter", "id": "google/gemma-4-31b-it" }
}
```

## Commands

| Command | Description |
|---------|-------------|
| `/om-status` | Show token counts and current thresholds |
| `/om-view` | Print current reflections and observations |
| `/om-view --full` | Same as above, plus raw kept messages |

## License

MIT
