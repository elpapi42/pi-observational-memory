# Concepts

This page defines the V3 vocabulary used by `pi-observational-memory`.

## The big picture

Long Pi sessions eventually outgrow the model context window. Pi solves that by compacting older messages into a summary while keeping recent messages verbatim. This extension makes that summary more durable by maintaining a branch-local memory ledger while the session happens.

In V3, the ledger is the source of truth. Compaction entries contain what the agent sees, but memory state is reconstructed by folding V3 ledger entries on the current branch.

## Memory layers

### Observations

An observation is a timestamped event from the conversation.

Shape:

```ts
type Observation = {
  id: string;                 // deterministic 12-character lowercase hex id
  content: string;            // single-line plain prose
  timestamp: string;          // YYYY-MM-DD HH:MM
  relevance: "low" | "medium" | "high" | "critical";
  sourceEntryIds: string[];   // raw/source entries that support this observation
  tokenCount: number;         // estimated content tokens
}
```

Rendered in summaries/views:

```md
[d4e5f6a1b2c3] 2026-01-15 14:30 [high] User decided to switch from REST to GraphQL for the public API; motivation was reducing over-fetching on mobile clients.
```

Observations are written by the observer into `om.observations.recorded` ledger entries. They are factual event records, not durable conclusions.

### Reflections

A reflection is a durable conclusion distilled from observations: user preferences, project constraints, architectural decisions, recurring behavior, or long-lived facts.

Shape:

```ts
type Reflection = {
  id: string;                         // deterministic 12-character lowercase hex id
  content: string;                    // single-line plain prose
  supportingObservationIds: string[]; // evidence observations
  tokenCount: number;                 // estimated content tokens
}
```

Rendered:

```md
[a1b2c3d4e5f6] User works at Acme Corp building Acme Dashboard on Next.js 15 with Supabase auth.
```

Reflections are written by the reflector into `om.reflections.recorded` ledger entries. They should be fewer and more durable than observations; the reflector should not turn every observation into a reflection. The reflector receives active observations whose first-valid input boundaries are within completed observer coverage, each with a deterministic coverage tier (`none`, `partial`, or `strong`). Coverage is review context rather than a quota or automatic reflection rule.

A reflection's `supportingObservationIds` are downstream dropper coverage evidence. They should include all and only current observations whose durable meaning the reflection preserves with equivalent fidelity. False or inflated support ids can make later pruning look safer than it is.

### Drops

A drop is a tombstone for observation ids that should no longer be active memory. Drops are written by the dropper into `om.observations.dropped` ledger entries.

Dropping does not delete history. Dropped observations remain recallable from ledger history, but they are not active observations in projections.

## Actors

### Observer

The observer checks work on `agent_start` and `turn_end` when raw/source tokens after the latest completed observation marker reach `observeAfterTokens`. It receives an oldest-first chunk of raw/source entries, validates source ids, and reports an explicit completed, nothing-new, incomplete, or failed outcome.

Completed reviews append `om.observations.recorded` with `completion: "completed"` and `coversUpToId`; an intentional empty batch is a valid nothing-new completion. Incomplete reviews append accepted records with `completion: "incomplete"` and `inputUpToId`, but do not advance coverage. A missing tool completion, plain text, rejected work, or a later stream failure cannot certify the source range. Accepted partial records are deduplicated on retry. There is no empty-result backoff: unfinished work is eligible again whenever its configured token clock is due. Chunking targets a fixed 60,000 estimated tokens but always includes at least one entry, so a single oversized entry cannot stall coverage.

### Reflector

The reflector runs when its raw-token clock reaches `reflectAfterTokens`. Its active observation snapshot includes only first-valid observation records whose input boundaries resolve at or before completed observer coverage; newer partial records remain out of the review.

Completed reviews append `om.reflections.recorded` with `completion: "completed"` and `coversUpToId`, including an explicit empty no-new verdict. Accepted incomplete records use `completion: "incomplete"` and `inputUpToId` without advancing coverage. Reflections must cite valid supporting observation ids. The reflector's coverage annotations describe current support state only; this first coverage-stewardship model does not repair historical coverage on existing reflections that already missed a supporting observation id.

### Dropper

The dropper runs only as post-reflection maintenance: after a completed same-turn review adds non-empty reflections, the dropper may run if that reviewed observation snapshot is over `observationsPoolTargetTokens`. It receives that same snapshot intersected with current active observations, plus same-turn reflections; newer partial or already-dropped records are excluded.

The dropper can only drop active observation ids. It cannot rewrite or merge observations. Relevance is treated as importance/resistance rather than an absolute lock: `critical` observations are the highest-resistance candidates, but they can be dropped when the model judges that age, reflection coverage, supersession, redundancy, and semantic safety make removal from active memory safe. Its maximum drop count is computed from tokens over target converted to an approximate observation count, and the model may drop fewer or none.

### Compaction hook

The compaction hook runs during `session_before_compact`. When V3 memory exists, it is deterministic and model-free:

- it does not run observer, reflector, or dropper;
- it does not call a model;
- it does not wait for background memory workers;
- it folds/projects ledger state and renders the summary.

If the projection is empty, the hook returns no extension compaction and Pi uses its native summarizer. This preserves pre-cut context instead of persisting an empty summary. Prepared V3 compactions remain effectively instantaneous compared with V2.

