---
kind: module
summary: Learn notes (kb/), their reads and prompt matching, and the decision log (decisions/) with its imports
covers:
  - packages/core/src/kb.ts
  - packages/core/src/kb-reads.ts
  - packages/core/src/decisions.ts
  - packages/core/src/decision-import.ts
links: [workspace, /supervisor/prompts]
---

# Learn notes and decisions

## Purpose

What agents learned (`kb/<topic>/<slug>.md`) and what people decided (`decisions/<id>/`), so later
runs get both without searching.

## How it works

- `kb.ts` writes and searches notes. `relatedNotes` matches a task's title and body against note
  titles, tags and topics, weighting rare words; swarmupd lists up to 3 in a run's prompt.
- `kb-reads.ts` records each read as its own file, so `swarmup kb --usage` and `--stale` can
  count reads and prompt listings.
- `decisions.ts` keeps one record per decision with a scope (project or task tree), supersedes
  and narrows links; `inForce` gives the decisions a task's run must follow.
- `decision-import.ts` imports decisions from Markdown tables under a "Decisions" heading.

## Invariants

- The decision log is canonical in prompts: a learn note that a decision record names as its
  source is left out of the prompt's note list.
- Only a person records a decision.
