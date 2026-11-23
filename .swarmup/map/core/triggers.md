---
kind: module
summary: 'Definitions as code, phase 4: git triggers with a cron parser; checks behind trust; scorers'
covers:
  - packages/core/src/defs/trigger.ts
  - packages/core/src/defs/cron.ts
  - packages/core/src/defs/checks.ts
  - packages/core/src/defs/scorer.ts
  - packages/supervisor/src/git-scorers.ts
  - packages/supervisor/src/triggers.ts
  - packages/cli/src/triggers-cmd.ts
  - packages/cli/src/trust.ts
  - packages/core/test/triggers.test.ts
  - packages/supervisor/test/triggers.test.ts
  - packages/supervisor/test/defs-checks.test.ts
  - packages/cli/test/defs-phase4.test.ts
  - packages/core/test/scorers.test.ts
  - packages/supervisor/test/scores-git.test.ts
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

- `checks.ts`: `swarm.yaml` `checks.<name>` and `checksHash` (name, command, paths).
  `withDefinitions` puts them under `merge.<root>.checks` only when `trusted_defs.<root>` is
  their hash and the machine sets no checks of its own; `DefsState` warns once per untrusted set
  and the merger logs it at each merge. `swarmup defs trust` (a person, outside runs) writes the
  hash.

- `scorer.ts`: `scorers/<id>.yaml`, `kind: builtin` (a W4 scorer's `pass` and `applies_to`) or
  `kind: rubric` (checked and listed only). `git-scorers.ts` reads the built-in ones into
  `ScoreOptions.stores`; `scores.ts` `scoreWithStores` scores each store's work with its
  threshold and filters. `swarmup defs scorers` lists them.

## Invariants

- Git triggers fire only where `swarmupd.triggers.<root>` is true, a person trusted the exact
  set (`trusted_defs.<root>.triggers`, `cli/src/trust.ts`) and a run's agent has `wake: true`; workflows and
  repeats they start act as `opsd:trigger`, never as a person.
- Git checks never run without a person's trust of their exact hash on that machine.
- One fire time starts once per machine: a `run` trigger is recorded after its launch, a
  `workflow` or `repeat` trigger before it acts.
