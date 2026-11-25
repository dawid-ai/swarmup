# Desktop app

The desktop app is the human's control room on top of `swarmupd`: the inbox, the board, task details
with every action, agents and their runs, run logs, votes and channels.

## Install and updates

On Windows, `SwarmUp-Setup.exe` from GitHub Releases installs the app for your user (under
`%LOCALAPPDATA%\Programs\SwarmUp` unless you pick another folder). The app carries swarmupd and the
`swarmup` command as bundles it runs with its own executable as Node, so no separate Node.js is
needed:

- `resources\app\`: `main.mjs` (the app), `swarmupd.mjs`, `swarmup.mjs`, the UI.
- `resources\bin\`: `swarmup.cmd` for PowerShell and cmd, and `swarmup` for Git Bash, plus the
  `ops.cmd` and `ops` aliases, which print a notice on stderr until they go in 0.4. The installer adds
  this folder to your user PATH when **Add the swarmup command to my PATH** is checked (the default);
  uninstalling removes it. If you edited PATH at or before that entry since installing, uninstalling
  leaves PATH as it is, so remove the entry yourself. Agent runs always get it first on their PATH
  from swarmupd.
- On its first start and after every update, the packaged app copies its bundled `swarmup` skill to
  Claude Code and Codex's user skill folders, and refreshes a copy in `~\.agents\skills\swarmup`
  when one exists. A restart of the same version leaves the copies as they are, so your edits
  stay until the next update. **Settings > Health checks > Fix** does the same at once. It
  removes a leftover `skills\agent-ops` folder only when `SKILL.md` is its sole entry; when the
  folder contains anything else, Health checks keeps it and says so.

The app checks GitHub Releases 20 seconds after it starts and every 30 minutes, and downloads a new
version in the background. **Settings > Updates** chooses how a downloaded version installs:

- **Manual** (the default) installs once no agent run is live and no window is open (the app sits
  in the tray), or when you choose **Restart and install** in Settings or the tray. With runs live,
  a clicked install asks first: the runs keep going and the new swarmupd adopts them, but their
  `swarmup` commands fail while the files are replaced.
- **Auto** pauses new runs and schedules, waits up to 3 hours for live runs to finish, then stops
  swarmupd, installs, restarts the app and swarmupd, and resumes new work. If swarmupd was already
  paused, Auto leaves that pause in place. A timeout or install failure clears an Auto-created
  pause and leaves a message in the Inbox.

Settings and the tray show downloading, waiting for live runs, and installing progress. A
development build run from a checkout never updates itself.

An update cannot safely move an existing installation out of an older install folder from before
the rename: the updater must replace the running installation in place,
and its shortcuts, PATH entry and swarmupd launcher all point there. To move it, let every run end,
quit SwarmUp from the tray, uninstall it, then run `SwarmUp-Setup.exe` and choose the new folder.
The installer recreates the shortcuts and PATH entry; do not drag the installed folder elsewhere.

## Run from a checkout

From the engine checkout:

```bash
pnpm install
pnpm run desktop   # builds the core, swarmupd and the UI, then opens the app
```

On the first start, when the user config has no `me`, the app asks for your id (default
`human:<OS user name>`) and the data roots to load (default: the root it was started in), then
writes the user config (`%APPDATA%\swarmup\config.yml`, `~/.config/swarmup/config.yml` or
`SWARMUP_CONFIG`) and starts `swarmupd`. An existing config keeps everything, comments and roots
included, and only gains a missing `me`. If a `swarmupd` that runs no agents is
already up, the app restarts it to load the config; one that runs agents keeps going, and the app
says to restart it. From a terminal, `swarmup init --user [--me human:NAME] [--root DIR]...` (or `swarmup setup`) does the
same.

The app starts `swarmupd` when none runs and connects to the one that does. A `swarmupd` started before
the engine was rebuilt runs an older build (its `GET /api/health` `build` differs from the one on
disk): the app restarts it at once when no run is live, and otherwise shows a banner and tries
again every 30 s, so no agent is cut off. Closing the window leaves `swarmupd` and every agent run
going; stop them with `swarmup daemon stop` (add `--kill-runs` to stop the runs too; a `swarmupd`
whose runs cannot outlive it refuses a stop without it while runs are live).

## Background service and tray

**Settings > Background service (swarmupd)** shows whether `swarmupd` runs, is paused or is stopped, with
its live runs; which `swarmupd` runs (pid, port, version and start time); and its build (when its code
was built), flagged when it is older than the app installed now. It has these controls:

- **Start**, **Stop** and **Restart**. Stop and Restart never stop a run, on Windows too: live runs
  keep going and the next `swarmupd` adopts them. A restart confirms itself with the new pid and start
  time, or says why it did not happen: the old `swarmupd` did not stop in time, or you kept live runs
  that cannot outlive it. A restart loads the code `swarmupd` starts from: the installed app's `swarmupd`
  gets a change merged into the engine repo only with a new build of the app (see
  [Start and stop](supervisor.md#start-and-stop)). While `swarmupd` is stopped, the runs' own `swarmup` calls
  that go through it fail until it is back. A `swarmupd` that reports runs cannot outlive it
  (`runs_outlive: false` in `GET /api/health`) ends its runs when it stops; with runs live, Stop
  and Restart (here and in the tray) then ask in a system dialog before they end them, and ending
  a run releases its claim. To let runs finish instead, cancel, pause new runs and stop when none
  are live.
- **Pause new runs** and **Resume new runs**. While paused, no wake, schedule, **Run now** or
  `swarmup launch` starts a run; helper runs of live runs still start, live runs finish, and sync,
  notifications and the API keep working. The pause is `swarmupd.paused: true` in the user config, so
  it lasts across restarts until you resume. From a terminal: `swarmup daemon pause` and
  `swarmup daemon resume`.
- **Start swarmupd**: **When I open the app** (the default) or **When I sign in to Windows**. Sign-in
  adds the app to your Windows sign-in apps (the per-user Run key, through Electron's login-item
  API) with `--background`: it starts in the tray with no window and starts `swarmupd`. Windows lists
  it under **Task Manager > Startup apps**, where you can also turn it off. The entry is written
  only when you pick the option, never in screenshot mode. It starts `swarmupd` in the folder you
  picked it from (`--ops-cwd`). The app reads the entry from the registry by its name,
  `SwarmUp`, so it still finds one made from a moved or replaced checkout: the card then shows
  the command the entry runs, with **Start this app instead** and **Remove the entry**. An entry
  turned off in Task Manager shows as off. Other systems get this later.
- **Notify me when I'm needed**: a Windows notification for each new question, review or vote
  addressed to you; clicking it opens the task. Off is `desktop.notify: false` in the user config.

While the app runs it has a tray icon (the notification area, bottom right of the taskbar): the
four tiles of the SwarmUp mark. They show the state: in colour while `swarmupd` runs, dimmed while
it is paused, grey outlines while it is stopped, with a blue dot while something waits for you. Its
tooltip and the top of its menu show `swarmupd`'s pid, start time, version and
build, and flag a build older than the app. Left-click opens the window; right-click offers the
same controls as the card (**Restart swarmupd** works like **Restart**, and a notification shows the
new pid and start time or why it did not restart), the items that need you, the notification
switch, a **Background service settings** link that opens **Settings > General**, **Quit SwarmUp
(swarmupd keeps running)** and **Quit and stop swarmupd**. Closing the window
keeps the tray icon. Quit closes the app only: `swarmupd` is a process of its own and keeps running
agents, and opening the app again connects to the same `swarmupd`. Quit and stop also stops `swarmupd`,
like **Stop**; if the stop fails or you cancel it, the app stays open. One app runs per person:
starting it again shows the open one.

## Views

| View           | What you do there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Inbox**      | What waits for you, grouped: questions to answer, workflow gates to decide (**Gates**, each with its question, its answers, **Approve** and **Reject** or **Send back**), milestone plans to approve (**Plans**, each with its item count and estimate sum, with **Approve plan** and **Send back**), reviews, decisions, tasks assigned or delegated to you, mentions; **Chat with the PM** opens Chat                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Board**      | Tasks by status; drag a card to another column to change its status (Working, Blocked and Review ask for what they need); swimlanes by agent, project, priority or milestone (tasks by their `milestone:` label); a milestone's card shows its plan's progress, such as `4/7 done, 9 h of 14 h`; ideas stay hidden until you turn on **Ideas**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Tasks**      | Search and filter by status, project, owner, role, provider, priority, type and label; sort by priority or update; due dates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Findings**   | Bugs, risks and ideas agents filed with `swarmup finding`: accept as a task or bug with a priority and owner, set aside as an idea, or park                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Standups**   | Per agent and person: done, in review, working on, blocked, runs and tokens, from the task history; `#standup` posts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Activity**   | Every task event and channel post across roots, newest first by day; filter by who, project and kind (work, reviews, talk, runs, findings and notes)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Reports**    | A week, 30 or 90 days: tasks opened, closed, parked, open and blocked per project; runs, minutes and tokens per provider and agent; decisions taken; channel posts; each agent's scores with a trend per scorer, the worst tasks per scorer and what each scorer measures on hover (see [Scores in the app](#scores-in-the-app))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Benchmarks** | Benchmark sets and their entries; runs with set, agent, model, effort, mode, pass rate, hidden pass, cost, time and live progress; a run's attempts with each criterion's result, the diff and the agent log; **Run benchmark** with a plan from a dry run first; **Compare** two runs with deltas (see [Benchmarks](#benchmarks))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Replay**     | Play a project's history from `GET /api/timeline` over a day, week, 30 or 90 days or custom dates as a 15, 30 or 60 s clip: play, pause, scrub, speed (0.25× to 4×), loop; **Space** plays, arrow keys step 1 s; **Project**, next to the time range, lists `All projects`, then each project of the sidebar (a data root, by its name) and, under a root whose tasks carry more than one project label, each label as `root / label`; the choice limits every scene, the review rally's task picker and the saved PNG and MP4 files, whose names carry it; scenes **Swimlanes** (one lane per agent, tasks as bars by state, review rounds as arcs, waits on a person glowing until answered, then the Human loop stat card), **Human loop** (agent work as a band of how many agents run at once against each human action as a tick; every ask to a person and review by a person a beam up, every answer and verdict a beam back down, while two counters run, then a 6 s stat card: agent hours, human minutes, asks answered, review rounds and tasks closed, where agent hours and tasks closed come from the report of the same window and match `swarmup report`), **Events**, **Counters**, **Metro map** (each task a line that branches off the main line at claim, review rounds as stations, human decisions as interchanges, parked ideas as stubs; time runs down on 9:16), **Wrapped** (stat cards from `wrapped=1`, the same figures as `swarmup wrapped`; for one root, as `swarmup wrapped` run in that root) and **Review rally** (pick a task with review rounds in the window, shown as `root/id` when two roots share the id; its rounds play as a fixed 10 s rally between author and reviewer, each return labeled with its verdict, ending on the last one); **Save frame** and **Save N cards** write 1920 x 1080 PNGs to a folder you pick, never overwriting a file; **Record MP4** renders the whole clip offscreen at 60 fps as H.264 in 16:9 (1920 x 1080), 1:1 (1080 x 1080) or 9:16 (1080 x 1920), with progress and **Cancel**, into a folder you pick first |
| Task panel     | Status and priority menus, owner as a tag, the conversation oldest first with each answer linked to its question, comments with `@` mentions and **Notify**, delegate with a due date and time, run an agent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Agents**     | What starts runs (wake, Run agent, schedules), **Create role**, each provider's usage and pause, work waiting with why, machines, agents by provider with live runs and backlog, agents ready without a role file; each agent's scores, with a 30-day trend and what to change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Runs**       | Every run with its log, followed live; readable or **raw**; its processes and **Kill leftovers**; **Start a run**; each run's model, effort, definition stamp, **resumed** badge and orientation; filters for resumed runs and by model                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Schedules**  | Recurring runs (swarmupd's cron): add, edit, pause, **Run now**, delete; templates for standups, inbox sweeps, nightly QA                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Automation** | Git triggers, merge-check trust and inbound webhooks on this machine: **Turn on here**, **Review and trust**, **Revoke trust**, the listener and **Direct action**; see **Automation** below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Workflows**  | Each project's workflows (`workflows/<id>.yaml`) with parameters, stages and gates: **New workflow** from a starter template or blank, **Edit** in a form or as YAML with a live check and a compiled preview, **Start**, **Delete**; see **Workflows** below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Repeating**  | Repeating tasks: a template that creates a task once, daily, weekly, on chosen weekdays, monthly, yearly, or when a task or all its subtasks close; add, edit, pause, **Run now**, delete; state, next slot, last task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Chat**       | One conversation with the orchestrator: replies stream in, what it changed shows as task links, `@*:orchestrator` posts from channels join it; **Stop**, **New conversation** (see [the supervisor](supervisor.md#chat))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Channels**   | **New channel**, read and post; `@id` in a message puts it in that inbox                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Decisions**  | **Log**: what people decided, with scope and source, **Include superseded**, and **Supersede** to record a replacement. **Votes**: tallies and ballots; decide ties and votes without quorum                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Knowledge**  | Learn notes from `kb/` by topic; search with the same matching as `swarmup kb`; links to the task a note came from. **Promote candidates** lists the notes that keep mattering (`swarmup kb --promote`) with why; **Fold into role** files the improver's task to turn them into rules in that agent's role file, and **Archive** moves a note to `kb/.archive/` with why (`swarmup kb archive`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Map**        | A project's map from `.swarmup/map/`: the root summary, nodes by kind or as a tree, search by words or a file path, a node with its covers and links, **Check**, **Rebuild index** and **Create map**; see **Map** below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Settings**   | swarmupd status and restart, health checks (same as `swarmup doctor`), data roots, the Master Repo and which project roots mirror into it, webhook notifications, run limits, providers, roles, which agents wake on work, MCP servers and their secrets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Agents and people are color-coded everywhere: the tile color and mark show the provider (Claude,
Codex, a person), the corner badge and the role name's color show the role (engineer, QA, PM,
docs). Priorities show as **Urgent**, **Medium**, **Standard** and **Low** for `p0` to `p3`; agents
and the files keep `p0` to `p3`. A due date alone means the end of that day; add a time in the
picker for an exact one.

