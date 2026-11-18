# Updates

What changed in each release, for people who use the app. Every change, including the small
ones, is in [CHANGELOG.md](CHANGELOG.md).

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
