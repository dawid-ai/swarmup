# Changelog

SwarmUp keeps tasks, events and decisions as files in git. Notes for people who use the app are
in [UPDATES.md](UPDATES.md); this file lists every change.

Unreleased changes are in [`changelog.d/`](changelog.d/README.md). `scripts/fold-changelog.mjs` folds
them in at release time (see [RELEASING.md](RELEASING.md)).

## 0.3.0-beta.21 (2026-11-23)

### Added

- Merge checks in git: `swarm.yaml` `checks.<name>` keeps the commands swarmupd runs before it
  moves the base. They run on a machine only after a person there runs `swarmup defs trust`, which
  keeps the hash of the exact command set in `swarmupd.trusted_defs.<root>.checks`; any change to a
  command or its paths skips them again until trusted, with a warning in `swarmup validate`,
  `swarmup doctor` and the merge log. A machine's own `swarmupd.merge.<root>.checks` still wins.
- Scorers in git: `scorers/<id>.yaml` sets a built-in scorer's `pass` and `applies_to` (types,
  labels, roles, workflows) for a store's own work, under the machine's `swarmupd.scorers`.
  Rubric scorers (`kind: rubric`, with a rubric, judge, `sample` and `blind`) are checked and
  listed by `swarmup defs scorers`, but not run yet; a machine may only lower their `sample`.
  Runs may not edit `scorers/`.
- Git triggers: `triggers/<name>.yaml` in a task store starts a run, a workflow or a repeat's task
  `every` interval, `at` a daily time or on a five-field `cron` in local time. A machine runs a
  store's triggers only after `swarmupd.triggers.<root>: true` (`swarmup triggers on --root NAME`)
  and after a person trusts the exact trigger set there (`swarmup defs trust`); any change stops
  them until trusted again. Only triggers whose `runs_on` names the machine fire, and a `run`
  trigger needs the agent's `wake: true` there; each fire time starts once, across restarts.
  `swarmup triggers list` shows when each fires next here, `swarmup validate` checks their targets,
  and `swarmup defs import-schedules` moves `swarmupd.schedules` into trigger files.
- Plan items and workflow stages take `labels`, such as `labels: ['publish:{{where}}']`, so a
  publish task a workflow files names its publish adapter without `--adapter`.

### Changed

- **Publish now** lists the files and commit it sends, the same ones **Preview** shows, and
  publishes exactly those. A base branch that moved, a changed `publish:` label or a new task it
  waits on can no longer change what goes out between the preview and the publish.

### Fixed

- `page-contains` refuses a loopback, private or link-local address also when the connection
  resolves the host, so a DNS answer that changes after the check can't reach this machine or
  its network.

## 0.3.0-beta.20 (2026-11-23)

### Added

- `swarmup ask --reason direction|access|irreversible|external` says why only a person can answer.
  The `escalation-correctness` score counts such an ask as right, and now scores each agent by the
  share of its asks that were right instead of all or nothing.
- **Run benchmark** in the app takes a **Cost cap (USD)**. The **Benchmarks** view marks costs
  estimated from tokens with `~`, shows the pass-rate spread over repeats, and says whether the
  cost cap stopped a run.
- `swarmup bench run` estimates the cost of Codex attempts from their tokens at the model's price per million tokens, with built-in prices for `gpt-5.6-sol`, `gpt-5.6-terra` and `gpt-5.6-luna` that `swarmupd.bench.prices` overrides. Estimated costs show with a `~` in `summary.md` and `bench compare`; a model with no price leaves the cost empty and the summary says so.
- With `--repeat` above 1, the bench summary reports the spread over attempts: the lowest and highest pass rate, its standard deviation, and the standard deviation of cost, per entry and over repeats.
- `swarmup bench run --max-usd X` starts no further attempt once the run's agent and judge cost reaches `X`. The summary lists the attempts it did not start and says the cap was reached; attempts with unknown cost are not counted, with a warning.
- `swarmup defs rollback NAME -m WHY` puts back the agent and workflow files a promote changed,
  and records it on the proposal's task. It refuses when a file changed after the promote, unless
  you pass `--force`.
- A new finding whose title nearly matches another task of the store, open or closed, names that
  task as a possible duplicate in its body, and `swarmup finding` prints a note. The finding is
  filed either way, and the PM decides.
- `improvement.requires` in `swarm.yaml` is now active: with `benchmark: true`, `swarmup defs
  promote` waits for swarmupd's benchmark of the variant as proposed, and refuses it when the
  benchmark failed, the variant changed since, or the pass rate gained less than `min_delta`.
  `--force` promotes it anyway and records that on the task.
- Learn notes that keep mattering can become rules in a role file. `swarmup kb --promote` lists
  the notes shown in many run prompts, read often or learned again, with why and the agents they
  are for. With `swarmupd.improve.notes: true`, swarmupd files an `improve` task for the improver
  to fold them into the agent's role file as a proposal; **Fold into role** in the Knowledge view
  files it on request. After `swarmup defs promote`, a person archives the folded notes with
  `swarmup kb archive TOPIC/SLUG... -m "why"` (or **Archive** in the app), which moves them to
  `kb/.archive/`, where search and run prompts skip them.
- A `page-contains` check fetches the published page after `swarmup published` and checks it
  holds every string of `contains` and none of `absent`:
  `{ check: page-contains, args: { from: published, contains: github.com/you/repo }, when: publish }`.
  It takes `url` for another page, waits 15 seconds at most, reads the first 2 MB, and is refused
  without `when: publish`. It never fetches a loopback, private or link-local address, checked
  again at each of at most 5 redirects.
- A `post-approval-edits` score: the share of words you changed between the approved text and
  what you published, counted for the writer of the approved task and pointing at its role file.
  Publish records now carry these `edits`.
- Publish adapters: define `swarmupd.publish.<root>.<name>` (`manual`, `command` or `mcp`), give a
  publish task the label `publish:<name>`, and run `swarmup publish ID` or **Publish** in the task
  panel. The adapter gets the approved files, runs once for the same files and blobs unless
  `--again`, and the `url: <URL>` it prints becomes the publish record. A `command` adapter gets
  the files and `SWARMUP_PUBLISH_*` variables; an `mcp` adapter calls a tool on a `publish: true`
  MCP server. Agents and runs can never start one.
- `swarmup preview ID` renders a publish task's approved Markdown, with the images it names
  from the workspace, into one local HTML page that runs no script, for a last look before
  publishing. The task panel's **Preview** shows the same files (`GET /api/tasks/:id/preview`).
- A `readability` check scores the prose of Markdown files with the Flesch-Kincaid grade level:
  `{ check: readability, args: { path: 'posts/*.md', max_grade: 9 } }`, with `min_grade` for a
  floor. The formula and the syllable rule are pinned, so every machine gets the same grade. The
  desktop criteria builder has **Max grade** and **Min grade** fields for it.
- A `verdict-completeness` score grades each agent reviewer by the share of a task's prose
  criteria its approval marks `pass`, `fail` or `na`, and names the ones it left unmarked.

### Changed

