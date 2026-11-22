---
kind: area
summary: '@swarmup/core: the task store library every other package uses; sync file I/O, no daemon state'
covers:
  - packages/core/package.json
  - packages/core/tsconfig.json
  - packages/core/src/index.ts
  - packages/core/test
links: [store, fold, workspace, sync, knowledge, repeats, search, adopt, content, map, defs, /leaks]
---

# Core

## Purpose

Reads and writes data roots: task files, event files, learn notes, decisions, channels, repeats
and plans. The CLI, swarmupd and the desktop app all go through it, so behavior is the same
whoever acts.

## How it works

- `src/index.ts` re-exports every module, `rubric.ts` included (see `/judge`); consumers import
  from `@swarmup/core` only.
- `Workspace` (`workspace.ts`) is the facade most callers use: it finds the roots, resolves task
  refs, checks permissions and appends events.
- State is never stored: it is folded from events every time (see `fold`), with a cache in
  `.swarmup/.ops/` that is local and rebuilt when stale.

## Invariants

- Synchronous file I/O, unless a caller needs async (swarmupd uses `git-steps` generators to run
  git off its event loop).
- Only one dependency, `yaml`; keep it that way.

## Tests

`packages/core/test/`, one file per behavior area (`variants.test.ts` for variants and
proposals); `helpers.ts` makes temp roots and runs git.
Vitest runs them against the sources (no build needed).
