# Design: compactionMaxToolCalls — Opt-in Tool Call Limit with Conditional Uncited Protection

**Date:** 2026-05-11
**Status:** Approved

## Context

The reflector and pruner currently default to 8 tool calls per pass with a hardcoded cap. This creates two problems:

1. **No user control** — users can't tune the limit or disable it entirely.
2. **Artificial uncited observations** — when tool calls are limited, the reflector may not cite all valuable observations. The pruner then sees them as `[coverage: uncited]` and may drop genuinely valuable observations that were uncited only due to the limit, not low value.

On master, uncited observations are shown to the pruner with advisory coverage tags, and the LLM decides. On the feature branch, uncited observations are hard-split out of the pruner pool (never shown to LLM).

## Decision

Make `compactionMaxToolCalls` an **opt-in** setting with **conditional uncited protection**:

- **Not set** (default): unlimited tool calls, no uncited protection. Both reflector and pruner run until `consecutiveEmptyCalls >= 2` stops them. All observations go to pruner with advisory `[coverage: uncited]` tags (master behavior).
- **Set to a number** (e.g., 30): tool calls capped at that number per pass, AND uncited observations are automatically protected from pruning (hard-split out of pruner pool).
- **Set to 0**: treated as "not set" — unlimited, no protection.

The coupling is intentional: uncited protection is only needed when tool calls are limited (because that's what creates artificial uncited observations). When unlimited, the reflector has full coverage, so uncited truly means low-value.

## Implementation

### `config.ts`
- No changes needed — `compactionMaxToolCalls` is already `number | undefined` in the Config interface.

### `compaction.ts`
- `runPruner()`: if `args.maxToolCalls` is set and > 0, split uncited observations out of the pruner pool. Otherwise, send all observations to pruner.
- `runReflectorPass()` / `runPrunerPass()`: when `args.maxToolCalls` is not set or 0, only use `consecutiveEmptyCalls >= 2` as the stop condition (no tool call cap).

### `compaction-hook.ts`
- No changes needed — already passes `runtime.config.compactionMaxToolCalls` which is `undefined` by default.

### `README.md`
- Add `compactionMaxToolCalls` to the settings table.

### `docs/configuration.md`
- Add section for `compactionMaxToolCalls` with behavior description and tuning guidance.

### Tests
- Update existing tests that assume uncited protection is always on.
- Add test for conditional protection behavior.