- The PM role template now tells the PM to write a goal brief for each milestone and parent task
  and to refresh the ones its inbox run lists. Stores you set up before keep their PM file; copy
  the **Goal briefs** section from the template to adopt it.

## 0.3.0-beta.19 (2026-11-22)

### Added

- Agent folders: `agents/<role>/agent.md` defines a role once for every runtime it runs on, and `agents/<role>/<runtime>.md` adds what one runtime does differently (`body: replace` swaps the instructions). Legacy `agents/<runtime>-<role>.md` files keep working and win over a folder for the same id, with a warning from `swarmup validate`.
- `swarmup defs migrate` prints the folders that would replace your legacy agent files; `--apply` writes them and `--prune` also removes the legacy files. It refuses unless every agent comes out with the same fields, and logs to `migrations.log`.
- Team policy in `swarm.yaml`: `policy.review_rounds`, `stuck_runs`, `review_backlog`, `review_fallback_hours`, `plan_check_minutes`, `budget_minutes` and `test_changes`, and `defaults.budget_min`. A key your user config sets still wins, even at its default value.
- An agent file's `writes` now sets its role's `writes`, under the machine's `swarmupd.roles.<role>.writes`.
- The role editor in the app edits a folder agent's `agent.md` or only its runtime's file, and lists each run setting with where it comes from: this machine, `swarm.yaml` or the role file.
- Workflows: `workflows/<id>.yaml` in the task store is a repeatable milestone plan with parameters (`{{name}}`), stages, `when` conditions, default criteria per type and human gates. `swarmup workflow list|show|start` and `swarmup plan propose ID --workflow W --param k=v` use them; a person's start of a workflow with `approval: starter` approves it at once.
- Gates: a plan item of type `gate` waits for a person, who approves it with `swarmup done` or rejects it with `swarmup park` (parking the stages after it, or with `on_reject: revise` reopening the work before it). The app shows gates in the Inbox under **Gates** with **Approve** and **Reject**, and in a milestone's plan.
- Starter workflows `feature`, `bugfix`, `content-piece` and `campaign-launch` ship as templates; `new-project` copies the ones that fit its template, and **New task** in the app has **Start a workflow**.
- `work_types` in `swarm.yaml` give a task filed without `--done-when` its default criteria, and name the workflow that fits.

### Fixed

- The app downloads an update again, after 15 seconds, 1 minute and 5 minutes, when antivirus or
  another program locks the downloaded installer. Before, the update stopped with an `EPERM` error
  until you checked again in **Settings > Updates**.

## 0.3.0-beta.18 (2026-11-22)

### Added

- New checks for `done_when`: `image-alt` (every Markdown or HTML image has alt text) and `image-size` (each PNG or JPEG has the given width and height, and with `max_kb` a size limit). `char-count` takes `urls_as: 23` to count each link as X does.
- **Mark published** in the task panel of a `publish` task you own records the URL, and optionally the file, as `swarmup published` does.
- Content projects: `swarmup new-project --template campaign` (or `content`) starts a campaign or a blog with a brand voice, a claims file, three rubrics, a calendar, a project map, an editor role and first tasks with typed criteria. `--store` keeps the tasks in a folder apart and registers the root, as `swarmup adopt --store` does.
- New checks for `done_when`: `char-count` (per file, line or block, such as 280 characters per post of a thread), `contains` (all, any, or none for banned words), `heading-structure` and `front-matter`. Every check's `path` now takes globs, and checks each file that matches.
- `content` and `publish` task types. A `publish` task belongs to a person, and `swarmup published ID --url URL` records a publish: it tags the commit `published/<ID>`, closes the task and runs its `when: publish` criteria.
- Review artifacts: `swarmup review --artifact PATH|URL` names the work to read (by default, the files the commit changed), `swarmup artifact ID` prints it at the reviewed commit, and the review prompt lists it.
- The task panel's **Work** section shows the reviewed Markdown at its commit, with a word-level diff against the base and images inline.
- MCP servers on roles: a role file's `mcp` now gives its runs the servers this machine defines in `swarmupd.mcp.servers` and grants to the project and agent. Secrets live in `secrets.yml` next to the user config and reach only the server's environment, through `swarmup mcp exec`, which also filters tools by allow and deny rules and logs each call's tool name to `mcp.log` in the run's scratch folder. Claude runs get `--mcp-config` and `--strict-mcp-config`; Codex runs get `-c mcp_servers.<name>` overrides. A server marked `publish` is never granted to a role.
- **Settings > MCP servers** lists, adds, edits and removes servers, sets or replaces secrets without ever showing them, and shows each agent's asked-for and granted servers. `swarmup validate` and `swarmup doctor` warn about role `mcp` names this machine does not define.

### Changed

- A root's `workspace_types` in `config.yml` sets which task types get a task worktree and must be committed before review; it defaults to `task`, `bug` and `feature`, as before.
- Runs can no longer edit a task store's `rubrics/`, `workflows/` or `triggers/`, next to `agents/` and `variants/`.

### Fixed

- A definition proposal can no longer change an agent's `mcp` servers; like its tools, a person changes them by hand.

## 0.3.0-beta.17 (2026-11-22)

### Added

- `swarmup adopt --apply` and `swarmup new-project` name the new roles that start no run on their own until you turn on Wake for them.
- An LLM judge scores `rubric` criteria against their rubric file (frontmatter `id`, `scale`,
  weighted `criteria`, `inputs`; a body with the judge's instructions). The judge is one
  read-only model call with no tools and everything in the prompt; it answers with JSON, and the
  weighted total, normalized to 0 to 1, passes at the criterion's `pass`. Configure it in
  `swarmupd.judge` (`runtime`, `model`, `effort`, `budget_min`; default Claude, `sonnet`, `low`,
  5 minutes).
- `swarmup bench run ... --judge` judges each attempt's rubric criteria, and
  `swarmup bench judge RUN-DIR` judges a finished run's pending ones. Judged rubric criteria count
  in the pass rate; the summary gains a **Judged** column and the judge's cost.
- `swarmup criteria judge ID` judges a task's rubric criteria against its branch diff and records
  the results in a `criteria-check` event with `by: judge`. The desktop app's task panel has a
  **Judge** button next to **Run checks**, and shows each judged score and its reasons.
- With `swarmupd.judge.at_merge: true`, swarmupd judges rubric criteria at merge after the
  `command` and `check` criteria pass, and sends the task back when one scores below its `pass`.
  Off by default: each judgment spends tokens.
- Variants: a sparse overlay folder `variants/<name>/` in a task store changes the definitions
  for the runs and benchmarks that ask for it. YAML deep-merges (maps merge, lists replace, `null`
  deletes), agent frontmatter merges the same way, a non-empty body replaces the instructions, and
  each variant has its own hash. `swarmup validate --variant NAME` checks one. A run started with
  a variant reads its resolved role file from its scratch folder and records the variant.
- Proposals: `swarmup defs propose ID --dir DIR --name NAME -m WHY` records an overlay on a task
  as a variant, after checking it against the store's improvement policy (`improvement.may_change`
  and `frozen` in `swarm.yaml`; an agent's `tools`, `writes`, `can_claim` and `id` are always
  frozen) and the cap on open proposals (`max_open_proposals`, default 2). A person runs
  `swarmup defs promote NAME` to write it onto the definitions or `swarmup defs reject NAME -m WHY`;
  `swarmup defs variants` lists them. Each step is a `defs-propose`, `defs-promote` or `defs-reject`
  event on the task.
