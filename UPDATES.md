# Updates

What changed in each release, for people who use the app. Every change, including the small
ones, is in [CHANGELOG.md](CHANGELOG.md).

## v0.3.0-beta.25 (2026-11-24)

- **Updates always finish.** If SwarmUp is still syncing your projects when an update installs, the update now waits for it to finish instead of giving up.
- **Build workflows in the app.** **Workflows** in the sidebar lists your workflows and lets you create one from a template or from scratch, edit it with a form or as YAML, see problems as you type, preview the plan, and save.
- **See what's behind every score.** Click any score to see each task or run behind it, worst first, with notes and links, and **How scores work** explains each one.
- **Propose agent changes yourself.** **Agents > Proposals** is always there: turn the improver on or off, see what each proposal still needs before you promote it, and use **Propose a change** to edit an agent's role and send it for review.
- **A map for every project.** New and added projects get a project map, so agents start each task oriented instead of rereading the project.

## v0.3.0-beta.24 (2026-11-24)

- **Judge scores in reports.** **Reports** now include the scores from a project's rubric scorers.
- **Compare against an earlier version.** A project can name a variant that is its own agent definitions as of an earlier commit, to benchmark or trial against the current ones.
- **Clearer problems.** `swarmup validate` points at the exact line of a trigger or scorer that names something missing.
- **Fixes.** Moving schedules into the project takes effect without a restart, publishing logs each tool call, and a failed publish keeps its note even when the error quotes a token.

## v0.3.0-beta.23 (2026-11-23)

- **Automation in the app.** A new **Automation** view shows each project's scheduled triggers and merge checks, whether this PC runs them, and lets you turn them on, review the exact set and approve it, or revoke it.
- **Work from outside.** A project can take webhooks from GitHub, Linear, Slack or anything that signs its requests, through your own tunnel. Each delivery arrives as a finding for you or your PM to triage; a trigger acts on its own only if you allow it.
- **Benchmark fix.** A benchmark whose commit id looks like a number now reads correctly.

## v0.3.0-beta.22 (2026-11-23)

- **Updates that wait their turn.** Installing an update no longer fails with "swarmupd did not stop in time" while SwarmUp finishes syncing your projects; it waits up to 2 minutes for that.
- **Readable update notes.** What's new now shows as whole bullets instead of broken lines.
- **Try a change on part of the work.** A project can run a proposed agent change on a share of its tasks and compare the scores of both sides before you decide.
- **Quality scores from a judge.** A project's rubric scorers now score finished work, on one PC per project and within a daily token budget you set.
- **Benchmark history.** Every benchmark attempt is kept, and `swarmup bench history` lists them by set, agent or variant.

## v0.3.0-beta.21 (2026-11-23)

- **Scheduled work from the project.** A project can keep its schedules in git: run an agent, start
  a workflow or file a repeating task every so often, at a time of day, or on a cron schedule. A
  PC runs them only after you turn them on there and approve the exact set, and any change waits
  for your approval again.
- **Team merge checks.** The checks that run before work is merged can live in the project too.
  Each PC runs them only after you approve the exact commands.
- **Team score thresholds.** A project can set its own pass thresholds for scores.
- **Publish what you previewed.** **Publish now** shows the files and version it sends, the same
  ones **Preview** shows, and sends exactly those.
- **Workflow publish steps** can name their publish adapter, so a workflow's publish task is ready
  to publish.

## v0.3.0-beta.20 (2026-11-23)

- **Publish from SwarmUp.** Set up a publish adapter (a command of yours or a publishing tool
  your MCP server offers), and **Publish** in a publish task sends the approved text out once and
  records the link. **Preview** shows the page first. Only you can publish; agents never can.
- **More checks for writing.** **Done when** can require a reading level (`readability`) and,
  after publishing, check the live page shows what it should (`page-contains`).
- **See how much you edit.** A new score shows how much you changed approved text before
  publishing, so a writer agent whose drafts always need work stands out.
- **Agents learn for good.** Notes agents keep needing can be folded into their role file as a
  proposal you approve, and you can archive notes nobody reads from the **Knowledge** view.
- **Safer improvements.** A proposed change to an agent can be required to beat the current one
  on a benchmark before you promote it, and `swarmup defs rollback` undoes a promote.
- **Benchmarks.** Codex runs show an estimated cost, runs with repeats show how much results vary,
  and **Run benchmark** takes a cost cap.
- **Better scores.** Reviewers are scored on whether they check every criterion, and an agent's
  question to you counts as right when it names a reason only you can decide.

## v0.3.0-beta.19 (2026-11-22)

