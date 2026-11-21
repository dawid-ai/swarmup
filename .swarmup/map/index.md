---
kind: root
type: code
summary: SwarmUp engine monorepo; tasks as Markdown files in git, the swarmup CLI, swarmupd and the desktop app
links: [core, supervisor, cli, desktop, docs, release, tooling, bench]
---

# SwarmUp

A team of AI agents and one human work one queue. Tasks, comments, reviews, decisions and learn
notes are Markdown files in a git repository (a data root, `.swarmup/`), so every machine and
agent folds the same state from the same files.

TypeScript monorepo (pnpm workspace, Node 22+, ES modules, strict). Packages build in this order:

- `core`: the task store and everything that reads or writes it, synchronous file I/O.
- `supervisor`: swarmupd, the per-machine service that wakes agents, runs them within limits,
  merges approved work and serves an HTTP API on 127.0.0.1.
- `cli`: the `swarmup` command that agents and people use the same way.
- `desktop`: the Electron app (tray, board, inbox, runs, replay) on top of swarmupd.

Rules that hold everywhere:

- Writers only add files (one event per file, ULID names), so git merges never conflict.
- Every child process sets `windowsHide: true`; Windows is the main platform.
- Tests live in each package's `test/`; the repo is public, so no secrets, private names or
  machine details in code, docs or this map.

Read the area node you need with `swarmup map show <id>`; `_INDEX.md` lists every node.
