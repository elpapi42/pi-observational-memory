# Configuration

Every setting that shapes observational memory's behavior, what each one trades off, and a few tuning recipes for common goals.

If you haven't read **[concepts.md](concepts.md)** yet, do that first — this doc assumes the vocabulary.

## Contents

- [Where settings live](#where-settings-live)
- [The full settings file](#the-full-settings-file)
- [Extension settings](#extension-settings)
  - [`observationThresholdTokens`](#observationthresholdtokens--default-1000)
  - [`compactionThresholdTokens`](#compactionthresholdtokens--default-50000)
  - [`reflectionThresholdTokens`](#reflectionthresholdtokens--default-30000)
  - [`passive`](#passive--default-false)
  - [`compactionModel`](#compactionmodel--default-session-model)
- [Pi compaction settings the extension depends on](#pi-compaction-settings-the-extension-depends-on)
  - [`keepRecentTokens`](#keeprecenttokens--pi-setting-default-20000)
  - [`reserveTokens`](#reservetokens--pi-setting-default-16384)
  - [`compaction.enabled`](#compactionenabled--pi-setting-default-true)
- [How compaction triggers fire](#how-compaction-triggers-fire)
- [Tuning recipes](#tuning-recipes)
- [Upgrading from v1.x](#upgrading-from-v1x)

---

## Where settings live

Observational memory's behavior is shaped by Pi's `settings.json`:

- **Globally** at `~/.pi/agent/settings.json`
- **Per-project** at `<project>/.pi/settings.json`

Project values override global values key-by-key.

Two namespaces are involved:

- The extension's own keys live under `observational-memory`.
- A few of Pi's built-in `compaction` keys are **structural** to how the extension works. They aren't owned by the extension, but they materially change its behavior, so they're documented alongside.

## The full settings file

Every setting at its default value:

```json
{
  "observational-memory": {
    "observationThresholdTokens": 1000,
    "compactionThresholdTokens": 50000,
    "reflectionThresholdTokens": 30000,
    "passive": false
  },
  "compaction": {
    "enabled": true,
    "keepRecentTokens": 20000,
    "reserveTokens": 16384
  }
}
```

You don't need any of these to start — defaults work well for most sessions.

One setting doesn't have a default and is easy to miss: **`compactionModel`**. Left unset, the observer / reflector / pruner all use the session model. Pointing them at a cheaper or faster model instead is usually the single biggest token-cost lever the extension exposes. A realistic settings file that overrides it looks like this:

```json
{
  "observational-memory": {
    "observationThresholdTokens": 1000,
    "compactionThresholdTokens": 50000,
    "reflectionThresholdTokens": 30000,
    "passive": false,
    "compactionModel": { "provider": "openrouter", "id": "google/gemma-4-31b-it" }
  },
  "compaction": {
    "keepRecentTokens": 20000
  }
}
```

The settings below are listed roughly in the order they affect a session's life: the observer fires first and most often, the extension-trigger cadence comes next, passive mode can disable that proactive work, the reflector + pruner gate engages inside compaction, the model choice applies to all three roles, and the Pi-owned settings determine the structural details of each compaction.

---

## Extension settings

These live under the `observational-memory` namespace.

### `observationThresholdTokens` — default `1,000`

How many raw conversation tokens accumulate since the last bound (the more recent of the most recent `om.observation` or `compaction` entry) before the observer fires asynchronously on `turn_end`. This is also roughly the chunk size each observer call digests — the observer receives the raw text between the last bound and the current leaf.

**Lower values** produce finer-grained observations and more frequent background LLM calls. Per-call latency stays low; total cost over a session goes up.

**Higher values** produce coarser, denser observations at lower cost — but also leave longer stretches of raw conversation with no running summary, which shifts work onto the sync catch-up observer at compaction time.

**Edge cases.** If the observer is already in flight when a new `turn_end` crosses the threshold, the trigger is skipped and tokens accumulate until the next turn. No data is lost.

### `compactionThresholdTokens` — default `50,000`

How many raw conversation tokens accumulate since the last `compaction` entry before the extension proactively calls `ctx.compact()` on `agent_end`.

The trigger isn't naive — it `setTimeout(0)`s a task, awaits any in-flight observer, re-checks `ctx.isIdle()` and the token count (another compaction may have happened during the wait), and only then calls `ctx.compact()`.

**Lower values** compact more often. More frequent opportunities for the reflector + pruner to crystallize patterns and clean up the pool, but more LLM cost over a session, and more `firstKeptEntryId` churn if the raw tail is short.

**Higher values** let observations accumulate longer. Cheaper per session, but if the window-pressure trigger (governed by `reserveTokens`) fires first, the extension's hook runs anyway. So this threshold is really about *proactive* compaction before window pressure hits — and is what lets the extension prefer compacting at idle (`agent_end`) rather than mid-turn.

### `reflectionThresholdTokens` — default `30,000`

The working observation pool size at which the reflector + pruner pair engages inside a compaction. "Working pool" here means *committed observations + delta observations + any sync-catch-up gap observation*, measured at hook-entry time.

**Below this gate**, the reflector and pruner are both skipped and the working pool is written to the new `compaction.details` unchanged. Compaction in this case is **0 LLM calls** (or 1 if the sync catch-up observer ran).

**At or above the gate**, the reflector appends new reflections (never rewriting existing ones) and the pruner runs up to 5 id-based drop passes until the pool fits under `0.8 × reflectionThresholdTokens`. Compaction in this case is **≥2 LLM calls**.

**Lower values** crystallize reflections earlier and keep the observation pool tight, at the cost of more frequent reflector+pruner runs.

**Higher values** let the pool grow before cleanup. Individual compactions are cheaper, but the summary the actor sees grows larger between cleanups.

### `passive` — default `false`

When `true`, observational memory becomes reactive instead of proactive: the background observer trigger and the extension's proactive `agent_end` compaction trigger are disabled.

Manual `/compact` and Pi's own window-pressure compaction still use the custom compaction hook. That means the sync catch-up observer, reflector, pruner, `/om-status`, `/om-view`, and `recall` remain available; passive mode only stops the extension from doing memory work on its own between compactions.

You can override this setting for a shell/session with `PI_OBSERVATIONAL_MEMORY_PASSIVE`. Recognized truthy values are `1`, `true`, `yes`, and `on`; recognized falsy values are `0`, `false`, `no`, and `off`. The environment variable is read after global and project settings, so it wins over both when set to a recognized value.

### `compactionModel` — default: session model

An optional `{ provider, id }` override for the observer, the reflector, and the pruner. All three background roles share this setting.

```json
{
  "observational-memory": {
    "compactionModel": { "provider": "openrouter", "id": "google/gemma-4-31b-it" }
  }
}
```

**Why you'd set this.** These three roles are structurally simpler than general coding: the observer summarizes fixed chunks, the reflector distills patterns, the pruner drops ids. A smaller, faster, or cheaper model is usually appropriate. Pointing them at one lets you offload background memory work without changing the main coding agent's model — which is often the single biggest token-cost lever the extension exposes.

**Failure modes.** If the configured model is not found in the registry, the extension falls back to the session model with a warning. If no API key is available for the chosen model, the observer is skipped (warning once) and the compaction hook cancels the compaction (surfacing a clear error) rather than silently falling back.

---

## Pi compaction settings the extension depends on

These live under Pi's `compaction` namespace, not the extension's. They're documented here because they materially change observational memory's behavior.

### `keepRecentTokens` — Pi setting, default `20,000`

How many tokens of recent conversation are kept **verbatim** during compaction — the raw tail that is *not* replaced by the compaction summary. This defines the `firstKeptEntryId` cutoff passed to `session_before_compact`.

This setting is **structural** to the extension, not just a tuning knob. Three of the extension's core behaviors are direct consequences of it:

- **Sync catch-up gap size.** The extension runs a synchronous observer pass over the range `[lastObservationBound, firstKeptEntryId)` at compaction time to cover any raw entries the async observer hasn't yet summarized. If `keepRecentTokens` is small, `firstKeptEntryId` advances further forward and the gap shrinks (or becomes empty); if it's large, the gap can be substantial and the sync catch-up pass does real work.
- **Pending observation deferral.** Pending observations whose `coversFromId` falls inside the kept tail (at or after `firstKeptEntryId`) are deferred to the next compaction cycle — their raw source is still live, so they'll be collected next time their coverage falls into the pre-tail range. Larger `keepRecentTokens` means more deferrals; smaller means fewer.
- **Raw tail the agent still sees.** After compaction, the actor sees the compaction summary *plus* the raw tail between `firstKeptEntryId` and the leaf. Higher `keepRecentTokens` preserves more literal conversation; lower forces more continuity through observations and reflections.

**Higher values** leave more conversation verbatim post-compaction — good for short-horizon recall, but less room in context for the summary and potentially more deferred observations.

**Lower values** compress more aggressively, reduce the sync-catch-up workload, and rely more heavily on observations + reflections to carry context across the compaction boundary.

---

## How compaction triggers fire

Three things can fire the `session_before_compact` hook (where this extension does its work):

1. **Extension trigger** — the proactive path. When raw tokens since the last compaction exceed `compactionThresholdTokens`, the agent is idle (`agent_end` has fired), no observer is in flight, and `passive` is not `true`. The deferred timing is intentional: it minimizes the chance of compaction interrupting an active turn.
2. **Window-pressure trigger** — the safety net. When context approaches `contextWindow − reserveTokens`.
3. **Manual `/compact`** — user-triggered.

The extension's hook runs the same way regardless of which path fired. The settings divide cleanly: `compactionThresholdTokens` controls the proactive path, `keepRecentTokens` and `reserveTokens` shape the structural details every compaction has to deal with (`firstKeptEntryId`, when the safety net forces a compaction). The hook's job in all cases is to assemble the new summary from the working observation pool plus carried-forward reflections.

---

## Tuning recipes

A few starting points for common goals. None of these are "right" — they're trade-offs.

### Lowest cost over long sessions

Point background roles at a cheap fast model and let observations accumulate longer between compactions:

```json
{
  "observational-memory": {
    "observationThresholdTokens": 2000,
    "compactionThresholdTokens": 80000,
    "reflectionThresholdTokens": 40000,
    "compactionModel": { "provider": "openrouter", "id": "google/gemma-4-31b-it" }
  }
}
```

You'll get coarser observations, less frequent reflector+pruner runs, and substantially lower per-session cost — at the cost of bigger summaries between cleanups and more raw context surviving each gap.

### Highest fidelity for long-horizon work

Fine-grained observations, frequent crystallization, larger raw tail:

```json
{
  "observational-memory": {
    "observationThresholdTokens": 500,
    "compactionThresholdTokens": 30000,
    "reflectionThresholdTokens": 20000
  },
  "compaction": {
    "keepRecentTokens": 30000
  }
}
```

More background LLM calls, more compactions, more crystallization — and a tighter, denser memory state. Use this when the project really demands hour-six-equals-hour-one continuity.

### Lean on observations more, raw tail less

If you want the agent to rely on the structured memory rather than raw recent messages, shrink the kept tail:

```json
{
  "compaction": {
    "keepRecentTokens": 8000
  }
}
```

This forces more continuity through observations and reflections. The sync catch-up observer's workload shrinks (smaller gap) but the actor sees less verbatim conversation post-compaction.

---

## Upgrading from v1.x

The config keys changed in v2:

| v1 key | v2 key |
|---|---|
| `observationThreshold` | `compactionThresholdTokens` |
| `reflectionThreshold` | `reflectionThresholdTokens` |
| *(new in v2)* | `observationThresholdTokens` |

Old v1 keys are silently ignored. If you upgrade and don't update your `settings.json`, the extension will run on defaults — which is usually fine, but it's worth doing the rename so your tuning carries over.

---

## Where to go next

- **[concepts.md](concepts.md)** — vocabulary reference.
- **[how-it-works.md](how-it-works.md)** — the full lifecycle, async-race handling, and runtime invariants.
