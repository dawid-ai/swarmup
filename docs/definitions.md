# Definitions as code

A task store can hold the team's settings in `swarm.yaml`, next to its agent files and workflows,
so they are versioned in git and every machine that syncs the store runs with them. Each machine's user config
still wins: at equal specificity a machine setting beats the same key in git, and swarmupd records
each such override.

Definitions are opt-in per store: a store without `swarm.yaml` works as before, and its runs record
nothing new.

## Where they live

```text
.swarmup/
  swarm.yaml                  # the team's settings
  agents/<role>/agent.md      # an agent folder: the role, for every runtime it runs on
  agents/<role>/<runtime>.md  # optional: what one runtime of the role does differently
  agents/<runtime>-<role>.md  # a legacy agent file, still read
  workflows/<id>.yaml         # repeatable milestone plans: see Workflows in the protocol
  triggers/<name>.yaml        # when swarmupd starts something: see Triggers
  scorers/<id>.yaml           # a built-in scorer's threshold and filters, or a rubric scorer
  rubrics/<id>.md             # what a judge scores work against: see Rubric files in the protocol
  variants/<name>/            # sparse overlays: see Variants
  .schemas/*.schema.json      # optional: `swarmup validate --write-schemas` writes them for editors
```

The definition hash covers `swarm.yaml` and every file under `agents/`, `workflows/`, `rubrics/`,
`triggers/` and `scorers/`. It is `d:` and the SHA-256
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
- `policy` is the team policy: the git half of top-level `swarmupd` keys (see
  [Team policy](#team-policy)). `defaults.budget_min` is the run budget for agents that set none.
- `work_types` give a new task without criteria its default ones (see
  [Work types](#work-types)).
- `experiments` give a share of task runs a variant (see [Experiments](#experiments)).
- `scoring` sets the [rubric scorers](#rubric-scorers)' cap and sample.
- `variants` describes variants and points them at a git ref (see
  [Variants from a git ref](#variants-from-a-git-ref)).
- Agent files keep their fields. They also take `runtimes.<rt>.{model, effort}`, which wins over the
  file's own `model` and `effort` for that runtime, and `role`, `providers`, `writes` and
  `scorers`; see [Agent folders](#agent-folders).

### Team policy

```yaml
policy:
  review_rounds: 3 # changes verdicts in a row before the author stops being woken
  stuck_runs: 3 # runs in a row without progress before a task stops being started
  review_backlog: 3 # reviews waiting in a project at which writers hold and reviewers burst
  review_fallback_hours: 2
  plan_check_minutes: 30
  budget_minutes: 180 # run budget when neither the task nor the agent sets one
  test_changes: { tests: ['test/**'], checks: ['.github/**'] } # or false
defaults:
  budget_min: 60 # wins over policy.budget_minutes
```

Each key fills the top-level `swarmupd` key of the same name on a machine whose user config does
not set it. A key the user config sets wins, even when it holds the built-in default: swarmupd
records which keys the user config sets (`explicit`), so a value written there on purpose is never
replaced by git. `policy.test_changes` applies to the store's own root, as
`swarmupd.test_changes.<root>` would. Each machine value that differs from git shows as an
override in `swarmup defs show` and **Settings > Definitions**.

### Work types

```yaml
work_types:
  - types: [bug]
    workflow: bugfix
    done_when: ['A test reproduces the bug and passes with the fix']
  - labels: [ui]
    done_when: [{ id: shot, kind: human, ask: Does the screen look right? }]
```

When `swarmup new` (or the app's **New task**) files a task without criteria, the first entry
whose `types` name the task's type (any type without `types`) and whose `labels` include one of the
task's labels (any labels without `labels`) gives the task its `done_when`. An entry with a
`workflow` also adds a note that names it: `this kind of work has a workflow: swarmup workflow
start bugfix`. An entry with neither `types` nor `labels` matches nothing, and `swarmup validate`
warns about it and about a `workflow` with no file.

## Agent folders

An agent folder holds one role for every runtime it runs on:

```text
agents/writer/agent.md   # the role: frontmatter and instructions
agents/writer/codex.md   # optional: only codex:writer reads it
```

- **Ids.** The folder name is the role. The folder expands into one agent, `<runtime>:<role>`,
  for each provider: the file's `providers`, else `roles.<role>.providers` in `swarm.yaml`, else
  the runtimes `swarm.yaml` names, else `claude` and `codex`. `id` is refused in folder files.
- **Addenda.** `agents/<role>/<runtime>.md` overlays `agent.md` for that runtime: maps merge,
  lists replace, and `null` deletes. Its body comes after the role's body, or instead of it with
  `body: replace`. `role` and `providers` belong in `agent.md`. An addendum for a runtime the
  folder does not expand into never applies, and `swarmup validate` says so.
- **Legacy files.** `agents/<runtime>-<role>.md` keeps working. When it and a folder define the
  same id, the legacy file wins and `swarmup validate` warns on the folder.
- **Runs.** A run of a folder agent with an addendum reads the two put together: swarmupd writes
  them as one role file in the run's scratch folder and points the prompt there. A variant
  (`variants/<name>/agents/<role>/agent.md` or `.../<runtime>.md`) overlays folders the same way.
- **`writes`** in an agent file sets its role's `writes`: it wins over `roles.<role>.writes` in
  `swarm.yaml`, and `swarmupd.roles.<role>.writes` on the machine wins over both.
- **Writes from the app.** Editing an agent writes where it lives: its legacy file, or the
  folder's `agent.md` (every runtime) or the runtime's addendum. A new role goes to a folder only
  when the store's `swarm.yaml` names `swarmup_defs: 1`, so a fleet still on a version that reads
  only legacy files keeps its agents. A new runtime for a role that has a folder is added to the
  folder's `providers`, and what it sets differently goes to its addendum.

### Migrate legacy files

`swarmup defs migrate` prints, for each root, the folders that would replace its legacy agent
files, as a diff. Values every runtime of a role shares go to `agent.md` with an explicit
`providers`; the rest, and a body that differs, go to the runtime's addendum. The migration
refuses unless the folders, read the way swarmupd reads them, give every agent the same fields as
its legacy file, and refuses a legacy file that does not read.

- `--apply` writes the folders. The legacy files stay and win, with a warning, until you prune
  them.
- `--prune` writes the folders and removes the legacy files.
- Both need `swarmup_defs: 1` in the store's `swarm.yaml`, and each write is logged to
  `migrations.log` next to the user config.
- A role that has a folder already is skipped; move its files by hand.

The template `packages/core/templates/swarm.yaml` is a commented example.
`swarmup defs import-config` starts a `swarm.yaml` from your user config.

## Triggers

A trigger in `triggers/<name>.yaml` says when swarmupd starts something, and what. It is the git
form of a machine's `swarmupd.schedules`, with cron times, workflows and repeats besides runs:

```yaml
# triggers/standup.yaml
cron: '0 9 * * mon-fri' # or every: 30m, or at: '09:00'
action: run # run | workflow | repeat
agent: claude:pm
prompt: Post the standup in the channel.
runs_on: [desk] # machine names; unset means every consenting machine (run only)
enabled: true # optional; false keeps the file and fires nothing
```

- **When:** exactly one of `every` (a duration such as `30m` or `1d`), `at` (a daily local time
  such as `09:00`) and `cron`, unless the trigger has a `webhook` section. `cron` takes five fields, minute, hour, day of month, month and
  day of week, in the local time of the machine that runs it. Each field takes `*`, a value, a
  range `a-b`, a step `*/s`, `a-b/s` or `a/s`, and lists joined by commas; months take `jan` to
  `dec` and days of the week `sun` to `sat` (0 or 7 is Sunday). When both day fields are
  restricted, a day that matches either one fires, as in Vixie cron.
- **What:** `action: run` starts `agent` with `prompt` (the standard prompt without one) on
  `task` (an `ID` of this store; a trigger never starts another store's task), under the usual
  limits, as a schedule does.
  `action: workflow` starts `workflow` with `params` and an optional milestone `title`, through
  the same path as `swarmup workflow start`. `action: repeat` creates the task of
  `repeats/<repeat>.md` now, as `swarmup repeat run` does. swarmupd starts workflows and repeats
  as `opsd:trigger`, never as a person, so a `starter` workflow still waits for a person's
  approval.
- **Consent:** git never starts anything on a machine without its consent. A trigger fires on a
  machine only when all of these hold:
  - The machine turned the store's triggers on: `swarmupd.triggers.<root>: true`, which
    `swarmup triggers on --root NAME` writes.
  - A person trusted the store's exact trigger set there (Decision 7, as for merge checks):
    `swarmup defs trust --root NAME`, or `swarmup triggers on --root NAME --trust`, keeps
    `t:` and a SHA-256 in `swarmupd.trusted_defs.<root>.triggers`. The hash covers every field
    that changes what fires: name, `every`, `at`, `cron`, `action`, `agent`, `prompt`, `task`,
    `workflow`, `params`, `title`, `repeat`, `runs_on`, `enabled` and `webhook`, not
    `description`. Any
    change stops every trigger of the store until a person trusts the new set, since a run can
    write `triggers/` with a shell command and store sync commits it. `validate` and `doctor`
    (on a machine that turned the store's triggers on), `swarmup triggers list` and swarmupd's
    log say so.
  - `runs_on` names the machine (`machine` in its user config), or is unset. `action: workflow`
    and `action: repeat` need `runs_on`, so one fire time starts one workflow or task, not one
    per consenting machine.
  - For `action: run`: the agent may be woken on this machine (`swarmupd.agents.<id>.wake:
true`) and has a role file in the store with `status: active`.
  - `swarmup triggers on|off`, `defs trust` and `defs import-schedules --apply` refuse an agent
    and anyone inside a run: only a person decides what git may start.
- **Once per fire time:** swarmupd records in `triggers.json`, in its state folder, when each
  trigger last fired on this machine, so a restart never fires one fire time twice. A new
  `every` trigger fires at once; a new `at` or `cron` trigger fires first at its next time after
  this machine first sees it. A trigger that stops firing here (turned off, untrusted, disabled,
  `runs_on` no longer naming the machine) loses its record, so when it fires again it starts
  from then, never for a time weeks ago. After a pause or a stop of swarmupd, each trigger fires
  once for the latest time it missed. Each fire is recorded before it acts (for a `run`, once
  the limits have room, just before the launch), so a crash or a failure never starts it twice.
  A cron time that a spring-forward change skips fires at the first minute after the gap, as in
  Vixie cron; a cron that names no date that comes, such as `0 0 30 2 *`, is an error.
- **webhook:** a `webhook` section (W8 phase 4) lets swarmupd's inbound listener take deliveries
  for the trigger at `POST /hooks/<root>/<name>`. A trigger may have a webhook alone, or a
  schedule and a webhook; `every`, `at` and `cron` are then optional. See
  [Webhook triggers](#webhook-triggers).

#### Webhook triggers

```yaml
# triggers/linear-issue.yaml
webhook:
  verify: linear # hmac | bearer | linear | slack
  secret: LINEAR_WEBHOOK_SECRET # the name of a value in secrets.yml, never the secret
  delivery_header: Linear-Delivery # optional; the header with a delivery id, for dedupe
  rate: 30 # optional; deliveries a minute, default 30
action: run
agent: claude:pm
prompt: Triage the Linear issue in the payload.
```

- **Checks:** `hmac` takes an HMAC-SHA256 of the body, hex, with or without `sha256=`, in
  `header` (default `X-Hub-Signature-256`; `X-GitHub-Delivery` is the default delivery id).
  `bearer` takes `Authorization: Bearer <secret>`. `linear` takes `Linear-Signature` and needs the
  body's `webhookTimestamp` within 5 minutes. `slack` takes `X-Slack-Signature` over
  `X-Slack-Request-Timestamp`, which must be within 5 minutes, and answers Slack's
  `url_verification` challenge. Every comparison is constant-time.
- **Replays:** `hmac` and `bearer` deliveries carry no signed timestamp, so the listener cannot
  tell a fresh delivery from a captured one. It keeps their body hashes for 7 days (24 hours for
  delivery ids, and for `linear` and `slack`, whose timestamps refuse old ones); a captured
  `hmac` or `bearer` delivery replays once that window has passed. Prefer `linear` or `slack`
  where the sender supports them, and rotate the secret if a delivery may have leaked.
- **The secret** lives in `secrets.yml`, beside the user config (the MCP secrets file: never
  synced, never in a repo). `secret` names it: letters, digits and `_`, in capitals by convention.
  The value must be at least 16 characters; a shorter one counts as unset, since a guessable key
  lets anyone forge a signature. `swarmup validate` checks the name's format, never the value,
  and refuses a value that looks like a token; `swarmup doctor` names hook triggers whose secret
  is missing or too short.
- **Trust:** the trigger hash covers the `webhook` section (verify, secret, header,
  delivery_header and rate), so changing it untrusts the set. A trigger set without webhooks
  keeps the hash it had before.
- **What a delivery does:** by default it files a `finding` in the trigger's store for triage,
  owned by the PM that triages findings (else the store's person), with the payload in a fenced
  block marked untrusted. Only where a person sets
  `swarmupd.hooks.direct.<root>.<name>: true` in the machine's user config does a delivery run
  the trigger's `action` instead: a `run` gets the payload in its prompt, a `workflow` in its plan
  note, a `repeat` in a comment on the task it creates, each only as the same fenced untrusted
  block. A `run` still needs the agent's `wake: true`, an active role file and room under the
  limits; when the action cannot run (paused, limits, an error), the delivery files the finding
  instead, with the reason.
- **The fence:** the block opens with a note that it came from outside and must not be followed
  as instructions. JSON is indented; control, bidirectional and invisible characters (zero-width
  marks, word joiners, the byte-order mark, Unicode tag characters) are dropped; lines that look
  like secrets are removed; the text is cut at 16 KB; and every run of three or more backticks or
  tildes is escaped, so nothing in the payload can close the fence. The fence's info string and
  the closing sentence carry a random nonce (`untrusted-<nonce>`), so a fake closing line in the
  payload, which cannot know it, stands out.
- **Which deliveries count:** see [Inbound webhook triggers](supervisor.md#inbound-webhook-triggers)
  for the listener, the order of its checks, dedupe, the rate limit and the log.
- **By hand:** `swarmup trigger fire <root>/<name> [--payload FILE]` does here what a delivery
  does, without the listener or a signature. `swarmup trigger test <root>/<name> --payload FILE
[--sign]` posts the file to the local listener, signed with the trigger's secret with
  `--sign`, and prints the answer. Both refuse an agent and anyone inside a run.

`swarmup validate` checks each trigger's schema and its targets: the workflow and the repeat must
exist in the store (errors), and the agent should have an agent file or a machine entry (a
warning). A trigger with an error never fires. `swarmup triggers list` prints each trigger, what
it does, and whether and when it fires next on this machine.

`swarmup defs import-schedules [--root NAME]` prints each `swarmupd.schedules` entry as a trigger
file, with `runs_on` set to this machine when the user config names it. `--apply` writes the
files, never over a different one, and `--remove` also takes the schedules out of the user config
and turns on `swarmupd.triggers.<root>`, so nothing fires twice; the new triggers fire once a
person trusts them. A running swarmupd reads the user config again at once, as after
`defs trust` and `triggers on|off`. A schedule on a task of another store is refused.

## Merge checks in git

`swarm.yaml` can keep the commands swarmupd runs on approved work before it moves the base, the
git half of `swarmupd.merge.<root>.checks`:

```yaml
checks:
  test: pnpm test # runs on every merge
  lint:
    run: pnpm lint
    paths: ['**/*.ts', '!docs/**'] # runs only when the merge changes one of these
    description: Lint the code
```

Git never names a command swarmupd runs without the machine's trust (Decision 7):

- The checks run on a machine only after a person runs `swarmup defs trust [--root NAME]` there,
  outside any run. It prints the commands and keeps the hash of the exact set, each check's name,
  command and paths, in the user config as `swarmupd.trusted_defs.<root>.checks`. An agent, or
  anyone
  inside a run, cannot trust them.
- Any change to a command or its paths untrusts the set: merges skip the git checks, and
  `swarmup validate`, `swarmup doctor`, `swarmup defs show`, swarmupd's log and each merge's line
  in `opsd.log` say so, until a person trusts the new set. A change to a `description` keeps the
  trust. `swarmup defs trust --revoke` takes the trust back.
- The machine still wins: a machine that sets `swarmupd.merge.<root>.checks` runs its own list,
  and the git list is recorded as overridden. The git checks need a `swarmupd.merge.<root>` entry
  on the machine, since `base`, `checkout`, `build` and `install` stay machine-only.

## Scorers in git

`scorers/<id>.yaml` keeps a scorer's settings with the store:

```yaml
# scorers/review-rounds.yaml: the built-in scorer of the same name, for this store's work
kind: builtin
pass: 0 # in the scorer's unit and direction; `swarmup scores` lists the defaults
applies_to: # optional; every list that is set must match
  types: [bug, feature]
  labels: [ui] # a task carries one of them
  roles: [engineer] # the role of the agent whose work it is
  workflows: [bugfix] # the workflow its milestone started from
```

- **kind: builtin** sets one of the built-in scorers ([Scores](supervisor.md#scores)): the file
  id names it, or `scorer:` when the file has another name. swarmupd, `swarmup scores` and
  `swarmup report` score the store's work with its `pass`, and only the work `applies_to` takes;
  other stores' work keeps the default. `enabled: false` turns the scorer off for the store's
  work. One file per built-in scorer and store.
- **kind: rubric** names a rubric (`rubrics/<id>.md`, which must exist and read), a `judge`
  (`runtime`, `model`, `effort`; `swarmupd.judge` fills the rest), a `sample` (the share of
  subjects judged, default 1), `pass` (a share from 0 to 1) and `blind` (default true: the judge
  does not see which agent did the work). See [Rubric scorers](#rubric-scorers) for when and how
  swarmupd runs them.
- **The machine wins:** `swarmupd.scorers.<id>.pass` beats the store's `pass`, and
  `enabled: false` there turns a built-in scorer off for every store. For a rubric scorer a
  machine may only lower `sample` (`swarmupd.scorers.<id>.sample`); a higher value is ignored.
- An agent-level scorer (`recommendation-acceptance`, `stuck-runs`) counts an agent across
  stores: it scores once, over the work every store's `applies_to` takes, with the stores'
  `pass` when they agree, else the default.

`swarmup defs scorers [--root NAME] [--json]` lists each scorer file with what this machine uses
of it. Runs may not edit `scorers/`, and a proposal never changes it by default.

### Rubric scorers

A rubric scorer has the [LLM judge](protocol.md#rubric-files) score closed tasks against a
rubric. It spends tokens, so it runs only where a machine takes it on, and one machine judges
each store:

```yaml
# swarm.yaml: the team's limits
scoring:
  scorers: [copy-quality] # optional: the rubric scorers that run; every enabled one when unset
  sample: 0.2 # the sample of a scorer whose file sets none; default 1
  daily_judge_tokens: 200000 # the most tokens a day (UTC) on this store's work; the default
  runs_on: [build-pc] # optional: the one machine (`machine` in its user config) that judges
```

```yaml
# The user config: this machine's consent and its own limit
swarmupd:
  judge:
    scorers: true # the roots this machine merges (swarmupd.merge.<root>); or a list: [site]
    daily_tokens: 100000 # optional: lowers every store's cap, and caps the machine's total
```

- **Who judges:** a machine judges a root when `swarmupd.judge.scorers` is `true` and it merges
  the root, which is one machine per root, or when the list names the root; and, when the store
  sets `scoring.runs_on`, only if that list names the machine. Cap and dedup live in that
  machine's `state.db`, so two machines that both take a store would each spend its cap and
  judge its tasks again: name one.
- **What it judges:** once a minute, swarmupd looks at each store's closed (`done`) tasks that
  the scorer's `applies_to` takes, the role being that of the agent whose work it is. A task is
  in the sample when `sha256("rubric-sample:" + scorer id + "root/ID")`, read as a fraction, is
  under the sample:
  the scorer's `sample`, else `scoring.sample`, lowered to the machine's
  `swarmupd.scorers.<id>.sample`. Each task gets one score, at most five judgments a minute. A
  judgment that gives no score is tried again after 6 hours; one that swarmupd stopped on its
  way down or for an update leaves nothing behind.
- **What the judge reads:** the task's title and body and the diff of its work: from the commit
  its first writing run started at to the commit its last review named, else a merge commit's
  first parent to the merge. Rubric scorers give the judge only these `task` and `diff` inputs:
  a rubric's `repo` and `files` stay empty, and `swarmup validate` warns about them. Blind (the
  default), every agent id of the machine's runtimes (`claude:engineer`) and its slug
  (`claude-engineer`) is replaced in both with "an agent", and each runtime's name as a word, in
  any case, with "a runtime"; with `blind: false` the task text names the agent. The judge
  is `swarmupd.judge` with the scorer's `judge` over it, and the rubric comes from the store's
  definitions.
- **The cap:** before each judgment swarmupd estimates its tokens on the high side (the prompt at
  3 characters a token, plus 2,000); it stops for the day for a store when the store's spend would
  pass `daily_judge_tokens`, and for every store at the machine's `daily_tokens`. A judgment then
  counts the tokens the runtime reports, else the estimate, so a day can end at most one judgment
  over the cap. Failed tries count too. Judging also waits while the judge's runtime is paused for usage or signed out.
- **The result:** each judgment is a row of `rubric_judgments` in `state.db`, with its tokens. One
  that gives a score is a task score row like a built-in scorer's: the scorer's id, the score as a
  share, `pass` against the scorer's `pass` (default 0.7), the criterion scores in `extra`, the
  judge's reasons in `note`, and the work's `defs_hash`, `variant` and `experiment`.
  `swarmup scores`, `swarmup report` (the rows of the window's tasks, by the closing event's time)
  and the app list it after the built-in scorers, and `--by-variant` splits it.
- `swarmup defs scorers` shows a rubric scorer as `on`, or why it is off here.

## Precedence

More specific beats less specific, and at equal specificity the machine beats git:

- **Model and effort:** the machine agent (`swarmupd.agents.<id>`), then the agent file's
  `runtimes.<rt>`, then the agent file, then the machine runtime (`swarmupd.runtimes.<rt>`), then
  `swarm.yaml` `runtimes.<rt>`, then `swarm.yaml` `defaults`.
- **Roles:** each key of `swarmupd.roles.<role>` wins over the same key in `swarm.yaml`; the
  built-in defaults fill what neither sets. An agent file's `writes` sits between the two.
- **Budget:** the `--budget` flag, then the delegation, then the machine agent
  (`swarmupd.agents.<id>.budget`), then the agent file's `budget_min`, then `budget_minutes` in
  the user config when it sets it, then `swarm.yaml` `defaults.budget_min`, then
  `policy.budget_minutes`, then 180.
- **Policy:** a top-level key the user config sets, then `swarm.yaml` `policy`, then the built-in
  default.
- **Merge checks:** `swarmupd.merge.<root>.checks` when the user config sets it, then the trusted
  `swarm.yaml` `checks`, then none.

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

### Definitions at a git ref

A run or a benchmark can also use the store's definitions as a git ref had them, such as a tag or
last week's commit: `swarmup launch AGENT --task ID --defs-ref REF` (`defs_ref` in
`POST /api/runs`) or `swarmup bench run ... --defs-ref REF --root ROOT`. The definition files are
read with `git show` into a snapshot, the way a variant's overlay is put together; nothing is
checked out, and swarmupd reads the ref off the event loop before the launch.

- The run gets the role file as the ref had it in its scratch folder, like a variant run.
- A variant or a ref changes the instructions, model and effort, never what the agent may do:
  `tools`, `mcp`, `writes` and `can_claim` always come from the store's own agent, and swarmupd
  warns when the variant or the ref sets them differently. A run (its token) cannot start a run
  with `variant` or `defs_ref`; that is a person's choice.
- Its definition stamp holds the snapshot's hash, `ref` and the `commit` the ref named, and its
  `run-start` event carries `defs_ref`. swarmupd keeps the snapshot's files in the `definitions`
  table of `state.db` under that hash.
- A run takes `--variant` or `--defs-ref`, not both, and an experiment never picks a variant for a
  run with a ref.

### Variants from a git ref

`variants` in `swarm.yaml` names variants. An entry with `from_ref` is a variant whose definitions
are the store's definitions at that ref, so you can give an older or another branch's team a name
and use it wherever a variant name goes: `swarmup launch --variant`, `swarmup bench run --variant`
and `experiments`.

```yaml
variants:
  as-v1: # a variant of the definitions as tag v1 had them
    from_ref: v1
    description: The team before the review checklist
  tests-first: # describes the folder variants/tests-first/
    description: Write the test first
```

- The ref is read with `git show`, as `--defs-ref` reads it; nothing is checked out. swarmupd
  reads each `from_ref` off the event loop every tick, again only when the commit it names moves,
  so a launch or an experiment that picks the variant runs no git.
- A run of a `from_ref` variant carries `variant`, and its definition stamp the snapshot's hash,
  `ref` and `commit`. `tools`, `mcp`, `writes` and `can_claim` still come from the store's own
  agent, as for `--defs-ref`.
- `description` without `from_ref` describes the folder `variants/<name>/`.
  `swarmup defs variants` shows the description, and for a `from_ref` variant the ref, its commit
  and the files that differ from the base.
- `swarmup validate` reports a `from_ref` git cannot read, and a name that is both a folder and a
  `from_ref` variant, as errors, and an entry with neither as a warning. A `from_ref` variant has
  no folder, so it is never proposed, promoted or rejected.

### Experiments

An experiment runs a variant on a share of the real work, so you can compare it with the base on
the same kind of tasks:

```yaml
experiments:
  - id: tests-first-trial # with the task, fixes which side a task lands on
    variant: engineer-tests-first # variants/engineer-tests-first/ must exist
    share: 0.5 # the share of matching tasks that run the variant, 0 to 1
    scope: { roles: [engineer], types: [bug], labels: [api] } # optional; every list must match
    until: 2026-12-31 # optional: the last day it runs, in UTC
    description: Does writing the test first cut review rounds?
```

- swarmupd picks a task run's definitions in this order: the variant named with `--variant`
  (`swarmup launch`, `variant` in `POST /api/runs`) or a `--defs-ref`, then the first active
  experiment whose `scope` takes the run, then the base. `scope` takes `agents`, `roles`, `types`
  and `labels` (a task carries one of them).
- The side is deterministic: the task lands on the variant when
  `sha256("experiment:" + id + "root/ID")`, read as a fraction from 0 to 1, is under `share`. It is also sticky: a task whose earlier `run-start`
  names the experiment keeps the side it had, even after `share` changes.
- The run record and the `run-start` event carry `experiment` on both sides, and `variant` on the
  variant side, so the base side of an experiment is the work it took that ran without a variant.
- A variant that does not check, or that has no active role file for the agent, puts the run on
  the base side of the experiment, recorded, so the task stays there; swarmupd warns once. A store
  whose `swarm.yaml` does not check runs no experiment.
- A machine with `swarmupd.experiments: false` runs the base for every run it starts without
  `--variant`.
- `swarmup scores --by-variant` (and `GET /api/scores?by_variant=1`) splits each agent's task and
  run scores by the variant its work ran with, the base first, so you can read an experiment.
  Agent-level scores count all of an agent's work and stay out of the split.

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
- `defs promote NAME [--root NAME] [-m NOTE] [--force]` is for a person only. It writes the
  variant's result onto the base files, records a `defs-promote` event with the hashes before and
  after (`defs_from`, `defs_to`) on the linked task, and removes the variant's folder. A variant
  that no longer checks against the base is refused, and so is one that doesn't meet
  [`improvement.requires`](#improvement-policy). `--force` promotes it anyway, and the event says
  so.
- `defs reject NAME [--root NAME] -m WHY` is for a person only. It records a `defs-reject` event
  with the note on the linked task and removes the folder. The base files don't change.
- `defs rollback NAME [--root NAME] -m WHY [--force]` is for a person only. It puts back the files
  the last promote of `NAME` changed, as they were before it, and records a `defs-rollback` event
  with the note and the hashes on the proposal's task. Promote keeps what it changed in
  `variants/.promoted/NAME.json`. A file changed after the promote is refused, since the rollback
  would drop that change, unless you pass `--force`. A promote rolls back once.
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
  frozen: ['scorers/**', 'benchmarks/**', 'rubrics/**', 'triggers/**', 'swarm.yaml'] # the default
  max_open_proposals: 2
  requires:
    benchmark: true # a finished benchmark of the variant before promote; default false
    min_delta: 0.05 # the least pass-rate gain, variant minus base; default 0
```

- Every path a proposal changes must match a `may_change` glob and no `frozen` glob; `frozen`
  wins. `*` stays within one folder, `**` crosses folders.
- An agent's `tools`, `mcp`, `writes`, `can_claim` and `id` are always frozen, whatever the policy says,
  and a proposal never removes an agent file. A person changes those by hand.
- With `improvement.requires.benchmark: true`, `defs promote` refuses a proposal until swarmupd's
  benchmark gate (`swarmupd.improve.benchmark`, in [the supervisor](supervisor.md)) has run the
  variant as proposed and recorded the result in its `proposal.json`. It refuses when the
  benchmark failed, when the variant changed after it ran, or when the pass rate gained less than
  `min_delta` (from -1 to 1; 0.05 is 5 points, and the default 0 means no worse than the base).
  `human_approval` accepts only `true`: promote is always a person's step.

## Commands

- `swarmup validate [PATH...] [--root NAME] [--strict] [--json] [--write-schemas]` checks each
  root, or the files and stores named. It prints `file:line:col: severity: path: message` and
  exits 0 when there are only warnings, 1 on errors or, with `--strict`, on warnings, and 2 on bad
  input. Under `--strict` an unknown key is an error. A problem across files, such as a trigger's
  workflow or a scorer's rubric that is missing, points at the key that names it.
- `swarmup defs show` prints each root's hash and what its `swarm.yaml` sets under this machine's
  config, with the machine keys that overrode it.
- `swarmup defs hash` prints the full hash of each root.
- `swarmup defs scorers [--root NAME]` lists the scorers in git; see
  [Scorers in git](#scorers-in-git).
- `swarmup defs trust [--root NAME] [--revoke]` trusts the merge checks of each root's
  `swarm.yaml` on this machine; see [Merge checks in git](#merge-checks-in-git).
- `swarmup defs diff [REF]` lists the definition files that changed since a git ref, `HEAD` by
  default, with both hashes.
- `swarmup defs migrate [--apply] [--prune]` moves legacy agent files into agent folders; see
  [Migrate legacy files](#migrate-legacy-files).
- `swarmup triggers list [--root NAME] [--json]` lists the triggers, with whether and when each
  fires next on this machine; `swarmup triggers on|off --root NAME [--trust]` turns a root's
  triggers on or off here, and `on` lists what would fire; `--trust` also trusts that set. `swarmup defs import-schedules [--apply] [--remove]` moves `swarmupd.schedules` into
  `triggers/`; see [Triggers](#triggers).
- `swarmup workflow list|show|start` lists, shows and starts the store's workflows; see
  [Workflows](protocol.md#workflows).
- `swarmup defs import-config` writes the user config's `swarmupd.runtimes.*.{model, effort}` and
  `swarmupd.roles.*` into `swarm.yaml`, keeping its comments, and prints the change. The user
  config keeps those keys, so this machine still overrides them, unless you pass `--remove`,
  which a running swarmupd reads at once.
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

**Automation**, next to **Schedules**, lists each project's triggers and merge checks with where
this machine's consent and trust stand, and does what `swarmup triggers on|off` and
`swarmup defs trust [--revoke]` do after a review of the exact set the hash covers. It also turns
the inbound listener on and approves direct webhook actions. See
[the desktop app](desktop.md#automation).

The role editor (**Agents**, **Role file**) edits a folder agent's `agent.md` (**The writer
role**) or its runtime's addendum (**Only codex**), and lists the agent's run settings with where
each comes from: **this machine**, **swarm.yaml** or **role file**. `GET /api/roles/:id` gives a
folder agent's `layers` (`role` and `runtime`, each with `data` and `instructions`) and every agent's
`settings`; `POST /api/roles` takes `scope: role | runtime`.

`GET /api/defs` gives each root's `text` of `swarm.yaml` and `values`: each key the git
definitions set, with `value`, `source` (`git`, `machine` or `unused`), the `git` value and the
`root`. The writes are `POST /api/defs/import` with `{ root }` for a preview and
`{ root, write: true, expect }` to write the previewed text, `POST /api/defs/create` with
`{ root }`, and `POST /api/defs/save` with `{ root, text, expect }`. Each checks the result first
and refuses a file that changed since `expect` was read. `POST /api/defs/validate` with `{ root }`
checks a whole root under this machine's config.
