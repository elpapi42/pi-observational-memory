# How it works

This is the V3 technical reference for `pi-observational-memory`.

V3 is ledger-centered: memory state is reconstructed by folding V3 ledger entries on the current branch. When that projection is non-empty, V3 renders it model-free into the summary the agent sees. Empty projections delegate to Pi's native summarizer.

## Runtime entry points

`src/index.ts` registers one shared runtime and these Pi surfaces:

| Surface | Purpose |
|---|---|
| `turn_end` observer trigger | Maybe run the observer in the background. |
| `turn_end` reflect/drop trigger | Maybe run the due reflector, then run dropper maintenance only after same-run successful reflection. |
| `agent_settled` compaction trigger | Maybe call `ctx.compact()` when idle and over `compactAfterTokens`, after Pi finishes retries and queued continuation. |
| `session_before_compact` hook | Build the V3 compaction payload deterministically. |
| `/om:status` | Show ledger counts, drift, progress clocks, and worker state. |
| `/om:view` | Show visible or full memory content and attempt to copy the rendered memory text. |
| `recall` tool | Recover source evidence for a memory id. |

## Lifecycle overview

```mermaid
flowchart TD
    TE[turn_end]
    AE[agent_settled]
    SBC[session_before_compact]

    ObsDue{raw tokens since observation coverage<br/>≥ observeAfterTokens?}
    Observer[Observer model call<br/>append om.observations.recorded]

    ReflectDropDue{observer not due<br/>and reflection/drop clock due?}
    BothDue{both due?}
    ReflectorOnly{reflector due only?}
    Reflector[Reflector model call<br/>append om.reflections.recorded]
    Dropper[Dropper model call<br/>append om.observations.dropped]

    CompactDue{raw tokens since compaction<br/>≥ compactAfterTokens<br/>and idle?}
    CompactCall[ctx.compact]

    Fold[fold/project V3 ledger]
    Render[render deterministic summary]
    Details[return om.folded details]

    TE --> ObsDue
    ObsDue -- yes --> Observer
    ObsDue -- no --> ReflectDropDue
    ReflectDropDue --> BothDue
    BothDue -- yes --> Reflector --> Dropper
    BothDue -- no --> ReflectorOnly
    ReflectorOnly -- yes --> Reflector
    ReflectorOnly -- no --> Dropper

    AE --> CompactDue
    CompactDue -- yes --> CompactCall
    CompactCall --> SBC
    SBC --> Fold --> Render --> Details
```

The observer has priority. Reflect/drop does not run on a turn where observer work is due.

## Source entries and progress

V3 raw-token progress counts only source entries:

- `message`
- `custom_message`
- `branch_summary`

Memory ledger entries and compaction entries do not add raw-token progress.

Completed observation and reflection reviews carry `data.coversUpToId`; incomplete reviews carry `data.inputUpToId` and do not advance progress. Legacy observation/reflection entries without a `completion` field retain their former `coversUpToId` interpretation. Worker clocks count raw/source tokens after the latest valid completed watermark for that worker's ledger type:

| Worker/trigger | Progress source |
|---|---|
| Observer | latest completed or legacy `om.observations.recorded.data.coversUpToId` |
| Reflector | latest completed or legacy `om.reflections.recorded.data.coversUpToId` |
| Dropper | latest `om.observations.dropped.data.coversUpToId` |
| Auto-compaction | latest compaction boundary |

For bounded projections, completed and legacy records resolve their input boundary from `coversUpToId`; incomplete records resolve it from `inputUpToId`. The first-valid record for an id keeps its original boundary. A boundary is not provenance: provenance lives in `sourceEntryIds` and `supportingObservationIds`.

## Ledger data shapes

### Observations recorded

```ts
customType: "om.observations.recorded"
data:
  | { completion: "completed"; observations: Observation[]; coversUpToId: string }
  | { completion: "incomplete"; observations: [Observation, ...Observation[]]; inputUpToId: string }
  | { observations: [Observation, ...Observation[]]; coversUpToId: string } // legacy
```

