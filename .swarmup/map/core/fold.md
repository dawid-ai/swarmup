---
kind: flow
summary: Folds a task's events in ULID order into its state; the state machine, leases, milestones, plans and criteria
covers:
  - packages/core/src/fold.ts
  - packages/core/src/plan.ts
  - packages/core/src/criteria.ts
  - packages/core/src/readability.ts
links: [store, workspace, /supervisor/merge, /docs]
---

# Fold

## Purpose

Computes a task's current state from its event files, the same way on every machine.

## How it works

- `fold.ts` sorts events by ULID and applies the ones that change state (claim, start, review,
  verdict, ask, answer, block, park, handoff, assign and so on); comments, findings, learn
  notes, runs and merges are history only.
- The state machine is in `docs/protocol.md` ("State machine"): `todo`, `claimed`,
  `in-progress`, `needs-review`, `blocked`, `done`, `parked`.
- Leases and dependencies need the clock or other tasks, so they apply at read time:
  `claimed(stale)`, `in-progress(stale)`, `todo(unblocked)`.
- `plan.ts` reads milestone plans (proposal, change, subtask, fix) and the effective plan. An
  item of type `gate` carries `gate` (`ask`, `options`, `on_reject`) and is owned by a person.

- `criteria.ts` parses typed `done_when` criteria (a plain string stays `prose`), folds
  per-criterion results (with `by: judge` from a judge's `criteria-check` event) and runs the
  `command` and `check` kinds for `swarmup criteria check` and the merge. Every file check takes
  path globs; `char-count` (with `urls_as`), `contains`, `heading-structure`, `front-matter`,
  `image-alt`, `image-size` (PNG and JPEG headers read in place) and `readability` (a pinned
  Flesch-Kincaid grade in `readability.ts`) serve content; `page-contains` fetches the published
  page through an injectable `fetchPage` and is refused without `when: publish`,
  and `when: publish` criteria run only after `swarmup published` (see `content`). The `rubric` kind is
  judged by `rubric.ts` and the supervisor's `judge.ts` (see `/judge`).

## Invariants

- Same events give the same state, whatever the order the files arrived in.
- A fold never writes; any write is a new event through `Workspace`.
- Bump the task state version in `root.ts` when cached task states gain a field.

## Gotchas

- Events from a newer build with an unknown type are kept and ignored, never dropped.
