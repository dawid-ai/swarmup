---
kind: flow
summary: 'Self-improvement: improvement tasks from failing scores and learn notes, the improver, proposals, the benchmark gate'
covers:
  - packages/supervisor/src/improve.ts
  - packages/core/templates/agents/claude-improver.md
  - packages/desktop/ui/src/ui/proposals.tsx
  - packages/supervisor/test/improve.test.ts
  - packages/supervisor/test/propose-api.test.ts
  - packages/core/test/variants.test.ts
  - packages/cli/test/defs-propose.test.ts
  - packages/desktop/test/proposals-view.test.ts
  - packages/desktop/test/knowledge-view.test.ts
links: [core/defs, supervisor/stats, bench, supervisor/wake, desktop/ui, docs]
---

# Self-improvement

## Purpose

Turns scorer failures, and learn notes that keep mattering, into reviewed changes to agent
definitions (W6): never a learn note, never a silent edit. Only a person's promote changes a
definition file.

## How it works

- Variants and proposals live in core (`core/defs`): `variants.ts` merges an overlay folder onto
  the base texts and hashes the result; `proposals.ts` holds the improvement policy
  (`may_change`, `frozen`, always-frozen agent keys), `proposal.json`, the variant listing with
  each file's before and after, and the write onto the base files. `Workspace.defsPropose`,
  `defsPromote`, `defsReject` and `variants` wrap them with the task events. `defsPromote` checks
  `improvement.requires` (`requiresProblems`) against the benchmark in `proposal.json`, which
  only `opsd:improve` writes (`defsRecordBenchmark`); `--force` overrides and the event says so.
  Promote keeps each changed file's before and after in `variants/.promoted/<name>.json`, which
  `defsRollback` (`rollbackPromoted`) puts back.
- `supervisor/src/improve.ts` `Improver`: `triggerTick` (behind `swarmupd.improve.enabled`, at
  most every `check_hours`) counts each agent's distinct failing task and run scores in
  `max_age_days` and files one `improve` task for the improver; `request` files it on demand from
  the app; `gateTick` starts a base and a variant bench run per new proposal through `BenchRuns`
  when `swarmupd.improve.benchmark` is set, and comments the `compareMarkdown` table and verdict
  on the task when both end, recording the result in the proposal (`record`). State (`checkedAt`, gates by `root/variant@hash`) is `improve.json`
  in the state folder. `proposals()` backs `GET /api/defs/variants` with line diffs and each
  store's `improvement.requires` with what it still refuses; `status()` backs `GET /api/improve`
  (the loop's switches, the gate, each store's policy), and `POST /api/improve/settings` turns
  `enabled` and `notes` on or off through `applySettings`. `proposeByHand` backs
  `POST /api/defs/propose`: a person's new role-file text becomes variant `<role>-by-hand`
  (`Workspace.defsPropose` with `files` instead of a folder, `overlayFromFiles`) on the task
  named or a new `improve` task for the person.
- With `swarmupd.improve.notes`, `triggerTick` also files a learn-note task per agent with
  promotion candidates (`Workspace.kbPromote`) that no earlier improvement task of the agent
  named (`improveNotesBody`, with `Agent:` and `Notes:` lines); `requestNotes` files it on
  demand (`POST /api/improve` with `kind: 'notes'`, **Fold into role** in the Knowledge view).
  `defsPromote` returns the notes a proposal names on a `Notes:` line, and `defs promote`
  prints the `swarmup kb archive` command for them.
- The improver template (`claude-improver.md`) is a read-only role (`READ_ONLY_ROLES`) whose
  Claude runs may edit only in their scratch folder (`SCRATCH_WRITER_ROLES`, `invocation`).
- `desktop/ui/src/ui/proposals.tsx` is the **Proposals** list in the Agents view: agents,
  scorers, diff, benchmark, `improvement.requires`, **Promote** (off while `requires` is unmet,
  with **Promote anyway…** as the recorded `force` override) and **Reject**, the improver's
  state, an empty state, **Propose a change**, and **Promoted** with **Roll back**
  (`Workspace.promotedChanges` over `listPromoted`, and `defsRollback`, through
  `GET /api/defs/promoted` and `POST /api/defs/promoted/<name>/rollback`); `score-agent.tsx` offers **Propose an
  improvement** on a failing scorer.

## Invariants

- A proposal never changes `tools`, `writes`, `can_claim` or `id`, nor a frozen path; at most
  `max_open_proposals` wait per store.
- Promote and reject are for a person only, in the CLI and the API; so are a proposal from the
  app and the loop's switches.
- The trigger, its learn-note half and the gate are off by default; the gate spends tokens.
- Nothing archives a note on its own: a person runs `swarmup kb archive` after the promote.
- Runs never edit `agents/` or `variants/` directly.
