# Compaction Progress Widget Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Show a persistent TUI widget above the editor during compaction that updates in real-time, showing which phase (observer/reflector/pruner) and pass is running, tool call counts, and overall pipeline progress.

**Architecture:** Add a `CompactionProgressTracker` class that receives `AgentEvent` callbacks from the agent loop streams (currently drained with `for await (const _event of stream)`). Thread an `onEvent` callback through `runReflectorPass`/`runPrunerPass`/`runReflector`/`runPruner`. Wire the tracker to `ctx.ui.setWidget()` in `compaction-hook.ts`. The widget renders as a single-line status strip above the editor (same pattern as `plan_tracker` in pi-superpowers-plus).

**Tech Stack:** TypeScript, pi TUI widget API (`ctx.ui.setWidget`), existing `AgentEvent` types from `@mariozechner/pi-agent-core`

---

### Task 1: Create `CompactionProgressTracker` class

**TDD scenario:** New feature — full TDD cycle

**Files:**
- Create: `src/progress.ts`
- Create: `tests/progress.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/progress.test.ts
import { describe, expect, it } from "vitest";
import { CompactionProgressTracker } from "../src/progress.js";

describe("CompactionProgressTracker", () => {
  it("starts in idle state with no phase", () => {
    const tracker = new CompactionProgressTracker();
    expect(tracker.getPhase()).toBeUndefined();
    expect(tracker.getPass()).toBe(0);
    expect(tracker.getMaxPasses()).toBe(0);
    expect(tracker.getToolCallCount()).toBe(0);
    expect(tracker.getTurnCount()).toBe(0);
  });

  it("transitions to observer phase", () => {
    const tracker = new CompactionProgressTracker();
    tracker.setPhase("observer", 1, 1);
    expect(tracker.getPhase()).toBe("observer");
    expect(tracker.getPass()).toBe(1);
    expect(tracker.getMaxPasses()).toBe(1);
  });

  it("transitions to reflector phase with pass info", () => {
    const tracker = new CompactionProgressTracker();
    tracker.setPhase("reflector", 1, 3);
    expect(tracker.getPhase()).toBe("reflector");
    expect(tracker.getPass()).toBe(1);
    expect(tracker.getMaxPasses()).toBe(3);
  });

  it("transitions to pruner phase with pass info", () => {
    const tracker = new CompactionProgressTracker();
    tracker.setPhase("pruner", 2, 5);
    expect(tracker.getPhase()).toBe("pruner");
    expect(tracker.getPass()).toBe(2);
    expect(tracker.getMaxPasses()).toBe(5);
  });

  it("counts tool calls from agent events", () => {
    const tracker = new CompactionProgressTracker();
    tracker.setPhase("reflector", 1, 3);
    tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "record_reflections", args: {} });
    tracker.onEvent({ type: "tool_execution_end", toolCallId: "tc1", toolName: "record_reflections", result: {}, isError: false });
    tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc2", toolName: "record_reflections", args: {} });
    expect(tracker.getToolCallCount()).toBe(2);
  });

  it("counts turns from agent events", () => {
    const tracker = new CompactionProgressTracker();
    tracker.setPhase("pruner", 1, 5);
    tracker.onEvent({ type: "turn_start" });
    tracker.onEvent({ type: "turn_end", message: {} as any, toolResults: [] });
    tracker.onEvent({ type: "turn_start" });
    expect(tracker.getTurnCount()).toBe(2);
  });

  it("formats widget text for reflector phase", () => {
    const tracker = new CompactionProgressTracker();
    tracker.setPhase("reflector", 2, 3);
    tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "record_reflections", args: {} });
    const text = tracker.formatWidget({
      fg: (color: string, text: string) => `<${color}>${text}</>`,
      bold: (text: string) => `<b>${text}</b>`,
    });
    expect(text).toContain("Reflector");
    expect(text).toContain("2/3");
    expect(text).toContain("1 tool call");
  });

  it("formats widget text for pruner phase with observations dropped", () => {
    const tracker = new CompactionProgressTracker();
    tracker.setPhase("pruner", 3, 5);
    tracker.addDroppedCount(7);
    tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "drop_observations", args: {} });
    const text = tracker.formatWidget({
      fg: (color: string, text: string) => `<${color}>${text}</>`,
      bold: (text: string) => `<b>${text}</b>`,
    });
    expect(text).toContain("Pruner");
    expect(text).toContain("3/5");
    expect(text).toContain("7 dropped");
  });

  it("formats widget text for observer phase", () => {
    const tracker = new CompactionProgressTracker();
    tracker.setPhase("observer", 1, 1);
    tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "record_observations", args: {} });
    const text = tracker.formatWidget({
      fg: (color: string, text: string) => `<${color}>${text}</>`,
      bold: (text: string) => `<b>${text}</b>`,
    });
    expect(text).toContain("Observer");
  });

  it("resets counts when phase changes", () => {
    const tracker = new CompactionProgressTracker();
    tracker.setPhase("reflector", 1, 3);
    tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "record_reflections", args: {} });
    tracker.onEvent({ type: "turn_start" });
    // Change phase
    tracker.setPhase("pruner", 1, 5);
    expect(tracker.getToolCallCount()).toBe(0);
    expect(tracker.getTurnCount()).toBe(0);
  });

  it("clears state", () => {
    const tracker = new CompactionProgressTracker();
    tracker.setPhase("reflector", 1, 3);
    tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "record_reflections", args: {} });
    tracker.clear();
    expect(tracker.getPhase()).toBeUndefined();
    expect(tracker.getToolCallCount()).toBe(0);
  });

  it("ignores events when no phase is set", () => {
    const tracker = new CompactionProgressTracker();
    tracker.onEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "record_reflections", args: {} });
    expect(tracker.getToolCallCount()).toBe(0);
  });

  it("renders pipeline overview with completed phases", () => {
    const tracker = new CompactionProgressTracker();
    tracker.setCompletedPhases(["observer"]);
    tracker.setPhase("reflector", 2, 3);
    const text = tracker.formatWidget({
      fg: (color: string, text: string) => `<${color}>${text}</>`,
      bold: (text: string) => `<b>${text}</b>`,
    });
    expect(text).toContain("observer"); // completed
    expect(text).toContain("reflector"); // active
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd E:/Work/Git/pi/pi-observational-memory && npx vitest run tests/progress.test.ts`
Expected: FAIL — module not found

