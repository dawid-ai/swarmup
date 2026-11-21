---
kind: data
summary: Data root layout on disk; config, ids, ULIDs, event model, frontmatter, roles, channels and attachments
covers:
  - packages/core/src/root.ts
  - packages/core/src/config.ts
  - packages/core/src/ids.ts
  - packages/core/src/ulid.ts
  - packages/core/src/model.ts
  - packages/core/src/frontmatter.ts
  - packages/core/src/init.ts
  - packages/core/src/agents.ts
  - packages/core/src/roots.ts
  - packages/core/src/channels.ts
  - packages/core/src/attachments.ts
  - packages/core/src/presence.ts
  - packages/core/src/store-move.ts
  - packages/core/src/env.ts
  - packages/core/src/units.ts
  - packages/core/src/lock.ts
links: [fold, workspace, sync]
verified: 0837bfc6
---

# Task store

## Purpose

Defines what a data root holds and how each file is named, read and written.

## Layout

```text
.swarmup/config.yml                         root name, id prefix, human, sync policy, leases
.swarmup/agents/<runtime>-<role>.md         role files
.swarmup/tasks/<id>/task.md                 frontmatter + body
.swarmup/tasks/<id>/events/<ulid>-<actor>.md  one file per change, never edited
.swarmup/kb/ channels/ decisions/ people/ projects/ repeats/ attachments/ machines/
.swarmup/.ops/                              local only: caches, locks, read markers
```

## How it works

- `root.ts` (`Root`) reads and writes one root's files; `config.ts` reads `config.yml` and the
  per-machine user config (`SWARMUP_CONFIG`, else `%APPDATA%\swarmup\config.yml`).
- `ids.ts`: actor ids are `<runtime>:<role>` or `human:<name>`; task ids are `<PREFIX>-<n>`.
- `ulid.ts` makes strictly increasing ULIDs, so file name order is time order.
- `model.ts` lists event types and statuses; unknown event types from newer builds are kept.
  A `run-start` event carries `session` when it resumes and `defs` (the definitions hash) when
  the store has a `swarm.yaml`.
- `agents.ts` reads role files; `runtimes.<rt>` gives a model and effort per runtime that wins
  over the file's own `model` and `effort` (see `/core/defs`).
- `lock.ts` takes file locks with stale takeover; `presence.ts` writes `machines/<name>.json`.
- `store-move.ts` and `env.ts` keep the old `.agent-ops/` and `OPS_*` names readable.

## Invariants

- Event files are immutable and uniquely named; writers only add files.
- A root folder is `.swarmup/` (or the old `.agent-ops/`) that holds a `config.yml`.
- Text is written with LF line endings; CRLF is read as LF.