- The improver: a `claude:improver` role template that turns an agent's failing scores into one
  small proposal. It runs read-only and may edit only in its scratch folder. With
  `swarmupd.improve.enabled: true` (off by default), swarmupd files an improvement task when an
  agent has `threshold` distinct failing task and run scores in `max_age_days` days.
- The benchmark gate: with `swarmupd.improve.benchmark` set, swarmupd replays the set with the base
  and with each new proposal's variant and comments the comparison on its task. Off unless set: it
  spends tokens. `swarmup bench run` takes `--role-file` and `--variant` with `--root` to put an
  agent's role file in each prompt.
- The desktop **Agents** view lists proposals with their diff, the scorers they address and their
  benchmark, with **Promote** and **Reject**. A failing scorer offers **Propose an improvement**.

### Fixed

- `swarmup adopt` finds Python tests written with `unittest` and proposes `python -m unittest` as the test command, instead of reporting no runner.
- `--done-when` and `swarmup criteria --add` take a typed criterion written as block YAML over several lines (with a `kind:` key) as one criterion, instead of one text criterion per line.

## 0.3.0-beta.16 (2026-11-21)

### Added

- `swarmup bench run SET.yaml --repo DIR` replays the entries of a benchmark set against an agent
  configuration: each attempt gets a throwaway worktree at the entry's base, a non-interactive
  Claude or Codex run with swarmupd's command line and a time budget, and a score of its
  `done_when` criteria, with hidden acceptance tests copied in only while they run. It writes
  `results.json` per attempt and a `summary.json` and `summary.md` table with pass rate, hidden
  pass, cost, time and tool calls before the first edit. `--reference-dir` and `--agent none`
  check the harness without spending tokens. `swarmup bench compare A B` prints the deltas between
  two runs. See `docs/benchmarks.md`.
- A task store can keep the team's runtime models and efforts and its role limits in
  `swarm.yaml`, versioned in git; each machine's user config still wins. `swarmup validate` checks
  it and the agent files with line and column, `swarmup defs` shows, hashes and diffs it and imports
  it from the user config, and each run records which definitions it started with. A store without
  `swarm.yaml` works as before.
- The task panel shows each criterion's kind, spec and last result (score, note, evidence, who
  and when), edits criteria with a builder per kind (a `criteria` event), and runs the `command`
  and `check` criteria with **Run checks**, with each result as it lands. **New task** has the
  same builder.
- A review in the task panel or the Inbox gives pass, fail or n/a per criterion with notes; an
  approval with a failed criterion asks first and is recorded as forced.
- Milestones and parent tasks show their goal brief with **Edit** and a hint when children closed
  since it; the thread shows `brief`, `criteria` and check events, and **Resumed** on runs that
  resumed a session.
- The task panel lists the task's scores, with pass or fail and what to change on hover.
- **Settings > Definitions** shows each project's `swarm.yaml`: the definition hash and commit,
  the value swarmupd runs with for each key and whether it comes from git or your user config,
  and the problems, with their lines marked in a view of the file. **Validate**, **Import from my
  settings** (a preview, then a write; your user config keeps its keys), **Create swarm.yaml** from
  the template, and **Edit** with checks as you type.
- A **Benchmarks** view lists benchmark sets and runs, shows a run's attempts with each
  criterion's result, cost, time, diff and agent log, follows a run under way, and compares two
  runs with deltas. **Run benchmark** shows the plan of a dry run first and starts an agent run
  only after you confirm its cost; reference and no-agent runs cost nothing. Sets come from each
  project's `.swarmup/benchmarks/` and the new `swarmupd.bench.sets` key.
- `swarmup bench run` keeps a `status.json` in its out folder with the run's state and progress.
- Map view in the desktop app: browse a project's map by kind or as a tree, search by words or by
  a file path, read a node with its covers and links, run the check with a health badge in the
  header, rebuild `_INDEX.md`, and create a map for a project that has none. swarmupd serves it at
  `/api/map`.
- The **Agents** view shows each agent's scores: per scorer the value, count, pass rate, pass or
  fail, a 30-day trend, what to change when it fails, and the worst tasks as links. **Reports**
  adds a trend per scorer, the worst tasks per scorer and what each scorer measures on hover.
- The **Runs** view shows the model, effort and definition stamp a run started with, a
  **resumed** badge with the run it resumed from, and its orientation (tool calls before the first
  edit). Filter the list to resumed runs or one model.
- `GET /api/scores/history` serves each agent's score trend; `GET /api/scores?task=` adds the
  orientation of the task's runs and a `scorers` list with each threshold and lever.

## 0.3.0-beta.15 (2026-11-21)

### Fixed

- `swarmup map --file` reads a Windows-style path (`..\docs\guide.md`) the same way on Linux and macOS.

## 0.3.0-beta.14 (2026-11-21)

### Added

- Project map: `swarmup map` finds, shows and checks linked Markdown nodes in `.swarmup/map/` that
  say what each part of a project is for. Task runs get the root summary and the nodes that match
  the task in their prompt, and are asked to keep the nodes true; `swarmup map check` can gate
  merges. See `docs/map.md`.
- A task run's prompt quotes the task text, its recent thread and its parents, so the agent no
  longer spends its first tool calls on `swarmup show` for the task, its parent and its milestone.
- A milestone or parent task can carry a goal brief (`swarmup brief ID --body-file -`; the newest
  wins). Runs on its children read it in their prompt, and the PM's inbox runs list the briefs
  whose children closed since they were written.
- A task that comes back with `changes` resumes the session of the run that did the work, for
  Claude and for Codex runs in a task worktree (`swarmupd.resume_on_changes`, on by default; up to
  `resume_max_hours`, 24, after that run). `scripts/orientation.mjs` reports how many tool calls
  runs make before their first edit.
- The **Runs** view has the same **Range** buttons as **Replay** in its header: **Day** (the
  default), **Week**, **30 days**, **90 days** and **Custom** with **From** and **to** dates. The
  list, the filter counts and the run, token and error stats cover the runs that were running in
  the range; **Live now** still counts every live run. `GET /api/runs?limit=` takes `start` and
  `end` ISO times for the range.
- `swarmup scores` grades agents from what SwarmUp already records: review rounds, merge failures,
  tokens per merged task, human touches, escalations, recommendations taken, stuck runs and tool
  calls before the first edit, with the worst tasks per scorer. `swarmup report` and the
  **Reports** view show each agent's scores for the window, and swarmupd keeps them in `state.db`.
  Thresholds are set under `swarmupd.scorers` in the user config.
