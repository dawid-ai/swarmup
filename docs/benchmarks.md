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
> `--agent none` and `--reference-dir` modes run no agent and cost nothing. `--judge` and
> `swarmup bench judge` spend tokens for each `rubric` criterion of each attempt. `--max-usd X`
> stops starting attempts once the run has cost `X`.

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
| `--repeat N`              | Attempts per entry, over the set's `repeat`. With more than one, the summary adds the spread over attempts; see [Results](#results).                |
| `--max-usd X`             | Starts no attempt once the attempts so far cost `X` dollars or more; see [Cost cap](#cost-cap).                                                     |
| `--budget-min N`          | Minutes an attempt's agent may run, over the set's `budget` (default 30).                                                                           |
| `--hidden-dir DIR`        | The hidden tests' folder, over the set's `hidden_dir`.                                                                                              |
| `--reference-dir DIR`     | Applies `DIR/<entry>.patch` instead of running an agent; see the following section.                                                                 |
| `--out DIR`               | Where results go; it must be new or empty and outside the repo. Default: `swarmup-bench/<set>-<UTC time>` in `$SWARMUP_SCRATCH` or the temp folder. |
| `--keep`                  | Keeps each attempt's worktree; by default it is removed after its diff is saved.                                                                    |
| `--judge`                 | Judges each attempt's `rubric` criteria after its checks, with the judge of `swarmupd.judge`; see the following sections. Spends tokens.            |
| `--judge-model M`         | The judge's model, over `swarmupd.judge.model`.                                                                                                     |
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

### Cost of Codex runs

Claude's log reports each run's cost (`total_cost_usd`). Codex's reports tokens only, so the
runner estimates the cost: the run's input, cached input and output tokens times the model's price
per million tokens. Codex's `input_tokens` include its `cached_input_tokens`; the runner prices
the cached part at the cached input price and the rest at the input price. The model is the first
of:

1. `--model`, or the model the role file gives the agent's runtime.
2. The `model` of the runtime config, for a caller that passes one (the command line does not).
3. The top-level `model = "..."` in `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`).

A model of `default`, or an empty one, counts as unset. The built-in prices, in USD per million
tokens, are OpenAI list prices as of 2026-11-22, from public reports that disagree:

| Model           | `input` | `cached_input` | `output` |
| --------------- | ------- | -------------- | -------- |
| `gpt-5.6-sol`   | 5       | 0.5            | 30       |
| `gpt-5.6-terra` | 2       | 0.2            | 12       |
| `gpt-5.6-luna`  | 0.2     | 0.02           | 1.2      |

Set your own prices, or prices for other models, in your user config. An entry replaces the
built-in price of that model; all three numbers are required:

```yaml
swarmupd:
  bench:
    prices:
      gpt-5.6-sol: { input: 5, cached_input: 0.5, output: 30 }
```

An estimated cost has `costEstimated: true` in its metrics, with the model as `priceModel`, and
shows with a `~` prefix in `summary.md` and `bench compare`. When the model is unknown or has no
price, the cost stays empty, the metrics have `unpriced: true`, and `summary.md` names the model
that has no price. `--dry-run` prints the model and price a Codex run would use. A Claude run that ends
before its `result` message, such as one that ran out of budget, has tokens and no cost too; it is
priced the same way, and has no cost unless its model has a price.

### Cost cap

`--max-usd X` checks the cost before each attempt: once the attempts that ran cost `X` or more,
agent cost (estimates included) plus judge cost with `--judge`, no further attempt starts. The
attempt under way when the cap is reached finishes. The attempts left over go into `summary.json`
as `skipped`, each with the entry, the attempt number and the reason, and `summary.md` lists them
under **Not started**. `summary.json` records `cap`: `maxUsd`, `spentUsd`, `hit`, and
`uncounted`, the attempts whose cost is unknown. The cap cannot count those, so the runner warns
once when the first one finishes. `status.json` counts the skipped attempts as `skipped`.
`--dry-run` prints the cap.

### Calibrate without spending tokens

Two modes check the harness itself:

- **`--reference-dir DIR`** applies `DIR/<entry>.patch`, a known good solution, to each entry
  that has one, and skips the rest. Every visible and hidden criterion of a reference attempt
  should pass. If one fails, the criterion or the hidden test is wrong, not the agent.
- **`--agent none`** changes nothing. Hidden tests should fail; one that passes on the base
  commit proves nothing about an agent.

Both run each entry once, whatever `repeat` says.

## Role files and variants