- **Workflows you can repeat.** Start a feature, a bug fix, a content piece or a campaign launch
  from **New task > Start a workflow**. A workflow lays out the stages, who does each one and
  what "done" means, so the same kind of work runs the same way every time. Projects can add
  their own workflows.
- **Gates for your decisions.** A workflow can stop and ask you something, such as "Is the spec
  right?", once the work before it is done. Answer in the Inbox under **Gates**: **Approve**
  starts the next stages, and **Reject** parks them or sends the work back with your note. No
  agent can answer a gate for you.
- **One definition per agent role.** A role is now defined once for every agent that runs it,
  with only the differences per agent. `swarmup defs migrate` moves existing role files over and
  checks that nothing changes.
- **Team rules in the project.** Review rounds, time budgets and similar limits can live in the
  project's `swarm.yaml`, so every machine uses the same ones. Settings you make on this PC still
  win.
- **Updates survive antivirus.** When antivirus holds the downloaded update, SwarmUp downloads it
  again a few times instead of stopping with an error.

## v0.3.0-beta.18 (2026-11-22)

- **Not just code.** Start a campaign or a blog with **New project** and the `campaign` or
  `content` template: it comes with a brand voice, a claims file every post must cite, rubrics for
  voice, accuracy and channel fit, a calendar, and an editor that reviews every draft. Drafts are
  versions you approve; nothing goes live until you post it.
- **Checks for writing.** A **Done when** item can now check characters per post (280 for an X
  thread, with links counted as X counts them), required or banned words, the headings a document
  must have, front matter, image alt text and image size.
- **See the work, not a commit.** A review lists the files, links and images it covers, and the
  task panel's **Work** section shows the text as it was reviewed, with word-level changes and
  images inline.
- **Publishing stays yours.** A publish task belongs to you. Post it yourself, then use **Mark
  published** to record the link; checks that need the live page run after that.
- **Tools for agents, safely.** Give an agent MCP servers (Notion, a CMS, your calendar) in
  **Settings > MCP servers**. Secrets stay on this PC and never reach the agent, each server can be
  limited to certain projects, agents and tools, and every tool call is logged.

## v0.3.0-beta.17 (2026-11-22)

- **A judge for quality checks.** A **Done when** item can be scored against a rubric, such as
  "readable, follows the project's conventions, tested". A judge model reads the change and gives
  a score and its reasons. Use **Judge** in the task panel, judge benchmark runs, or have SwarmUp
  judge at merge (off by default; it costs a few cents a task).
- **SwarmUp improves its agents, with your say.** When an agent keeps failing a score, SwarmUp
  can open an improvement task: an improver agent reads the failures and proposes a small change
  to that agent's instructions. Proposals show up at the top of **Agents** with the exact change,
  the scores they address and, if you set one up, a benchmark of before and after. Nothing changes
  until you click **Promote**; **Reject** drops it. Off by default.
- **Fixes:** adding a Python project finds tests written with `unittest`; adding a project tells
  you which new agents need **Wake** turned on before they pick up work; and checks written over
  several lines are read as one check.

## v0.3.0-beta.16 (2026-11-21)

- **Everything from beta.15 now lives in the app.** The task panel shows each **Done when** item
  with its last result, lets you add and edit typed checks, and runs them with **Run checks**.
  Reviews in the task panel and the Inbox give a pass or fail per item. **New task** builds
  checks too. Milestones and parent tasks show their goal brief, with **Edit**, and tell you when
  children closed since it was written.
- **Map view.** Browse a project's map by kind, as a tree or as a graph, search by words or by
  file, read what each part does, and check that the map still matches the code. Projects without
  a map get **Create map**.
- **Scores everywhere.** **Agents** shows each agent's scores with a 30-day trend, what to change
  when one fails and the worst tasks behind it. **Reports** adds trends and worst tasks, the task
  panel lists a task's own scores, and **Runs** shows each run's model, effort, whether it resumed
  an earlier session and how much it read before its first change.
- **Benchmarks.** Replay real tasks against an agent setup and score the results: the
  **Benchmarks** view lists your sets and runs, follows a run as it goes, shows each attempt's
  checks, cost, time, diff and log, and compares two runs side by side. Starting a run that uses
  an agent shows the plan and asks you to confirm the cost first; calibration runs are free.
- **Team settings in git.** A project can keep its agents' models, effort and limits in
  `swarm.yaml` next to its tasks, so they travel with the project. **Settings > Definitions** shows
  each value and whether it comes from the project or from this PC, flags problems by line,
  imports your current settings and checks edits as you type. Each run records which settings it
  started with.

