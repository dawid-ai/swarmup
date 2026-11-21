# Benchmarks

`swarmup bench` replays real tasks against an agent configuration and scores the results, so you
can show whether a change to a role, a model, an effort level or the harness helped. Each entry of
a benchmark set names a base commit, a prompt and typed `done_when` criteria. The runner gives
every attempt a throwaway worktree at the base, runs the agent there with the same command line
swarmupd uses, and checks the criteria.

The runner works on its own: it needs no swarmupd, no task store and no data root, only the repo
under test and the set file.

> **Cost:** a run with a real agent spends tokens for every entry and every repeat, up to the
> budget of each attempt. Start with `--dry-run`, then two or three entries and one repeat. The
> `--agent none` and `--reference-dir` modes run no agent and cost nothing.

## Set file format

A set is one YAML file, `benchmarks/<set>.yaml`, in the format W5's definitions use, so a set
written today carries over when swarmupd runs benchmarks itself.

```yaml
id: demo # letters, digits, '.', '_' or '-'
description: Bugs and small features from the issue tracker
hidden_dir: ../hidden # optional; relative to this file, outside the repo under test
hidden_to: hidden # optional; where hidden files go in the worktree (default hidden)
defaults:
  agent: claude:engineer # <runtime>:<role>, or none
  budget: 30 # minutes an attempt's agent may run
  repeat: 1 # attempts per entry
entries:
  - id: BUG-12
    base: { ref: 3f2a9c1 } # a commit, tag or branch of the repo under test
    task:
      type: bug
      title: Reject negative budgets
      body: |
        `budget set Groceries -50` stores a negative limit. Make it fail like `budget load`.
    done_when:
      - { id: tests, kind: command, run: python -m unittest }
      - { id: hidden, kind: command, run: python -m unittest hidden.test_bug12, hidden: true }
      - { id: flag, kind: check, check: regex, args: { path: app/cli.py, pattern: '--strict' } }
      - { id: readable, kind: rubric, rubric: rubrics/code-quality.md, pass: 0.8 }
      - Validation is shared with `budget load`, not duplicated.
    budget: 45 # optional overrides of the defaults
  - id: DOC-3
    base: { ref: main }
    prompt: Write docs/cli.md, a reference of every command and flag.
    done_when:
      - { kind: check, check: regex, args: { path: docs/cli.md, pattern: 'exit code', flags: i } }
      - { kind: command, run: 'git diff --quiet {{base}} -- src' }
```

- **`task` or `prompt`**: an entry has exactly one. The agent gets the prompt as written, or the
  task's title as a heading followed by its body. It never sees the criteria.
- **`base`**: this version runs `base.ref` only. `base.snapshot` (a fixture folder) and
  `base.empty` parse, for the swarmupd runner, and a run refuses them.