By default an attempt's prompt is the entry's task alone. `--role-file --root ROOT` puts the
agent's role file from `ROOT` (a store folder, or the name of a root) at the top of each prompt and
runs with the model and effort it gives the agent's runtime, unless `--model` or `--effort` say
otherwise. `--variant NAME --root ROOT` does the same with variant `NAME` on top of the store's
definitions, so a [proposal](definitions.md#proposals) can be measured against its base:

```bash
swarmup bench run tally.yaml --repo C:\dev\swarmup-testbed --agent claude:engineer \
  --role-file --root tally --out base
swarmup bench run tally.yaml --repo C:\dev\swarmup-testbed --agent claude:engineer \
  --variant engineer-tests-first --root tally --out variant
swarmup bench compare base variant
```

The run writes the resolved role file to `role.md` in its out folder, and `summary.json` records
`role`: the agent, the store, the definition hash and the variant. `bench compare` names the
variant in its header.

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
  with the end of the output as evidence. A `rubric` criterion is `pending` until a judge scores
  it (`--judge` or `swarmup bench judge`); then it is `pass` or `fail` with its `score` (0 to 1),
  the judge's reasons as its note, and the per-criterion scores, model and cost as its evidence.
  Prose and `human` criteria stay `pending`. A `map` criterion is `na`.
- **Judge:** with a judged rubric criterion, the judge's runtime and model and what judging the
  attempt cost (`judge.costUsd`).
- **Run:** the command line, exit code, wall time, and whether the budget ran out.
- **Metrics:** cost and tokens when the log reports them (Claude's `result` message has
  `total_cost_usd` and `usage`; Codex reports tokens, no cost, so its cost is an estimate, see
  [Cost of Codex runs](#cost-of-codex-runs)), turns, tool calls, and tool calls before the first
  edit, read the way `swarmup scores` reads orientation.
- **Diff:** files changed, insertions and deletions against the base, from `git diff --shortstat`
  after every change is staged, so new files count. The runner stages the worktree's changes
  before it checks the criteria, so `git diff {{base}}` in a command sees new files too.

`summary.md` has one row per entry: attempts, the mean pass rate of checkable criteria (judged
`rubric` criteria count), attempts whose hidden criteria all passed, pending criteria, judged
rubric results over all attempts, the mean cost, what judging cost in all, and the mean time and
tool calls before the first edit. The last row covers the run: the pass rate weighs every entry
the same, and the other figures count attempts. A run with judged rubric criteria has a pass
rate over more criteria than the same run without, so compare judged runs with judged runs.

With more than one attempt per entry, `summary.md` adds a **Spread over attempts** table and
`summary.json` adds, per entry, `passRateMin`, `passRateMax`, `passRateSd` (the sample standard
deviation of the attempts' pass rates) and `costSdUsd` (the same for their cost). The overall row
and `overall` give the spread over repeats: repeat N's pass rate is the mean over the entries'
attempt N, and its cost is the mean cost of those attempts. A large standard deviation means one
run's pass rate says little; add repeats before you compare.

## Judge rubric criteria

A `rubric` criterion names a rubric file and a `pass` score; an LLM judge scores the attempt
against it. The file format, what the judge sees and how the score is worked out are in
[docs/protocol.md](protocol.md#rubric-files).

```sh
swarmup bench run benchmarks/demo.yaml --repo ../app --reference-dir refs --judge
swarmup bench judge <out>                  # judge a finished run's pending rubric criteria
swarmup bench judge <out> --again          # judge every rubric criterion again
swarmup bench judge <out> --set demo.yaml  # a run from before summary.json named its set
```

- **When:** `--judge` judges each attempt right after its checks, while its worktree is still
  there. `swarmup bench judge` judges a finished run afterwards: it reads the set from the
  `setFile` its `summary.json` names (or `--set`), writes each `results.json` and the summary
  again, and prints the new table. An attempt whose worktree is gone gets a temporary worktree
  at its base with its `diff.patch` applied, when a rubric asks for the `repo` or `files` input.
- **What it sees:** the entry's prompt as the task, the attempt's `diff.patch`, and the files of
  the attempt's tree the rubric asks for. It never sees which agent or model did the work.
- **Where the rubric comes from:** a path relative to the set file, else the file at the entry's
  base commit in the repo under test, never the attempt's worktree, which the agent may change.
- **A failed judgment** (a timeout, a signed-out runtime, an answer it cannot read) leaves the
  criterion `pending` with why in its note, so a later `swarmup bench judge` tries again.
- **Calibrate the judge** like the harness: a reference patch should score high and the unchanged
  base (`--agent none`) low. If both score alike, the rubric's anchors need work.
- **The judge's settings** are `swarmupd.judge` in the user config ([docs/supervisor.md](supervisor.md#config)):
  runtime, model, effort and a time budget per judgment.

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
before you read a small delta as a real change. A `~` marks an estimated cost.