## v0.3.0-beta.15 (2026-11-21)

- **Every task can say what done means.** A task's **Done when** list can now hold checks, not
  just sentences: a command that must pass, a file or pattern that must exist, a word count, links
  that must resolve, a rubric a reviewer scores, or a question for a person. swarmupd runs the
  commands and checks when it merges the work and sends the task back if one fails. Reviewers give
  a pass or fail for each item, and the task panel shows every item with its last result.
- **Project map.** A project can keep a map of what each part does and where it lives, as short
  linked notes in `.swarmup/map/`. Agents get the parts that matter to their task in their
  instructions, keep the map up to date as they work, and `swarmup map check` flags a change that
  leaves the map behind. SwarmUp's own code ships with its map.
- **Agents pick up where they left off.** A task's instructions now include its recent thread and
  the goal it belongs to, so agents spend less time looking things up. When a reviewer asks for
  changes, the agent continues its earlier session instead of starting from scratch. Milestones
  and parent tasks can carry a short goal brief (`swarmup brief`) that the PM keeps current.
- **Scores.** **Reports** shows how each agent is doing: review rounds, merges that failed, cost
  per merged task, how often it needed you, and how much it read before its first change.
  `swarmup scores` lists the same, with the tasks behind each number.
- **Runs** has a date range like **Activity** and **Replay**, and a custom range now covers whole
  days in your time zone.
- **Fixes:** files you attach to a new task land in the right project; Git Bash stops warning
  "could not find /tmp" after SwarmUp cleans up old scratch folders; the PM can read GitHub and
  release tags while it plans.

## v0.3.0-beta.13 (2026-11-21)

- **SwarmUp cleans up after itself.** Old scratch folders go after 2 days, run logs and merge logs
  after 14, and swarmupd's log starts a new file past 10 MB. Worktrees of finished tasks whose work is
  already merged are removed instead of waiting for a merge that never comes. Cleanup runs in the
  background, so it never holds up the app.
- **No more frozen dialogs.** **Create task** and other actions no longer wait while swarmupd
  cleans up or builds a report, and **New task** keeps its fields still while the task is created.
  If anything does hold swarmupd for more than 2 seconds, swarmupd's log says what it was.
- **Tasks:** picking **Done** or **Parked** shows those tasks, and a project link from the sidebar
  shows its tasks even when the project's name differs from its folder's.
- **Board:** the **Done** column header has a 20 / 100 / 250 / All choice, and shows the real
  total.
- **Activity** has a time range like **Replay**'s, and a custom range now includes its end day in
  both.
- **Reports** open in a fraction of a second instead of several, with a progress state while one
  builds.
- **Agents** show the full model name.
- **Merges:** reviews record the exact commit and branch, approved work that only changes the task
  store closes cleanly, merge checks can be limited to the paths they cover, and a merge check that
  failed a test goes back at once instead of being retried.

## v0.3.0-beta.11 (2026-11-20)

- **Slow merge checks no longer bounce work back.** When a merge check times out, swarmupd runs it
  again with twice the time and starts no new agent runs until it ends. If it times out again, the
  work stays approved and you get a note on raising `timeout_minutes`, instead of the task going
  back to its author.
- **Reviews name exactly what to merge.** `swarmup review` records the commit and branch of the
  work, from `--commit` and `--branch` or from the task branch it runs on, so swarmupd merges
  exactly what was reviewed.
- **Pause holds merges too.** While swarmupd is paused, no new merge starts; one under way finishes.
- **Merge history.** swarmupd keeps its merge attempts and runs in `state.db`, a local SQLite file
  in its own folder, for every project. Each attempt records how it ended; `GET /api/merges` lists
  them. SwarmUp now needs Node 22.13 or later when you run it from source.
- **Sync with shared store repos.** `swarmup sync` pushes again when two projects keep their tasks
  in one repo, such as `.swarmup/` and `web/.swarmup/`.

## v0.3.0-beta.10 (2026-11-19)

- **Renamed projects show their new name everywhere.** After **Edit name**, the new name shows in
  project dropdowns and filters, **New task**, task cards, the task panel, **Replay** and its
  exports, **Runs**, **Agents**, **Reports** and **Settings**, not only in the sidebar.
- **Merge conflicts get fixed faster.** When approved work conflicts with `main`, the agent merges
  `main` into its branch, the fix starts ahead of other work, and the review covers only the
  resolution instead of the whole task again.
- **Approved tasks merge in batches.** Tasks that wait together go through the merge checks once
  as a batch; a failing check splits the batch, so only the task that breaks it goes back.
