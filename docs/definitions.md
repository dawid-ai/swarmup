# Definitions as code

A task store can hold the team's settings in `swarm.yaml`, next to its agent files, so they are
versioned in git and every machine that syncs the store runs with them. Each machine's user config
still wins: at equal specificity a machine setting beats the same key in git, and swarmupd records
each such override.

Definitions are opt-in per store: a store without `swarm.yaml` works as before, and its runs record
nothing new.

## Where they live

```text
.swarmup/
  swarm.yaml                  # the team's settings
  agents/<runtime>-<role>.md  # agent files, as before
  .schemas/*.schema.json      # optional: `swarmup validate --write-schemas` writes them for editors
```

The definition hash covers `swarm.yaml` and every file under `agents/`. It is `d:` and the SHA-256
of a header line plus one line per file, its path and the SHA-256 of its text, sorted by path. The
text is read with the BOM removed and CRLF turned into LF, so line ends and file order never change
the hash. `swarmup defs hash` prints it.

## swarm.yaml

```yaml
swarmup_defs: 1 # format version; always 1 for now

defaults: # for runtimes that set no model or effort, here or on the machine
  effort: medium

runtimes: # the git half of swarmupd.runtimes: model and effort only
  claude: { model: opus }
  codex: { model: gpt-5-codex, effort: medium }

roles: # as swarmupd.roles takes them
  engineer: { providers: [claude, codex], per_project: 2 }
  reviewer: { providers: [codex, claude], overflow: true }
  qa: { writes: false, burst: 6 }
```

- `runtimes.<rt>` takes `model` and `effort`. Commands, arguments, environment, `max_live`,
  `pause_at` and the other runtime keys are machine-only: `swarmup validate` refuses them, since
  swarmupd runs only commands the user config names.
- `roles.<role>` takes `providers`, `overflow`, `writes`, `per_project`, `burst` and
  `max_children`. `max_live` is machine-only.
- `defaults.model` applies to every runtime that sets none, so set the model per runtime when you
  run several providers.
- `policy`, `work_types`, `scoring`, `checks`, `variants`, `experiments`, `improvement` and
  `defaults.budget_min` are accepted with a warning that they are not active yet.
- Agent files keep their fields. They also take `runtimes.<rt>.{model, effort}`, which wins over the
  file's own `model` and `effort` for that runtime. `role`, `providers`, `writes` and `scorers` are
  accepted with a "not active yet" warning.

The template `packages/core/templates/swarm.yaml` is a commented example.
`swarmup defs import-config` starts a `swarm.yaml` from your user config.

## Precedence

More specific beats less specific, and at equal specificity the machine beats git:

- **Model and effort:** the machine agent (`swarmupd.agents.<id>`), then the agent file's
  `runtimes.<rt>`, then the agent file, then the machine runtime (`swarmupd.runtimes.<rt>`), then
  `swarm.yaml` `runtimes.<rt>`, then `swarm.yaml` `defaults`.
- **Roles:** each key of `swarmupd.roles.<role>` wins over the same key in `swarm.yaml`; the
  built-in defaults fill what neither sets.

With several roots, swarmupd merges their `swarm.yaml` files in root order: for a key two roots
set, the first wins and swarmupd warns once. A root whose `swarm.yaml` has errors keeps its last
good definitions until the file is fixed, with one warning per version.

## Run stamps

When a run's root has a `swarm.yaml` (or, for a run without a task, any root has one), the run
record gains:

- `defs`: `root`, `hash`, the last store `commit` that changed a definition file when they are all
  committed or `dirty: true` when one is not, and `local`, the machine keys that overrode git for
  the run, such as `runtimes.claude.model`.
- `model` and `effort`: what the run was started with.

The task's `run-start` event carries `defs`, the short hash (`d:` and 12 hex digits), so scores on
any machine can tell which definitions did the work. swarmupd keeps the files of each hash in the
`definitions` table of `state.db` the first time it sees it, and each run's hash in `run_defs`.
The commit is read with git off the event loop when the definitions change; a run that starts
before that read ends records the hash alone.

## Commands

- `swarmup validate [PATH...] [--root NAME] [--strict] [--json] [--write-schemas]` checks each
  root, or the files and stores named. It prints `file:line:col: severity: path: message` and
  exits 0 when there are only warnings, 1 on errors or, with `--strict`, on warnings, and 2 on bad
  input. Under `--strict` an unknown key is an error.
- `swarmup defs show` prints each root's hash and what its `swarm.yaml` sets under this machine's
  config, with the machine keys that overrode it.
- `swarmup defs hash` prints the full hash of each root.
- `swarmup defs diff [REF]` lists the definition files that changed since a git ref, `HEAD` by
  default, with both hashes.
- `swarmup defs import-config` writes the user config's `swarmupd.runtimes.*.{model, effort}` and
  `swarmupd.roles.*` into `swarm.yaml`, keeping its comments, and prints the change. The user
  config keeps those keys, so this machine still overrides them, unless you pass `--remove`.
- `swarmup doctor` and `swarmup agents` show the problems of each root with a `swarm.yaml`.
- The API has `GET /api/defs` (each root's set, what it applied, overrides and conflicts) and
  `POST /api/defs/validate` with `{ file, text, strict? }`, which checks text without writing it.

The schemas are written once, in `packages/core/src/defs`, and generated into
`packages/core/schemas/*.schema.json` by `node scripts/gen-schemas.mjs`; a test fails when the two
drift apart.

## In the desktop app

**Settings > Definitions** shows each project's `swarm.yaml`: whether there is one, the hash and
commit, the effective value and source (git or this machine) of each key it sets, the problems,
and the file with each problem's line marked. **Validate**, **Import from my settings** (a
preview, then a write that keeps your user config as it is), **Create swarm.yaml** from the
template, and **Edit** with checks as you type. See [the desktop app](desktop.md#definitions).

`GET /api/defs` gives each root's `text` of `swarm.yaml` and `values`: each key the git
definitions set, with `value`, `source` (`git`, `machine` or `unused`), the `git` value and the
`root`. The writes are `POST /api/defs/import` with `{ root }` for a preview and
`{ root, write: true, expect }` to write the previewed text, `POST /api/defs/create` with
`{ root }`, and `POST /api/defs/save` with `{ root, text, expect }`. Each checks the result first
and refuses a file that changed since `expect` was read. `POST /api/defs/validate` with `{ root }`
checks a whole root under this machine's config.