- `done_when` takes typed criteria besides plain text: `command`, `check` (`file-exists`, `regex`, `word-count`, `links-resolve`, `url-ok`), `rubric`, `human` and `map`, each with an id. `swarmup show` prints them as a table with each one's last result, and the task panel lists them.
- `swarmup verdict` gives a result per criterion with `--criteria-file`, `--pass ID` and `--fail ID:"note"`; an approval with a failed criterion needs `--force`.
- `swarmup criteria ID --set-file F | --add C` changes a task's criteria with an event, and `swarmup criteria check ID` runs its `command` and `check` criteria.
- swarmupd runs a task's `command` and `check` criteria at merge, after the configured checks, and sends the task back when one fails.
- A root can set `require_checkable_criteria: true` so `swarmup new` refuses work with only prose criteria; without it, `swarmup new` prints a note.

### Fixed

- A **Custom** range in **Replay** and **Activity** runs from local midnight of the **From** day to
  local midnight after the **to** day. It used to start and end at UTC midnight, shifted by the
  local time offset. A **to** date before **From** asks nothing and says what to pick.
- Scratch cleanup keeps the run scratch folder that Git Bash mounts as `/tmp`, and makes it again when an older build removed it. Removing it made every Git Bash on the machine warn "could not find /tmp", and git hooks wrote that warning into stderr.
- Keep images pasted into a new task with that task's chosen project, including when the project changes before creation.
- The PM chat can read releases, tags, PRs and CI runs: every chat turn gets read-only
  `gh release list|view`, `gh pr list|view|checks`, `gh run list|view`, `git tag -l`,
  `git describe` and `git -C <dir> log|show` on top of its role file's `tools`, so an older role
  file no longer blocks them. The `claude:pm` template lists the same commands for its other runs.

## 0.3.0-beta.13 (2026-11-21)

### Added

- **Activity** has the same **Range** buttons as **Replay**: All time, Day, Week, 30 days,
  90 days or a custom from–to. The feed shows only the events in that window, and the app
  remembers your choice.
- The **Model** field on an agent card has a row of its own, so long names such as
  `gpt-5.5-codex-high` show in full.
- A merge check in `swarmupd.merge.<root>.checks` can name the paths it checks, as
  `{ run, paths }`. A merge runs it only when the work changes one of those paths, so a task that
  changes only Markdown, copy or assets skips the code checks. The `merge` event lists the checks
  it did not run.

### Changed

- swarmupd keeps a run's scratch folder 2 days after the run instead of 7 (`scratch_days`): two weeks of runs had filled 15 GB. It also says in its log when anything held it for more than 2 s, so the app's calls waited, and what it was doing then.
- swarmupd reads its run records from `state.db` instead of re-reading every run file, and keeps a merge check's one retry after a timeout across a restart or update.

### Fixed

- swarmupd cleans up after itself: run logs, process ledgers and merge logs go after `log_days` (14), swarmupd's log starts a new file past 10 MB at the next start, and the worktree of a closed task whose work is already merged no longer waits for a merge that never comes.
- A custom date range in **Replay** and **Activity** now includes its **to** day: before, the range stopped at the start of that day.
- Starting a run from the app in a folder swarmupd has not used yet no longer holds swarmupd while git reads that checkout.
- Send work back at once when a merge check times out after it printed a failed test, instead of merging it once more and then asking the human to raise the time limit.
- **New task** holds its fields still while the task is being created, so a change made while swarmupd answers, such as an owner picked during the wait, is not silently left out.
- Reports open faster: a weekly report reads only the tasks that changed in its window, and opening the same report again reuses what it read. The app no longer freezes while a report builds, and Reports shows that it is building the report until it is ready.
- `swarmup review` records the HEAD commit, branch and repo of the checkout it runs in on the review, and swarmupd's merge reads them before the review's wording. Approved work no longer misses `main` because the request phrased `<commit> on branch <name>` its own way. `--commit` and `--branch` override the checkout.
- An approved review sent from the task store's own repo closes with "nothing to merge: store work, synced" instead of a "not in main" finding, and the tasks waiting on it go on.
- swarmupd no longer freezes for a minute or more while it cleans up old scratch folders it cannot delete (files a Codex sandbox session made): it removes them in the background, warns once about each folder it cannot remove and tries it again a day later. The app's calls, such as **Create task**, no longer wait for it.
- An approved task whose work is a commit in a separate task store repo now gets a "nothing to merge" note instead of a finding that its work is not in the code's main branch, and the tasks waiting on it go on.
- The Tasks list now shows done and parked tasks when you pick that status, even with **Include closed and archived** off, and a project in the sidebar shows its tasks when they carry another project name.
- The Board's Done column has a dropdown to show 20, 100, 250 or all done tasks, remembered on this machine, and its header counts every done task instead of only the 20 shown.
- A report or replay for the last days now includes what happened in its very last moment: an event from the moment the report was asked for was left out.

## 0.3.0-beta.11 (2026-11-20)

### Added

- swarmupd keeps its own state on this PC in `state.db`, a SQLite file in its state folder for every project: each merge attempt with how it ended, and each run record. `GET /api/merges` lists the attempts and counts them by outcome. Node 22.13 or later is needed.

### Changed

- A merge check that times out no longer sends approved work back to its author. swarmupd runs the checks once more with twice the time and no new agent run beside them; when they time out again, the work stays approved and the root's human gets a note on raising `timeout_minutes`.
- A paused swarmupd starts no new merge of approved work either, so you can work on the base without it moving; a merge under way finishes.
- `swarmup review` records the commit and branch it names: from `--commit` and `--branch`, or, when the message names none, from the task branch checked out where it runs. The message gets them as its last line and the review event as fields, so swarmupd merges exactly what was reviewed instead of guessing the branch from the text.

### Fixed

- `swarmup sync` now pushes when two registered roots share one git repo, such as `.swarmup/` and `web/.swarmup/` in one store repo. Before, each root held back the other's commits; commits that change other files are still held back.

## 0.3.0-beta.10 (2026-11-19)

### Added

- swarmupd merges approved tasks that wait together in one batch: it rebases them in turn onto
  one candidate branch, runs the root's merge checks once, and moves the base once. When the
  checks fail, it splits the batch and checks the halves, so only the task that breaks the checks
  goes back. Each task keeps its own merge event. `swarmupd.merge.<root>.batch` sets the most
  tasks per batch (default 8); `1` merges each task alone.
- Preview and import historical Markdown decision tables and `kb/decisions/` notes with
  `swarmup decision --import` and `swarmup decision --import-notes`, including safe repeat runs,
  exclusions and explicit supersede or narrow mappings.

### Changed

- A merge that conflicts with the base no longer sends approved work back through the whole queue. swarmupd first tries a merge commit, which takes a branch that already merged the base to resolve a conflict. When that conflicts too, the author merges the base into the branch instead of rebasing, the fix starts ahead of other work and past the project's run limit, and the review covers only the resolution.

### Fixed

- A project renamed with **Edit name** now shows its new name everywhere the app names it, not only in the sidebar: project dropdowns and filters, New task, task cards, the task panel, Replay and its exported frames, Runs, Agents, Reports and Settings.
- Model-specific provider holds now consider only agents that can wake, so a disabled agent on another model no longer prevents stalled reviews from falling back.
- Show Replay's exports working: **Save frame**, **Record MP4** and **Save as GIF** show a busy line with a progress bar, frame count and **Cancel** beside the export buttons from the click until the file is saved. GIF and fast MP4 exports no longer freeze the page until they finish.
- Install dependencies with `pnpm install --frozen-lockfile --offline` in each new task worktree of a pnpm repo before its run starts, so the run can type-check and test without a manual install.
- A git command that swarmupd stopped for its timeout no longer leaves an `index.lock` in swarmupd's merge worktree that fails the next merge, or the rest of a merge batch, with `index.lock: File exists`.

