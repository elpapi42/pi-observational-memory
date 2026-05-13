# Implementation Plan: Remove Uncited Protection

**Design:** `docs/plans/2026-05-13-remove-uncited-protection-design.md`

## Tasks

1. **Remove uncited protection logic from `src/compaction.ts`**
   - In `runPruner()`: remove `protectUncited`, `uncitedPool`, the `if/else` branching, and the merge-back
   - Simplify to always use `coverageTags = deriveObservationCoverageTags(...)` and `pool = observations`

2. **Update `tests/pruner.test.ts`**
   - Replace `"excludes uncited observations from the pruner pool when maxToolCalls is set"` with test confirming all observations go to pruner regardless of `maxToolCalls`

3. **Update `README.md`**
   - Change example `compactionMaxToolCalls` from `8` to `32`
   - Update settings table description to remove uncited protection mention

4. **Update `docs/configuration.md`**
   - Change example `compactionMaxToolCalls` from `8` to `32`
   - Rewrite `compactionMaxToolCalls` section to remove uncited protection description
   - Update intro paragraph mentioning uncited protection

5. **Update design doc** (already committed, minor update to include doc changes)

6. **Run tests** to verify everything passes
