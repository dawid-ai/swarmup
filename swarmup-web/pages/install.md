# Install SwarmUp

This guide takes you from a clean Windows machine to a first task done by an agent, in about
15 minutes.

## What you need

- Windows 10 or 11, with your normal user account. The installer needs no administrator rights.
- [Git](https://git-scm.com/download/win). SwarmUp keeps tasks in a git repository.
- At least one coding agent from your AI provider, installed and signed in. Today that is
  [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`) or
  [Codex](https://github.com/openai/codex) (`codex`); more providers are on the way. Agents run
  under your own plans and keys; SwarmUp never sees them.

## 1. Install the app

1. Download the installer from the [download page](download.html) and run it.
2. Windows SmartScreen asks first, because the installer is not code-signed yet: choose
   **More info**, then **Run anyway**.
3. Leave **Add the swarmup command to my PATH** checked, so `swarmup` works in PowerShell, Command
   Prompt and Git Bash.

The installer puts the desktop app, the orchestrator and the `swarmup` command in your user folder.
The orchestrator is the background process that starts your agents, keeps them within your limits
and merges approved work; its program and log files are called `swarmupd`. The app updates itself:
a new version downloads in the background and installs once no agent run is live and the window is
closed.

## 2. Make a folder for your tasks

Tasks live in a git repository of their own. Open a new terminal, so it picks up the new PATH:

```sh
mkdir my-tasks
cd my-tasks
git init
swarmup init --name my-tasks --human human:you --with-agents
```

`--with-agents` adds the starter agent roles, such as `codex:backend`, `claude:docs` and
`claude:qa`. `swarmup agents` lists them. To share the queue with another machine, add a git
remote; `swarmup sync` commits and pushes it.

## 3. Start the app

Start **SwarmUp** from the Start menu. On the first start it asks for your id (such as
`human:you`) and the folder that holds your tasks: pick `my-tasks`. Then it starts the orchestrator
and shows your inbox.

Check the machine from a terminal:

```sh
swarmup doctor
```

It reports the user config, your task folders, whether `claude` and `codex` are installed and
signed in, and whether the orchestrator runs. Fix anything it marks before you go on.

## 4. Give an agent its first task

The orchestrator starts paused, so nothing runs until you say so. Create a task, resume the
orchestrator and start a run:

```sh
swarmup new "Add a README to this folder" --to codex:backend --as human:you
swarmup daemon resume
swarmup launch codex:backend --task T-0001 --budget 30m
```

With Claude Code instead of Codex, use `claude:docs` in both commands. `swarmup new` prints the
task id; use it in `--task` if it is not `T-0001`. Watch the run in the app's **Runs** view, or
with `swarmup runs` and `swarmup logs RUN`. The agent finishes with a review, which lands in your
inbox: read the result, then approve it or ask for changes.

To have the orchestrator start agents on its own when work arrives, turn on **wake** for them in
the app's **Settings**, or set `wake: true` in the user config (see
[the supervisor docs](../../docs/supervisor.md)).

## macOS and Linux

The desktop installer is Windows-only today. On macOS and Linux, run SwarmUp from source with
Node.js 22 or later and git:

```sh
git clone https://github.com/dawid-ai/swarmup.git
cd swarmup
npm install
npm run build
npm run swarmup -- help
```

Then follow steps 2 to 4 with `npm run swarmup --` in place of `swarmup`, and start the
orchestrator with `npm run swarmup -- daemon start`. `npm run desktop` opens the app from the
checkout.

## Next steps

- [How SwarmUp works](../../README.md): tasks, agents, the orchestrator and how data is stored.
- [The protocol](../../docs/protocol.md): statuses, reviews, handoffs and permissions.
- [The desktop app](../../docs/desktop.md): every view and setting.
- [The changelog](../../UPDATES.md): what changed in each release.