Each observation:

```ts
type Observation = {
  id: string;
  content: string;
  timestamp: string;
  relevance: "low" | "medium" | "high" | "critical";
  sourceEntryIds: string[];
  tokenCount: number;
}
```

Incomplete records are retained without advancing coverage. A completed empty array is an explicit "nothing new" verdict and advances `coversUpToId`; empty legacy and incomplete arrays are invalid. Readers fold valid observations from completed, incomplete, and legacy entries.

### Reflections recorded

```ts
customType: "om.reflections.recorded"
data:
  | { completion: "completed"; reflections: Reflection[]; coversUpToId: string }
  | { completion: "incomplete"; reflections: [Reflection, ...Reflection[]]; inputUpToId: string }
  | { reflections: [Reflection, ...Reflection[]]; coversUpToId: string } // legacy
```

Each reflection:

```ts
type Reflection = {
  id: string;
  content: string;
  supportingObservationIds: string[];
  tokenCount: number;
}
```

The reflector must cite valid active observation ids. Completed empty entries are intentional no-new-reflection reviews; incomplete entries retain accepted records but do not advance reflection coverage.

### Observations dropped

```ts
customType: "om.observations.dropped"
data: {
  observationIds: string[];
  coversUpToId: string;
}
```

Drops are tombstones. They remove ids from active observations but do not delete ledger history.

### Folded compaction details

```ts
details: {
  type: "om.folded";
  version: 1;
  fullFold: boolean;
  observations: Observation[];
  reflections: Reflection[];
}
```

These details are what later visible projections read. The ledger remains the source of truth.

## Observer flow

The observer trigger checks eligibility on `agent_start` and `turn_end`.

1. Load config if needed and skip in passive mode or while another pass is in flight.
2. Count raw/source tokens since the latest completed observation watermark; skip below `observeAfterTokens`.
3. Select the oldest size-capped chunk after that watermark and serialize its source entries.
4. Resolve the memory model and run `runObserver()` in a background task.
5. Require a complete final assistant tool batch: every call in that batch must be the expected recording tool with a successful finalized result and `terminate: true`, followed by clean agent/stream completion.
6. Validate source ids and compute deterministic ids and per-observation token counts in code.
7. Persist accepted partial records with `completion: "incomplete"` and `inputUpToId`; persist completed records with `completion: "completed"` and `coversUpToId`.

A valid explicit empty completed tool call writes an empty completed envelope and advances coverage. No tool call, plain text, partial batch, rejected work, or incomplete final turn does not advance coverage. Accepted records from an incomplete run are retained and deduplicated on retry. If the stream fails after accepting records, save them as incomplete, report the stage failure, and abort the rest of that pass. Without accepted records, the existing one-time fallback may retry a thrown stage failure. There is no in-memory empty-result backoff; unfinished work is eligible again when its configured token clock is due. Observer chunks target a fixed 60,000 estimated tokens, oldest-first, so an oversized uncovered span drains in slices; the oldest entry is always included even if it alone exceeds the target. API/stream failures surface as worker errors rather than as empty completion.

## Reflect/drop flow

Reflect/drop checks the reflection raw-token clock on eligible passes, including after observer work in the same pass.

1. Skip in passive mode or while another pass is in flight; resolve the model only for stages that are due.
2. Fold current ledger state and select active observations whose first-valid record input boundary resolves at or before the latest completed observer watermark. Partial observations beyond that watermark remain out of the reflection review.
3. Run the reflector over that bounded snapshot, annotating records with reflection coverage tiers (`none`, `partial`, `strong`). Coverage is context, not a quota.
4. Persist completed reflections with `coversUpToId`; persist accepted incomplete reflections with `inputUpToId`. An explicit empty completed review advances reflection coverage.
5. Run the dropper only after a same-pass completed review adds at least one new reflection and the reviewed observation pool is over `observationsPoolTargetTokens`. Give it the same reviewed snapshot intersected with current active observations, so neither newer partial records nor observations already tombstoned can become drop candidates.
6. Append non-empty `om.observations.dropped` with `coversUpToId` set to the earlier branch position of latest completed observation coverage and same-run reflection coverage.

