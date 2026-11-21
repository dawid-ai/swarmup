---
kind: module
summary: 'The project map: parse .swarmup/map/ nodes, check coverage of a change, search, _INDEX.md and prompt block'
covers:
  - packages/core/src/map.ts
  - packages/cli/src/map-cmd.ts
  - packages/supervisor/src/map-prompt.ts
  - docs/map.md
links: [/cli, /supervisor/prompts, /supervisor/merge]
---

# Project map

## Purpose

Linked Markdown nodes in `.swarmup/map/` of the work's folder say what each part of a project
is for, so a run reads one node instead of the whole tree. This folder is that map for SwarmUp.

## How it works

- `readMap` parses nodes (`<name>.md` or `<name>/index.md`); `checkMap` checks them against
  themselves and against the change since a base: uncovered changed paths, covers that match
  nothing, missing links, size limits, URL nodes without `review_after`, a stale `_INDEX.md`.
- `searchMap`, `nodesCovering` and `findNode` back `swarmup map`, `--file` and `show`.
- `mapPromptOf` and `mapPromptLines` give a run's prompt the root summary and up to 5 matching
  nodes; `mapReviewWarnings` adds the check's warnings to a review prompt.

## Invariants

- Deterministic, no model. A project without `.swarmup/map/` gets no checks and no prompt block.
- The generated list is `_INDEX.md`, not `INDEX.md`: on Windows and macOS that is the same file
  as the root `index.md`.

## Gotchas

- `.swarmup/` is excluded from code diffs as a task store; `merge.ts` adds `.swarmup/map/` back,
  so map edits merge with the work instead of being sent back as store files.