## Ledger entries

V3 uses three custom memory ledger entry types. Completed and legacy observation/reflection records advance coverage; incomplete records retain accepted data without a progress watermark:

```ts
om.observations.recorded:
  | { completion: "completed"; observations: Observation[]; coversUpToId: string }
  | { completion: "incomplete"; observations: [Observation, ...Observation[]]; inputUpToId: string }
  | { observations: [Observation, ...Observation[]]; coversUpToId: string } // legacy

om.reflections.recorded:
  | { completion: "completed"; reflections: Reflection[]; coversUpToId: string }
  | { completion: "incomplete"; reflections: [Reflection, ...Reflection[]]; inputUpToId: string }
  | { reflections: [Reflection, ...Reflection[]]; coversUpToId: string } // legacy

om.observations.dropped: {
  observationIds: string[];
  coversUpToId: string;
}
```

An empty observations/reflections array is valid only on an explicit completed entry. Readers still fold valid records from incomplete entries.

The compaction hook writes V3 folded details on Pi compaction entries:

```ts
type MemoryDetails = {
  type: "om.folded";
  version: 1;
  fullFold: boolean;
  observations: Observation[];
  reflections: Reflection[];
}
```

Old V2 memory entry/details formats are ignored.

## `coversUpToId` and `inputUpToId`

`coversUpToId` is a progress watermark. On completed records it tells V3 where a worker's raw/source-token progress has reached. `inputUpToId` marks the submitted source boundary for an incomplete review and never advances that clock.

It is not:

- source provenance;
- a dependency pointer;
- proof that a later memory ledger entry caused another one.

Source provenance lives on `Observation.sourceEntryIds` and `Reflection.supportingObservationIds`.

Progress counting uses raw/source tokens after the marker. Raw/source entries are `message`, `custom_message`, and `branch_summary` entries; memory ledger entries and compaction entries do not add raw-token progress.

## Visible, full, and drift

V3 distinguishes visible memory, full memory, and the drift between them:

- **Visible memory** — what the latest `om.folded` compaction details made visible to the agent. This is what `/om:view` shows by default.
- **Full memory** — full V3 ledger truth folded at the branch tip. This is what `/om:view full` shows.
- **Drift** — the difference between visible and full memory. Use `/om:status` to inspect visible-vs-full drift.

Visible and full memory can differ intentionally. Background ledger work may happen after the latest compaction, and normal compactions may avoid re-folding reflection/drop effects until full-fold pressure requires it.

## Recall

`recall` is an agent-facing tool, not a search command. It takes a specific 12-character memory id and looks it up in V3 ledger history on the current branch.

Recall can return:

- an observation, marked `active` or `dropped`;
- a reflection plus supporting observations;
- a mixed result if an id collision exists;
- missing/non-source diagnostics when source evidence is unavailable.

Use recall when compacted memory matters and exact source evidence is needed before acting.

## Relevance tiers

Observation relevance is assigned by the observer:

| Tier | Meaning |
|---|---|
| `critical` | User identity, explicit corrections, hard constraints, completed outcomes, or facts that require the strongest evidence before leaving active memory. |
| `high` | Important decisions, non-trivial technical direction, unresolved blockers, key preferences. |
| `medium` | Useful task-level context and ordinary progress. |
| `low` | Routine status, tool acknowledgements, or details likely re-derivable from nearby context. |

The dropper uses relevance as part of its judgment, but it is not the only signal and it is not a permanent active-memory pin. User assertions, exact decisions, unique identifiers, dated events, errors, and rationale should be preserved unless safely represented by durable reflections or newer memory. Dropping removes observations from active memory, not from ledger history; recall can still recover dropped observations when their ids are known.

## V2 compatibility model

V3 intentionally does not migrate V2 memory. Old V2 settings are ignored, old V2 custom entries/details are ignored, and rollback to V2 after creating V3 ledger entries should be treated as memory reset or visibility loss.

When upgrading from V2, update settings and start a new clean session.

## Glossary

| Term | Meaning |
|---|---|
| Branch | One path through Pi's session tree. V3 memory is branch-local. |
| Ledger | Silent V3 custom memory entries folded from branch root to a point. |
| Observation | Timestamped source-backed event record. |
| Reflection | Durable conclusion backed by observations. |
| Drop | Tombstone that removes an observation id from active memory. |
| Visible memory | Latest folded memory visible to the agent through compaction details. |
| Full memory | Full V3 ledger truth folded at branch tip or another boundary. |
| Full fold | Compaction mode that folds observations, reflections, and drops through the boundary. |
| Progress watermark | `coversUpToId`; marker used for raw-token progress clocks. |
| Input boundary | `inputUpToId`; boundary stored with incomplete records for projection limits. |
| Observer | Background agent that records observations. |
| Reflector | Background agent that records durable reflections. |
| Dropper | Background agent that drops active observations by id. |
| Recall | Agent tool for exact evidence behind a memory id. |

## Where to go next

- [how-it-works.md](how-it-works.md) — runtime lifecycle and data flow.
- [configuration.md](configuration.md) — V3 settings and migration table.
- [../README.md](../README.md) — quick start and V2 upgrade notice.
