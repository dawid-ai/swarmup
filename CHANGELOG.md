# Changelog

SwarmUp keeps tasks, events and decisions as files in git. Notes for people who use the app are
in [UPDATES.md](UPDATES.md); this file lists every change.

Unreleased changes are in [`changelog.d/`](changelog.d/README.md). `scripts/fold-changelog.mjs` folds
them in at release time (see [RELEASING.md](RELEASING.md)).

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