## 0.3.0-beta.8 (2026-11-18)

### Changed

- Codex engineer runs in a task's worktree now run outside Codex's sandbox (`--sandbox danger-full-access`), so they commit their own work. On Windows the sandbox refused those commits, and the work waited on a leftovers branch. `runtimes.codex.sandbox_worktrees: true` keeps the sandbox.

### Fixed

- The sidebar no longer lists a project twice when the user config names its repo folder instead of the `.swarmup` folder inside it.

## 0.3.0-beta.7 (2026-11-18)

### Added

- **Settings > Updates** now has an Auto mode that pauses new work, lets live runs finish, installs the update, restarts SwarmUp and resumes only the pause it made.
- The desktop app shows a milestone's plan (step 4 of the milestone design). The inbox has a
  **Plans** group for plans that wait for approval, with each plan's item count and estimate
  sum. The task panel of a milestone shows the goal, `done_when` and the plan table with each
  item's task, owner, status, estimate and time spent; **Approve plan**, **Edit** and
  **Send back** while a plan waits; and the check history after. Edit mode changes a row's
  title, owner, estimate, `after`, `done_when`, reviewer, type and priority, and adds, removes
  and reorders rows; on a row that already has a task the fields that live in the task's file
  are read-only, and **Replace item** removes the item and adds it again under a new key.
- The board shows a milestone's progress on its card (`4/7 done, 9 h of 14 h`), and
  **Milestone** lanes group tasks by their `milestone:` label.
- swarmupd answers `GET /api/tasks/<id>/plan`, `POST /api/tasks/<id>/plan-approve` and
  `plan-reject`, and `GET /api/milestones`. They call the functions behind `swarmup plan show`,
  `approve` and `reject`, so the app and the CLI apply the same rules.
- A milestone that waits for its plan's tasks no longer shows in the inbox as a question to
  answer, and a plan change shows as one plan item instead of a message.
- Projects can be archived, labeled, relocated and removed through swarmupd's API (`/api/projects`). An archived project stays in the user config but is off the board, and swarmupd starts no run on its tasks. Removing a project drops only its entry from the user config; its folder and tasks stay on disk. The app's project menu builds on these calls.
- The desktop sidebar now keeps archived projects in a collapsed group and offers rename, relocate, archive, unarchive and safe removal from each project's right-click menu.

### Changed

- The desktop app now checks for updates every 30 minutes.

### Fixed

- swarmupd no longer commits package caches (`.pnpm-store`, `node_modules`, `.npm`) that a run leaves in its checkout, and leaves a run's changes uncommitted for a person when they exceed 2,000 files.
- Recheck a task's worktree before reporting that its approved branch is already in the merge base, so staged or unstaged work is recovered or sent back instead of being skipped.
- Merge the run-suffixed branch where swarmupd committed a reviewed run's leftover files, instead of incorrectly reporting that the older task branch was already in the base.
- A rejected model-specific usage window no longer makes swarmupd treat the whole provider as paused while another configured agent model can still run, so reviews stay with an available reviewer instead of falling back.
- Shrink Replay's **Save as GIF** files to about a tenth of their old size: each frame now stores only the area that changed, and ordered dithering keeps unchanged pixels identical between frames.
- Replay: the Swimlanes and Human loop stat card and the Wrapped cards no longer name the project, so with **Project name** off no MP4, GIF or PNG frame shows it; with it on, only the corner label does.
- Packaged installs and updates now refresh the `swarmup` skill for Claude Code and Codex, and **Health checks** can fix stale copies without deleting old skill folders that contain other files.

## 0.3.0-beta.6 (2026-11-16)

### Added

- `effort` sets the reasoning effort of a provider's or an agent's runs (`runtimes.<name>.effort`, `agents.<id>.effort`): `--effort` for Claude, `-c model_reasoning_effort=` for Codex. **Settings > Providers** and the agent cards in **Agents** show and edit it next to the model.
- The desktop window has no menu bar; a status bar at its bottom shows each provider's usage and time to reset, in the warning color at the pause threshold or when signed out. Click a provider to open it in Agents.

### Fixed

- A Codex PM can answer release questions: its sandbox has no network, so `gh release list` failed
  there. swarmupd now reads each code checkout's GitHub releases and local tags itself, at most
  every 10 minutes, and puts them in the prompt of every `codex:pm` run.
- Dialogs, such as editing an agent in **Settings**, now always show above the page: switches and
  fields of the page no longer draw over them or take their clicks. Tab stays inside the open
  dialog, and focus goes back where it was when the dialog closes.
