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
  variants/<name>/            # sparse overlays: see Variants
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
- `improvement` sets the [improvement policy](#improvement-policy).
- `policy`, `work_types`, `scoring`, `checks`, `variants`, `experiments` and
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

## Variants

A variant is a sparse overlay of the definitions: a folder `variants/<name>/` in the store with the
same layout, holding only the files it changes. Variants are how a change is tried before it
lands: a run or a benchmark can use a variant while every other run keeps the base.

```text
.swarmup/
  variants/engineer-tests-first/
    agents/claude-engineer.md   # only what changes
    proposal.json               # written by `swarmup defs propose`; not part of the overlay
```

A variant's definitions are the base files with the overlay on top:

- YAML files, `swarm.yaml` among them, deep-merge: maps merge key by key, a list replaces the whole
  list, and `null` removes a key. The base file's comments stay.
- An agent file's frontmatter merges the same way. A non-empty body replaces the base body; an
  overlay with frontmatter only keeps the base instructions, and one with a body only keeps the
  base frontmatter as it is.
- `<path>.delete` removes the base file at `<path>`. Any other file replaces its base file.

A variant has its own hash, of the base files with the overlay applied, so a run or a benchmark
names exactly the definitions it used. The base hash never covers `variants/`. Variant names use
lowercase letters, digits and dashes.

- `swarmup validate --variant NAME [--root NAME]` checks a variant as a whole; problems name the
  overlay file when the overlay holds it.
- A run started with a variant (`variant` in `POST /api/runs`, `LaunchRequest.variant`) gets the
  resolved role file in its scratch folder, `role-<runtime>-<role>.md`, and its prompt points there.
  Its run record and `run-start` event carry `variant`, and its definition stamp the variant's hash.
- `swarmup bench run ... --variant NAME --root ROOT` replays a benchmark set with the variant's
  role file for the agent; see [benchmarks](benchmarks.md#role-files-and-variants).

## Proposals

A proposal is a variant recorded on a task for a person to decide on. The improver
([self-improvement](supervisor.md#self-improvement)) writes one; anyone can, from an overlay
folder.

```bash
swarmup defs propose TL-0012 --dir ./overlay --name engineer-tests-first \
  -m "Reviews send back untested work: run the tests the task names before review."
swarmup defs variants                         # each variant: hash, status, linked task, files
swarmup defs promote engineer-tests-first     # a person: write it onto the definitions
swarmup defs reject engineer-tests-first -m "Too broad; name the test command instead."
```

- `defs propose ID --dir DIR --name NAME -m WHY` checks the overlay in `DIR` against the store's
  improvement policy, writes `variants/<NAME>/`, checks the result as `validate` does (an error
  removes the folder again), and records a `defs-propose` event on task `ID` with the variant
  (`variant`), its short hash (`defs`) and a "Regressions addressed" section: the agents, the
  scorers (`--scorer`, else the task's `Scorers:` line) and the evidence (the task's `Evidence:`
  line). `--agent` names the agents when the overlay's files don't.
- At most `improvement.max_open_proposals` proposals (default 2) wait in one store; the next
  `defs propose` is refused until a person promotes or rejects one.
- `defs promote NAME [--root NAME] [-m NOTE]` is for a person only. It writes the variant's result
  onto the base files, records a `defs-promote` event with the hashes before and after
  (`defs_from`, `defs_to`) on the linked task, and removes the variant's folder. A variant that no
  longer checks against the base is refused.
- `defs reject NAME [--root NAME] -m WHY` is for a person only. It records a `defs-reject` event
  with the note on the linked task and removes the folder. The base files don't change.
- `defs variants` lists each variant's hash, `proposed` (it has a `proposal.json`) or `draft` (a
  folder made by hand), the linked task, the agents, the files it changes, and **stale** when the
  base moved since the proposal.

Runs can't edit `agents/` or `variants/`: they change definitions only through `defs propose`.

### Improvement policy

`swarm.yaml` sets what a proposal may change:

```yaml
improvement:
  agent: claude:improver # who writes proposals
  may_change: ['agents/*.md', 'agents/*/*.md', 'workflows/**'] # the default
  frozen: ['scorers/**', 'benchmarks/**', 'rubrics/**', 'swarm.yaml'] # the default
  max_open_proposals: 2
```

- Every path a proposal changes must match a `may_change` glob and no `frozen` glob; `frozen`
  wins. `*` stays within one folder, `**` crosses folders.
- An agent's `tools`, `mcp`, `writes`, `can_claim` and `id` are always frozen, whatever the policy says,
  and a proposal never removes an agent file. A person changes those by hand.
- `improvement.requires` is accepted and not active yet; `swarmupd.improve.benchmark` runs the
  benchmark gate.

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
