---
kind: flow
summary: 'swarmup sync: commits, pulls and pushes a data root by policy; git step generators and the Master Repo mirror'
covers:
  - packages/core/src/sync.ts
  - packages/core/src/git-steps.ts
  - packages/core/src/index-lock.ts
  - packages/core/src/exec-thread.ts
  - packages/core/src/mirror.ts
links: [store, /supervisor]
---

# Sync

## Purpose

Moves a data root between machines through git, so every clone sees the same task files.

## How it works

- `sync.ts` commits only store files on the store branch (`sync.branch`, else the learned one),
  pulls with rebase, and pushes. Policy per root: `manual`, `checkpoint` (default) or
  `coordinated` (push right after claims, handoffs, verdicts and asks).
- `git-steps.ts` writes git logic once as generators: `runSteps` runs them synchronously for the
  CLI, `runStepsAsync` off the event loop for swarmupd. `exec-thread.ts` spawns from a worker
  thread, since process creation on Windows blocks the caller.
- `index-lock.ts` removes a stale `.git/index.lock` that a killed git left behind.
- `mirror.ts` copies roots that opt in (`mirror: true`) into a Master Repo, both ways, as a union
  of files.

## Invariants

- Sync never commits files outside the root unless asked (`--all-paths`).
- A push rejected because someone pushed first is retried after pulling, up to three times.

## Gotchas

- Sync holds and asks for `sync.branch` when it cannot tell the store branch from a code branch.
