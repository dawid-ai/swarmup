---
kind: module
summary: swarmup report, scores and wrapped; throughput, loop figures, run costs, scorers and the Wrapped card sequence
covers:
  - packages/supervisor/src/report.ts
  - packages/supervisor/src/loops.ts
  - packages/supervisor/src/wrapped.ts
  - packages/supervisor/src/scores.ts
  - packages/supervisor/src/score-keeper.ts
  - packages/supervisor/src/score-history.ts
  - packages/supervisor/src/orientation.ts
links: [/core/search, /desktop/replay]
---

# Reports and Wrapped

## Purpose

Figures over a time window for `swarmup report`, the desktop's **Reports** view and Wrapped
cards.

## How it works

- `report.ts` builds a window's report: tasks closed, runs, tokens, minutes, and what answers
  and verdicts unblocked, and each agent's scores, with the rubric scorers' rows from
  `state.db` (passed in as `rubric`) for the window's tasks. `reportWindow` takes the last N
  whole days (default 7) or a `from`/`to` range.
- `loops.ts` adds loop figures: author and reviewer pairs, cost of a merged task over its runs,
  why runs stopped, how long people took to answer.
- `scores.ts` holds the deterministic scorers over task events and run records, at run, task
  and agent level; `score-keeper.ts` reads the tasks and keeps the scores in `state.db`, and
  `orientation.ts` parses how much a run read before its first edit from its run log.
  `post-approval-edits` reads the `edits` a `publish` event records (see `/core/content`), so
  the scorers stay pure. Task and run scores carry `defs_hash`, `variant` and `experiment` of the
  run they came from (a task's newest `run-start` by its author), and `summarizeScores` with
  `byVariant` splits an agent's scores by variant for `swarmup scores --by-variant`.
- `score-history.ts` turns the kept scores and the agent-score rows of `state.db` into each
  agent's trend per scorer, a point per hour or day, for `GET /api/scores/history` and the
  desktop's Agents and Reports views. The keeper also hands the Runs view each run's orientation
  from memory.
- `wrapped.ts` turns the report and the replay timeline of one window into a short card
  sequence.

## Invariants

- Counts that the report and Wrapped both show come from the same code, so they agree.
