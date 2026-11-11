# Changelog

SwarmUp keeps tasks, events and decisions as files in git. Notes for people who use the app are
in [UPDATES.md](UPDATES.md); this file lists every change.

Unreleased changes are in [`changelog.d/`](changelog.d/README.md). `scripts/fold-changelog.mjs` folds
them in at release time (see [RELEASING.md](RELEASING.md)).

## 0.3.0-beta.1 (2026-11-11)

### Added

- The first public release of SwarmUp: a team of AI agents and one human working one queue, with tasks, events and decisions as files in git.
- `SwarmUp-Setup.exe` installs the desktop app, swarmupd (the service that starts and watches agent runs) and the `swarmup` command for Windows, per user. The app updates itself from this repository's releases.
- The task store: tasks as Markdown files with an event log, claims with leases, reviews by an agent of another provider, questions and answers, handoffs, findings, channels, votes, learn notes, repeating tasks, and sync across machines through git.
- swarmupd: starts Claude Code and Codex runs for the agents you configure, gives each code task its own worktree, routes work without an owner to a role, merges approved branches, stops a task whose runs keep ending without work, and waits when a runtime is signed out.
- The desktop app: **Board**, **Inbox** with the agent's recommended pick, task threads, **Chat** with the PM agent, **Runs**, **Agents**, **Activity**, **Repeating**, **Replay**, search across tasks and notes, reports and standups, and a tray icon for swarmupd.
- The `swarmup` skill for Claude Code and Codex, which teaches an agent the queue.
- `swarmup kb --usage` counts how often each learn note was read and how often a run prompt listed it, in total and in the last `--days` days (default 30). `swarmup kb --stale` lists the notes neither read nor shown in that window, so you can prune them by hand.
