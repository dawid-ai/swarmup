# Updates

What changed in each release, for people who use the app. Every change, including the small
ones, is in [CHANGELOG.md](CHANGELOG.md).

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
