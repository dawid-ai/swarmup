---
kind: flow
summary: 'swarmup bench: replay benchmark set entries in throwaway worktrees, score their criteria, compare runs'
covers:
  - packages/core/src/bench.ts
  - packages/supervisor/src/bench.ts
  - packages/cli/src/bench-cmd.ts
  - docs/benchmarks.md
  - packages/core/test/bench.test.ts
  - packages/supervisor/test/bench.test.ts
links: [core, supervisor/stats, cli, docs]
---

# Benchmarks

## Purpose

Show whether a change to a role, model, effort or the harness helped, by replaying real tasks
against an agent configuration and scoring the results. Runs standalone, without swarmupd.

## How it works

- `core/src/bench.ts` reads and checks a set file (`benchmarks/<set>.yaml`, W5's format):
  entries with a base, a task or prompt and typed `done_when`; `hidden: true` marks a command
  criterion whose files the agent never sees.
- `supervisor/src/bench.ts` plans attempts, makes a detached worktree per attempt, runs the agent
  with swarmupd's `invocation` (bench tool list, no `swarmup`), applies a reference patch, or
  does nothing (`none`), then saves the diff and scores: visible criteria through `runCriteria`,
  then each hidden command with the hidden folder copied in and removed after. Metrics come from
  the log, orientation from `orientation.ts`. It writes `results.json` per attempt and
  `summary.json`/`summary.md`, and compares two summaries.
- `cli/src/bench-cmd.ts` is `swarmup bench run|compare`.

## Invariants

- Hidden files never exist in the worktree while the agent or a visible criterion runs, and the
  hidden folder must lie outside the repo under test.
- Results and worktrees go to an out folder outside the repo; an existing non-empty one is
  refused, never overwritten.
- The agent's command line ignores machine runtime settings, so runs compare across machines.
