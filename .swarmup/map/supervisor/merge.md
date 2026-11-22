---
kind: flow
summary: Merges approved work into the base; rebase, path-scoped checks, batches, fast-forward, build and branch pushes
covers:
  - packages/supervisor/src/merger.ts
  - packages/supervisor/src/merge.ts
  - packages/supervisor/src/merge-checks.ts
  - packages/supervisor/src/merge-conflict.ts
  - packages/supervisor/src/push.ts
  - packages/supervisor/src/diff.ts
  - packages/supervisor/src/git.ts
links: [wake, runs, /core/map, /judge]
---

# Merging approved work

## Purpose

With `swarmupd.merge.<root>` set, swarmupd merges a task's work once a review approves it.

## How it works

- `merger.ts` picks approved tasks, reads where the work is (`review-source.ts` in core), and
  merges one task or a batch at a time in its own worktree (`<state>/merge/<root>`).
- `merge.ts` (`MergeRepo`) rebases onto the base, lists changed files outside task stores, and
  fast-forwards the base where it is checked out.
- `merge-checks.ts`: `checks` entries are commands, or `{ run, paths }` that run only when the
  merge changes one of `paths`. A failed batch splits in halves until the breaking task is found.
- After the checks, the task's `command` and `check` criteria run; with
  `swarmupd.judge.at_merge`, `mergeJudge` then judges its `rubric` criteria (see `/judge`). A
  failure of either sends the task back; a task with such criteria merges alone.
- After the base moves: `install` when a lockfile changed, then `build`.
- `push.ts` pushes task branches with new commits; `diff.ts` serves a task's diff to the app.

## Invariants

- A branch that changes task store files is sent back; `.swarmup/map/` counts as code.
- Only verdicts after swarmupd first saw the root's merge setting count.
- A `publish` task has nothing to merge: a `no_merge` comment, and nothing waits on it.

## Gotchas

- `swarmup map check --base <base>` is a normal `checks` entry; nothing special-cases the map.