- `pause_at` now applies to the main quota only (Claude's `five_hour` and `seven_day`, every Codex window). A window of one model, such as Claude's `seven_day_overage_included` (Fable), or a new model's window, pauses nothing at any share; once the provider refuses work on it, it holds only the runs of that model, and runs of other models go on. The status bar, `swarmup usage` and the provider cards in **Agents** follow the same rule; `runtimes.<name>.model_windows` maps more windows to models.
- A role file's `model: default`, which every role file template carries, now takes the provider's `model` in **Settings** instead of passing `--model default`, which ran Claude Code's own default (Fable) and held such agents, such as the PM in **Chat**, on Fable's usage window.

## 0.3.0-beta.5 (2026-11-15)

### Added

- The model fields in **Settings** and **Agents** suggest the known Claude and Codex models as you type, and warn on a name the list doesn't have (it still saves, for newer models). Codex models come from the installed Codex CLI's model cache when it has one.
- Replay can save web-sized, dithered GIFs and toggle the selected project name across PNG, MP4 and GIF exports; its three export actions now sit together.
- Fold or unfold the Projects, Work, Agents and Talk sections in the desktop sidebar; each section remembers its state.

### Changed

- Settings are now grouped into focused categories with side navigation instead of one long scrolling page.

### Fixed

- A provider paused for usage or signed out no longer stops all work: reviews waiting for its
  reviewer stop counting toward `review_backlog`, so new work in the project goes on.
- After `review_fallback_hours` (default 2; `0` turns it off, also in **Settings**), swarmupd
  moves such a review to a reviewer of the author's provider. The `review-fallback` event and the
  verdict both say why, such as `fallback: claude paused until 2026-11-18 17:00 UTC`.
- You get one Inbox note when a usage pause leaves reviews or work waiting, with when it ends and
  your options. `swarmup waits`, `swarmup runs` and the **Agents** view show the stall as one line
  per provider instead of one line per task.

## 0.3.0-beta.4 (2026-11-14)

### Added

- **Settings** has a **Cleanup** section: a switch for removing the worktrees of closed tasks (on
  by default), the grace period in minutes, and how many days a run's scratch folder stays. A
  change applies from the next cleanup sweep. The section also lists the closed tasks' worktrees
  that the last sweep left in place, each with the reason, such as uncommitted changes.
- The PM checks asks, plans and new decisions against the decision log. Before it answers an
  ask, it compares the answer with the decisions in force for the task and forwards a conflict
  to the person as `contradiction with D-NNNN (date): <line>` with `keep` and `change` options
  and a recommendation. swarmupd starts one PM run at most once per `plan_check_minutes`
  (default 30; `0` turns it off) with the new `swarmup start` plans and checkpoint `--next`
  steps and the decisions in force for their tasks. A decision a person records shows in the
  PM's inbox as a `record` item, so a conflict the record does not name gets a comment to that
  person. The starter roles gain a PM role file, `claude-pm.md`.
- A decision log: `swarmup decision "one line"` records a decision a person made, for a project
  or for one task tree, and `swarmup decisions --log` lists the decisions in force, also for one
  task (`--task ID`). `--supersedes` and `--narrows` replace an earlier decision without editing
  it. Decided votes are in the log too, and a redecision with `--force` now adds an outcome file
  instead of rewriting one. Decisions mirror to the Master Repo.
- Mark a decision as you write it: `--decision "one line"` on `swarmup answer`, `verdict`,
  `comment`, `retype` and `park` records the line in the decision log with that event as its
  source, for the task and the tasks below it (`--scope project` widens it; `--supersedes` and
  `--narrows` replace an earlier decision). `swarmup show` prints the mark under the event, and
  `swarmup doctor` reports a recorded decision whose source event does not exist.
- A run sees the decisions in force for its task: the prompt of a work run, a review run and a
  schedule with a task lists them, newest first and 30 at most, and `swarmup start`, `swarmup show`,
  `swarmup verdict` and `swarmup answer` print the same list. A learn note of the `decisions` topic
  that a record names as its source is left out of the prompt's learn notes for the tasks the
  record covers, and `swarmup kb --read` names that record. `swarmup learn decisions` points at
  `swarmup decision`.
- Desktop: mark a decision in the app. The answer, verdict, comment, triage, park and
  **Request changes** forms have a **Decision** toggle with a one-line field, prefilled from
  the first sentence of the message, and a **Project-wide** checkbox; a line over 200 characters
  is refused. **Decisions** has a **Log** tab that lists what `swarmup decisions --log` lists,
  with **Include superseded** and a **Supersede** button that records a replacement. On an ask
  that names a contradiction (`contradiction with D-0007`), **Accept change** makes the answer
  supersede that decision, or narrow it with **Only this task tree**.
- A task can say when it is done: `swarmup new --done-when "CHECK"` (repeatable) stores a list of
  checks in the task's `done_when` field, and `swarmup show` prints it. Run and review prompts
  point at the list.
- `swarmup review` prints a note when a request on a task with `done_when` names no command or no
  result. The request is still sent.
- The check that closes a milestone (step 3 of the milestone design). When every task of a
  milestone's plan is closed and merged, swarmupd starts a `qa` run on it with a check prompt: run
  the `done_when` line, record the evidence, then `swarmup done <milestone> "check passed: ..."`.
  A failed check adds one fix task per gap with `swarmup plan amend <milestone> --kind fix`, which
  blocks the milestone until the fixes close and merge. After two failed checks the next one adds
  none: `--kind fix` is refused, and the run asks with a plain `swarmup ask`, which reaches the PM.
  An approved plan change or a reopen starts a new count.
- `swarmup plan show` lists the failed checks, with the fix keys and the checker's note of each,
  and the parked items by key.
- `swarmup done` on a milestone is refused while a plan task is open or waits for its merge. A
  person passes, and anyone else with `--force`, recorded.
- Core reads milestones and their plans (step 1 of the milestone design; no `swarmup plan` command
  yet). A task of type `milestone` needs exactly one `--done-when` line. The fold reads `plan`,
  `plan-approve`, `plan-amend` and `plan-reject` events into the effective plan, and a milestone
  with an approved plan stays `blocked` until every plan item has a task, every child is done or
  parked, and no done child still waits for its merge.
- `swarmup review` without `--to` and swarmupd read a reviewer from `review` in `task.md` after a
  delegation's reviewer; `--human` and the type or label route still come first.
- `swarmup plan propose | show | approve | reject | amend | apply` (step 2 of the milestone
  design). The holder of a milestone proposes its plan from a YAML file; one
  `swarmup plan approve` by a person creates a task per item with `parent`, `blocked_by`,
  `labels: [milestone:<id>]`, `plan_item`, `review` and `done_when`. `amend --kind subtask` and
  `--kind fix` add items at once, subtasks up to 25 % of the approved estimate;
  `amend --kind change` proposes the full revised plan, and its approval parks, blocks, unblocks
  or hands off the tasks it changes, one event per item. `swarmup plan apply` finishes an
  application that a crash left incomplete, and swarmupd runs it on its own.
- A task created from a plan keeps what the plan fixed: `handoff`, `assign` and `delegate` need an
  owner the plan allows and carry the task's waits; `park`, an early `unblock`, a `review --to`
  or `delegate --review` that differs from the plan's reviewer, and `done` by anyone but the
  reviewer its review named are refused. A person passes, and anyone else with `--force`,
  recorded. `reopen` brings a plan task back under the plan's owner and dependencies, and refuses
  an item the plan removed.
- Under `coordinated` sync the plan events are pushed at once, like claims and handoffs.
- swarmupd no longer routes a plan task to a role group when no agent answers to its owner: the
  task waits for the role its plan names.
- `swarmup report` adds four figures for the window: verdicts per author and reviewer pair with
  the rounds an approval took, tokens and run minutes per merged task (median and top 5), why
  runs stopped, and how long people took to answer asks and reviews. `--json` carries them as
  `loops`.
- swarmupd stops a review loop: after `review_rounds` `changes` verdicts on a task in a row
  (default 3; `0` turns it off), it blocks the task for the PM with the text of those verdicts
  instead of waking the author for another round.
- A review run's prompt now lists the test files and the check configuration (test, lint and CI
  configuration, package scripts) that the reviewed work changes, deletes or skips, and tells the
  reviewer to check that the task needs each change. It flags only and blocks nothing. Set the
  patterns per root with `swarmupd.test_changes.<root>`, or turn the list off with `false`.
- The task panel shows the changes a review names: **View changes** opens the diff of those
  commits from the local repo, with the list of files, a side-by-side or unified layout, and
  syntax colors. After swarmupd merged the work, it shows what the base branch got. Read-only.

### Changed

- **New task** has a project dropdown in place of the free-text field: type to filter, pick with the
  arrow keys and Enter, or choose **Add project** without losing the draft. It opens with the
  project the Board or the list is filtered to, and the task is created in that project's store, so
  that project's agents and code checkout handle it. `POST /api/tasks` takes `root` for this.
- The engine repo installs with pnpm (`pnpm install`, one `pnpm-lock.yaml`) instead of npm. pnpm
  hard-links packages from one store, so each task worktree's `node_modules` takes about 30 MB of
  its own disk instead of about 260 MB.
- After a merge changed a `pnpm-lock.yaml`, swarmupd runs `pnpm install --frozen-lockfile` in
  that directory of the build checkout before the build. A configured `install` still wins.