The status menu and the board offer only moves the protocol has one action for: **To do**
releases, unblocks, reopens or requests changes; **Working** starts work (you take it, or an agent
run starts); **Blocked** asks why and on whom or what; **Review** asks for the reviewer; **Done**
closes; **Parked** asks why. Other moves are dimmed with the reason. Every move, from the status
menu, a board drop or the palette, opens a dialog and changes nothing until you click its button
there, so no stray pick, drop or Enter closes or reopens a task in your name.

Text that agents and people write shows as Markdown wherever it appears: the task description,
events and checkpoint in the task panel, Inbox messages, questions, review requests and triage
questions, Activity, Decisions (question, context, ballot reasons, outcome), Chat, Channels,
Standups, Knowledge, the Agents view's waiting list, schedule prompts and the task description of
each repeating task. Headings, lists, code and links render; task ids are links with a status dot
and `@id` mentions are colored pills. Titles stay one line. In lists (Inbox, Activity, Agents,
Schedules, Repeating) long text shows its first lines; click it or **Show more** to expand it, and
again to fold it. See
[event text](protocol.md#event-text-is-markdown) for how agents write it.

**Chat with the PM**, at the top of the sidebar and in the Inbox, opens **Chat**: one
conversation with the project's PM (the orchestrator), with no agent to pick. An answer never
closes it, and it survives a restart of the app. A task of type `question` that an agent answered
keeps its reply box: **Reply** reopens it with your text as the next round, and its owner answers
again.

**Settings** is split into **General**, **Projects**, **Agents**, **MCP servers**, **Runs**,
**Definitions**, **Cleanup**, **Updates**, **Notifications** and **Health**. It remembers the open category on this PC. App navigation and the
screenshot runner can link one directly as `settings:<category>`, for example `settings:updates`.
Settings writes the user config with its comments kept, and swarmupd applies the change at once.
Through swarmupd's API it changes limits, roles, a provider's `model`, `effort`, `max_live`,
`pause_at` and `paused`, removes a provider or resets a seeded one to default, adds, edits and
removes agents (`wake`, `budget`, `model`, `effort`), sync and roots only. **Effort** sits next to
**Model** on the **Providers** card in **Settings > Agents** and on each agent card in the
**Agents** view; see [the supervisor](supervisor.md#runtimes) for the levels each provider takes.
A provider card in the **Agents** view tags a usage window that holds only one model's runs with
that model, and says which model's runs wait while the others go on.

- **Providers.** `swarmup setup`, the app's first start and swarmupd's first start write the default
  providers (`claude`, `codex`) into the user config; from then on the config is the only source,
  and every provider is edited the same way. Each row shows whether its program is on swarmupd's
  PATH, the agents that run on it, and its model, most live runs, pause-at share and pause
  switch. **Add provider** and **Edit** take the name, the program, its arguments and the
  environment variables its runs must not see. Electron's main process, not swarmupd, writes those,
  after a system dialog shows the exact command line; the page and anyone holding the API token
  cannot change which program a run starts. **Remove** works for every provider and names the
  agents that use it first; their runs then do not start and say why. **Reset to default**
  restores a seeded provider's entry, and **Add back** returns a removed one. A paused provider
  starts no new runs; live runs go on.
- **Agents** (the Agents view). **Add agent** takes a provider from Settings, a role, a model and
  the Wake switch; an agent whose provider does not exist is refused. Each card edits Wake, the
  model and the budget, opens or creates the role file `agents/<provider>-<role>.md`, and removes
  an agent the config lists (its role file stays). A card whose provider was removed says
  **no provider**.
- **Role files.** **Create role** and **Edit** write the agent's role file in a data root:
  name, description, instructions (the body), `kb` topics and `files` to read first, a writing
  `style`, a budget and the task types it takes. swarmupd repeats the reading list and style in every
  run's prompt. The app never sets `tools`; edits keep other frontmatter. A role file's `model`
  sets the run's model unless the agent's own `model` in Settings overrides it; the app keeps
  its `mcp` as it is.
  Agents without a role file still run with the built-in prompt.
  - An agent of an [agent folder](definitions.md#agent-folders) shows a **folder** chip on its
    card. Its editor has two choices: **The &lt;role&gt; role** edits `agents/<role>/agent.md`,
    which every runtime of the role reads, and **Only &lt;runtime&gt;** edits
    `agents/<role>/<runtime>.md`, whose empty fields take the role's values and whose instructions
    come after the role's (or instead, with `body: replace`).
  - **Run settings and where they come from** lists the agent's model, effort, budget and its
    role's providers and limits, each marked **this machine** (your Settings), **swarm.yaml** or
    **role file**; a machine value that overrides git shows the git value it replaces.
  - A new role is written as `agents/<provider>-<role>.md`, or as a folder when the project's
    `swarm.yaml` names `swarmup_defs: 1`.
- **Workflows.** **New task** has **Start a workflow**: pick one of the project's workflows
  (`workflows/<id>.yaml`, see [Workflows](protocol.md#workflows)), fill in its parameters
  (required ones are marked; a list of options shows as a choice), optionally a milestone title,
  and **Start**. A workflow with `approval: starter` is approved by your start and its tasks are
  created; any other waits in **Plans**. In a milestone's plan a gate item shows a **Gate** badge
  with its question; the gate's own task panel has **Your decision** with **Approve** and
  **Reject**. Approve calls `done`; Reject calls `park` and needs a note. When the project has
  no workflow, the dialog says so and **Open Workflows** goes to the Workflows view.

- **MCP servers.** **Settings > MCP servers** lists the servers this machine defines
  (`swarmupd.mcp.servers`, see [MCP servers](supervisor.md#mcp-servers)), each with its command,
  the projects and agents it is granted to, its allowed and denied tools, and whether each secret
  it reads is set. **Add server** and **Edit** take the name, the program, its arguments, the
  environment (one `NAME=value` per line, `NAME=secret:KEY` for a value from `secrets.yml`), the
  projects, the agents, the tool rules and **Publish only**, which keeps a server from every role.
  **Remove** takes a server out of the config; its secrets stay. **Secrets** sets or replaces a
  value of `secrets.yml`, or removes it: a value is sent once and never shown, and swarmupd
  answers with names only. **Agents** shows, for each role file that names servers, the ones it
  asks for, the ones this machine does not define, and what its runs get in each project. A
  switch turns on `swarmupd.mcp.strict`. The page uses `GET /api/mcp` and
  `POST /api/mcp/servers`, `/api/mcp/servers/NAME/delete`, `/api/mcp/secrets` and
  `/api/mcp/strict`, which answer a run token with 403.

**Answer and Comment.** While a task waits on you, **Answer** closes the question and puts the
task back to to do, so the agent goes on; **Comment** adds a note and the task keeps waiting.
Ctrl+Enter sends the highlighted button: **Answer** while the task waits on you, else **Comment**.

**Done when.** The task panel lists a task's criteria (see
[Done when](protocol.md#done-when)), each with its kind (**Prose**, **Command**, **Check**,
**Rubric**, **Human** or **Map**), what it checks (the command, the built-in check and its
arguments, the rubric file and the score that passes, the question) and its last result: pass,
fail or n/a, the score, the note, the evidence under **Evidence**, who recorded it, when, and
whether a verdict, **Run checks** or the merge did. A milestone's one criterion shows with its plan.

- **Edit** (or **Add criteria** on a task without any) opens the builder: a row per criterion with
  its kind, an optional id and the fields that kind takes, moved up or down or removed, and an
  **Add** button per kind. Prose without an id saves as plain text with a position id (`c1`, `c2`,
  ...), as `task.md` writes it; give it an id or pick another kind to make it typed. **Save
  criteria** writes a `criteria` event with the whole list, as
  `swarmup criteria ID --set-file F` does (`POST /api/tasks/ID/criteria` with `done_when`, and
  `add: true` to append). The same rules apply: the task's creator, a person, the orchestrator or
  a PM on a task nobody holds may change them, and swarmupd's refusal shows under the form. A
  criterion you change or remove loses its last result.
- **Check builders.** Every built-in check has its fields: `file-exists`, `regex`, `word-count`,
  `char-count` (**Min**, **Max**, **Per** whole file, each block or each line, and a
  **Separator** line for blocks), `contains` (**Text**, all or any of them, must or must not
  contain, ignore or match case), `heading-structure` (**Headings** in order, exactly one h1, no
  skipped levels), `front-matter` (**Keys**, and **Match** as `key: pattern` pairs separated by
  `;`), `image-alt`, `image-size` (**Width**, **Height** and **Max KB**), `readability`
  (**Max grade** and **Min grade**), `page-contains` (**Page** the published URL or a **URL**,
  **Contains**, **Absent** and case; only with **Checked after publish**), `links-resolve` and
  `url-ok`. `char-count` also takes
  **Each link counts**, such as 23 for X. **Path** takes one path or several, comma-separated,
  and a glob such as `posts/*.md` checks every file it matches. A `check` or `command` row also picks **Checked at merge** or **Checked after
  publish**; a post-publish criterion shows **after publish** in the list and runs when a person
  records the publish with `swarmup published`.
- **Run checks** runs the task's `command` and `check` criteria, as `swarmup criteria check ID`
  does, in the task's worktree, else the root's code checkout, and records the results in one
  `criteria-check` event. It runs in swarmupd, in the background: each criterion shows **queued**,
  **running…** and then its result, and the button says how many are done. Only a person can
  start it, never a run's token (`POST /api/tasks/ID/criteria-check`; `GET` reads the running or
  last run).

**Review with criteria.** On a task with criteria that waits for your review, the task panel shows
**Review against the criteria** instead of the two plain buttons: **pass**, **fail** or **n/a** per
criterion with a note, and a score for a rubric. The `command`, `check` and `map` criteria show
their last result; the checks judge them, so you usually leave them unmarked. The results go with
the verdict as its `criteria` map. **Approve** with a criterion marked fail asks first; **Approve
anyway** sends the verdict with `force`, as `swarmup verdict --force`, and the thread marks it
**forced**. **Request changes** needs a message. In the Inbox, **Criteria** on a review reads the
task's criteria and gives the same choices. A verdict, a check run or a merge in the thread lists
its result per criterion, and a `criteria` event lists the new criteria.

**New task** has a **Done when** builder (the same rows as the task panel's) for any type but idea
and question; prose without an id is plain text. When swarmupd notes that the work has no
checkable criterion (only prose), the note shows as a warning and the task opens, so you can add
one under **Done when**.

**Brief.** A milestone, a task with children and a task that has a brief show **Brief**: the
newest `brief` event as Markdown with its author and when, and how many children are done.
**Edit** (or **Write a brief**) writes a new brief, as `swarmup brief ID --body-file -` does
(`POST /api/tasks/ID/brief` with `message`); a first one starts from the outline: outcome, done,
next, open questions, decisions in force. When children closed after the brief (or a milestone
has closed children and no brief), a hint names them; they are the ones the PM's inbox runs list
(see [Goal briefs](protocol.md#goal-briefs)). `brief` events show in the thread.

**Work.** When the task's latest review names artifacts (see
[Content work and publishing](protocol.md#content-work-and-publishing)), the task panel shows
**Work**: each piece the reviewer reads, at the reviewed commit, which the heading names.

- A Markdown file renders as it reads, its front matter shown as plain fields. Other text files
  show as text. The first Markdown file and the first images open on their own; click a file to
  open or fold it. The app reads a file only when it opens, with
  `GET /api/tasks/ID/artifact?path=PATH&commit=SHA`.
- **Changes** shows a word-level diff of the file against the same file at the merge base:
  added words underlined in green, deleted words struck through in red. A new file shows as all
  added.
- An image shows inline. A URL or a document is a link that opens in your browser.
- In **Done when**, a criterion's **Evidence** that names an artifact's path makes the path a
  link: click it to open that file in **Work**.

**Mark published.** An open `publish` task a person owns shows **Mark published**. After you post
the approved work, enter the URL it went live at and, optionally, the file you published, then
choose **Record publish**. It does what `swarmup published ID --url URL --artifact PATH` does:
tags the commit, writes the `publish` event, closes the task and runs its `when: publish`
criteria (`POST /api/tasks/ID/published`, never a run's token).

**Preview.** A publish task shows **Preview**: the approved files a publish hands over, at the
approved commit, with Markdown rendered as any text in the app is
(`GET /api/tasks/ID/preview`, as `swarmup preview ID` renders it).

**Publish.** A publish task with the label `publish:<name>` also shows **Publish**, which runs
that adapter on this machine (see [Publish adapters](supervisor.md#publish-adapters)). **Publish
now** does what `swarmup publish ID` does: it records the attempt, hands the adapter the approved
files and records the URL it prints. The form lists the files and the commit it sends, the same
ones **Preview** shows, and the publish uses exactly those, so a change after you looked can't
change what goes out. It runs once for the same files; tick **Again** to run it once more. A
failure shows under the button and leaves a comment on the task.

**Scores.** A task with scores shows **Scores**: the task's scores and its runs' orientation from
`GET /api/scores?task=<root>/<ID>`, each with its value and pass or fail. Hover a score for what
it measures, its threshold and what to change when it fails. Click a value for its breakdown
(see [Scores in the app](#scores-in-the-app)); **How scores work** explains the scorers.

**Resumed runs.** A `run-start` event of a run that resumed the session of an earlier one (see
[Resume after changes](supervisor.md#resume-after-changes)) shows **Resumed** in the thread; hover
it for the session id.

The window updates when `swarmupd` reports a change (Server-Sent Events): at once after a write
through the app, and within 3 seconds after an agent writes from the CLI. A message you send shows
in the open task at once; an item you handle in the inbox leaves with a confirmation that links to
the task. The app shows a desktop notification for each new question, review, decision or mention
addressed to you.

**Saved views.** Board and Tasks share one filter bar. **Save view** names the current filters (and the board's lanes) as a view under **Saved views** in the sidebar. Views are stored in the app on this machine, never in a data root.

**Search.** The box under **New task** (Ctrl+F from anywhere) searches every root: tasks by id (`AO-0047` or `47`), title, description and every comment, answer and verdict in their threads, plus learn notes, channel posts and votes. Every word must match; `"quoted words"` match together. Filters narrow it: `agent:` (an owner, author or anyone who acted on the item; a full id, a runtime such as `codex`, a role such as `qa`, or a name such as `dawid`), `status:`, `project:`, `type:`, `priority:`, `root:`, `is:open` or `is:closed`, and `in:tasks`, `in:notes`, `in:posts` or `in:votes`. Results drop down as you type; arrow keys and Enter open one, and Enter on the query opens **Search** with every result, grouped by kind. The same search is `GET /api/search?q=...`, which answers `{ hits, partial }`. Each request has a fixed work budget (file system calls and bytes read), so a search never blocks `swarmupd` on a large store; when a request reaches it, `partial` is `true` and the app says it searched part of the store. Each kind in each root gets a share of the budget, and `root:` skips the other roots before any work. Items read once stay cached, and each request picks up each folder where the one before it stopped, so searching again covers more; an item too large for a whole share is skipped.

**Map.** **Map** shows the [project map](map.md) of one project: `.swarmup/map/` in the root's
code checkout (`swarmupd.code.<root>`, else the repo its task store is in), or in the folder the
store is in for a project with no repo. Pick the project at the top right when you have several.

- The root node's summary is on top. The list groups nodes by kind, or shows them as a tree by id
  (`core`, then `core/fold`); a dot marks a node past its `review_after` date.
- The search box matches words the way `swarmup map <words>` does. A file path such as
  `src/fold.ts` lists the nodes that cover it, as `swarmup map --file` does.
- A node shows its kind, summary, size, `verified` commit, `review_after` date with **Review due**
  when it has passed, its `covers` (URLs open in the browser), its links and the nodes that link to
  it as chips that open them, and its Markdown body. **Graph** draws the nodes and their links.
- The badge in the header shows the last check: errors, warnings, or **Map OK**. The check runs
  when you open the view; **Check** runs it again and lists each error and warning with its node
  or path. It compares with the root's merge base (`swarmupd.merge.<root>.base`), else the default
  of `swarmup map check`; type another branch in **Base** to compare with that.
- **Rebuild index** rewrites `_INDEX.md`, as `swarmup map index` does.
- A project with no map offers **Create map**, with the detected type picked, as
  `swarmup map init` does.

Rebuild index and Create map write files in the checkout without committing them: commit them
with the work they belong to. A run's token cannot use them. The check and type detection run git
off swarmupd's event loop, so the rest of the app stays responsive while they run.

**Voice input.** Every composer (New task, comments, answers, channel posts, standups) has a
microphone button at its top right. Click it to start and click again to stop, or hold it and
release to stop; the text goes in at the cursor, or replaces the selection. Recordings stop after
five minutes. Turn it on in **Settings > Voice input**; it is off by default and then records
nothing.

- **On this PC (whisper.cpp).** Pick `whisper-cli.exe` from the
  [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases) and a model file such
  as `ggml-base.bin` from the [model list](https://huggingface.co/ggerganov/whisper.cpp/tree/main).
  Both are picked in a system file dialog; the page cannot name the program. Audio never leaves
  the PC: the main process writes the recording to a temporary folder, runs whisper.cpp on it, and
  deletes the folder.
- **OpenAI.** Sends each recording to OpenAI's transcription API (`gpt-4o-mini-transcribe`, or
  `desktop.voice.cloud_model` in the user config) with the key in `OPENAI_API_KEY` from the app's
  environment. The app never stores the key. Turning it on asks in a system dialog first.

The settings live under `desktop.voice` in the user config: `engine` (`off`, `local` or `cloud`),
`program`, `model`, `language` (`auto` or a code such as `pl`) and `cloud_model`.

**Keyboard.** Ctrl+K (Cmd+K on macOS) opens the command palette: find a task by id or title, go to a view, create a task, or move the open task (start, review, block, done, back to to do) through the same calls as the board. Outside text fields, `n` starts a new task, `/` focuses the view's search, `g` then a letter goes to a view (`g b` board, `g l` tasks, `g i` inbox, `g c` channels, `g k` knowledge, `g m` map), and `?` lists every shortcut.

**Back and Forward in the task panel.** Following a task link inside the open task panel (a thread, a comment, the parent, a blocked-on task, a message) keeps the task you came from. **Back** in the panel header returns to it, and **Forward** goes again after Back. Alt+Left, Alt+Right and the mouse back and forward buttons do the same outside text fields. A link to the task already open adds no step. Closing the panel clears the history, so a task opened from a view with no panel open has no **Back**.

### Scores in the app

The app shows the [scores](supervisor.md#scores) swarmupd keeps in `state.db`.

- **Breakdown.** Every score value is a link: on an agent card, in the **Reports** table, under
  **Worst tasks** (a scorer's name, across agents) and in a task's **Scores**. It opens the
  scorer's breakdown for that agent or task: what the scorer measures, the threshold and what
  pass means, the definition to change when it fails, the mean and how many pass, then every
  scored task or run, worst first, with its value, **pass** or **fail**, its note and its
  evidence. A task's title links to the task panel, a run to the run, and an event to the task
  scrolled to it. The criteria scorers (`criteria-pass-rate`, `verdict-completeness`) list each
  criterion of the approving verdict with **pass**, **fail**, **na** or **unmarked**, its note
  and its evidence; `cost-per-merged-task` lists the runs it summed with their tokens;
  `stuck-runs` lists the failed runs with why they ended; a rubric scorer shows the judge's
  score per rubric criterion and its reasons. Reports covers the report's window; the agent card
  and the task cover all time. The breakdown uses `GET /api/scores?scorer=S&agent=A&detail=1`
  (with `task=` or `since=` to narrow it).
- **How scores work**, next to the scores on an agent card, in Reports and in a task, explains
  where the data comes from (task events and run records; rubric scorers add an LLM judge), what
  pass means, and each scorer's description, threshold and lever.
- **Agents.** Each agent card lists its scorers: the value (an agent score, or the mean over every
  scored task or run), the count, the pass rate, **pass** or **fail** against the threshold, and a
  line of the last 30 local days, one point per day. Hover a point for its day, value and count.
  Click a scorer to open it: what it measures, the definition to change when it fails (its
  `lever`), and its worst tasks or runs, each a link to the task panel or the run. A failing scorer
  opens by default. An agent with scores but no role file or config entry gets a card too. A
  failing scorer offers **Propose an improvement**, which files a task for the improver to
  propose a change to the agent's definitions (see
  [self-improvement](supervisor.md#self-improvement)).
- **Proposals.** Above the providers, the **Agents** view lists each change to the definitions
  that waits for you: the variant and its hash, the agents and scorers it addresses, who proposed
  it and why, a link to its task, the diff of each file against the base, and its benchmark
  (**better**, **worse** or **same**, with the change in pass rate, hidden pass rate and cost, or
  that it runs or failed), and what the store's `improvement.requires` still needs before a
  promote, or that it is met. **Promote** writes it onto the definition files; **Reject** asks
  for a note for the improver. Both are yours alone: a run can't call them. The list always
  shows: with nothing waiting, it says what a proposal is and how one appears.
  - The improver's state heads the list: **Files tasks from failing scores** and **Folds learn
    notes into roles** turn `swarmupd.improve.enabled` and `swarmupd.improve.notes` on or off in
    your user config (`POST /api/improve/settings`); the benchmark gate, set as
    `swarmupd.improve.benchmark` in the user config, or that it is off; and per store, whether a
    promote needs a benchmark and how many proposals are open of `max_open_proposals`, with a link
    to **Settings > Definitions**, where `swarm.yaml`'s `improvement` section sets them. The page
    reads `GET /api/improve`.
  - **Propose a change** lets you write a proposal yourself: pick an agent with a role file, edit
    the file's text (it opens with the file as it is), say why, and optionally name a task to link
    it to. Without a task, it files an improvement task for you, labeled `improve`. The change is
    recorded as variant `<role>-by-hand` (numbered when taken) with `POST /api/defs/propose`; the
    role file stays as it is until you promote it. A run's token, or an `as` that is not a person,
    gets 403.
- **Reports.** The **Scores** table adds a trend under each value, over the report's own window:
  one point per hour for **Day**, else per day. Hover a column header for what the scorer
  measures, its threshold and what to change. **Worst tasks** lists the five worst tasks or runs
  per scorer across agents, each a link.
- **Runs.** A run's header shows the model and effort it started with, its definition stamp (the
  short hash, `d:` and 12 hex digits; hover it for the full hash, the last definition commit or
  **dirty**, and the settings this machine overrode), a **resumed** badge with the run it resumed
  from, and its orientation: tool calls before its first edit and the share of the run's tool
  output read by then, in amber when it fails the threshold. The list marks resumed runs and
  names each run's model. **Resumed** and the model menu under the tabs narrow the list and its
  counts.

A task or run trend counts each score at its subject's time, such as the approval or the run's
start. An agent score, such as `stuck-runs`, is a running figure: its point is the last value of
the day. The orientation shows only for runs whose log swarmupd read while it was kept.

## Definitions

**Settings > Definitions** shows each project's `swarm.yaml`, the team settings kept in git (see
[definitions as code](definitions.md)). Each project gets a card with:

- Whether the store has a `swarm.yaml`, the definition hash (`d:` and 12 hex digits), and the last
  commit that changed a definition file, or **uncommitted changes**. **Last good version in use**
  means the file has errors and swarmupd keeps the version before them.
- **Effective values**: each key the file sets, the value swarmupd runs with, and its source:
  **git** when the file gave it, **this machine** when your user config sets the key too (the
  git value shows next to it when they differ), **unused** when no provider on this machine takes
  it. Keys two projects set differently show which project wins.
- **Problems** as `file:line:col`, severity and message, for `swarm.yaml` and the agent files.
- `swarm.yaml` itself with line numbers, each line with a problem marked and its message under
  it. **Edit** opens it in place: the app checks the text as you type
  (`POST /api/defs/validate`), **Save** stays off while it has errors, and it saves the whole file
  at once. If the file changed since you opened it, the save is refused and nothing is written.

The actions:

- **Validate** checks the project's definitions with this machine's providers and agents, as
  `swarmup validate` does.
- **Import from my settings** previews `swarmup defs import-config` for this project: the lines
  it adds to `swarm.yaml`, comments kept. **Write swarm.yaml** or **Update swarm.yaml** writes
  it. Your user config keeps every key, so this machine still overrides them; the app never
  removes them.
- **Create swarm.yaml**, on a project without one, writes the commented template.

## Workflows

**Workflows**, in the sidebar under **Agents**, lists each project's workflows
(`workflows/<id>.yaml` in the task store, see [Workflows](protocol.md#workflows)): the title, the
file, whether your start approves the plan, the description, the parameters (required ones
marked `*`, options and defaults shown), the milestone and its check, and the stages in a row.
A gate stage is marked with its question and its person. A workflow that does not check shows
its problems by line. Each card has **Start** (the **Start a workflow** dialog with it chosen),
**Edit** and **Delete**.

- **New workflow** asks for the project, a starter template (feature, bug fix, content piece,
  campaign launch) or **Blank**, and the id (the file name), then opens the editor.
- The editor has three tabs. **Form** edits the common fields: title, description, approval,
  parameters (description, default, options, required; **Add parameter**, remove), the
  milestone's title and check, and each stage's key, title, owner, estimate, after, type,
  labels and check, with **A person approves here (gate)** for the gate's question, person and
  what a rejection does. **Add stage** and **Remove stage** change the list. The form writes the
  YAML in place, so comments and keys it does not show stay. **YAML** edits everything else,
  such as `when`, `rework`, `criteria` and typed checks. **Preview** compiles the workflow for
  values you type (defaults, else the first option, else `example`) and lists the milestone and
  each task with its owner, estimate, after and gate.
- Under the tabs, the problems of the text show as `line:col` and the message, from the schema
  and the compile, as you type (`POST /api/workflows/check`). **Save** stays off while there is
  an error.
- **Save** writes `workflows/<id>.yaml` in the store, and swarmupd's sync commits it like any
  other store change. A new workflow is refused when the id is taken; an edit is refused when the
  file changed since you opened it. **Delete** asks first, then removes the file; milestones it
  started keep their tasks.

The page uses `GET /api/workflows` (each workflow with `file`, `text`, `issues` and `def`),
`GET /api/workflows/templates`, `POST /api/workflows/check` (`{ id, text, root, params }`),
`POST /api/workflows/save` (`{ root, id, text, expect }` or `create: true`) and
`POST /api/workflows/delete` (`{ root, id, expect }`). Save and delete answer a run token, and an
`as` that is not a person, with 403; runs may read and check.

## Automation

**Automation**, in the sidebar under **Agents**, shows what git may start on this machine and
holds the decisions that only you make about it. It is the app's side of `swarmup triggers`,
`swarmup defs trust` and `swarmupd.hooks` (see [definitions as code](definitions.md)).

Each project gets a card with:

- A status line for its triggers: **Off on this machine**, **On but not trusted**, **Changed
  since you trusted it** (nothing fires until you review it again) or **Trusted**.
- Each trigger in `triggers/*.yaml` with its schedule or webhook, its action, its `runs_on`, and
  when it fires next here, or why it does not fire here. Trigger files with errors are counted;
  they are never trusted and never fire.
- Its merge checks in `swarm.yaml` and whether this machine trusts them.
- **Turn on here** and **Turn off** set `swarmupd.triggers.<root>`.
- **Review and trust** opens the exact trigger set and merge-check commands that the trust hashes
  cover: every field of each trigger (schedule, action, agent, prompt, task, params, `runs_on`,
  `enabled` and the `webhook` section) and each check's command and paths. Nothing is trusted
  until you click **Trust these on this machine**. If the files changed after the dialog read
  them, the trust is refused and nothing is written; open the review again.
- **Revoke trust** takes back the trust of both the triggers and the merge checks.

The **Inbound webhooks** card shows the listener: **Off**, **Listening on** its host and port,
or **Could not listen** with the reason. **Listener** turns `swarmupd.hooks.enabled` on or off.
swarmupd starts or stops the listener only when it starts, so the card says when the config and
the running listener differ and offers **Restart swarmupd**. Each webhook trigger shows its
verify scheme and whether `secrets.yml` holds its secret; the app never shows the value.
**Direct action** sets `swarmupd.hooks.direct.<root>.<trigger>`: it opens a warning first,
because each verified delivery then runs the trigger's action instead of filing a finding.
Turning it off takes effect at once. The last 20 lines of `hooks.log` close the card.

The page uses `GET /api/automation` and `POST /api/automation/triggers` (`{ root, on }`),
`/api/automation/trust` (`{ root, triggers, checks }`, the hashes you reviewed),
`/api/automation/revoke` (`{ root }`), `/api/automation/hooks` (`{ enabled }`) and
`/api/automation/direct` (`{ root, trigger, on }`). Every write answers a run token, and an `as`
that is not a person, with 403, so no agent can turn these on. The writes use the same config
edits and hash functions as the CLI, so a trust from the app equals one from `swarmup defs trust`.

## Benchmarks

**Benchmarks**, in the sidebar under **Work**, runs and reads [benchmarks](benchmarks.md) without
the command line.

- **Sets** lists the set files in each project's `.swarmup/benchmarks/` folder and the ones your
  user config names under `swarmupd.bench.sets`. Open a set to see its entries, their visible,
  hidden and pending criteria and their base. A set that does not read says why.
- **Runs** lists the runs in swarmupd's state folder (`bench/<run-id>/`) and in the folders
  `swarmupd.bench.results` names, newest first: when, set, agent, model and effort, mode, pass
  rate, hidden pass, cost, time and status. A run under way shows **Running** with its progress
  and updates every 2 seconds.
- A run's page has a figure row, a table per entry, and a card per attempt: checkable criteria
  passed, the hidden result, cost, time, tool calls before the first edit (orientation), the
  diff's size, and a table of criteria with **pass**, **fail**, **pending** or **na**. Click a
  criterion to see its evidence. **Diff** and **Log** open the attempt's `diff.patch` and its
  agent log. **Stop** ends a run under way and every process under it.
- **Compare**: tick two finished runs and click **Compare** to see them side by side, per entry
  and over the entries both have, with B minus A.

**Run benchmark** asks for the set, the entries (none picked runs all), the mode, the repo under
test and the hidden tests folder; for **Agent** mode, the agent, model, effort, repeats, the
budget per attempt and an optional **Cost cap (USD)** (`--max-usd`); for **Reference** mode, the
patches folder. **Review plan** makes a dry run
and shows its plan: entries × repeats, the agent and the budget. An agent run shows how many
sessions it starts and the most agent time they may take, and starts only after you tick that it
spends tokens on your account. **Reference** and **No agent** modes say they cost nothing. The run
is `swarmup bench run` in a background process with no window; closing the app does not stop it.
The form remembers the last values for each set on this PC.

A cost estimated from tokens, which is how Codex runs get one, shows with `~`, such as `~$0.31`.
With more than one repeat, the entries table adds **Spread** (the pass-rate range and its
standard deviation), and a run with a cost cap says what it spent and whether the cap stopped
it.

## Add project

**Add project**, at the top of the sidebar's **Projects** list and under **Settings > Data
roots**, adds an existing repo as a project without a terminal:

1. Pick the repo's folder in the system dialog. The folder has to be a git repo, because agent
   runs work in git worktrees of it.
2. Review the proposal. It shows what the survey found (languages, frameworks, tests, build,
   lint, docs, CI), the project name and id prefix, the roles, and the first tasks. Change the
   name and the prefix, and clear the tasks you don't want. Nothing is written yet.
3. Choose where the tasks live:
   - **In this repo** (default): a `.swarmup/` folder in the repo.
   - **In a separate folder**: for a public repo whose tasks stay private. Pick or create a
     folder outside the repo; a folder outside git gets `git init`. The user config then names
     the repo as the project's code checkout (`swarmupd.code.<name>`) and sets
     `swarmupd.merge.<name>` with `base` (the branch checked out in the repo) and `checkout`
     (the repo). See "Code in a checkout of its own" in [supervisor.md](supervisor.md).
4. Click **Create**. The app writes the store and the first tasks with the same code as
   `swarmup adopt --apply`, adds the store folder to `roots` in the user config (comments and
   other keys stay), and tells swarmupd to read the config again. The project shows in the
   sidebar at once; no restart.

If the folder already has a data root (`.swarmup/` or `.agent-ops/`), **Add project** skips the
proposal and only adds the folder to `roots`. Errors, such as a folder that is not a git repo or
has no write access, show in the dialog. A project in the sidebar opens **Tasks** filtered to it.

## Manage projects

Right-click a project in the sidebar to **Edit name**, **Edit location**, **Archive** or **Delete**.
Edit location opens the system folder dialog and points SwarmUp at the data root in the folder you
pick; it moves nothing. Archived projects leave the board and no new run starts for their tasks.
They stay in the collapsed **Archived** group under **Projects**, where the same menu offers
**Unarchive**. **Delete** removes only the user-config entry after confirmation: it never deletes or
changes the project's folder or files. A refused change shows swarmupd's error in the app.

## Security

- The page talks to `swarmupd` only through Electron's main process, which holds the API token; the
  page never sees it. The main process accepts only `/api/` paths.
- The page never names a folder to **Add project**: the main process uses only the folders you
  pick in the system dialog, and refuses calls that don't come from the app's own page. **Edit
  location** uses the same boundary: the renderer names the existing project, and the main process
  alone sends the folder picked in the system dialog to swarmupd.
- The window runs with context isolation and the renderer sandbox, without Node, under a content
  security policy that allows only the app's own files.
- Task text, comments and messages come from agents, so Markdown is sanitized before it is shown.
- Links open in the browser; the window never navigates away from the app.
- The app refuses every browser permission except the microphone, and grants that only to its own
  page in its own window while voice input is on. No page gets the camera, the screen, location or
  notifications.

## Screenshots for checks

`SWARMUP_SCREENSHOTS=<dir>` renders the app offscreen, saves one PNG per view in
`SWARMUP_VIEWS` (default every view; `task:<id>` and
`runs:<id>` open one task or run), and quits. It needs no GPU or visible desktop. Screenshot mode
has no system dialogs, so the view `add-project` takes its folders from
`SWARMUP_SCREENSHOT_PICKS` (in order, separated like `PATH`), and `add-project:create` also
creates the proposed project. `replay:export-mp4` and `replay:export-gif` take their folder from the
same list, start that export, capture it once its progress bar shows 10-90%, then cancel it; the
run fails when the bar never gets there or Cancel does not stop it.

## Smoke check

`pnpm run smoke:desktop` (after `pnpm run build:desktop`) renders every view and the **Add
project** proposal offscreen against a scratch data root and fails when a view logs an error, a swarmupd call fails, or the allowlist refuses
a call. It stops the scratch swarmupd it started. The release workflow runs it on Linux under
`xvfb-run` for every `v*` tag.

## Record check

`pnpm run check:record` records 30 s clips of the **Events** scene in 16:9, 1:1 and 9:16 with
Electron's own H.264 encoder, under the app's page CSP. It fails unless each MP4 has 1800 frames
at 60 fps, the right size and a 30 s duration, plays to the end in Chromium's video player, and
shows a drawn, moving picture; when `ffprobe` is on `PATH`, it counts the frames too. Pass
`--software` to turn the GPU off, `--seconds N` or `--aspects 16x9` for a shorter run, and
`--keep` to keep the clips.