**Step 3: Implement `CompactionProgressTracker`**

```typescript
// src/progress.ts
import type { Text } from "@mariozechner/pi-tui";
import type { AgentEvent } from "@mariozechner/pi-agent-core";

export type CompactionPhase = "observer" | "reflector" | "pruner";

export interface ThemeLike {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
}

export class CompactionProgressTracker {
  private phase: CompactionPhase | undefined;
  private pass = 0;
  private maxPasses = 0;
  private toolCallCount = 0;
  private turnCount = 0;
  private droppedCount = 0;
  private completedPhases: CompactionPhase[] = [];

  getPhase(): CompactionPhase | undefined { return this.phase; }
  getPass(): number { return this.pass; }
  getMaxPasses(): number { return this.maxPasses; }
  getToolCallCount(): number { return this.toolCallCount; }
  getTurnCount(): number { return this.turnCount; }

  setPhase(phase: CompactionPhase, pass: number, maxPasses: number): void {
    // Mark previous phase as completed
    if (this.phase && this.phase !== phase && !this.completedPhases.includes(this.phase)) {
      this.completedPhases.push(this.phase);
    }
    this.phase = phase;
    this.pass = pass;
    this.maxPasses = maxPasses;
    this.toolCallCount = 0;
    this.turnCount = 0;
  }

  setCompletedPhases(phases: CompactionPhase[]): void {
    this.completedPhases = phases;
  }

  addDroppedCount(count: number): void {
    this.droppedCount += count;
  }

  onEvent(event: AgentEvent): void {
    if (!this.phase) return;
    switch (event.type) {
      case "tool_execution_start":
        this.toolCallCount++;
        break;
      case "turn_start":
        this.turnCount++;
        break;
    }
  }

  clear(): void {
    this.phase = undefined;
    this.pass = 0;
    this.maxPasses = 0;
    this.toolCallCount = 0;
    this.turnCount = 0;
    this.droppedCount = 0;
    this.completedPhases = [];
  }

  formatWidget(theme: ThemeLike): string {
    if (!this.phase) return "";

    const parts: string[] = [];

    // Pipeline overview: show completed phases
    const allPhases: CompactionPhase[] = ["observer", "reflector", "pruner"];
    const phaseLabels = allPhases.map((p) => {
      if (p === this.phase) {
        return theme.fg("accent", p.charAt(0).toUpperCase() + p.slice(1));
      }
      if (this.completedPhases.includes(p)) {
        return theme.fg("success", `✓${p.charAt(0).toUpperCase()}`);
      }
      return theme.fg("dim", p.charAt(0).toUpperCase());
    });
    parts.push(phaseLabels.join(theme.fg("dim", " → ")));

    // Pass info (only for multi-pass phases)
    if (this.maxPasses > 1) {
      parts.push(theme.fg("muted", `pass ${this.pass}/${this.maxPasses}`));
    }

    // Tool calls
    const tcLabel = this.toolCallCount === 1 ? "tool call" : "tool calls";
    parts.push(theme.fg("muted", `${this.toolCallCount} ${tcLabel}`));

    // Dropped count for pruner
    if (this.phase === "pruner" && this.droppedCount > 0) {
      parts.push(theme.fg("muted", `${this.droppedCount} dropped`));
    }

    return parts.join(theme.fg("dim", " · "));
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd E:/Work/Git/pi/pi-observational-memory && npx vitest run tests/progress.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/progress.ts tests/progress.test.ts
git commit -m "feat: add CompactionProgressTracker with TDD tests"
```