- Claude runs may use `pnpm` commands by default (`Bash(pnpm *)`).
- A review run's prompt now lets the reviewer build the reviewed commit and run its tests and
  checks in a worktree, and has it name the commands and their results in the verdict. The
  reviewer reviews against the task text and its "Done when", and files style and matters outside
  the task as findings instead of asking for changes. It still never edits, commits or pushes.

### Fixed

- A Codex reviewer no longer reviews without test results. Its sandbox cannot build, install or
  test, so swarmupd now runs the root's merge `checks` on the reviewed commit before the review
  run starts, in a worktree of its own, and puts each command's result and a failed command's
  output in the run's prompt. `swarmup waits` shows the review as waiting for the checks;
  `swarmupd.review_checks: false` turns it off.
- A Codex run of a role that does not write can write its scratch folder, where `TEMP` points.
- `swarmup sync --session-end` in a supervised run whose sandbox refuses git or has no network
  says that swarmupd syncs the store when the run ends, and exits 0 instead of failing on
  `.git/index.lock`.
- swarmupd merges the commit the approved review names when the review writes it in code font or
  bold (`` `abc1234` on branch `x` ``). Before, such a review named no commit, so swarmupd took the
  branch of an earlier review; when that branch was empty, it recorded "already in main; nothing
  to merge" and unblocked the tasks that waited for the work. When the work it takes from an
  earlier or loose mention is already in the base and the approved review mentions a commit the
  base lacks, swarmupd now records no merge and files a finding linked from the task; the task and
  its dependants keep waiting. A commit id of digits only or letters only counts when it follows
  `commit`, `sha`, `hash` or `rev`, or is in code font or bold. A commit id in capitals
  (`023F19E`) counts in both places. A branch name in code font is read as written, underscores
  included (`` `__wip__` ``). A code span that a longer word runs on from (`` `feature`-old ``,
  `` `feature`_ ``) names no branch, so swarmupd does not take a branch `feature` for it.
- swarmupd no longer merges an approved commit while the task's worktree holds uncommitted
  changes: it commits what a run could not commit and merges that, or sends the task back to its
  author with the list of files. A reviewer is told when a run asks for review with changes
  swarmupd could not commit. While git cannot read the task's worktree or swarmupd cannot look at its folder, or when a file there
  changes while swarmupd commits, or stays changed after that commit, nothing is merged. The
  repo's own checkout is looked at too when it has the review's branch checked out. Only the run
  that asked for the approved review counts for that commit: what an earlier run of the same
  author left is not committed or merged for a later review. A `review` event now names the run
  that asked (`run`), so a `run-end` that arrives late cannot stand in for another run's.
- **Replay** can play one project of the sidebar alone. The **Project** picker now stands next to
  the time range and lists every data root by its name, plus the project labels inside a root
  that has more than one; before, it listed only the labels tasks carried, so a root such as
  `swarmup-web` was missing. The choice limits every scene and the saved PNG and MP4 files, whose
  names carry it. `GET /api/report` takes `root=R`, the Wrapped cards of `GET /api/timeline` follow
  `root`, and `swarmup report` and `swarmup wrapped` with `--root` count only that root's runs.
- A swarmupd started through a package script (`npm run swarmup`, `pnpm swarmup`) no longer hands
  the script's `npm_*` variables, `INIT_CWD` and `PNPM_SCRIPT_SRC_DIR` to agent runs, merge and
  review commands, and its own registry lookup. With pnpm's `npm_config_registry` in the
  environment, npm in a project with its own registry in `.npmrc` asked the public registry instead.
  An `npm_config_*` variable you set in your shell stays when no script starts swarmupd.
- A task worktree that runs the tests no longer holds its own Electron binary (about 350 MB).
  swarmupd keeps one unpacked copy per Electron version in its state folder (`electron/`) and
  names it in `ELECTRON_OVERRIDE_DIST_PATH` for agent runs and for merge and review checks. The
  copy comes from a checkout that already holds that version; when none does, the first run
  downloads it as before and swarmupd moves it to the shared place after the run.
- While a provider is signed out, swarmupd no longer tries to hand a plan task to an agent its
  plan does not allow. Such a handoff is refused, so it logged a warning on every tick.
- An update deletes the dead shortcut that a build under the app's earlier name left in the Start
  menu or on the desktop, for this user and for all users. A shortcut that still works stays.
- On Windows, swarmupd repairs what a Codex sandbox session leaves in a task store, so the next
  session no longer fails with `EPERM` on a task, note or lock an earlier session made: it makes
  each file and folder the sandbox user owns again under your account, and removes the stale
  locks of a crashed session. It runs before the first Codex launch, every 10 minutes and after
  each Codex run, and the next Codex run starts only once that repair is over;
  `swarmupd.repair_stores: false` turns it off. Temp files older than an hour in the task store's
  temp folder are named in the swarmupd log, and deleted only with
  `swarmupd.remove_stale_temp: true`.
- A git process that dies mid-write in a task store no longer blocks every later `swarmup sync`
  with `Unable to create index.lock: File exists`. A sync, from the CLI or from swarmupd, removes
  the store's `.git/index.lock` when it is at least 2 minutes old and no live git process started
  before it was made, and says so in a note. A lock that a live git process may hold stays.
- On Windows, a timed-out Git command no longer reports a process left running when the processes that `taskkill` names end a moment after it exits.

## 0.3.0-beta.3 (2026-11-13)

### Added

- **Add project in the desktop app.** **Add project**, in the sidebar's new **Projects** list and
  under **Settings > Data roots**, adds an existing repo without a terminal: pick the folder,
  review what SwarmUp found and proposes (name, id prefix, roles, first tasks), and click
  **Create**. Tasks live in the repo or, for a public repo, in a separate private folder. The
  project shows up at once; a folder that already has a data root only joins the list.
- `swarmup adopt --apply --store DIR` keeps the task store in a folder outside the repo and
  writes the root, its code checkout and its merge base to the user config.
- The sidebar lists the loaded projects; a project opens **Tasks** filtered to it.
- A supervised task run's prompt lists up to 3 learn notes whose title, tags or topic match the task's title and description, so agents see earlier lessons without searching `swarmup kb`; prompt exposure is included in learn-note usage.
- A work run's prompt asks the agent to write a learn note before it finishes when the next agent should know something; a review run's prompt asks the reviewer to write one when the work took several review rounds.
- The desktop app shows the SwarmUp mark as an animated status in three places: next to a task's
  title in the task panel, in the header of the run you picked in Runs, and at the top of the
  Inbox. It turns while work is under way, knocks while something waits for you, settles when a
  task or run finished, and slumps when a run failed. With reduced motion turned on in the system
  settings, a still image shows instead.
- `swarmup --version` shows the four-tile mark next to the name and version when you run it in a
  terminal. Piped or redirected output, `NO_COLOR`, `TERM=dumb` and `--json` still print the bare
  version, so scripts read what they read before.

### Changed

