---
kind: module
summary: 'Definitions as code, phase 5: experiments that give task runs a variant, runs at a git ref, rubric scorers'
covers:
  - packages/core/src/defs/experiments.ts
  - packages/core/src/defs/ref.ts
  - packages/core/test/experiments.test.ts
  - packages/supervisor/test/experiments.test.ts
  - packages/supervisor/src/rubric-scorers.ts
  - packages/supervisor/test/rubric-scorers.test.ts
links: [defs, triggers, /improve, /bench, /judge, /supervisor/wake, /supervisor/stats]
---

# Experiments, definitions at a ref, rubric scorers

## Purpose

Lets a team try a variant on real work (an experiment) or rerun with older definitions (a git
ref), and read the result in the scores. W5 phase 5; see `docs/definitions.md` ("Experiments",
"Definitions at a git ref").

## How it works

- `experiments.ts`: `swarm.yaml` `experiments[]` (`id`, `variant`, `share`, `scope`, `until`).
  `pickExperiment` takes the first active experiment whose scope matches a task run and deals the
  task by `sha256(id + ref)` read as a fraction under `share`; `priorSide` keeps the side an
  earlier `run-start.experiment` records. `load.ts` checks that each variant exists, ids are unique
  and `until` is a real day.
- The supervisor's `experimentFor` calls it in `launch` when no variant or ref is named and
  `swarmupd.experiments` is on. A variant that does not check or lacks the agent's role file runs
  the base outside the experiment, with one warning. The run record and `run-start` carry
  `experiment` on both sides and `variant` on the variant side.
- `ref.ts`: `--defs-ref` reads a store's definition files at a git ref with `git show` into a
  snapshot (`readDefsAtRef` for the CLI; `defs-state.ts` `readDefsAtRefAsync` for swarmupd, run in
  `launchFresh` off the event loop), and `loadDefinitionsAtRef` checks it like a variant. The run's
  `RunDefs` gets the snapshot's hash, `ref` and `commit`, `run-start` gets `defs_ref`, and the
  files go in `state.db` `definitions`. `swarmup bench run --defs-ref` puts the role file in the
  prompt and `summary.json` `role` records `ref` and `commit`.
- `rubric-scorers.ts` `runRubricScorers` (supervisor `rubricTick`, once a minute, only with
  `swarmupd.judge.scorers`): for each store's `kind: rubric` scorers, judges closed tasks that
  `applies_to` takes and `sha256(id + ref) < sample` picks, once each, with the diff from the task's
  first run base to its review commit (`taskWorkDiff`), blind by default (`judgeTexts`), under
  `scoring.daily_judge_tokens` and `swarmupd.judge.daily_tokens`. Rows go to `state.db`
  `rubric_judgments`; `ScoreKeeper` `extra` joins their score rows to the built-in ones.
- Scores read the side back: task and run scores carry `variant`, `experiment` and `defs_hash`
  (`scores.ts` `attributeScores`), and `swarmup scores --by-variant` splits them.

## Invariants

- Explicit beats experiment: `--variant` or `--defs-ref` first, then the experiment, then base.
- A task's side never flips while the experiment runs, even when `share` changes.
- Nothing is checked out for a ref, and `launch` itself runs no git.
- Rubric scorers never run without the machine's consent, and never past either token cap.
