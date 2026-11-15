# Updates

What changed in each release, for people who use the app. Every change, including the small
ones, is in [CHANGELOG.md](CHANGELOG.md).

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