---

### Task 2: Thread `onEvent` callback through compaction functions

**TDD scenario:** Modifying tested code — run existing tests first

**Files:**
- Modify: `src/compaction.ts`
- Modify: `tests/reflector.test.ts`
- Modify: `tests/pruner.test.ts`

**Step 1: Run existing tests to confirm baseline**

Run: `cd E:/Work/Git/pi/pi-observational-memory && npx vitest run tests/reflector.test.ts tests/pruner.test.ts`
Expected: PASS

**Step 2: Add failing test that verifies onEvent is called**

Add to `tests/reflector.test.ts`:

```typescript
it("calls onEvent callback with agent events during reflector passes", async () => {
  const events: string[] = [];
  const loop = fakeAgentLoop(async (_prompts, context) => {
    const tool = context.tools[0];
    await tool.execute("pass-1", {
      reflections: [{ content: "User consistently prefers fork-based investigation.", supportingObservationIds: [obsA.id, obsB.id] }],
    });
  });

  // Create a fake agent loop that also emits events
  const emittingLoop = ((prompts: any[], context: any) => {
    const stream = loop(prompts, context);
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "tool_execution_start", toolCallId: "tc1", toolName: "record_reflections", args: {} };
        yield { type: "tool_execution_end", toolCallId: "tc1", toolName: "record_reflections", result: {}, isError: false };
      },
      result: stream.result,
    };
  }) as any;

  await runReflector(
    { model: {} as any, apiKey: "test", agentLoop: emittingLoop },
    [],
    observations,
    (event) => { events.push(event.type); },
  );

  expect(events).toContain("tool_execution_start");
  expect(events).toContain("tool_execution_end");
});
```

**Step 3: Modify `compaction.ts` to accept and forward `onEvent`**

Changes to `src/compaction.ts`:

1. Add `onEvent?: (event: AgentEvent) => void` to `LlmArgs` interface
2. In `runReflectorPass`: change `for await (const _event of stream)` to forward events to `args.onEvent`
3. In `runPrunerPass`: same change
4. In `runReflector`: accept and forward `onEvent`
5. In `runPruner`: accept and forward `onEvent`

Key diff for the event drain loop (applies to both `runReflectorPass` and `runPrunerPass`):

```typescript
// Before:
for await (const _event of stream) {
  // Drain events; the tool's execute already updates reflections.
}

// After:
for await (const event of stream) {
  args.onEvent?.(event);
}
```

For `runReflector`:
```typescript
export async function runReflector(
  args: LlmArgs,
  reflections: MemoryReflection[],
  observations: ObservationRecord[],
  onEvent?: (event: AgentEvent) => void,
): Promise<MemoryReflection[]> {
  let currentReflections = reflections;
  for (let pass = 1; pass <= REFLECTOR_MAX_PASSES; pass++) {
    const result = await runReflectorPass(
      { ...args, onEvent },
      currentReflections,
      observations,
      reflectorPassContext(pass),
    );
    currentReflections = result.reflections;
    if (result.failed) break;
  }
  return currentReflections;
}
```

Same pattern for `runPruner`.

**Step 4: Run all compaction tests**

Run: `cd E:/Work/Git/pi/pi-observational-memory && npx vitest run tests/reflector.test.ts tests/pruner.test.ts tests/compaction.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/compaction.ts tests/reflector.test.ts tests/pruner.test.ts
git commit -m "feat: thread onEvent callback through reflector and pruner"
```

---

### Task 3: Wire progress widget into compaction hook

**TDD scenario:** Modifying tested code — integration-level, verify manually

**Files:**
- Modify: `src/hooks/compaction-hook.ts`

**Step 1: Add imports**

