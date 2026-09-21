# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Model auth (OAuth vs API key)

`src/runtime.ts` `resolveModel` must accept auth that carries EITHER an `apiKey` OR non-empty
`headers` (e.g. `Authorization: Bearer …`). Pi's OAuth providers (kimi-coding, xai, openai-codex,
anthropic OAuth, …) return headers-only auth from `getApiKeyAndHeaders`, and pi-ai providers treat a
caller-supplied `Authorization` header as a substitute apiKey. The acceptance rule mirrors pi's own
`AgentSession._getRequiredRequestAuth` (`result.auth.apiKey || result.auth.headers`). Do not
re-introduce a hard `apiKey` requirement — it breaks compaction/consolidation for every OAuth model.
Tests: `npm test` (vitest); typecheck: `npm run typecheck`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

<!-- opm:managed:start -->
- The user prefers narrow fixes that preserve unrelated improvements. For ambiguous semantics, the user wants options and tradeoffs first, then autonomous implementation, validation, and a focused pull request.
- Compaction, consolidation, and memory storage use separate token domains. `compactAfterTokens` measures estimated source entries after the compaction boundary, while observation and reflection scheduling can use provider deltas. Pool, serialized-input, stored-memory, and output limits use local estimates. Changes to token accounting must align the trigger, status, documentation, and tests. The diagnostic runbook is `.pi/skills/diagnose-compaction-trigger`.
- Pi exposes aggregate active-context usage, not exact token attribution for an entry or entry-ID range. Its exported range-capable estimator uses a character heuristic, so provider context cannot replace raw-entry counting without changing semantics.
- Pi context pressure and compactable history are separate conditions. Extension-requested `ctx.compact()` can fail before `session_before_compact` when Pi finds no removable range, while Pi-native compaction handles this path separately.
- `firstKeptEntryId` is a retention boundary, not a zero-progress boundary. Retained source entries can already exceed `compactAfterTokens`, so cadence changes must test consecutive post-success turns and distinguish successful repetition from failed-attempt backoff.
- Compaction must never discard source entries observation coverage has not reached. The proactive trigger counts observed tokens only (`observedTokensSinceLastCompaction`), and `session_before_compact` either moves `firstKeptEntryId` back to the turn containing the first unobserved entry (folding through the coverage marker, within `compactionMaxRetainedTokens`) or declines ownership so Pi's native summarizer runs. Pi honors an extension-supplied `firstKeptEntryId`; keep it on a valid cut point (user/assistant message, never a tool result) so no tool result is orphaned. Observer/reflector due-checks take the larger of the raw uncovered backlog and the provider delta: the delta alone starves coverage that fell behind a compaction.
- Compaction must never discard source entries observation coverage has not reached. The proactive trigger counts observed tokens only (`observedTokensSinceLastCompaction`), and `session_before_compact` either moves `firstKeptEntryId` back to the turn containing the first unobserved entry (folding through the coverage marker, within `compactionMaxRetainedTokens`) or declines ownership so Pi's native summarizer runs. Pi honors an extension-supplied `firstKeptEntryId`; keep it on a valid cut point (user/assistant message, never a tool result) so no tool result is orphaned. Observer/reflector due-checks take the larger of the raw uncovered backlog and the provider delta: the delta alone starves coverage that fell behind a compaction.
<!-- opm:managed:end -->