- **Replay export progress.** **Save frame**, **Record MP4** and **Save as GIF** show a progress
  bar with **Cancel**, and the page no longer freezes while a GIF or MP4 renders.
- **Import old decisions.** `swarmup decision --import` and `--import-notes` bring decision tables
  and `kb/decisions/` notes into the decision log.
- **Fixes.** New task worktrees of pnpm repos get their dependencies installed before the run
  starts, and a paused agent on another model no longer stops stalled reviews from moving to
  another reviewer.
- **Merges recover from a stuck git.** A git command that swarmupd stopped for taking too long no
  longer leaves a lock behind that fails the next merge.

## v0.3.0-beta.8 (2026-11-18)

- **Each project shows once.** The sidebar no longer lists a project twice when your settings
  name its repo folder.
- **Codex agents commit their own work.** A Codex engineer working on a task now commits in the
  task's worktree, as Claude agents do, so its work no longer waits on a separate branch. It runs
  outside Codex's sandbox there; `runtimes.codex.sandbox_worktrees: true` in your config keeps
  the sandbox.

## v0.3.0-beta.7 (2026-11-18)

- **Manage projects from the sidebar.** Right-click a project to rename it, change its folder,
  archive it or remove it. Archived projects move to a collapsed **Archived** group, leave the
  board and run no tasks. Removing a project takes it off SwarmUp's list only; its folder and
  tasks stay on disk.
- **Updates every 30 minutes, and an Auto mode.** The app checks for updates every 30 minutes.
  **Settings > Updates** has an Auto mode: it pauses new work, lets live runs finish, installs
  the update, restarts SwarmUp and resumes.
- **Milestone plans in the app.** A milestone's task panel shows its plan, and plans that wait
  for approval show in a **Plans** group in the inbox, where you approve, edit or send them
  back. Milestone cards show their progress.
- **Smaller GIFs.** **Replay**'s **Save as GIF** files are about a tenth of their old size, and
  with **Project name** off, no exported frame names the project.
- **Approved work reaches main.** swarmupd merges work it committed for a run that could not
  commit, and no longer skips work left uncommitted in a task's worktree.
- **Faster reviews and merges.** Reviews judge the work without running the test suite, and
  merges run only the tests of what changed.

## v0.3.0-beta.6 (2026-11-16)

