# Remove Uncited Protection Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Remove the uncited observation protection logic from the pruner so all observations always go through the pruner with coverage tags as advisory signals, and update documentation to reflect the change (including changing example `compactionMaxToolCalls` from 8 to 32).

**Architecture:** The `runPruner()` function currently branches on `protectUncited` (derived from `args.maxToolCalls`) to split observations into separate pools. We simplify it to always pass all observations to the pruner with their coverage tags. Coverage tags remain as advisory signals in the pruner prompt — the LLM sees them and uses its judgment, but no observations are mechanically excluded.

**Tech Stack:** TypeScript, Vitest

---

### Task 1: Remove uncited protection logic from `src/compaction.ts`

**TDD scenario:** Modifying tested code — run existing tests first to establish baseline, then update code and fix tests.

**Files:**
- Modify: `src/compaction.ts` (lines 601-674, the `runPruner` function body)

**Step 1: Run existing tests to establish baseline**

Run: `npx vitest run tests/pruner.test.ts`
Expected: All tests pass (the "excludes uncited observations" test currently tests the old behavior).

**Step 2: Edit `src/compaction.ts` — simplify `runPruner()`**

Replace the block from line 601 to 674. The old code:

```typescript
	const target = Math.max(1, Math.floor(budgetTokens * PRUNER_TARGET_RATIO));
	const allCoverageTags = deriveObservationCoverageTags(reflections, observations);

	// When compactionMaxToolCalls is set, the reflector may not have had enough
	// tool calls to cite all valuable observations. In that case, uncited observations
	// are protected from pruning — their uncited status is an artifact of the limit,
	// not a quality signal. When no limit is set, all observations go to the pruner
	// with advisory coverage tags.
	const protectUncited = args.maxToolCalls !== undefined && args.maxToolCalls > 0;

	let pool: ObservationRecord[];
	let uncitedPool: ObservationRecord[] = [];
	let coverageTags: ReadonlyMap<string, ObservationCoverageTag>;

	if (protectUncited) {
		const prunablePool: ObservationRecord[] = [];
		for (const obs of observations) {
			const tag = allCoverageTags.get(obs.id) ?? "uncited";
			if (tag === "uncited") {
				uncitedPool.push(obs);
			} else {
				prunablePool.push(obs);
			}
		}

		if (prunablePool.length === 0) {
			return { observations, droppedIds: [], fellBack: false };
		}

		coverageTags = deriveObservationCoverageTags(reflections, prunablePool);
		pool = prunablePool;
	} else {
		coverageTags = allCoverageTags;
		pool = observations;
	}
```

Replace with:

```typescript
	const target = Math.max(1, Math.floor(budgetTokens * PRUNER_TARGET_RATIO));
	const coverageTags = deriveObservationCoverageTags(reflections, observations);
	const pool = observations;
```

Then replace the return block at the end of `runPruner()`:

```typescript
	if (protectUncited) {
		// Merge back: uncited (always kept) + prunable that survived pruning
		const finalObservations = [...uncitedPool, ...pool];
		return { observations: finalObservations, droppedIds: allDropped, fellBack };
	}
	return { observations: pool, droppedIds: allDropped, fellBack };
```

Replace with:

```typescript
	return { observations: pool, droppedIds: allDropped, fellBack };
```

**Step 3: Commit**

```bash
git add src/compaction.ts
git commit -m "refactor: remove uncited observation protection from pruner"
```

---

### Task 2: Update pruner test to match new behavior

**TDD scenario:** Modifying existing test to match new behavior.

**Files:**
- Modify: `tests/pruner.test.ts` (the test at line ~187)

**Step 1: Replace the test `"excludes uncited observations from the pruner pool when maxToolCalls is set"`**

Replace the entire test block:

```typescript
	it("excludes uncited observations from the pruner pool when maxToolCalls is set", async () => {
		const loop = fakeAgentLoop((prompts) => {
			const text = promptText(prompts);
			// Only cited/reinforced observations are passed to the pruner
			expect(text).toContain(`[${obsA.id}] ${obsA.timestamp} [high] [coverage: cited] ${obsA.content}`);
			expect(text).toContain(`[${obsB.id}] ${obsB.timestamp} [medium] [coverage: reinforced] ${obsB.content}`);
			// Uncited observations are excluded from the pruner pool when maxToolCalls is set
			expect(text).not.toContain(`[${obsC.id}]`);
		});
		const reflections: MemoryReflection[] = [
			reflection("A cited.", [obsA.id]),
			reflection("B cited 1.", [obsB.id]),
			reflection("B cited 2.", [obsB.id]),
			reflection("B cited 3.", [obsB.id]),
			reflection("B cited 4.", [obsB.id]),
		];

		const result = await runPruner({ model: {} as any, apiKey: "test", agentLoop: loop, maxToolCalls: 8 }, reflections, observations, 1);

		// All observations returned: uncited (always kept) + prunable (no drops)
		expect(result.droppedIds).toEqual([]);
		expect(result.observations.length).toBe(observations.length);
	});
```

With:

```typescript
	it("passes all observations including uncited to the pruner pool regardless of maxToolCalls", async () => {
		const loop = fakeAgentLoop((prompts) => {
			const text = promptText(prompts);
			// All observations are passed to the pruner with coverage tags, even when maxToolCalls is set
			expect(text).toContain(`[${obsA.id}] ${obsA.timestamp} [high] [coverage: cited] ${obsA.content}`);
			expect(text).toContain(`[${obsB.id}] ${obsB.timestamp} [medium] [coverage: reinforced] ${obsB.content}`);
			expect(text).toContain(`[${obsC.id}] ${obsC.timestamp} [low] [coverage: uncited] ${obsC.content}`);
		});
		const reflections: MemoryReflection[] = [
			reflection("A cited.", [obsA.id]),
			reflection("B cited 1.", [obsB.id]),
			reflection("B cited 2.", [obsB.id]),
			reflection("B cited 3.", [obsB.id]),
			reflection("B cited 4.", [obsB.id]),
		];

		const result = await runPruner({ model: {} as any, apiKey: "test", agentLoop: loop, maxToolCalls: 32 }, reflections, observations, 1);

		expect(result.droppedIds).toEqual([]);
		expect(result.observations.length).toBe(observations.length);
	});
```

**Step 2: Run tests to verify**

Run: `npx vitest run tests/pruner.test.ts`
Expected: All tests pass.

**Step 3: Commit**

```bash
git add tests/pruner.test.ts
git commit -m "test: update pruner test to verify all observations pass through regardless of maxToolCalls"
```

---

### Task 3: Update `README.md` — change example value and remove uncited protection description

**TDD scenario:** Trivial doc change — no tests needed.

**Files:**
- Modify: `README.md`

**Step 1: Edit the example snippet**

Change:
```json
     "compactionMaxToolCalls": 8
```
To:
```json
     "compactionMaxToolCalls": 32
```

**Step 2: Edit the description above the snippet**

Change:
```
To cap tool calls per reflector/pruner pass and protect uncited observations from pruning (useful for controlling cost on large observation pools):
```
To:
```
To cap tool calls per reflector/pruner pass (useful for controlling cost on large observation pools):
```

**Step 3: Edit the settings table description**

Change:
```
| `compactionMaxToolCalls` | *(not set)* | Caps tool calls per reflector/pruner pass; when set, also protects uncited observations from pruning |
```
To:
```
| `compactionMaxToolCalls` | *(not set)* | Caps tool calls per reflector/pruner pass |
```

**Step 4: Commit**

```bash
git add README.md
git commit -m "docs: update compactionMaxToolCalls example to 32, remove uncited protection description"
```

---

### Task 4: Update `docs/configuration.md` — change example value and remove uncited protection description

**TDD scenario:** Trivial doc change — no tests needed.

**Files:**
- Modify: `docs/configuration.md`

**Step 1: Edit the intro paragraph mentioning uncited protection**

Change:
```
Two settings don't have defaults and are easy to miss: **`compactionModel`** and **`compactionMaxToolCalls`**. Left unset, the observer / reflector / pruner all use the session model with no tool call cap and no uncited observation protection. A realistic settings file that overrides both looks like this:
```
To:
```
Two settings don't have defaults and are easy to miss: **`compactionModel`** and **`compactionMaxToolCalls`**. Left unset, the observer / reflector / pruner all use the session model with no tool call cap. A realistic settings file that overrides both looks like this:
```

**Step 2: Change the example value in the full settings snippet**

Change:
```json
    "compactionMaxToolCalls": 8
```
To:
```json
    "compactionMaxToolCalls": 32
```

**Step 3: Rewrite the `compactionMaxToolCalls` section**

Replace the entire section from `### \`compactionMaxToolCalls\` — default: not set` through to the `---` separator:

```markdown
### `compactionMaxToolCalls` — default: not set

An optional integer that caps the number of tool calls per reflector or pruner pass. When set to a positive number, each reflector and pruner pass stops after this many tool calls (across all `record_reflections` or `drop_observations` invocations). The agents also stop early when two consecutive tool calls produce no new results (`consecutiveEmptyCalls >= 2`), regardless of this cap.

**Not set** (default): no tool call cap. Both reflector and pruner run until `consecutiveEmptyCalls >= 2` stops them. All observations go to the pruner with advisory `[coverage: uncited]`, `[coverage: cited]`, or `[coverage: reinforced]` tags, and the LLM decides based on the prompt guidance.

**Set to 0**: treated as "not set" — unlimited tool calls.

```json
{
  "observational-memory": {
    "compactionMaxToolCalls": 32
  }
}
```

**Why you'd set this.** To control LLM cost per compaction pass. Without a cap, a complex observation pool could drive many tool calls. With a cap, you trade completeness for predictable cost.

**Why the default is unset.** Unlimited tool calls gives the reflector full coverage. In that mode, uncited truly means "the reflector reviewed this and chose not to cite it" — which is a quality signal the pruner can safely act on.
```

**Step 4: Commit**

```bash
git add docs/configuration.md
git commit -m "docs: update configuration.md — change compactionMaxToolCalls example to 32, remove uncited protection"
```

---

### Task 5: Update design doc and run full test suite

**TDD scenario:** Final verification — run all tests.

**Step 1: Update the design doc to reflect the doc changes**

The design doc at `docs/plans/2026-05-13-remove-uncited-protection-design.md` was already updated with the doc change section. Verify it's accurate.

**Step 2: Run the full test suite**

Run: `npx vitest run`
Expected: All tests pass.

**Step 3: Commit any remaining changes**

```bash
git add docs/plans/
git commit -m "docs: finalize remove-uncited-protection design document"
```
