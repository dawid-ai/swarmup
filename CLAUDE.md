# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Follow [AGENTS.md](AGENTS.md) for the rules, the task workflow and the code conventions. This file
adds the commands and the big picture.

## Commands

```sh
pnpm install --frozen-lockfile   # pnpm only; also points git hooks at .githooks (leak check)
pnpm run build                   # tsc -b: core, supervisor, cli, desktop in order
pnpm run typecheck               # the build, the test files and the desktop UI
pnpm run lint                    # eslint, then the prettier check
pnpm vitest run packages/core/test/fold.test.ts           # one test file
pnpm vitest run packages/core/test/fold.test.ts -t "name" # one test by name
pnpm vitest run --changed main   # the tests your branch's changes reach
pnpm test                        # the full suite: git-heavy, tens of minutes on Windows
pnpm run desktop                 # build the app and start Electron
pnpm run smoke:desktop           # render every desktop view offscreen against a scratch root
pnpm swarmup <command>           # the CLI from the last build
```

- Tests import the package sources through the aliases in `vitest.config.ts`, so they need no
  build. `vitest.global-setup.ts` still builds `packages/core` once, because the fake agents and
  other child processes that tests start import the built core.
- Most tests create real git repos and processes, and process creation is the bottleneck on
  Windows, so vitest uses at most 4 workers. Run the files your change touches; the full suite
  runs before a release ([RELEASING.md](RELEASING.md)).
- In Git Bash, `/tmp` must exist, or the git and push tests fail with "could not find /tmp".

## Architecture

Tasks, comments, reviews, decisions and learn notes are Markdown files in a git repository, the
data root (`.swarmup/`). Writers only add files, one event per file with a ULID name, so git
merges never conflict. A task's state is the fold of its events in ULID order
(`packages/core/src/fold.ts`). [docs/protocol.md](docs/protocol.md) is the reference for the
commands, events and rules agents follow.

| Package               | Role                                                                                                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`       | The task store and everything that reads or writes it: fold, index, sync, map, criteria, definitions. Synchronous file I/O.                                                                                                   |
| `packages/supervisor` | `swarmupd`, one per machine: wakes agents and runs them in worktrees within limits, merges approved work with merge checks, runs scorers, judges and triggers, and serves the HTTP API on `127.0.0.1` (`api.ts`, `*-api.ts`). |
| `packages/cli`        | The `swarmup` command, used the same way by agents and people (`cli.ts`, `*-cmd.ts`).                                                                                                                                         |
| `packages/desktop`    | The Electron app: the main process in `src/`, the Vite UI in `ui/` (own `tsconfig.json`), installer scripts in `build/`. The UI talks to `swarmupd` through its API.                                                          |

- The repo keeps its own project map in `.swarmup/map/`: `swarmup map show <id>` prints a node and
  `_INDEX.md` lists them all. When a change moves what a node covers, update that node in the same
  commit; merges run `swarmup map check`. The format is in [docs/map.md](docs/map.md).
- A data root can hold the team's agents, workflows, triggers, scorers and rubrics as files, with
  settings in `swarm.yaml`. See [docs/definitions.md](docs/definitions.md).
- More design notes: [docs/supervisor.md](docs/supervisor.md), [docs/desktop.md](docs/desktop.md)
  and [docs/content-projects.md](docs/content-projects.md).

## Repo practices

- The repo is public: no tokens, private names or machine details in code, tests, docs or the
  map. `pnpm run leaks` and the pre-commit hook scan for them.
- A change users notice adds a fragment, `changelog.d/<slug>.<type>.md`. Don't edit
  `CHANGELOG.md`; the release folds the fragments in.
- CI runs on Linux only (lint, typecheck, unit tests). Windows-only paths, such as
  `packages/desktop/build/*.ps1`, are tested only on a Windows machine.