- **Usage pauses follow the main quota.** swarmupd pauses a provider at its pause threshold of
  the main quota only (Claude's five-hour and weekly windows). One model's own allowance, such
  as Fable's weekly window, no longer stops runs of other models, and holds that model's runs
  only once the provider refuses work. The status bar and **Agents** show the main quota.
- **Agents use your provider model.** A role file with `model: default`, such as the PM's, now
  runs the model set for the provider in **Settings** instead of the CLI's own default.
- **Reasoning effort.** **Settings > Providers** and the agent cards in **Agents** set how hard
  each provider or agent thinks, next to its model.
- **Status bar.** The window has no menu bar; a status bar at the bottom shows each provider's
  usage and time to reset. Click a provider to open it in **Agents**.
- **Dialogs stay on top.** Dialogs always show above the page, and Tab stays inside them.

## v0.3.0-beta.5 (2026-11-15)

- **Settings in categories.** **Settings** has a side list of categories instead of one long
  page, and `settings:<category>` links open one directly.
- **Model suggestions.** The model fields in **Settings** and **Agents** suggest the known Claude
  and Codex models as you type and warn on a name they don't know; it still saves, for newer
  models. Codex models come from your installed Codex CLI.
- **Work goes on when a provider is paused.** A provider paused for usage or signed out no longer
  holds up new work. After `review_fallback_hours` (default 2, in **Settings**), its waiting
  reviews move to a reviewer of the author's own provider, and you get one Inbox note with when the
  pause ends.
- **Fold the sidebar.** The Projects, Work, Agents and Talk sections fold and unfold, and keep
  their state.
- **Replay exports.** **Replay** saves GIFs, can show or hide the project name in PNG, MP4 and GIF
  exports, and keeps the export buttons together.

## v0.3.0-beta.4 (2026-11-14)

- **New task picks the project.** **New task** has a project dropdown: type to filter, or choose
  **Add project** without losing what you wrote. It opens with the project the Board or the list
  is filtered to. The task is now created in that project, so its own agents and code checkout
  handle it.
- **Less disk per task.** Each task worktree now takes about 30 MB of its own instead of several
  hundred, and swarmupd removes the worktrees of closed tasks again. **Settings > Cleanup**
  turns that on or off, sets how long it waits, and lists the worktrees it kept and why.
- **See the changes.** **View changes** in the task panel shows the diff a review names, side by
  side or unified, with syntax colors.
- **A decision log.** Answers, verdicts and comments have a **Decision** toggle that records the
  decision. **Decisions > Log** lists the decisions in force, agents see them in their prompts,
  and the PM asks you when a new answer contradicts one.
- **Better reviews.** Reviewers run the tests of the work they review, and a Codex reviewer gets
  the check results first. After 3 rounds of changes on one task, swarmupd hands the task to the PM
  instead of starting another round.
- **Fixes.** Merges no longer leave out work a run could not commit, or merge an earlier commit
  than the approved one. On Windows, tasks no longer fail with `EPERM` after a Codex session, a
  crashed git process no longer blocks sync, and the dead Start menu shortcut of the earlier build
  is removed. **Replay** can show one project.

## v0.3.0-beta.3 (2026-11-13)

- **Add project from the app.** **Add project**, in the sidebar's new **Projects** list and under
  **Settings > Data roots**, adds an existing repo without a terminal: pick the folder, review
  what SwarmUp proposes, and click **Create**. For a public repo, tasks can live in a separate
  private folder. The sidebar lists your projects; a project opens **Tasks** filtered to it.
- **The SwarmUp look.** The app icon, the installer, the tray and the sidebar show the four-tile
  SwarmUp mark. Avatars are the provider's tile with the role icon on it, and names use the same
  colors. An animated mark shows whether a task or run is under way, waits for you, finished or
  failed.
- **Agents learn from earlier tasks.** A run's prompt lists up to 3 learn notes that match the
  task, and agents are asked to write one when the next agent should know something.
- **Faster and steadier.** Chat messages no longer wait behind the app's reads, the Inbox loads in
  about half the time, and swarmupd no longer stalls after each task change. On Windows, claiming
  a task and marking Inbox items read no longer fail with `EPERM`. Merges keep working after you
  move or delete the code checkout.

## v0.3.0-beta.2 (2026-11-12)

- **Tasks and code in separate repos.** Your task store can live in a private repo of its own
  while the code lives in another, such as a public one. Name the code checkout under
  `swarmupd.code` in your user config: runs, task worktrees and merges happen there, and swarmupd
  pushes the merged branch after each merge.
- **Settings under `swarmupd`.** swarmupd's section of the user config is now called
  `swarmupd`. A config with the earlier name keeps working.
- **Steadier merges and runs.** A task waiting on approved work starts only after that work is
  merged. A merge whose build lacked installed packages installs them and builds again instead of
  reopening the task. swarmupd no longer starts a run beside an agent session you started
  yourself, and two swarmupd starts at the same moment no longer fail.

## v0.3.0-beta.1 (2026-11-11)

The first public SwarmUp release.

- **One installer for everything.** `SwarmUp-Setup.exe` installs the desktop app, swarmupd (the
  background service that starts and watches agent runs) and the `swarmup` command. They update
  together: a new version downloads in the background and installs once no agent run is live and
  the window is closed. **Settings > Updates** and the tray install it sooner.
- **A team of agents on one queue.** Describe an idea to the PM agent in **Chat**; it splits the
  idea into tasks and routes them. Engineer, QA and reviewer agents on Claude Code and Codex
  claim tasks, work them and hand them on. Each code task runs in its own worktree, so two
  engineers on one project don't wait for each other.
- **Only crucial decisions reach you.** Reviews go to an agent of another provider, and agents'
  questions go to the PM agent first. Releases, money, accounts, client work and deleting data
  come to your **Inbox**, each with the option the agent would pick; **Accept recommendation**
  answers in one click.
- **Every task is a thread.** Claims, questions, answers, reviews and verdicts sit in one place,
  as Markdown files in your git repo. Nothing lives on a server.
- **See what runs.** **Runs** shows each live agent run with its log, tokens and time. The
  **Board** and **Agents** show the merge swarmupd runs. A tray icon shows swarmupd's state and
  starts, stops or pauses it.
- **Repeating tasks.** Set a task to come back daily, weekly, on chosen weekdays, monthly or
  yearly, or whenever another task closes.
- **Search everything.** Ctrl+F finds tasks by id, title, description or anything said in their
  thread, plus learn notes, channel posts and votes.
- **Replay your project.** **Replay** plays a project's history as scenes and records them as
  MP4 videos.

This is a beta and the installer is not signed yet, so Windows SmartScreen warns on first run:
choose **More info**, then **Run anyway**.
