---
kind: module
summary: A run's process, records, environment, task worktrees, leftovers commits and process ledger
covers:
  - packages/supervisor/src/runs.ts
  - packages/supervisor/src/run-artifacts.ts
  - packages/supervisor/src/runenv.ts
  - packages/supervisor/src/proc.ts
  - packages/supervisor/src/procs.ts
  - packages/supervisor/src/checkout.ts
  - packages/supervisor/src/worktree.ts
  - packages/supervisor/src/electron-dist.ts
  - packages/supervisor/src/store-repair.ts
  - packages/supervisor/src/msys-tmp.ts
links: [wake, merge]
---

# Runs and worktrees

## Purpose

Everything about one run after the launch: where it works, what it may see, what it leaves.

## How it works

- `runs.ts` keeps each run in `<state>/runs/<id>.json`, with `defs`, `model` and `effort` when a
  store has a `swarm.yaml` (see `core/defs`), and `variant` (also in `defs`) for a variant run; `runenv.ts` builds its environment
  (`SWARMUP_AGENT`, `SWARMUP_RUN`, `SWARMUP_RUN_TOKEN`, `SWARMUP_SCRATCH`, TEMP in scratch).
  `pageRuns` serves the desktop Runs view one page, narrowed by range, `resumed` and `model`.
- `run-artifacts.ts` keeps what a run declares (`swarmup run artifact`) or writes into
  `<scratch>/artifacts/` in `<state>/artifacts/<id>/` with a manifest, within
  `swarmupd.artifacts` limits, refusing real paths outside the scratch folder and worktree; the
  wrap-up keeps them after the reap, `swarmup review` from a run attaches them (kind `run`), and
  housekeeping prunes them after `keep_days`. A kept file is served only by a one-segment name
  found in the run's manifest.
- `proc.ts` spawns hidden processes that can outlive swarmupd; `procs.ts` records every process a
  run starts and kills only by PID plus creation time.
- `worktree.ts`: a task of its root's `workspace_types` (core's `workspaceTypes`; default task,
  bug, feature) in a store checkout works in `out/wt-<ID>` on its own branch.
- `checkout.ts` reads a checkout's dirty state and commits what a run left on a branch
  `<runtime>/<task>-<run>`, then restores the files.
- `electron-dist.ts` shares one unpacked Electron per version across worktrees;
  `store-repair.ts` fixes file ownership a sandboxed Codex run leaves on Windows.

## Invariants

- Never kill by name, user or start time.
- Task stores (`.swarmup/`) and package caches are never part of a run's changes.
- A run artifact is only stored and served, never run; only plain images are served inline.

## Gotchas

- The leftovers commit excludes `.swarmup/**`, so it does not take uncommitted map edits; runs
  commit map changes with their work.
- Git Bash mounts `/tmp` on the `TEMP` of the first MSYS process, often a run's scratch folder,
  and keeps it for days. Scratch cleanup keeps that folder (`msys-tmp.ts`) and makes it again if
  it is gone.