No-tool or incomplete reflection reviews do not advance coverage and skip the dropper. If reflection fails after accepting records, save them as incomplete, report the stage failure, and abort that pass. Dropper failure does not roll back already-appended reflections.

## Auto-compaction trigger

The auto-compaction trigger runs on `agent_settled`, after Pi has finished automatic retries, automatic compaction, and queued continuation.

It skips when:

- `passive` is true;
- compaction is already in flight;
- estimated source-entry progress after the latest compaction boundary is below `compactAfterTokens`;
- Pi is not idle after the deferred check;
- the raw threshold is no longer met after the deferred check.

The count starts at `firstKeptEntryId` when Pi provides that boundary. Memory
ledger entries and compaction metadata contribute zero. The trigger uses this
same raw metric before scheduling and in the deferred re-check, then calls
`ctx.compact()` when all checks pass.

This trigger does not wait for observer, reflector, or dropper promises. That is intentional: background memory work should never make compaction feel stuck.

## Compaction hook

The compaction hook runs on `session_before_compact` and is the critical V3 latency path.

It does only deterministic work:

1. Guard against duplicate concurrent compaction hooks.
2. Load config if needed.
3. Read `event.preparation.firstKeptEntryId` and `event.preparation.tokensBefore`.
4. Build a compaction projection from branch entries and `firstKeptEntryId`.
5. Render a summary from projected reflections and observations.
6. If the summary is empty, return no extension result so Pi uses native compaction.
7. Otherwise return `{ compaction: { summary, firstKeptEntryId, tokensBefore, details } }` where `details.type` is `om.folded`.

It does not:

- call a model;
- run a sync observer;
- run reflector/dropper;
- wait for worker promises;
- append ledger entries.

If another compaction hook is already in flight, it returns `{ cancel: true }`. Delegating an empty projection is intentionally different: Pi proceeds with its native summarizer so pre-cut context is preserved.

## Projections

V3 uses projection helpers so commands, compaction, and recall do not each invent their own truth.

### Full projection

Full projection folds valid V3 observations, reflections, and drops from branch root through the requested boundary. Observation/reflection records are included by resolving `data.coversUpToId` for completed/legacy entries or `data.inputUpToId` for incomplete entries against that boundary, not by the physical position of the `om.*` custom entry. Old V2 entries/details, invalid V3-shaped entries, and dangling boundaries are ignored.

### Visible projection

Visible projection without a boundary reads the latest V3 `om.folded` compaction details. This is what the agent currently sees.

### Compaction projection

When compaction runs, the projection helper decides whether this compaction is a full fold. It first builds the normal compaction projection: observations whose completed/legacy `coversUpToId` or incomplete `inputUpToId` reaches `firstKeptEntryId`, with reflection/drop effects held stable from the latest full-fold boundary. If there is no previous full-fold boundary, normal compaction includes observations only and excludes reflections/drops. It sums that projection's active observation `tokenCount`; if the total is at or above `observationsPoolMaxTokens`, it performs a full fold through `firstKeptEntryId`, applying observations, reflections, and drops by their resolved input/coverage boundaries. Otherwise, it keeps the normal projection.

### Diff projection

Diff projection compares visible memory with full memory. `/om:status` uses this to show recorded-vs-visible drift. `/om:status` also reports the visible observation pool separately from the folded active observation pool because compaction pressure and dropper maintenance intentionally use different projections and thresholds.

## Summary rendering

The renderer returns an empty string when there are no visible observations or reflections. Otherwise it starts with deterministic usage instructions that tell the agent how to treat the memory, how to handle conflicts, and when to use `recall` for exact source context. It then renders reflection and observation sections when those entries exist:

