---
kind: module
summary: 'Definitions as code, phase 4: git triggers with a cron parser; checks behind trust; scorers'
covers:
  - packages/core/src/defs/trigger.ts
  - packages/core/src/defs/cron.ts
  - packages/supervisor/src/triggers.ts
  - packages/cli/src/triggers-cmd.ts
  - packages/core/test/triggers.test.ts
  - packages/supervisor/test/triggers.test.ts
links: [defs, repeats, /supervisor/wake, /cli]
---

# Triggers, checks and scorers in git

## Purpose

W5 phase 4: what swarmupd starts on a schedule, the merge checks it runs and the scorer settings
it uses can live in a task store, behind each machine's consent. See `docs/definitions.md`.

## How it works

- `trigger.ts` and `cron.ts`: `triggers/<name>.yaml` with `every`, `at` or a five-field `cron`
  (local time, Vixie day matching) and `action: run | workflow | repeat`. `triggerDue` and
  `nextTriggerFire` are pure; `loadDefinitions` lists each store's triggers and checks their
  targets (workflow, repeat, agent).
- `supervisor/src/triggers.ts` picks the triggers a machine runs (`swarmupd.triggers.<root>:
true`, `runs_on` against `user.machine`); the supervisor's `runTriggers` fires them from
  `runSchedules` and records each in `triggers.json` in the state folder.
- `cli/src/triggers-cmd.ts` is `swarmup triggers list|on|off`; `defs import-schedules` in
  `defs-cmd.ts` writes `swarmupd.schedules` as trigger files.

## Invariants

- Git triggers fire only on a machine whose `swarmupd.triggers.<root>` is true; workflows and
  repeats they start act as `opsd:trigger`, never as a person.
- One fire time starts once per machine: a `run` trigger is recorded after its launch, a
  `workflow` or `repeat` trigger before it acts.
