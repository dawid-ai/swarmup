---
kind: entry
summary: 'The swarmup command: one COMMANDS table of subcommands over core and swarmupd, used by agents and people'
covers:
  - packages/cli
links: [core, supervisor, core/map, core/defs, bench]
---

# CLI

## Purpose

`swarmup` is how agents and people act on tasks the same way: create, claim, start, review, ask,
answer, vote, learn, sync, launch runs, and read the project map.

## How it works

- `main.ts` is the bin; it drops output on a closed pipe so `swarmup show ID | head` keeps the
  exit code. `ops.ts` is the old name's alias.
- `cli.ts` exports `run(argv, io)`: it parses options with `node:util` `parseArgs` against the
  `COMMANDS` table (usage, summary, options, run). Most commands call `Workspace`; daemon,
  runs, logs and launch talk to swarmupd's API.
- `map-cmd.ts` holds `swarmup map` (see `core/map`), `defs-cmd.ts` holds `swarmup validate`
  and `swarmup defs`, with `migrate`, `propose`, `promote`, `reject` and `variants` (see
  `core/defs` and `improve`), `cli.ts` holds `swarmup workflow` and `plan propose --workflow`,
  and `bench-cmd.ts` holds `swarmup bench` (see `bench`,

  and `judge` for `bench judge` and `criteria judge`, which `cli.ts` holds);
  put new large commands in their own file and register them with one line in `COMMANDS`.

- `hooks.ts` installs Claude Code hooks that sync at session end; `banner.ts` draws the mark.

## Invariants

- Exit codes: 0 ok, 1 refused, 2 bad input, 3 nothing to do (`next`).
- `--as` sets the actor; runs get theirs from `SWARMUP_AGENT`.
- `version.ts` is kept in step with `package.json` by `scripts/set-version.mjs`.

## Tests

`packages/cli/test/`; `cli.test.ts` runs commands in temp roots through `run()`.
