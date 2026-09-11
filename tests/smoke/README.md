# Real-host activation-boundary smoke test

This directory holds a **black-box smoke test** that proves the observational-memory
activation boundary against a real, installed OMP host — not against a
simulated `ExtensionContext`. It is separate from the Vitest unit suite
(`bun run test`), which drives the extension in-process and cannot spawn a
real host process or a real native subagent.

## What it proves

`run.ts` drives one real OMP TUI session through a pseudo-terminal and several
independent OMP `--mode rpc` host processes against a deterministic local HTTP
model fixture (`mock-model-server.ts`, no external network access or
credentials). It asserts, end to end:

1. **TUI activation.** A fresh OMP TUI session first reports the disabled
   status, then activates with `/om`, reports enabled `/om:status` and
   `/om:view` output, records an observation in the enabled session, and
   proves enabled compaction includes the observational projection.
2. **Parent RPC activation and native-subagent isolation.** A fresh RPC session
   starts disabled; disabled compaction injects no observational summary
   sections; `/om` dispatched over the real RPC command route activates the
   session; a repeated `/om` is idempotent; and enabled compaction supplies the
   observational projection. The parent's `smoke_task` extension tool then
   spawns a genuine in-process child `AgentSession` via OMP's SDK
   `createAgentSession()` — the same mechanism a real native subagent uses,
   with no TUI, stdin, or RPC command channel. The child loads the same
   observational-memory extension, cannot access the disabled `recall` tool,
   produces no observational-memory notifications or tool results, writes zero
   `om.*` ledger entries, and uses native compaction.
3. **Independent RPC session.** A second, wholly separate OMP process proves it
   starts disabled (not inheriting the first process's activation) and can
   independently activate itself with its own `/om`.
4. **Passive lockout.** A third process configured with
   `"observational-memory": { "passive": true }` seeds pre-existing
   observational-memory ledger data, then proves `/om` is rejected with an
   explicit lockout message, `/om:status` stays disabled, and passive
   compaction delegates to OMP native compaction without observational
   sections.
5. **Lifecycle and restart reset.** After activating, the parent process issues
   RPC `{"type":"new_session"}` and confirms `/om:status` reports disabled.
   A separate pair of persistent-session OMP processes also confirms that a
   fresh process does not inherit activation from the prior process.

## Why the smoke drives both TUI and RPC

OMP `--mode rpc` dispatches slash commands through the same extension command
handlers used by a real interactive TUI session. The smoke still drives a real
TUI process through the repository's Python PTY bridge so the TUI path itself
is exercised, while RPC provides deterministic JSONL assertions for independent
headless activation and lifecycle control.

## Prerequisites

- The OMP CLI (`omp`) installed and resolvable on `PATH`, or set
  `OM_SMOKE_OMP_BIN` to an absolute path to the executable.
- Node.js 22.6+ (native `.ts` execution via `--experimental-strip-types`).
- Python 3, used by the PTY bridge to allocate the TUI pseudo-terminal.

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
| `notification-probe.ts` | Child-only extension that counts observational-memory notifications for the native-subagent assertion. |
| `child-task-tool.ts` | OMP extension registering a `smoke_task` tool that spawns a real in-process child `AgentSession` via `createAgentSession()`, loading the same observational-memory extension, and reports its ledger/compaction state back to `run.ts` via a JSON file. |
