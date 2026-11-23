---
kind: module
summary: Learn notes (kb/), their reads, prompt matching, promotion and archive, and the decision log (decisions/)
covers:
  - packages/core/src/kb.ts
  - packages/core/src/kb-reads.ts
  - packages/core/src/kb-promote.ts
  - packages/core/test/kb-promote.test.ts
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
- `kb-promote.ts` `promotionCandidates` picks the notes that keep mattering (W6): shown in many
  run prompts, read often, or learned again (`likelyDuplicate` titles), each with why and the
  agents it is for. `Workspace.kbPromote` backs `swarmup kb --promote`; the improver folds the
  notes into a role file (`improve`). `archiveNote` (`Workspace.kbArchive`, a person only)
  moves a note to `kb/.archive/<topic>/<slug>.md` with who, when and why in its frontmatter.
- `decisions.ts` keeps one record per decision with a scope (project or task tree), supersedes
  and narrows links; `inForce` gives the decisions a task's run must follow.
- `decision-import.ts` imports decisions from Markdown tables under a "Decisions" heading.

## Invariants

- The decision log is canonical in prompts: a learn note that a decision record names as its
  source is left out of the prompt's note list.
- Only a person records a decision.
- Only a person archives a note. `noteFiles` and the search index skip dot folders under `kb/`,
  so archived notes never reach search, prompts, usage counts or candidates.
