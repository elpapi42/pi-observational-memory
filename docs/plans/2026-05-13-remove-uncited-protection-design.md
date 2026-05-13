# Remove Uncited Protection Logic

**Date:** 2026-05-13
**Branch:** feature/compact-progress

## Summary

Remove the `protectUncited` mechanism from `runPruner()` so that all observations always go through the pruner with their coverage tags as advisory signals, regardless of whether `compactionMaxToolCalls` is set.

## Background

The `protectUncited` logic was introduced to shield uncited observations from pruning when `compactionMaxToolCalls` limited the reflector's tool calls. The rationale was: with a tool-call cap, the reflector may not have had enough calls to cite all valuable observations, so their uncited status was an artifact of the limit rather than a quality signal.

The repo owner has decided this protection should be removed entirely. Coverage tags (`uncited`, `cited`, `reinforced`) will remain as advisory signals in the pruner prompt — the LLM will see them and use its judgment, but no observations will be mechanically excluded from the pruning pool.

## Verified: Per-Pass Early Exit Scoping

`consecutiveEmptyCalls` and `turnCount` (for `compactionMaxToolCalls`) are local variables inside `runReflectorPass()` and `runPrunerPass()`. They reset fresh on every pass call. The pass loops in `runReflector()` and `runPruner()` each invoke these pass functions independently. No cross-pass leakage exists.

The pruner's multi-pass loop has three exit conditions:
1. `poolTokens <= target` — pool is under budget (correct, most common exit)
2. `result.fellBack` — LLM call failed (correct)
3. `result.droppedIds.length === 0` — pass produced zero drops (correct; if a pass can't find anything to drop, subsequent passes with different strategies might, but in practice if the pool is under budget this condition is rarely hit)

## Changes

### `src/compaction.ts` — `runPruner()`

- Remove the `protectUncited` variable and the `if (protectUncited) { ... } else { ... }` branching
- Remove the `uncitedPool` variable and the merge-back logic at the end
- Simplify to always use `coverageTags = allCoverageTags` and `pool = observations`
- Keep `LlmArgs.maxToolCalls` — it's still used by `effectiveMaxToolCalls` in `shouldStopAfterTurn` within each pass

### `tests/pruner.test.ts`

- Replace the test `"excludes uncited observations from the pruner pool when maxToolCalls is set"` with a test confirming all observations (including uncited) are always passed to the pruner regardless of `maxToolCalls`

### `README.md`

- Change example `compactionMaxToolCalls` from `8` to `32`
- Update the settings table: remove "also protects uncited observations from pruning" from the description

### `docs/configuration.md`

- Change example `compactionMaxToolCalls` from `8` to `32`
- Rewrite the `compactionMaxToolCalls` section to remove the uncited protection description (point 2 of the current docs)
- Update the intro paragraph that mentions uncited protection

## What Stays Unchanged

- `consecutiveEmptyCalls` and `compactionMaxToolCalls` logic within each pass
- `deriveObservationCoverageTags()` — coverage tag derivation
- `renderObservationsForPrunerPrompt()` — coverage tag rendering in pruner prompts
- Pruner prompt text describing coverage tags as advisory signals
- `LlmArgs.maxToolCalls` field and its use in `shouldStopAfterTurn`
