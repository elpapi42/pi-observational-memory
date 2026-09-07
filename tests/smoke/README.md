# Real-host activation-boundary smoke test

This directory holds a **black-box smoke test** that proves the observational-memory
activation boundary against a real, installed OMP host — not against a
simulated `ExtensionContext`. It is separate from the Vitest unit suite
(`bun run test`), which drives the extension in-process and cannot spawn a
real host process or a real native subagent.

## What it proves

`run.ts` spawns three independent OMP `--mode rpc` host processes against a
deterministic local HTTP model fixture (`mock-model-server.ts`, no external
network access or credentials) and asserts, end to end:

1. **Parent activation.** A fresh RPC session starts disabled; disabled
   compaction (`{"type":"compact"}`) injects no observational summary
   sections; `/om` dispatched over the real RPC command route activates the
   session; a repeated `/om` is idempotent; `/om:status` and `/om:view`
   report the enabled state over RPC; once the observer has recorded an
   observation, compaction supplies the observational projection.
2. **Real native-subagent isolation.** The parent's `smoke_task` extension tool
   spawns a genuine in-process child `AgentSession` via OMP's SDK
   `createAgentSession()` — the same mechanism a real native subagent uses, with
   no TUI, stdin, or RPC command channel. The child
   loads the *same* observational-memory extension. The test asserts the
   child's session branch contains **zero** `om.*` ledger entries and that
   the child's own compaction is native (no observational summary sections,
   no `om.folded`-shaped details) — proving parent activation is not
   inherited by a child session.
3. **Independent RPC session.** A second, wholly separate OMP process
   proves it starts disabled (not inheriting the first process's
   activation) and can independently activate itself with its own `/om`.
4. **Passive lockout.** A third process configured with
   `"observational-memory": { "passive": true }` proves `/om` is rejected
   with an explicit lockout message and `/om:status` stays disabled.
5. **Lifecycle reset.** After activating, the parent process issues RPC
   `{"type":"new_session"}` and confirms `/om:status` reports disabled again
   — activation does not survive a session boundary.

## Why RPC instead of the interactive TUI

OMP `--mode rpc` dispatches slash commands through the exact same extension
command handlers a real interactive TUI session uses (see the OMP RPC and
extension docs: both `"tui"` and `"rpc"` are `ExtensionContext.mode` values that
reach the same command registration).
Driving two independent RPC processes exercises "parent OMP session" and
"independently controlled OMP RPC session" exactly as specified, without
needing PTY automation of the interactive terminal UI, which would be
neither deterministic nor safe to run unattended.

## Prerequisites

- The OMP CLI (`omp`) installed and resolvable on `PATH`, or set
  `OM_SMOKE_OMP_BIN` to an absolute path to the executable.
- Node.js 22.6+ (native `.ts` execution via `--experimental-strip-types`).

## Running

```sh
bun run test:smoke
```

This runs `node --experimental-strip-types tests/smoke/run.ts`, which is
**not** picked up by `bun run test` (Vitest's `include` pattern is
`tests/**/*.test.ts`; every file in this directory intentionally does not
match that pattern).

The script exits non-zero and prints every failing assertion by name if any
check fails; it never silently skips a check because the host or fixture is
unavailable — if OMP cannot be spawned or a real child session cannot be
created, the corresponding step fails loudly instead of being treated as
"not applicable".

## Files

| File | Role |
|---|---|
| `run.ts` | Orchestrator: spawns the three RPC host processes, drives them, asserts, and reports. |
| `rpc-client.ts` | Minimal client for OMP's `--mode rpc` JSONL protocol. |
| `mock-model-server.ts` | Deterministic local HTTP model fixture (Anthropic Messages SSE format). |
| `fixture-provider.ts` | OMP extension registering the fixture server as a custom model provider. |
| `child-task-tool.ts` | OMP extension registering a `smoke_task` tool that spawns a real in-process child `AgentSession` via `createAgentSession()`, loading the same observational-memory extension, and reports its ledger/compaction state back to `run.ts` via a JSON file. |
