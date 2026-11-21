---
kind: module
summary: swarmup report and wrapped; throughput, loop figures, run costs and the Wrapped card sequence
covers:
  - packages/supervisor/src/report.ts
  - packages/supervisor/src/loops.ts
  - packages/supervisor/src/wrapped.ts
links: [/core/search, /desktop/replay]
---

# Reports and Wrapped

## Purpose

Figures over a time window for `swarmup report`, the desktop's **Reports** view and Wrapped
cards.

## How it works

- `report.ts` builds a window's report: tasks closed, runs, tokens, minutes, and what answers
  and verdicts unblocked. `reportWindow` takes the last N whole days (default 7) or a `from`/`to`
  range.
- `loops.ts` adds loop figures: author and reviewer pairs, cost of a merged task over its runs,
  why runs stopped, how long people took to answer.
- `wrapped.ts` turns the report and the replay timeline of one window into a short card
  sequence.

## Invariants

- Counts that the report and Wrapped both show come from the same code, so they agree.
