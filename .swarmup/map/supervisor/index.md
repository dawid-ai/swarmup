---
kind: service
summary: 'swarmupd: the per-machine service; tick loop, config, state folder, HTTP API, doctor and notifications'
covers:
  - packages/supervisor/package.json
  - packages/supervisor/tsconfig.json
  - packages/supervisor/src/index.ts
  - packages/supervisor/src/main.ts
  - packages/supervisor/src/opsd.ts
  - packages/supervisor/src/daemon.ts
  - packages/supervisor/src/config.ts
  - packages/supervisor/src/defs-config.ts
  - packages/supervisor/src/defs-state.ts
  - packages/supervisor/src/seed.ts
  - packages/supervisor/src/state-db.ts
  - packages/supervisor/src/migrate.ts
  - packages/supervisor/src/api.ts
  - packages/supervisor/src/admin.ts
  - packages/supervisor/src/doctor.ts
  - packages/supervisor/src/notify.ts
  - packages/supervisor/test
links: [wake, runs, prompts, merge, chat, stats, /core/sync, /core/defs]
---

# swarmupd

## Purpose

One background service per machine: wakes agents for ready work, keeps runs within limits,
watches them, merges approved work, syncs the roots and serves the desktop app.

## How it works

- `main.ts` is the `swarmupd` bin (`opsd.ts` is the old name's alias); `daemon.ts` starts and
  stops it and compares the built-at stamp, so the app can tell a stale swarmupd.
- `Supervisor` (`supervisor.ts`, see `wake`) runs a tick: repeats, schedules, wake, merges,
  pushes and syncs.
- `config.ts` reads the `swarmupd` section of the user config (providers, limits, wakes,
  schedules, merge, notifications); `seed.ts` fills defaults once. The supervisor merges each
  root's `swarm.yaml` under it (`defs-config.ts`, `defs-state.ts`, see `core/defs`).
- State lives in `~/.swarmup/swarmupd/`: run records, logs, `state.db` (`node:sqlite`, loaded
  lazily so the CLI never prints its warning), scratch folders.
- `api.ts` serves 127.0.0.1 with a token per request; `admin.ts` backs the app's Settings,
  Schedules and Standups. Runs get their own run token, never the human's. `/api/defs/*` and
  `/api/bench/*` live in `defs-import.ts` and `bench-runs.ts` (see `core/defs` and `bench`);
  `swarmupd.bench` names extra benchmark sets and results folders.
- `doctor.ts` checks config, roots, CLIs and sign-ins; `notify.ts` posts to a webhook URL.

## Invariants

- swarmupd starts paused; `swarmup daemon resume` lets it start runs.
- Settings change a fixed set of keys only; a webhook URL is a secret and is never logged.
