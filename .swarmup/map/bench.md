---
kind: flow
summary: 'swarmup bench and the Benchmarks view: replay set entries in throwaway worktrees, score criteria, compare runs'
covers:
  - packages/core/src/bench.ts
  - packages/supervisor/src/bench.ts
  - packages/supervisor/src/bench-runs.ts
  - packages/cli/src/bench-cmd.ts
  - docs/benchmarks.md
  - packages/core/test/bench.test.ts
  - packages/supervisor/test/bench.test.ts
  - packages/supervisor/test/bench-api.test.ts
  - packages/desktop/ui/src/views/Bench.tsx
  - packages/desktop/ui/src/ui/bench.tsx
  - packages/desktop/test/bench-view.test.ts
links: [core, supervisor/stats, cli, docs, desktop/ui, judge]
---

# Benchmarks

## Purpose

Show whether a change to a role, model, effort or the harness helped, by replaying real tasks
against an agent configuration and scoring the results. The runner works standalone, without
swarmupd; the desktop app's Benchmarks view starts it through swarmupd's API.

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
- With `--judge`, each attempt's `rubric` criteria go to the LLM judge (see `judge`) right
  after its checks; `judgeBenchRun` (`swarmup bench judge`) judges a finished run's pending ones,
  with a temporary worktree from `diff.patch` when the rubric needs files. Judged rubric
  criteria count in the pass rate; the summary adds judged counts and judge cost, and names the
  set file (`setFile`) so a later judge finds the entries.
- `--role-file` and `--variant` with `--root` (a store folder or root name) put the agent's role
  file, or a variant's, at the top of each prompt (`rolePrompt`) and take its model and effort;
  the run writes `role.md` and `summary.json` records `role` (agent, store, hash, variant). The
  improvement loop's benchmark gate starts runs this way (see `improve`).
- `cli/src/bench-cmd.ts` is `swarmup bench run|judge|compare`. `runBench` keeps `status.json` (state,
  attempts done of total, the attempt under way, the runner's pid) in the out folder.
- `supervisor/src/bench-runs.ts` serves `/api/bench/*`: sets from each root's
  `benchmarks/` and `swarmupd.bench.sets`, runs under `<state>/bench/` and
  `swarmupd.bench.results`, a dry run's plan, and a run started as `swarmup bench run` in a
  detached child with no window (`request.json`, `run.log`); a request may name `variant`,
  `root` and `role_file`. `BenchRuns` lives on the supervisor (`sup.bench`), and `get(id)` gives
  one run's view. `SWARMUP_BENCH_CLI` names another
  runner for tests.
- `desktop/ui/src/views/Bench.tsx` and `ui/bench.tsx` are the Benchmarks view: sets, runs with
  live progress, a run's attempts and criteria, the run dialog with the plan and cost
  confirmation, and Compare.

## Invariants

- Hidden files never exist in the worktree while the agent or a visible criterion runs, and the
  hidden folder must lie outside the repo under test.
- Results and worktrees go to an out folder outside the repo; an existing non-empty one is
  refused, never overwritten.
- The agent's command line ignores machine runtime settings, so runs compare across machines.
- The API starts only sets it lists; an agent run from the app follows a dry run's plan and an
  explicit cost confirmation in the run dialog.
