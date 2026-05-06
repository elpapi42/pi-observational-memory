# Review Pass — Explicit Observation Verdicts Before Pruning

## Goal

Add a review stage between the reflector and pruner that forces the LLM to explicitly judge every **uncited** observation as `not-needed` or `preserve`. This eliminates the dangerous ambiguity where "uncited" could mean either "reviewed and rejected" or "never examined due to tool-call cap."

## Architecture

### Pipeline Flow (before)

```
Reflector (3 passes) → Pruner (up to 5 passes)
```

### Pipeline Flow (after)

```
Reflector (3 passes) → Reviewer (1 pass) → Pruner (up to 5 passes)
```

### How It Works

1. **Reflector runs** (same as now, with tool-call cap). Produces reflections with `supportingObservationIds`.
2. **Compute coverage** — same logic as now: cited/uncited/reinforced from reflection provenance.
3. **Reviewer runs** — receives ONLY uncited observations. For each observation, the LLM must call `review_observations` with explicit verdicts:
   - `preserve` — this observation has potential lasting value but wasn't crystallized. Keep it.
   - `not-needed` — this observation is routine, exhausted, or trivially re-derivable. Safe to drop.
   - Unreviewed observations (reviewer hit the cap before getting to them) default to `preserve`.
4. **Pruner runs** — same as now, but with an additional signal:
   - `uncited-reviewed-not-needed` → safe to drop (explicit LLM verdict)
   - `uncited-unreviewed` → protected (defaults to `preserve`)
   - `cited` / `reinforced` → same logic as before

### Key Design Decisions

- **Reviewer only sees uncited observations.** Cited/reinforced observations already have provenance — the pruner handles those with existing coverage-tag logic. This keeps the review pool small and focused.
- **One pass only.** Unlike reflector (3 passes) and pruner (up to 5), the reviewer runs a single pass. The decision per observation is simple (preserve or not-needed), not a multi-tier synthesis.
- **Batch tool calls.** The `review_observations` tool accepts an array of `{ id, verdict }` pairs. The LLM can review 10-30 observations per call, keeping total calls low even for large pools.
- **Default to preserve.** If the reviewer hits the tool-call cap, any unreviewed observations are treated as `preserve`. This is the safe default — no data loss from incomplete review.
- **Reuses existing LlmArgs + agentLoop infrastructure.** Same `onEvent` and `onPassStart` callbacks as reflector/pruner. Same `shouldStopAfterTurn` with `maxToolCalls` cap.

### Coverage Tag Extension

Current tags: `uncited | cited | reinforced`

New tags: `uncited-unreviewed | not-needed | cited | reinforced`

- `uncited-unreviewed` — uncited observation that the reviewer didn't get to (cap hit). Pruner treats as protected.
- `not-needed` — uncited observation explicitly judged by reviewer as safe to drop.
- `cited` — same as before (1-3 reflections cite it).
- `reinforced` — same as before (4+ reflections cite it).

The pruner prompt and pass strategies are updated to understand these new tags.

## Tech Stack

- TypeScript, same as existing compaction code
- vitest for tests
- Reuses `agentLoop`, `AgentTool`, `AgentLoopConfig` from pi-agent-core
- New prompt constant in `src/prompts.ts`
- New functions in `src/compaction.ts`

## Tasks

### Task 1: Add REVIEWER_SYSTEM prompt to src/prompts.ts (~5 min)

Add a new exported constant `REVIEWER_SYSTEM` with the reviewer agent system prompt. The prompt should:
- Explain the reviewer's role: explicitly judge uncited observations
- Define the two verdicts: `preserve` and `not-needed`
- Explain the `review_observations` tool and batching
- Include the observation content rules and relevance rubric (same as reflector/pruner)
- Emphasize: when in doubt, choose `preserve` — a false `not-needed` verdict loses data forever
- Note: observations marked `critical` should almost never be marked `not-needed`

**Files:** `src/prompts.ts`
**Test command:** `npx vitest run tests/compaction.test.ts`

### Task 2: Add review_observations tool schema and runReviewerPass function to src/compaction.ts (~8 min)

Add:
- `ReviewObservationsSchema` (TypeBox schema): array of `{ id: string, verdict: "preserve" | "not-needed" }`
- `ObservationReviewTag` type: `"uncited-unreviewed" | "not-needed" | "cited" | "reinforced"`
- `deriveObservationReviewTags(reflections, observations, reviewVerdicts)` — extends coverage tags with review verdicts
- `runReviewerPass(args, reflections, uncitedObservations)` — single-pass review using agentLoop
  - Creates `review_observations` tool that collects verdicts
  - Returns `{ verdicts: Map<string, "preserve" | "not-needed">, failed: boolean }`

**Files:** `src/compaction.ts`
**Tests:** Add to `tests/reflector.test.ts` or new `tests/reviewer.test.ts`

### Task 3: Add runReviewer orchestration function (~3 min)

Add `runReviewer(args, reflections, observations, onPassStart?)`:
- Computes uncited observations from coverage tags
- If no uncited observations, returns empty verdicts (nothing to review)
- Calls `runReviewerPass` once
- Returns `Map<string, "preserve" | "not-needed">`

**Files:** `src/compaction.ts`
**Tests:** Add to reviewer test file

### Task 4: Update pruner to use review tags instead of coverage tags (~5 min)

- Update `renderObservationsForPrunerPrompt` to render new tag format: `[review: not-needed]`, `[review: uncited-unreviewed]`, `[coverage: cited]`, `[coverage: reinforced]`
- Update `PRUNER_SYSTEM` prompt to explain review tags
- Update pruner pass strategies to handle new tags:
  - `not-needed` → prime drop candidate (explicit LLM verdict)
  - `uncited-unreviewed` → protected, do not drop
  - `cited` / `reinforced` → same as before

**Files:** `src/compaction.ts`, `src/prompts.ts`
**Tests:** Update existing pruner tests, add tests for new tag rendering

### Task 5: Wire reviewer into compaction-hook.ts (~3 min)

Insert reviewer between reflector and pruner:
1. After reflector completes, compute uncited observations
2. If uncited count > 0, run reviewer with progress tracking
3. Pass review verdicts to pruner via new parameter
4. Update progress widget to show reviewer phase

**Files:** `src/hooks/compaction-hook.ts`
**Tests:** Run full test suite

### Task 6: Update progress widget for reviewer phase (~2 min)

Add reviewer to `CompactionProgressTracker`:
- Phase abbreviations: observer=O, reflector=R, reviewer=V (for "verdict"), pruner=P
- Reviewer shows count of reviewed vs total uncited

**Files:** `src/progress.ts`, `tests/progress.test.ts`

### Task 7: Full test suite verification (~2 min)

Run TypeScript check and all tests.

**Command:** `npx tsc --noEmit && npx vitest run`
