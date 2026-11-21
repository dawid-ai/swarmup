---
kind: module
summary: The Workspace facade; every command (new, claim, review, verdict, ask, inbox, next) goes through it
covers:
  - packages/core/src/workspace.ts
  - packages/core/src/review-source.ts
  - packages/core/src/brief.ts
links: [store, fold, knowledge, search]
---

# Workspace

## Purpose

One class, `Workspace`, that the CLI, swarmupd and the desktop use to act on tasks: it finds the
roots, resolves `T-0001` or `root/T-0001`, checks who may do what, and appends events.

## How it works

- Construct with `{ cwd, env, actor, root, force }`; roots come from the user config,
  `SWARMUP_ROOTS` and the folder `cwd` is in.
- Each command method validates, then writes one or more events with `act()`.
- Read paths: `list`, `showEvents`, `inbox`, `next`, `kb`, `taskNotes` (learn notes for a run's
  prompt), `decisionLog`, `search`.
- `review-source.ts` reads where approved work is (commit and branch) from a review event or its
  text, for the merge.
- `brief.ts` folds the newest `brief` event of a parent task, the goal brief `swarmup brief`
  writes; it is history and changes no state.

## Invariants

- Permissions follow `docs/protocol.md` ("Permissions"); `--force` is for people only.
- No secrets in events: the write path scans text with `secrets.ts` and refuses a hit.

## Gotchas

- The file is over 5000 lines; search it by method name instead of reading it whole.
