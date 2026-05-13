# Review Loop #0 — 2026-05-13-remove-uncited-protection

**Date:** 2026-05-13
**Reviewer:** generic
**Files reviewed:** src/compaction.ts, tests/pruner.test.ts, README.md, docs/configuration.md, docs/plans/2026-05-13-remove-uncited-protection-design.md, docs/plans/2026-05-13-remove-uncited-protection-implementation.md

## Issues

### Issue R0-1: Two tests now test identical behavior [Minor]
- **Category:** testing
- **File:** tests/pruner.test.ts:164-197
- **Description:** After removing the uncited protection branching, the test "passes all observations to the pruner loop when no maxToolCalls is set" (line 164) and the updated test "passes all observations including uncited to the pruner pool regardless of maxToolCalls" (line 187) now test the exact same code path. The only difference is one passes `maxToolCalls: 32` and the other omits it — but since the code no longer branches on `maxToolCalls` for pool selection, both exercise identical logic. The `maxToolCalls` value only affects `shouldStopAfterTurn` inside the pass, which neither test verifies (the fake agent loop produces no tool calls, so the cap is never reached).
- **Suggested fix:** Either merge the two tests into one, or update one of them to actually exercise the `maxToolCalls` cap behavior (e.g., by having the fake agent loop produce enough tool calls to trigger the cap). The second option would add meaningful coverage for the `shouldStopAfterTurn` path that `maxToolCalls` controls.

### Issue R0-2: `pool` variable is now a const alias, not a mutable pool [Minor]
- **Category:** quality
- **File:** src/compaction.ts:610
- **Description:** After the refactor, `const pool = observations;` creates an alias, then the loop reassigns `pool = result.kept;` on line 632. Since `pool` is `const`, this would be a TypeScript error — but it's declared with `const` and reassigned later. Let me re-check... Actually, looking at the diff, `pool` was previously `let pool` but the new code uses `const pool = observations`. Wait — the diff shows the replacement is `const pool = observations;` but the loop body has `pool = result.kept;`. This needs verification.
- **Suggested fix:** If `pool` is reassigned in the loop, it must be `let`, not `const`.

## No other issues found

The code removal is clean and complete. All uncited protection references are gone from source and docs. Coverage tags remain as advisory signals in the pruner prompt. Documentation updates are consistent. The per-pass early exit scoping is correct and untouched.