```md
These are condensed memories from earlier in this session.

- Reflections: stable, long-lived facts about the user, project, decisions, and constraints. New reflection lines may include ids in brackets.
- Observations: timestamped events from the conversation history, in chronological order. Observation lines include ids in brackets.

Treat these as past records. When entries conflict, the most recent observation reflects the latest known state. Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.

When exact source context is needed for precision or traceability, use the recall tool with the relevant observation or reflection id. This is especially useful when a reflection materially affects a decision or is too compressed to continue confidently. Do not use recall as broad search or inject raw source unless it is needed.

## Reflections
[id] durable reflection

## Observations
[id] YYYY-MM-DD HH:MM [relevance] timestamped observation
```

The renderer is deterministic. It does not call a model and does not rewrite memory content.

## Commands

### `/om:status`

Shows:

- recorded/dropped/visible observation counts, with plain `+N` / `-N` visible-vs-full drift suffixes when drift exists;
- recorded/visible reflection counts, with a plain `+N` drift suffix when full memory has extra reflections;
- next observation/reflection/compaction token progress and drop coverage since the last successful drop;
- visible observation pool pressure against `observationsPoolMaxTokens` from the current compaction projection;
- active observation pool pressure against `observationsPoolTargetTokens` from folded active observations;
- dropper state explaining whether the active pool is under target or waiting for the next successful reflection;
- reflection pool token total;
- passive mode;
- worker in-flight flags;
- last observer and reflect/drop errors.

### `/om:view`

Default mode shows visible memory and attempts to copy the rendered memory text to the clipboard. If no V3 compaction has happened yet, visible memory can be empty because nothing has been folded into `om.folded` details; use `/om:view full` to inspect recorded branch memory before the first compaction.

Clipboard copy uses platform clipboard commands (`pbcopy`, `clip`, `wl-copy`, `xclip`, `xsel`, or `termux-clipboard-set`). If copying succeeds, Pi shows `Copied /om:view output to clipboard.` If copying fails, the command still prints the memory view and shows a warning. The clipboard text is only the rendered memory content; it does not include the success/failure line.

### `/om:view full`

Shows full V3 ledger truth at branch tip and attempts to copy the rendered memory text to the clipboard using the same success/failure behavior as default `/om:view`.

## Recall flow

The agent-facing `recall` tool accepts a 12-character lowercase hex id.

1. Validate id shape.
2. Read the current branch.
3. Index V3 observations, reflections, and drops from ledger history.
4. Match the id against observations and reflections.
5. For observations, mark status as `active` or `dropped`.
6. Resolve observation source entries from `sourceEntryIds`.
7. For reflections, resolve supporting observations and their sources.
8. Return exact evidence plus diagnostics for missing/non-source entries.

Recall ignores old V2 memory by construction because it indexes only V3 ledger entry types.

## Error and race handling

- Worker in-flight flags prevent duplicate observer or reflect/drop runs.
- Reflection and drop inputs are bounded by completed observation coverage, so partial observation tails cannot be reviewed or pruned.
- Incomplete workers append accepted records without advancing coverage; only an explicit completed empty result writes an empty progress entry.
- Invalid source/support/drop ids are filtered or rejected by code.
- Background worker errors are recorded on runtime state and surfaced in `/om:status`.
- Compaction does not wait for background workers; it folds whatever ledger state is already present.
- Historical or invalid coverage markers are tolerated by progress helpers instead of throwing.

## V2 behavior

V3 does not use V2 state shapes. Old V2 custom memory entries, old V2 compaction details, and old V2 config keys are ignored. Existing old visible compaction text in a continued session may remain visible until a V3 compaction replaces it. The recommended upgrade path is to update settings and start a new clean session.

## Invariants

- The branch-local V3 ledger is the memory source of truth.
- Pi compaction summaries represent what the agent sees.
- Non-empty V3 compaction projections are deterministic and model-free; empty projections delegate to Pi's native summarizer.
- Observer input is raw/source entries only.
- `coversUpToId` is a completed-review progress watermark; `inputUpToId` bounds incomplete records. Neither is provenance.
- Kept observations and reflections are rendered without paraphrase.
- Dropped observations remain recallable from ledger history.
- Old V2 memory is ignored rather than migrated.