- **`done_when`**: the typed criteria of [docs/protocol.md](protocol.md#done-when), checked the
  same way. `{{base}}` in a command is replaced with the entry's resolved base commit.
- `swarmup bench run` refuses a set with an unknown key, a bad criterion, two entries with one
  id, or an entry with both or neither of `task` and `prompt`, and names the key.

## Hidden tests

A hidden test is an acceptance test the agent must never see: an agent that can read it can pass
it without doing the work. Mark its criterion `kind: command` with `hidden: true`, and keep the
files in a folder outside the repo under test (`hidden_dir` in the set, or `--hidden-dir`).

For each attempt, the runner:

1. Runs the agent, then saves the diff.
2. Runs the visible `command` and `check` criteria, with no hidden files in the worktree, so a
   test runner that discovers tests by folder never collects them.
3. For each hidden criterion, copies the hidden folder to `hidden_to` in the worktree, runs the
   command, and removes the folder again.

If the agent created a folder at `hidden_to`, the runner leaves it alone and fails the hidden
criterion. The runner refuses a hidden folder inside the repo under test.

## Run a benchmark

```sh
swarmup bench run benchmarks/demo.yaml --repo ../app --dry-run
swarmup bench run benchmarks/demo.yaml --repo ../app --entries BUG-12,DOC-3 --agent claude:engineer
```

| Flag                      | What it does                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--repo DIR`              | The repo under test. Each attempt gets a detached worktree of it at the base.                                                                       |
| `--entries ID,ID`         | Runs these entries only, in this order.                                                                                                             |
| `--agent RUNTIME:ROLE`    | Overrides the set's agents. `claude` and `codex` runtimes run; `none` runs no agent.                                                                |
| `--model M`, `--effort E` | The model and reasoning effort, passed as `--model`/`--effort` (Claude) or `-m`/`-c model_reasoning_effort=` (Codex).                               |
| `--repeat N`              | Attempts per entry, over the set's `repeat`.                                                                                                        |
| `--budget-min N`          | Minutes an attempt's agent may run, over the set's `budget` (default 30).                                                                           |
| `--hidden-dir DIR`        | The hidden tests' folder, over the set's `hidden_dir`.                                                                                              |
| `--reference-dir DIR`     | Applies `DIR/<entry>.patch` instead of running an agent; see the following section.                                                                 |
| `--out DIR`               | Where results go; it must be new or empty and outside the repo. Default: `swarmup-bench/<set>-<UTC time>` in `$SWARMUP_SCRATCH` or the temp folder. |
| `--keep`                  | Keeps each attempt's worktree; by default it is removed after its diff is saved.                                                                    |
| `--dry-run`               | Prints the plan and the agent's command line, and changes nothing.                                                                                  |
| `--json`                  | Prints `summary.json` instead of the table.                                                                                                         |

The agent runs non-interactively with the prompt on stdin:

- **Claude:** `claude -p --permission-mode acceptEdits --output-format stream-json --verbose`
  with swarmupd's deny list. Its allow list is swarmupd's default tools without the GitHub
  commands, plus `MultiEdit` and `python`, `python3`, `py`, `pytest`, `ls`, `cat`, `head`, `tail`,
  `wc`, `mkdir` and `diff`. `swarmup` is denied: a bench run works one repo and no task store.
- **Codex:** `codex exec --json --sandbox danger-full-access --skip-git-repo-check -C <worktree> -`,
  as swarmupd starts a run in a task worktree.

The runner ignores the machine's `swarmupd.runtimes` settings, so two machines run the same
command line. When the budget runs out, it stops the agent and every process under it, and
records the attempt as timed out. Attempts run one at a time.

### Calibrate without spending tokens

Two modes check the harness itself:

- **`--reference-dir DIR`** applies `DIR/<entry>.patch`, a known good solution, to each entry
  that has one, and skips the rest. Every visible and hidden criterion of a reference attempt
  should pass. If one fails, the criterion or the hidden test is wrong, not the agent.
- **`--agent none`** changes nothing. Hidden tests should fail; one that passes on the base
  commit proves nothing about an agent.

Both run each entry once, whatever `repeat` says.

## Results

The out folder holds one folder per attempt and the run's summary:

```text
<out>/
  summary.json
  summary.md
  BUG-12/1/results.json       # the attempt: run, metrics, diff stats, each criterion's result
  BUG-12/1/agent.log          # the agent's stream-json or --json output
  BUG-12/1/diff.patch         # every change against the base, new files included
  BUG-12/1/worktree/          # with --keep only
  status.json                 # where the run stands; see Run from the app
```

Each attempt records:

- **Criteria:** `pass`, `fail` or `na` for `command` and `check` criteria, hidden ones included,
  with the end of the output as evidence. Prose, `rubric` and `human` criteria are `pending`: a
  judge scores them later. A `map` criterion is `na`.
- **Run:** the command line, exit code, wall time, and whether the budget ran out.
- **Metrics:** cost and tokens when the log reports them (Claude's `result` message has
  `total_cost_usd` and `usage`; Codex reports tokens, no cost), turns, tool calls, and tool calls
  before the first edit, read the way `swarmup scores` reads orientation.
- **Diff:** files changed, insertions and deletions against the base, from `git diff --shortstat`
  after every change is staged, so new files count. The runner stages the worktree's changes
  before it checks the criteria, so `git diff {{base}}` in a command sees new files too.

`summary.md` has one row per entry: attempts, the mean pass rate of checkable criteria, attempts
whose hidden criteria all passed, pending criteria, and the mean cost, time and tool calls before
the first edit. The last row covers the run: the pass rate weighs every entry the same, and the
other figures count attempts.

## Run from the app

The desktop app's **Benchmarks** view lists sets and runs, starts runs and compares them; see
[the desktop app](desktop.md#benchmarks). It finds sets in two places:

- Each project's `.swarmup/benchmarks/*.yaml`.
- The files and folders of `.yaml` files in your user config under `swarmupd.bench.sets`. A
  relative path is read from the user config's folder.

```yaml
swarmupd:
  bench:
    sets: [C:/work/benchmarks/tally.yaml, C:/work/more-sets]
    results: [C:/work/bench-results] # optional: more folders of run folders to list
```

A run from the app writes to `bench/<run-id>/` in swarmupd's state folder, with `<run-id>` the
set's id and the UTC start time. swarmupd starts `swarmup bench run` there in a background process
with no window, with the flags the form sets; the folder also holds `request.json` (what the app
asked for) and `run.log` (the runner's output). Before it starts a run, the app makes a dry run
and shows the plan; an agent run needs an explicit confirmation of its cost. The API is
`GET /api/bench/sets`, `GET /api/bench/runs`, `GET /api/bench/runs/<id>`,
`GET /api/bench/runs/<id>/attempt?entry=E&n=1&file=diff|log`, `POST /api/bench/run`,
`POST /api/bench/runs/<id>/stop` and `POST /api/bench/compare` with `{ a, b }`.

While it runs, every run, from the app or the command line, keeps `status.json` in its out folder:
`state` (`running`, `done` or `failed`), `done` and `total` attempts, the attempt under way as
`current`, the runner's `pid`, and the times. A run whose runner ended without `done` shows as
failed. `--out` may hold the app's `request.json` and `run.log` already; any other file still
refuses the folder.

## Compare two runs

```sh
swarmup bench compare <out-A> <out-B>
swarmup bench compare a/summary.json b/summary.json --json
```

`compare` takes two out folders or `summary.json` files and prints, per entry and overall, A's
figure, B's, and B minus A for the pass rate, hidden pass, cost, time and tool calls before the
first edit. The overall row covers only the entries both runs have, so the deltas compare like
with like. With one repeat, an entry's pass rate moves in large steps; use `--repeat 3` or more
before you read a small delta as a real change.