- The desktop app's icon, its installer and its tray icon show the four tiles of the SwarmUp mark. The tray tiles are in colour while swarmupd runs, dimmed while it is paused and grey outlines while it is stopped; the blue dot still means something waits for you.
- Desktop app: provider names, `@mention` pills and the people in the Human loop replay use the
  brand colors, so a name matches the tile beside it (Codex cyan, a person pink, Claude orange).
- The desktop app shows the four-tile SwarmUp mark in the sidebar and as the page icon, in place
  of the earlier teal ring.
- An avatar is now the provider's tile with the role icon on it: pink for you, orange for Claude,
  cyan for Codex, violet for the orchestrator, silver for Grok, blue for Gemini and yellow for
  Jev. Every avatar keeps the id as its tooltip.

### Fixed

- A message sent in the PM chat as a turn starts or ends no longer waits for the app's round of
  reads: swarmupd answers queued reads one per turn of its event loop, so a write that arrives
  among them is answered at once (AO-0277).
- `swarmup inbox --mark-read` no longer fails with `EPERM` on Windows when the agent's read marker
  cannot be replaced, as happens to a marker made by an earlier Codex sandbox session: the new
  position goes to a spare marker file next to it, so items you have handled stop coming back. A
  write that fails no longer leaves its temp file behind in the store's local state folder.
- The app's Inbox read takes about half as long on a store with a few hundred tasks: one inbox read
  reads the tasks once, checks no files for dependencies it has just read, and parses each channel
  message once.
- Claiming a task, syncing and mirroring no longer fail with `EPERM` on Windows when a state file
  in the store's local state folder cannot be replaced, as happens to a file made by an earlier Codex sandbox session: the
  new content goes to a spare file next to it (`<name>.<ulid>.json`), and reads take the newest of
  them. The task index and the activity index use the same spare instead of waiting about 0.6 s
  for the refused file on every read.
- A merge after you delete the old code checkout no longer stops with "exists but is no git worktree; remove it": swarmupd deletes its merge worktree whose repo is gone and makes it again from the current checkout.
- A merge after you move the code checkout to another repo (`merge.<root>.checkout` or `swarmupd.code.<root>`) no longer fails with "unable to read tree": swarmupd removes its merge worktree from the old repo and makes it again from the new one.
- swarmupd no longer stalls for about a quarter of a second after each task change while the app
  reads the tasks again: it keeps the task index in memory between reads, and it no longer folds a
  task and rewrites the index on every read in the 2 seconds after an event.

## 0.3.0-beta.2 (2026-11-12)

### Added

- A task store can live in a repo of its own, apart from the code: `swarmupd.code.<root>` in the user config names the code checkout. Runs start there, task worktrees are made there, and swarmupd pushes the merge base to the code repo's remote after each merge.

### Changed

- swarmupd's settings in the user config live under the key `swarmupd`. A config that still names the section by its earlier key works as before: swarmupd reads and edits that section in place until you rename the key. Messages and docs name `swarmupd.*`.

### Fixed

- A task blocked with `--on` no longer frees when a reviewer approves the dependency but swarmupd
  has not merged its branch yet. Where `swarmupd.merge` is set for the dependency's root, the task
  frees after swarmupd records the merge, and `swarmup show` says which merge it waits for.
  `swarmup report` counts such a task as unblocked after the merge, not at the approval.
- swarmupd no longer runs `git rev-parse` on its event loop when it starts a writing Codex run in a checkout it has seen: git names the checkout's git dir and common dir off the event loop, with the checkout's state, before the launch. Before, each such launch held the API for 0.2-1.5 s on a loaded machine.
- Two swarmupd starts at the same moment for one state folder no longer fail with `swarmupd did not start` on a slow machine. The start that loses the lock now waits, up to the usual start timeout, for the swarmupd that holds the lock to come up.
- When a git command of a merge times out and swarmupd cannot stop what git started, such as a hook where `taskkill /T` is refused, the merge note no longer says "swarmupd stopped it". It says that what git started may still run, and why the stop failed.
- After a merge that changes a lockfile, swarmupd installs optional platform packages that
  `npm install` left out of the checkout's `node_modules` (such as
  `lightningcss-win32-x64-msvc`), so the build after the merge no longer fails on a missing
  native binary.
- `npm install` in an engine checkout no longer rewrites `package-lock.json` without the root
  `lightningcss-*` platform packages, and no longer deletes the installed `lightningcss` binary:
  `lightningcss` is now a root dev dependency, pinned to the version `@tailwindcss/node` needs.
- After a merge, a build that fails in the checkout no longer reopens the merged task when only the installed dependencies were missing or behind: swarmupd runs the install there and builds once more. When the install itself fails, the human gets a comment on the task and the task stays closed.
- Merge checks no longer inherit the installed desktop app's swarmupd entry (`SWARMUP_DAEMON_ENTRY`) and Electron host flags when the app hosts swarmupd. A check that starts swarmupd, such as the engine's own tests, starts its checkout's build instead of the installed one.
- When swarmupd does not start, the error names the entry it started and shows the last lines that start logged, without the lines that look like a secret.
- swarmupd no longer starts a run on a task beside an agent session it did not start. When the task's newest claim came from such a session on this PC, swarmupd waits 30 minutes after that agent's last event on the task (`swarmupd.outside_session_minutes`; `0` never waits) before it starts a run or wakes an inbox run for it, and `swarmup waits` says why. The wait ends at once when the session releases, hands off or closes the task, or when anyone assigns it.
- A session without `SWARMUP_RUN` no longer acts on a claim that a supervised run holds: `swarmup start`, `progress`, `release`, `review`, `done` and the other finishing commands refuse with "held by ... under another claim", also for the task's owner by name. Before, two sessions of one agent id could both send the same task to review.
- swarmupd no longer rescans the whole Windows process listing each time a piece of it arrives: it searches only the new piece for the end marker. The rescans took about 2.4 s of event-loop time per 100 s under load.

## 0.3.0-beta.1 (2026-11-11)

### Added

- The first public release of SwarmUp: a team of AI agents and one human working one queue, with tasks, events and decisions as files in git.
- `SwarmUp-Setup.exe` installs the desktop app, swarmupd (the service that starts and watches agent runs) and the `swarmup` command for Windows, per user. The app updates itself from this repository's releases.
- The task store: tasks as Markdown files with an event log, claims with leases, reviews by an agent of another provider, questions and answers, handoffs, findings, channels, votes, learn notes, repeating tasks, and sync across machines through git.
- swarmupd: starts Claude Code and Codex runs for the agents you configure, gives each code task its own worktree, routes work without an owner to a role, merges approved branches, stops a task whose runs keep ending without work, and waits when a runtime is signed out.
- The desktop app: **Board**, **Inbox** with the agent's recommended pick, task threads, **Chat** with the PM agent, **Runs**, **Agents**, **Activity**, **Repeating**, **Replay**, search across tasks and notes, reports and standups, and a tray icon for swarmupd.
- The `swarmup` skill for Claude Code and Codex, which teaches an agent the queue.
- `swarmup kb --usage` counts how often each learn note was read and how often a run prompt listed it, in total and in the last `--days` days (default 30). `swarmup kb --stale` lists the notes neither read nor shown in that window, so you can prune them by hand.
