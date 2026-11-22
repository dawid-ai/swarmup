---
kind: module
summary: The Workspace facade; every command (new, claim, review, verdict, ask, inbox, next) goes through it
covers:
  - packages/core/src/workspace.ts
  - packages/core/src/review-source.ts
  - packages/core/src/brief.ts
  - packages/core/src/similar.ts
links: [store, fold, knowledge, search]
verified: 0837bfc6
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
- `recordRun` writes swarmupd's `run-start` and `run-end` events, with the resumed `session`
  and the `defs` stamp. `recordCriteriaCheck` writes a `criteria-check` event, with `by: judge`
  for an LLM judge's results.
- `defsPropose`, `defsPromote`, `defsReject`, `defsRollback` and `variants` record definition
  proposals as variants (see `/improve`); promote, reject and rollback are for a person only.
- `finding` names up to 3 tasks of the root with a near-identical title (`similar.ts`, word
  overlap) as possible duplicates in the new finding's body. `ask --reason` records why only a
  person can answer (`ASK_REASONS`).
- `workflowStart` and `planProposeWorkflow` compile a store workflow (see `defs`) into a plan
  proposal; a person's start of a `starter` workflow also approves it. The milestone records
  `workflow` and `defs_hash`. `addTask` applies `work_types` criteria when none are given.
- Gates (type `gate`, or any task with `meta.gate`): only a person outside a run decides one,
  once the stages it waits for are done; `done` approves, and `park` goes to `gateReject`, which parks the items after the gate or, with `on_reject: revise`, reopens the
  items before it. The inbox lists a ready gate as kind `gate`.
- `saveRole` writes where an agent lives (`writeAgent` in `agents.ts`): a legacy file, a folder's
  `agent.md`, or its runtime addendum (`scope: 'runtime'`).

- `review-source.ts` reads where approved work is (commit and branch) from a review event or its
  text, for the merge.
- `brief.ts` folds the newest `brief` event of a parent task, the goal brief `swarmup brief`
  writes; it is history and changes no state.

## Invariants

- Permissions follow `docs/protocol.md` ("Permissions"); `--force` is for people only.
- No secrets in events: the write path refuses text that `assertNoSecret` (`secrets.ts`) flags.

## Gotchas

- The file is over 5000 lines; search it by method name instead of reading it whole.
