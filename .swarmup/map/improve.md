---
kind: flow
summary: 'Self-improvement: improvement tasks from failing scores, the improver, proposals, the benchmark gate'
covers:
  - packages/supervisor/src/improve.ts
  - packages/core/templates/agents/claude-improver.md
  - packages/desktop/ui/src/ui/proposals.tsx
  - packages/supervisor/test/improve.test.ts
  - packages/core/test/variants.test.ts
  - packages/cli/test/defs-propose.test.ts
  - packages/desktop/test/proposals-view.test.ts
links: [core/defs, supervisor/stats, bench, supervisor/wake, desktop/ui, docs]
---

# Self-improvement

## Purpose

Turns scorer failures into reviewed changes to agent definitions (W6): never a learn note, never a
silent edit. Only a person's promote changes a definition file.

## How it works

- Variants and proposals live in core (`core/defs`): `variants.ts` merges an overlay folder onto
  the base texts and hashes the result; `proposals.ts` holds the improvement policy
  (`may_change`, `frozen`, always-frozen agent keys), `proposal.json`, the variant listing with
  each file's before and after, and the write onto the base files. `Workspace.defsPropose`,
  `defsPromote`, `defsReject` and `variants` wrap them with the task events.
- `supervisor/src/improve.ts` `Improver`: `triggerTick` (behind `swarmupd.improve.enabled`, at
  most every `check_hours`) counts each agent's distinct failing task and run scores in
  `max_age_days` and files one `improve` task for the improver; `request` files it on demand from
  the app; `gateTick` starts a base and a variant bench run per new proposal through `BenchRuns`
  when `swarmupd.improve.benchmark` is set, and comments the `compareMarkdown` table and verdict
  on the task when both end. State (`checkedAt`, gates by `root/variant@hash`) is `improve.json`
  in the state folder. `proposals()` backs `GET /api/defs/variants` with line diffs.
- The improver template (`claude-improver.md`) is a read-only role (`READ_ONLY_ROLES`) whose
  Claude runs may edit only in their scratch folder (`SCRATCH_WRITER_ROLES`, `invocation`).
- `desktop/ui/src/ui/proposals.tsx` is the **Proposals** list in the Agents view: agents,
  scorers, diff, benchmark, **Promote** and **Reject**; `score-agent.tsx` offers **Propose an
  improvement** on a failing scorer.

## Invariants

- A proposal never changes `tools`, `writes`, `can_claim` or `id`, nor a frozen path; at most
  `max_open_proposals` wait per store.
- Promote and reject are for a person only, in the CLI and the API.
- The trigger and the gate are off by default; the gate spends tokens.
- Runs never edit `agents/` or `variants/` directly.