```typescript
import { CompactionProgressTracker } from "../progress.js";
import type { Text } from "@mariozechner/pi-tui";
```

**Step 2: Create tracker and wire widget in the `session_before_compact` handler**

Inside the handler, after the model resolution check, create the tracker:

```typescript
const progress = new CompactionProgressTracker();

const updateWidget = () => {
  if (!hasUI || !ui) return;
  const text = progress.formatWidget(ui.getTheme?.() ?? {
    fg: (_color: string, t: string) => t,
    bold: (t: string) => t,
  });
  if (text) {
    ui.setWidget("om_compact_progress", (_tui: any, theme: any) => {
      return new Text(text, 0, 0);
    });
  }
};
```

Then wire into each phase:

**Observer catch-up section** — before `runObserver`:
```typescript
progress.setPhase("observer", 1, 1);
updateWidget();
```

**Reflector** — replace the existing `runReflector` call:
```typescript
progress.setPhase("reflector", 1, 3);
updateWidget();
finalReflections = await runReflector(
  { model: resolved.model as any, apiKey: resolved.apiKey, headers: resolved.headers, signal },
  workingReflections,
  workingObservations,
  (event) => {
    progress.onEvent(event);
    updateWidget();
  },
);
```

Wait — the reflector runs 3 passes internally. We need the pass number to update. The simplest approach: track pass transitions in the event callback by counting `agent_start` events (one per pass). But that's fragile.

Better approach: also modify `runReflector` to accept a `onPassStart` callback:

```typescript
export async function runReflector(
  args: LlmArgs,
  reflections: MemoryReflection[],
  observations: ObservationRecord[],
  onEvent?: (event: AgentEvent) => void,
  onPassStart?: (pass: number, maxPasses: number) => void,
): Promise<MemoryReflection[]> {
  // ...
  for (let pass = 1; pass <= REFLECTOR_MAX_PASSES; pass++) {
    onPassStart?.(pass, REFLECTOR_MAX_PASSES);
    // ...
  }
}
```

Then in compaction-hook:
```typescript
finalReflections = await runReflector(
  { model: resolved.model as any, apiKey: resolved.apiKey, headers: resolved.headers, signal },
  workingReflections,
  workingObservations,
  (event) => { progress.onEvent(event); updateWidget(); },
  (pass, max) => { progress.setPhase("reflector", pass, max); updateWidget(); },
);
```

Same pattern for pruner with its 5 passes.

**After pruner completes** — clear widget:
```typescript
// At the end of the try block, before return:
progress.clear();
if (hasUI && ui) ui.setWidget("om_compact_progress", undefined);
```

**In the finally block** — ensure cleanup:
```typescript
finally {
  runtime.compactHookInFlight = false;
  if (hasUI && ui) ui.setWidget("om_compact_progress", undefined);
}
```

**Step 2: Verify existing tests pass**

Run: `cd E:/Work/Git/pi/pi-observational-memory && npx vitest run`
Expected: PASS

**Step 3: Commit**

```bash
git add src/hooks/compaction-hook.ts src/compaction.ts
git commit -m "feat: wire progress widget into compaction hook"
```

---

### Task 4: Add progress notification for step transitions

**TDD scenario:** Trivial change — use judgment

**Files:**
- Modify: `src/hooks/compaction-hook.ts`

**Step 1: Add transition notifications**

Replace the single `"running reflector + pruner..."` notification with per-phase notifications:

```typescript
// Before observer:
if (hasUI) ui?.notify("Observational memory: observer catch-up running...", "info");

// Before reflector:
if (hasUI) ui?.notify("Observational memory: reflector running (up to 3 passes)...", "info");

// Before pruner:
if (hasUI) ui?.notify("Observational memory: pruner running (up to 5 passes)...", "info");
```

These are in addition to the widget — they provide a notification history in the chat, while the widget shows real-time state.

**Step 2: Verify existing tests pass**

Run: `cd E:/Work/Git/pi/pi-observational-memory && npx vitest run`
Expected: PASS

**Step 3: Commit**

```bash
git add src/hooks/compaction-hook.ts
git commit -m "feat: add per-phase transition notifications during compaction"
```

---

### Task 5: Full test suite verification

**Files:** None (verification only)

**Step 1: Run full test suite**

Run: `cd E:/Work/Git/pi/pi-observational-memory && npx vitest run`
Expected: All tests PASS

**Step 2: Run typecheck**

Run: `cd E:/Work/Git/pi/pi-observational-memory && npx tsc --noEmit`
Expected: No errors

**Step 3: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address test/type issues from progress widget"
```
