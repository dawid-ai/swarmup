# Supervisor (swarmupd)

`swarmupd` runs once per machine. It starts agent runs, watches them, renews their claims, ends them
when they run over budget, runs schedules, wakes agents when work arrives, syncs the data roots, and
serves a local API for the desktop app. It replaces v1's `launch.sh`, `waitpids.sh` and `watch.sh`.

## Start and stop

```bash
swarmup daemon start            # in the background, no window; log in <state>/opsd.log
swarmup daemon status           # pid, port, version; exit 3 when not running
swarmup daemon stop             # runs keep going; the next swarmupd adopts them
swarmup daemon stop --kill-runs # also stop every run
swarmup daemon restart          # stop and start; live runs keep going and are adopted
swarmup daemon pause            # no new runs or schedules until resumed; live runs finish
swarmup daemon resume
swarmup daemon run              # in this terminal, until Ctrl+C
```

On Windows, Node puts each child it starts into a job object that ends the child when `swarmupd`
exits, and starting runs detached would leave them without a console, so their own console tools
would open visible windows. `swarmupd` starts each run there through a hidden `cmd.exe` that runs a
small launcher (`node -e`, with a fixed command line). The job lets that shell's children break
away, so the launcher runs outside the job and keeps the hidden console when the job ends the
shell.

1. The launcher sends its PID to `swarmupd` over a named pipe with a random name.
2. `swarmupd` reads the launcher's creation time while it waits, and saves its PID, image and
   creation time in the run record (`shim_pid` keeps the shell's).
3. Only then does `swarmupd` send the command, its arguments, its environment and the prompt. The
   launcher starts the command as its own child, in a kill-on-close job, and forwards the prompt
   to its stdin.

No argument passes through a `cmd.exe` command line, except for a `.cmd` or `.bat` runtime, which
`cmd.exe` must read: there, an argument with `"`, `%`, `!`, CR or LF is refused at launch. If
`swarmupd` exits, aborts the launch or fails to record the launcher, the pipe closes and the launcher
exits without starting anything. Killing the launcher ends the command too. A stop gives a run
still launching up to 5 s to finish, then ends it here and releases its claim, so every run
handed to the next `swarmupd` names a launcher it can adopt by PID and creation time.

`GET /api/health` reports `runs_outlive`. Where it is false, `swarmupd` refuses a stop or restart
without `--kill-runs` while runs are live (exit 1, nothing changes), and Ctrl+C on
`swarmup daemon run` ends the runs and releases their claims.

A stop waits up to 15 s for the old process to exit. If it is still alive, the stop fails and a
restart starts no second `swarmupd`.

A start waits up to 75 s for the new `swarmupd` to answer while its process runs, and stops waiting
as soon as that process exits. Before it answers, `swarmupd` reads process creation times (its own for
the lock, a stale lock holder's, and those of the runs it adopts); on Windows each read starts
PowerShell, which a loaded machine can hold up to its 15 s timeout.

`swarmupd` is a process of its own, not part of the desktop app. Closing the app's window, or
**Quit SwarmUp** in its tray menu, leaves `swarmupd` running agents. To stop it as well, use
**Quit and stop swarmupd** in the tray, **Stop** in **Settings**, or `swarmup daemon stop`. A restart
from the tray (**Restart swarmupd**) or **Settings** (**Restart**) works like `swarmup daemon restart`:
live runs keep going and the new `swarmupd` adopts them. It reports the new pid and start time, or
says why it did not happen, such as a stop that timed out or live runs that cannot outlive
`swarmupd` and that you chose to keep.

A restart loads the code `swarmupd` starts from, which is not always the code just merged. The
installed app's `swarmupd` runs the app's own files (for example `C:\Program Files\SwarmUp`), so a
change merged into the engine repo goes live only with a new build of the app. **Settings** and
the tray tooltip show the running `swarmupd`'s pid, start time, version and build, and flag a build
older than the app installed now. After `swarmupd` merges a change to its own code (files under
`packages/supervisor/` or `packages/core/`, without tests and Markdown) into the engine repo, it
tells you once, in `#general` with a mention, that the running `swarmupd` does not have it yet: restart
it when it runs from the checkout it just built, build that checkout first when the build did not
run, or install a new build of the app when it runs the installed app.

A pause is `swarmupd.paused: true` in the user config, so it holds across restarts, and a stopped
`swarmupd` starts paused. While paused, `swarmupd` refuses every new run (wakes, schedules,
`swarmup launch`, **Run now**) with the reason in `swarmup waits`; helper runs of live runs still start.
Sync, notifications, presence and the API keep working.

The `swarmupd` command (`packages/supervisor/dist/main.js`) takes the same verbs. Start swarmupd from a
folder inside a data root, or list roots in the user config, so it finds the tasks.

State lives in `~/.swarmup/swarmupd/` (or `SWARMUP_STATE_DIR`) and is never committed:

| Path                 | Content                                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `opsd.json`          | pid, port and API token of the running swarmupd (mode `0600` on Linux and macOS)                                                                                                                                                                 |
| `opsd.lock`          | PID and creation time of the running swarmupd; one swarmupd per state folder, even when two start at once. A lock is replaced only when its holder is certainly gone; if swarmupd cannot tell, it refuses to start and names the file to delete. |
| `opsd.lock.takeover` | held for a moment while a starter replaces a stale lock; never reclaimed automatically. If a start crashed while holding it, swarmupd refuses and names it.                                                                                      |
| `opsd.log`           | the supervisor's own log                                                                                                                                                                                                                         |
| `runs/<id>.json`     | one record per run: agent, task, pid, budget, tokens, outcome                                                                                                                                                                                    |
| `logs/<id>.log`      | the run's output (Claude `stream-json`, Codex `--json`)                                                                                                                                                                                          |
| `schedules.json`     | when each schedule last ran                                                                                                                                                                                                                      |
| `wake.json`          | which inbox items each waking agent was last started for                                                                                                                                                                                         |

## Runs

```bash
swarmup launch codex:engineer --task AO-0009 --budget 2h --tokens 400k
swarmup runs                    # live runs; --all for the last 30
swarmup logs 7Q2K               # end of a run's log; a run id or its last characters
swarmup kill 7Q2K               # stop the run and its process tree
swarmup procs 7Q2K              # every process the run started; --kill stops what an ended run left
swarmup usage                   # each provider's usage allowance, and whether it pauses new runs
swarmup waits                   # what waking agents could start, and why each waits (needs swarmupd)
swarmup spawn -m "look up X"    # inside a run: start a helper under the run's claim
swarmup procs 7Q2K --kill --pid 4120   # stop one of them, such as an unsure one you checked
```

A run with a task:

1. swarmupd checks the launch, then claims the task for the agent before the process starts, so two
   runs never race for it. If starting the process fails, swarmupd releases the claim it took.
2. It starts the runtime with the prompt on stdin, `SWARMUP_AGENT`, `SWARMUP_RUN`, `SWARMUP_ROOTS`,
   `SWARMUP_RUN_TOKEN` and `SWARMUP_RUN_STATE_DIR` set, and writes a `run-start` event on the task. See
   [Run tokens](#run-tokens).
3. While the process lives, it renews the claim when less than half of the lease is left (a `renew`
   event), counts tokens from the log, and kills the run when it passes its time or token budget.
4. When the process ends, it writes a `run-end` event (exit code, reason, minutes, tokens). If the
   agent still holds the task, swarmupd releases it, so the task goes back to the queue at once instead
   of waiting for the lease to run out.

The budget comes from `--budget`, then the task's delegation (`swarmup delegate --budget`), then the
agent's `budget` in the swarmupd config, then the role file's `budget_min`, then `budget_minutes`
(default 180). The token budget comes from `--tokens`, then the delegation. Tokens counted are
input, cache writes and output; cache reads are left out.

### Learn notes in the prompt

The standard prompt of a task run (work, review or question) lists up to 3 learn notes that may
apply to the task, so the agent sees them without searching `swarmup kb`. swarmupd matches the task's
title and description against each note's title, tags and topic:

- Any word may match. Words under four letters and very common ones (`that`, `with`, `task`) are
  left out.
- A word weighs more the fewer notes and task titles hold it, so words most of them share, such as
  `run` or `claude`, count for little.
- A word in the task title counts twice as much as one only in the description. A note is listed
  only when a word of the task is in the note's title, tags or topic; overlap between the task
  description and the note body alone never lists a note.

The list is a hint: the agent reads the ones that fit with `swarmup kb --read <ref>`. A note ref
that exists in several roots is listed as `<root>/<topic>/<slug>`. Each list is recorded in
`kb-shown/` so `swarmup kb --usage` and `--stale` count prompt exposure separately from explicit
reads. A work run's prompt also asks the agent to write a learn note before it finishes if the next
agent should know something; a review run's prompt asks the reviewer to write one when the work took
several review rounds.

### The review prompt

A review run's prompt tells the reviewer what to review against and what it may run:

- **Scope.** The reviewer reviews against the task text and its "Done when". It approves work
  that meets them and asks for changes only where the work does not. Style and matters outside
  the task stay out of the verdict; the reviewer files them with `swarmup finding`.
- **Checks.** The reviewer builds the reviewed commit and runs its tests and checks itself, in a
  worktree and never in the checkout swarmupd merges into: the task's own worktree
  (`out/wt-<ID>`) when it is clean and at that commit, else a detached one it adds in its
  scratch folder (`$SWARMUP_SCRATCH`). The verdict names each command and its result, and each
  check the reviewer could not run, with the reason.
- **No changes.** The reviewer never edits files, commits or pushes. Logs and test output go in
  the scratch folder.

- **Changes to tests and check configuration.** The merge `checks` run in swarmupd's worktree,
  but on the tests and the configuration the branch itself has: a branch that deletes or skips a
  test, or loosens a check, still passes them. So when the reviewed work changes such files, the
  prompt ends with a list of them and tells the reviewer to check that the task needs each
  change. See [Changes to tests and check configuration](#changes-to-tests-and-check-configuration).

A reviewer's role file should say the same and, for Claude, list the tools the checks need (such
as `Bash(npm test*)`, `Bash(npm run *)` and `Bash(git worktree *)`): a Claude run is allowed only
its role file's `tools`. A Codex run of a role that does not write can write only its task store
(see [Runtimes](#runtimes)), so a check that writes build output in the worktree fails there; the
verdict then names it as not run.

#### Changes to tests and check configuration

Before a review run starts, swarmupd compares the work the newest review request names with the
point where it left the base branch (`swarmupd.merge.<root>.base`; without a merge setting, the
remote's default branch, else `main` or `master`). It reads the repo only, with git, and checks
nothing out. The review prompt then lists:

- **Test files** that the work changes, deletes or moves, and each one where it adds a line that
  skips or narrows tests, such as `it.skip(`, `describe.only(`, `xit(`, `@pytest.mark.skip` or
  `t.Skip(`. A new test file is listed only when it adds such a line.
- **Check configuration** that the work adds, changes or deletes: test, lint, format and type
  check configuration, CI files and git hooks. A `package.json` is listed only when its `scripts`
  differ.

Deleted and skipped tests come first; the list names 40 files and counts the rest. swarmupd flags
only: the review starts as usual, nothing is blocked, and the prompt says that many tasks change
tests for good reason. Work that changes no such file adds nothing to the prompt. Neither does a
review that names no commit or branch the repo has.

The patterns are set per root, next to `merge` in the user config:

```yaml
swarmupd:
  test_changes:
    v2: # the root's name
      tests: ['**/test/**', '*.test.*'] # test files
      checks: [package.json, 'vitest.config.*', '.github/workflows/**'] # check configuration
    notes: false # no list for this root
```

- A pattern without `/` matches the file name in any folder (`*.test.*`, `package.json`). With a
  `/`, it matches the path from the top of the repo. `*` and `?` stay inside one path segment,
  `**` crosses folders, and a pattern that ends in `/` covers the folder.
- A root without an entry, and a list left out, take the defaults. Tests: `**/test/**`,
  `**/tests/**`, `**/__tests__/**`, `**/e2e/**`, `*.test.*`, `*.spec.*`, `*_test.*` and
  `test_*.py`. Check configuration: `package.json`, the configuration of Vitest, Jest,
  Playwright, Cypress, Karma, Mocha, pytest, tox, ESLint, Prettier, Biome, Ruff and golangci-lint,
  `tsconfig*.json`, `.github/workflows/**`, `.gitlab-ci.yml`, `.circleci/**`,
  `azure-pipelines.yml`, `Jenkinsfile`, `.husky/**`, `lefthook.yml` and
  `.pre-commit-config.yaml` (`DEFAULT_TEST_PATTERNS` and `DEFAULT_CHECK_PATTERNS` in
  `packages/supervisor/src/test-changes.ts`).
- A list you set replaces the defaults; `[]` lists no file of that kind.

The list reaches a review run that swarmupd starts. A review that goes to a person has no
prompt: the task's diff in the app shows the same files.

### Runtimes

| Runtime  | Command line                                                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude` | `claude -p --permission-mode acceptEdits --output-format stream-json --verbose [--model M] --allowedTools ... --disallowedTools ... --add-dir ...` |
| `codex`  | `codex exec [-m M] --json --sandbox workspace-write --skip-git-repo-check -C <cwd> --add-dir ... -`                                                |
| other    | the config's `command` and `args`, prompt on stdin                                                                                                 |

- The providers come from the user config only, once it is seeded (`swarmupd.seeded`). `swarmup setup`,
  the desktop's first start and swarmupd's start write the defaults (`claude`, `codex`) once; a
  machine with no config file also gets the default agents (`engineer`, `qa`, `reviewer` and `pm`
  for each default provider found on PATH). A config from before seeding gets the defaults
  written on the next swarmupd start, with a note in the swarmupd log, and keeps every entry it had.
- The model of a run is the agent's `model` in the config, else its role file's `model`, else the
  provider's `model`. A model is one word that cannot start with `-`. Other runtimes get no model
  flag.
- A run of a provider the config does not list, such as one removed in Settings, does not start:
  `swarmup waits` and the launch error say `no provider '<name>' in Settings > Providers`.
- Claude's allowed tools are the role file's `tools` (or a default dev set) plus `Bash(swarmup *)` and, until 0.4, `Bash(ops *)` for the old command name.
  Kills by name (`taskkill`, `pkill`, `killall`, `Stop-Process`), force pushes, and `Edit` or
  `Write` against any data root's `agents/` directory are always denied. A run of a role that does
  not write (`roles.<role>.writes: false`, the default for `qa`, `reviewer` and `orchestrator`)
  gets `Edit`, `Write` and `NotebookEdit` denied as well, even when its role file lists them.
- Role-file `mcp` fields are preserved metadata; the supervisor does not configure a run from them.
- Runs inherit swarmupd's environment and act as the human's accounts; task events record which agent
  did what. Codex's sandbox blocks network access and `.git` writes. A runtime's `unset_env` lists
  variables its runs must not see; no default runtime sets one.
- `--add-dir` gives the run every data root's repo that is not inside its working folder.
- A Codex run of a role that writes also gets `worktrees`, `objects`, `refs` and `logs` of its
  checkout's shared git folder (`git rev-parse --git-common-dir`) as `--add-dir`, so it can
  commit in a worktree such as `out/wt-<id>`, whose index and lock files live in
  `<common>/worktrees/<name>`. swarmupd makes `worktrees` and `logs` when they are missing. The
  shared git folder itself stays read-only: the run cannot change `config` or `hooks`, or the
  main checkout's `HEAD` and `index`.
- A Codex run of a role that does not write starts in its task store, not in its checkout:
  `-C <store>`, with every other data root's folder as `--add-dir`. Codex's sandbox always lets a
  run write its working folder, so this keeps the checkout and the other repos read-only while
  the run's `swarmup` commands still write the task store. The run's scratch folder is one more
  `--add-dir`, since `TEMP` points there, unless it holds the checkout or a store. The prompt
  names the checkout and the scratch folder, tells the run to read the checkout by path and to
  run `git -C <checkout>`, and says that swarmupd syncs the store when the run ends: the sandbox
  keeps every `.git` read-only and has no network, so the run's `swarmup sync --session-end`
  only reports that and exits 0. If the run has no task store, it gets `--sandbox read-only` in
  its checkout instead.
- **Checks for a reviewer that cannot run them (AO-0296).** A build, a test run and an install
  all fail in that sandbox. So before a review run of a Codex agent whose role does not write,
  swarmupd runs the root's merge `checks` (`swarmupd.merge.<root>.checks`) itself: it checks out
  the commit the newest review request names (`<commit> on branch <name>`, else the branch tip,
  as a merge picks it), as it is and not rebased, in a worktree of its own
  (`<state>/review/<root>`, kept between reviews so installed packages stay), and runs the
  commands there in order until one fails. The review run starts once they are over; `swarmup
waits` says `starts once swarmupd has run the checks of the reviewed commit` meanwhile. Its
  prompt ends with each command and its result, the end of a failed command's output, and the
  commands that did not run after it; the whole output is in `review-checks.log` in the run's
  scratch folder. The prompt tells the reviewer to name them in its verdict as run by swarmupd.
  A failed check does not send the task back by itself: the reviewer decides. When swarmupd
  cannot run the checks (no review request names a commit or branch the repo has, git fails),
  the run starts anyway and its prompt says why. One set of checks runs at a time, none starts
  during a merge, and no merge starts during them. Checks stopped with swarmupd or broken by
  the PC's sleep run again; results are kept in memory, so a review that has not started when
  swarmupd restarts gets its checks run again. The swarmupd log has a `review-checks` line for
  each step. Reviewers of other runtimes run their own checks and get none of this; a root
  without `checks` gets none either. Set `swarmupd.review_checks: false` to turn it off.
- The working folder is `--cwd`, then the agent's `cwd` in the config, then the top of the task's
  repo.
- When the working folder is a data root's checkout (the git checkout that holds a `.swarmup/`
  folder swarmupd knows), the branch checked out there carries the task store. The run's prompt names
  the store branch (`sync.branch`, else the learned one) and tells the run never to run
  `git checkout` or `git switch` there, and to make code branches in a worktree inside the
  checkout, such as `git worktree add out/wt-<ID> -b <branch> <base>`. A custom prompt (a
  `--prompt-file`, a helper's instructions, a chat turn) gets the same rule appended under
  `Rule for this folder:`, so no launch path skips it. A Claude run there also gets
  `Bash(git checkout*)` and `Bash(git switch*)` denied; Codex has no deny list and relies on the
  prompt. A run in a linked worktree is in no data root's checkout and gets neither. Linked
  worktrees inside a checkout are never changes of it: they do not hold back a writing run, and
  swarmupd never commits them with what a run left.
- **Task worktrees (AO-0168).** A run on a code task (type `task`, `bug` or `feature`) of a role
  that writes, whose folder would be a data root's checkout, starts in the task's own worktree
  `out/wt-<ID>` inside that checkout instead. Not for an explicit `--cwd`, an agent with its own
  `cwd`, a helper, a review, a question or a chat turn. A worktree that is there is reused as it
  is, so a task's later runs go on with its branch. A missing one is made on branch
  `<runtime>/<id>` (lowercase), from that branch when it exists, else from the root's
  `swarmupd.merge` base, else from the checkout's `HEAD`. Wake makes it off the event loop and starts
  the run at a later tick (`swarmup waits` says `starts once swarmupd has made its worktree <path>`); a
  launch from the API or a schedule makes it before it starts. When git cannot make it, or
  something that is not a worktree is at that path, the run starts in the checkout as before,
  and swarmupd tries again 10 minutes later; the swarmupd log has a `worktree` line for each made one and
  a warning for each failure. The prompt names the worktree and its branch and tells the run to
  commit there and leave the store checkout's branch alone. The worktree holds a copy of the task
  store as of its branch, so a run whose folder holds such a copy gets `SWARMUP_ROOTS_ONLY=1`: its
  `swarmup` uses only `SWARMUP_ROOTS`, the copied root first, never the stale copy. To keep such runs in
  the store checkout, one writer at a time, set `swarmupd.task_worktrees: false`.
- **Code in a checkout of its own (AO-0252).** A task store can be a repo of its own, so the code
  repo can be public while tasks and chats stay private. Name the code checkout per root in the
  user config:

  ```yaml
  swarmupd:
    code:
      agent-ops: C:\dev\swarmup # the root's name: the code checkout
    merge:
      agent-ops:
        base: main
        checkout: C:\dev\swarmup
  ```

  Runs then start in that checkout instead of the store's. Task worktrees are made there
  (`<code>/out/wt-<ID>`), and run leftovers and task branches go to its repo. Reclaiming and
  pushing task branches work on its worktrees and remote. The prompt calls it the checkout
  swarmupd merges into, with the same rule as a store checkout: keep its base checked out, and
  make code branches in a worktree. Because no store sync pushes that repo, swarmupd pushes the
  merged commit to its base on the remote after each merge, after the same secret check task
  branches get. It never forces the push, and a refused push is a warning in the swarmupd log.
  `swarmupd.push_branches.<root>: false` turns that push off too. Without an entry, the code is the
  repo the store is in, as before.

- **Reclaiming task worktrees (AO-0230).** Every 10 minutes, and at swarmupd's first tick,
  swarmupd removes the worktree `out/wt-<ID>` of each task that has been `done` or `parked` for
  `swarmupd.reclaim_after_minutes` (60). It removes a worktree only when no run works in it, no merge
  of the task waits, `git status` shows no change, and its commit is on a branch. A merge waits
  from the approval until swarmupd records the merge or notes that it has nothing to merge; a
  note that the merge failed does not end the wait, so that worktree stays. The branch stays. swarmupd notes on the task (as `opsd:worktree`) which branch and commit hold the work,
  and a reopened task gets its worktree again on that branch. A worktree that fails a check stays,
  with one warning per reason in the swarmupd log. swarmupd deletes the folder with Node's
  `fs.rm`, then runs `git worktree prune`. It never uses `git worktree remove`, because Git for
  Windows follows a junction in the folder, such as a `node_modules` entry linked to the main
  checkout, and deletes what the junction points to. A removal is saved before the folder is
  touched, so the next sweep finishes one that a crash or a locked file cut off. Set
  `swarmupd.reclaim_worktrees: false` to keep every worktree.
- **Cleanup in Settings (AO-0298).** The **Cleanup** section of **Settings** shows and changes the
  three keys: the **Remove the worktrees of closed tasks** switch (`reclaim_worktrees`, on by
  default), **Grace period (min)** (`reclaim_after_minutes`) and **Scratch folders (days)**
  (`scratch_days`). `GET /api/settings` reports them and `POST /api/settings` accepts them; it
  refuses anything but true or false for the switch and anything but a number of at least 0 for
  the other two. A change applies from the next sweep, with no restart. Turning the switch on
  removes the key from the user config, a hand-written `false` included. Under **Held back by the
  last sweep**, the section lists each closed task's worktree that the last sweep left in place,
  with the reason: a run works in it, its merge is pending, it has uncommitted changes, its commit
  is on no branch, it is locked with `git worktree lock`, it is a junction or symlink, or git
  cannot read it. The list is empty while the switch is off, because no sweep looks at the
  worktrees then, and it is kept in memory, so it is empty from a swarmupd start until the first
  sweep ends.
- **Crash recovery in task worktrees (AO-0230).** swarmupd makes a task worktree locked with the
  reason `swarmupd: making` and unlocks it once git has checked out every file. A worktree that
  still has that lock was cut off mid-checkout by a crash or power cut: no run ever worked in it,
  so the next sweep deletes it, and the next run makes it again. Before a run starts in a task
  worktree, swarmupd removes an `index.lock` older than 2 minutes there. After a run's processes
  are gone, it removes the run's `index.lock` before committing what the run left. Git leaves
  such a lock when it is killed mid-write, and every later git command in the worktree fails
  until it is gone.
- **Scratch folders (AO-0230).** Each run gets its own folder, `<state>/scratch/<run id>`, named in
  `SWARMUP_SCRATCH` and in `TEMP`, `TMP` and `TMPDIR`. It is an extra writable folder for Claude
  (`--add-dir`) and Codex. The prompt of a run that writes tells it to put logs, test output,
  experiments and downloads there, and never in the repo, its `out/` folder or the folder that
  holds the repo. swarmupd removes a scratch folder `swarmupd.scratch_days` (7) days after its run
  ends. For a writing run, swarmupd lists the folder that holds the store checkout (unless that is
  a home, temp or drive-root folder), plus the store checkout and its `out/` for a run in a task
  worktree. It lists them when the run starts and again when it ends. The `run-end` event names
  each new file or folder; swarmupd changes nothing there, since another run or a person may have
  made them.
- **Store repair after Codex sandbox sessions (AO-0287, Windows).** A sandboxed Codex run works
  as the user `CodexSandboxOffline`, under a token limited to SIDs of its own session. Codex adds
  those SIDs to the store folder for each session, and Windows passes them down only to the files
  and folders you own. What a sandbox session made keeps the ACL it was made with, so a later
  session can read it but cannot replace it, delete it or add a file to it: `swarmup` in that
  session fails with `EPERM` on an edited `task.md`, a new event in a task folder an earlier
  session made, a `git pull` that changes such a file, or a lock a crashed session left. You are
  not the owner either and cannot change that ACL, but you may delete and rename the entry. So
  swarmupd, which runs as you, lists what a `CodexSandbox*` account owns in each task store (one
  PowerShell process, about 1 s for 11,000 entries, never inside `.git` or through a link) and
  makes each entry again under its own name:
  - A file is copied to `.ops/tmp` and renamed over the original, with the same content and
    times, under the task's lock when it belongs to a task.
  - A folder gets a new folder next to it, `.<name>.<ulid>.repair`, which takes everything the old
    one holds and then its name. For two system calls the folder does not exist. If swarmupd
    stops mid-move, the next repair finds the `.repair` folder and ends the move.
  - A lock file in `.ops/locks` is removed when it is stale by the lock's own rule: its process is
    gone, or it is older than 30 s.

  The repair runs before the first Codex launch after swarmupd starts, in each housekeeping sweep
  (every 10 minutes) and after each Codex run ends, under the root's `git` lock, so no sync commits
  a half-moved folder. No Codex run starts while one of those repairs is due or under way, including
  from the moment a Codex run's process ends until the repair after it is over: `swarmup waits`
  names the repair as the reason, and the run starts at the next tick.
  Helper runs of a live Codex run are not held. Two Codex runs that overlap
  can still meet a file the other made minutes ago, until the next repair. Set
  `swarmupd.repair_stores: false` to turn the repair off. Temp files older than an hour in
  `.ops/tmp` are left in place and named once in the swarmupd log; set
  `swarmupd.remove_stale_temp: true` to have swarmupd delete them.

### Processes

Every process starts with no console window. swarmupd stops only processes it started, and never
with a tree kill by bare PID: Windows matches a tree by parent PID alone, which can reach a process
whose parent PID was reused.

- A run swarmupd started on Linux or macOS leads its own process group; swarmupd stops the group. The
  child is not reaped yet, so its PID and group cannot have been reused.
- On Windows, and for a run adopted from an earlier swarmupd, swarmupd takes a fresh snapshot, adds the
  run's processes to its ledger, and kills the root and every confirmed descendant, each checked
  at the moment of the kill (see the process ledger). A run swarmupd started on Windows is also
  stopped through Node's own handle to it.
- On macOS, an adopted run is not stopped: creation times there are whole seconds, too coarse to
  check the PID at the moment of a kill. swarmupd warns and marks the run ended.

swarmupd records each run's process creation time before it saves the run. A run adopted from an
earlier swarmupd is watched only while its PID still has that creation time, so a later process that
reuses the PID is never taken for the run. A run with no creation time on record is marked lost and
never stopped. When the creation time of a live PID cannot be read at adoption (on Windows,
PowerShell can miss its timeout on a loaded machine), swarmupd keeps the run adopted, warns, and reads
it again in the background, up to five times 10 s apart; the run is marked lost as soon as a read
shows another process. Stopping swarmupd cancels a pending read and the wait between reads, so they
never hold swarmupd past the wait of `swarmupd stop`; the next swarmupd checks the run again. A kill still
checks the creation time at the moment of the kill.

The desktop app can host swarmupd: it starts it with its own executable in Node mode
(`ELECTRON_RUN_AS_NODE`), and agent runs do not inherit that flag. Neither do merge commands
(checks, install, build), and neither gets the app's `SWARMUP_DAEMON_ENTRY`: a check or a run that
starts swarmupd from a checkout starts that checkout's build, not the installed app's.

#### Process ledger

Each run keeps a ledger of every process it started, in `procs/<run>.json` in the state folder:
PID, parent PID, name, command line, creation time, and when swarmupd first and last saw it. A process
is named by its PID and its exact creation time together.

| Platform | Snapshots                                                                               | Ledger                                                                                                        |
| -------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Windows  | one PowerShell helper answers every snapshot and kill (`Get-CimInstance Win32_Process`) | yes; creation times to the millisecond                                                                        |
| Linux    | read from `/proc`                                                                       | yes; creation times in clock ticks                                                                            |
| macOS    | `ps`                                                                                    | no: `ps` reports whole seconds, too coarse to tell a reused PID apart; runs are stopped by process group only |

- Every `proc_seconds` (default 5), and right after a launch, swarmupd takes one snapshot and adds the
  run's new descendants. The helper itself is never recorded.
- The root joins only with the exact creation time in the run record. Without one, the ledger
  stays empty: a later process that reused the root's PID is never taken for the run.
- A process joins when its parent PID names a process in the ledger:
  - while that parent runs, or if the process started before the last snapshot that saw the
    parent alive (on Linux, at least 1 s before, since creation times come from a boot time in
    whole seconds);
  - as **unsure** if it started after that snapshot but before the parent was seen gone, and no
    process holding the parent's PID now started before it. The parent's PID could have been
    reused in between, so unsure processes, and their children, are listed but never killed
    automatically.
- On Linux a process in the run's process group joins by the same rules, so an orphan that was
  reparented after its parent exited is kept.
- When a run ends, however it ends, swarmupd takes a last snapshot and kills every confirmed ledger
  process still alive, one by one rather than as a tree, and checks again, up to three rounds.
  Each kill checks the creation time at the moment of the kill: on Windows through the open
  process handle, which keeps the PID from being reused between the check and the kill; on Linux
  from `/proc` right before the signal. A PID that runs another process is left alone. What
  survives shows as `procs_left` on the run, in `swarmup runs` and in the desktop.
- When swarmupd starts, it sweeps the ledgers of runs that ended in the last 7 days for survivors.
- `swarmup procs RUN` lists the ledger with each process alive, killed or gone, and marks unsure ones
  with `?`. `--kill` stops what an ended run left; `--kill --pid N` stops one process, unsure
  ones included, after you checked it. The desktop **Runs** view has the same list, **Kill
  leftovers** and a **kill** link per process.

What can still escape or remains:

- A process whose parent started and exited between two snapshots, so swarmupd never saw the parent.
- On Linux, a process that was reparented after its parent exited and also left the run's process
  group (`setsid`).
- On Linux, the PID could be reused between the `/proc` check and the signal only if the kernel
  wrapped through the whole PID range in those microseconds.

Windows job objects would close the first gap on Windows; add them if it shows up in practice.

## Limits

swarmupd starts a run only when every limit has room. A refused `swarmup launch` names the limit, and
wake and schedules wait for room.

| Limit            | Setting                                      | Counts                                                    | Default                                                        |
| ---------------- | -------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| PC               | `max_runs`, `min_free_gb`                    | live runs on this PC; free memory                         | number of CPU cores; 4 GB                                      |
| Provider         | `runtimes.<name>.max_live`                   | live runs of that provider on this PC                     | none                                                           |
| Usage allowance  | `usage_pause_at`, `runtimes.<name>.pause_at` | the provider's plan windows, as its runs report them      | pause at 90% of a window until it resets                       |
| Role per project | `roles.<role>.per_project`                   | live runs of the role on one project, over every provider | 1 for roles that write; 3 for `qa`, `reviewer`, `orchestrator` |
| Role total       | `roles.<role>.max_live`                      | live runs of the role on every project                    | none; 1 for `orchestrator`                                     |
| Checkout         | none                                         | live runs of roles that write in one folder               | 1                                                              |

- A run's project is its task's `project`, else its root's name. `claude:engineer` and
  `codex:engineer` count as one role. One task never has two live runs.
- **One writing run per checkout.** A run of a role that writes never starts in a checkout where
  another run of a role that writes is live or planned, whatever project either task names. A
  run's folder is the launch's `cwd`, else `swarmupd.agents.<id>.cwd`, else the top of the git repo
  of its task's root, so tasks in one root share a checkout. Its checkout is the top of that
  folder's git work tree, so two runs in different subfolders of one checkout count as one; each
  linked `git worktree` is its own checkout, and a folder outside git is its own. A run on a code
  task works in the task's worktree (see Task worktrees under Runtimes), so code tasks of one
  root run side by side, within the role's `per_project` limit. Other writing runs in one root,
  and code tasks with `swarmupd.task_worktrees: false`, run at once only when their projects live in
  different roots or their agents have their own checkout. Helpers work under their parent and are not counted, and
  neither are question runs or chat turns: a chat turn has `Edit` and `Write` denied, so it
  neither holds a checkout nor waits for one, whatever its role.
- **A writing run starts on a clean checkout.** While a git checkout has changed tracked files or
  untracked files outside task stores (`.swarmup/` and every root's folder), no run of a role
  that writes starts there; `swarmup waits` says `checkout has uncommitted changes in <top>` and
  names a file. Ignored files do not count. A checkout that is itself a task store is never
  checked. When such a checkout holds a writing run and no live or ending run works in it, swarmupd
  (`opsd:checkout`) posts once in `#general`, mentioning the human, so it lands in their Inbox:
  which run waits, the checkout and its first changed file. It posts again for that checkout only
  after it was clean once. A checkout with a live run gets no post: the changes may be that run's
  work, which its wrap-up commits.
- **No run beside a session outside swarmupd.** A session of an agent that swarmupd did not start
  (one with no `SWARMUP_RUN`, such as an agent CLI you opened yourself) often works on after its
  claim ended, say on a change request for the work it sent to review. When the task's newest
  claim is one such a session made on this PC, swarmupd starts no run on the task, and wakes no
  inbox run for an item about it, until `outside_session_minutes` (default 30; `0` never waits)
  have passed since that agent's last event on the task. `swarmup waits` says
  `a session of <agent> outside swarmupd worked on it <n> min ago and may still do`. The wait
  ends at once when that session releases, hands off or closes the task, or when anyone assigns,
  hands off or delegates it. A session that goes on takes the task with `swarmup start`: its
  live claim keeps the task out of swarmupd's queue, and a run that holds a task refuses that
  session's `start`, `progress`, `review` and other finishing commands (see
  [protocol.md](protocol.md), Claims across machines). An inbox run that started for other items
  still reads the whole inbox.
- **What a run leaves goes to a branch.** Codex runs in a sandbox that keeps `.git` read-only, so
  they cannot commit in their checkout (only in a worktree, see Runtimes). When a top-level run of a role that writes ends and its checkout has
  changes outside task stores, swarmupd commits them with the normal git on a new branch
  `<runtime>/<task>-<run>` (lowercase; `<runtime>/run-<run>` without a task), from the commit the
  run started on (`base` on the run record). The message is the task's title, then
  `Changes left by run <id> (<agent>).` The commit is built in a temporary index, so neither the
  index nor the checked-out branch takes it. swarmupd then restores those files to that commit, and
  deletes files the run added. A
  file that changed again after the commit, or whose staged version is in neither the commit nor
  HEAD, stays as it is and is named in the run's `run-end` event, so nothing is discarded that the
  commit does not hold.
  - The `run-end` event names the branch and the commit.
  - If the run ended without `swarmup review`, swarmupd sends the task for review with the commit and
    branch: to the reviewer the task's delegation expects, else the first active `qa` agent of
    another provider, else the human. If the run already asked for review, swarmupd comments to its
    reviewer where the files went.
  - swarmupd commits only once nothing of the run still writes: it first reaps the processes the run
    left behind and waits up to 30 seconds for the run's helpers to end, including helpers that
    ended first and are still reaping their own processes. Until then the run counts as live, so
    it holds its checkout and its task. If processes of the run or of a helper survive the
    reaping, or a helper is still running, swarmupd commits nothing and says so in the `run-end`
    event.
  - The run's record keeps how far this wrap-up got (`wrap_up`: `pending`, `committed`,
    `recorded`, `settled`, `done`). If swarmupd stops or restarts before it is `done`, the next swarmupd
    resumes it from that step: it reaps again, commits, records the `run-end` event and sends
    the task for review, each once. A branch the earlier swarmupd already created for the run is
    reused, and only the restore of the checkout is finished.
  - If HEAD is no longer the commit the run started on (the run, or a person, moved it) and
    changes are left, swarmupd commits nothing and says so in the `run-end` event; the checkout stays
    as it is for a person, and no writing run starts there until it is clean.
  - Runs that commit themselves (Claude) leave nothing, so nothing happens. Merging the branch
    stays with the orchestrator or a person after approval.
  - Any other top-level run, such as a `qa`, `reviewer` or chat run, gets the same wrap-up when
    its checkout had no changes outside task stores at its start, so what it leaves never holds
    writing runs. A run that started on a checkout with changes has no `base`, and swarmupd commits
    nothing after it: those changes were there before it.
- A finding filed with `swarmup finding --task ID` and a task created with `--parent ID` take the
  project of that task unless `--project` names another.
- A task that names no project counts under its root's default project: `project` in the root's
  `config.yml`, else the root's `name`. `project_aliases` there maps old project names to the
  current one, so tasks filed under two names count as one project.
- `roles.<role>.writes: false` marks a role that only reads code and posts to SwarmUp.
- **Bottleneck first.** Wake plans across every waking agent, in this order: review requests (one
  run per request; the run gives a verdict and holds no claim); tasks that resume after an answer
  or a change request; new claims; last, runs that only read new inbox items, since they name no
  work. Within each: priority, then the project with the fewest live runs, then age. Each planned
  run counts against the limits before the next is planned. When a project has `review_backlog`
  (default 3) tasks waiting for review, swarmupd starts no new work there for roles that write, and
  its reviewers may run up to `roles.<role>.burst` (default twice `per_project`), so reviews catch
  up before more work piles on.
- **Helper runs.** A run that works on a task and still holds its claim starts helpers with
  `swarmup spawn [AGENT] -m PROMPT` (`POST /api/runs` with `parent`). A helper works on the parent's
  task, always in the parent's folder, under its claim. It may comment on tasks but never change
  their state (`SWARMUP_PARENT_RUN` marks it), counts against the PC, provider and usage limits but
  not the role limits, may not start helpers of its own, and stops when the parent ends (reason
  `parent-ended`), also when swarmupd restarts after the parent ended. `roles.<role>.max_children`
  (default 2) caps helpers per run. Sub-agents a runtime starts inside its own process (Claude
  Code's Agent tool) are not swarmupd runs: they share the run's provider allowance and are not
  counted.
- **Providers.** A task owned by `*:<role>`, or by nobody, goes to the first waking agent of the
  role whose provider has room, in the order of `roles.<role>.providers` (default: the order of
  `runtimes`). With `overflow: false` it waits for the first provider. A task owned by one agent
  (`claude:engineer`) waits for that agent.
- Providers do not limit how many sessions run at once; their plans limit usage in windows. Claude
  Pro and Max have a five-hour and a weekly window shared by Claude, Claude Code and the IDEs;
  Codex Pro has a weekly window, Plus and Business a five-hour and a weekly one. swarmupd reads them
  from run output: Claude Code's `rate_limit_event` in `stream-json`, and the `rate_limits` of
  the Codex session file named after the thread id in `codex exec --json`
  (`$CODEX_HOME/sessions`, default `~/.codex/sessions`). It keeps them in `usage.json` in the
  state folder. A provider that refused work for its limit is paused until the reset it reported.
  Runs whose output has no such event still count: a usage-limit error in the output (Claude
  Code's "usage limit reached", Codex's "hit your usage limit", an API `rate_limit_error`) pauses
  the provider until the reset it names, or for `usage_cooldown_minutes` (default 30).
- The part of a window over `usage_pause_at` stays for your own Claude and Codex sessions; runs
  already going finish.
- **Signed out.** The first run that cannot sign in (an expired OAuth session, no login, a bad
  API key) puts its provider in the signed-out state. swarmupd starts no run of that provider until it
  is signed in again: no task, review, inbox or schedule run, no helper and no chat turn. Runs
  already live go on.
  - You get one notice, in your inbox (the desktop app shows it as a notification) and as a
    banner at the top of the app. It names the provider, how to sign in again (Claude: run
    `claude`, then `/login`; Codex: run `codex login`), how swarmupd resumes, and which reviews wait
    for that provider. There is no second notice while the provider stays signed out, also across
    swarmupd restarts.
  - swarmupd checks the sign-in with the CLI's own status command, which sends no prompt: `claude
auth status` and `codex login status` (`runtimes.<name>.sign_in_check`, the arguments after
    `command` and `args`; `false` for none). It checks right after the failed run, then every 3 minutes,
    and starts the provider's runs again once the check says you signed in. A check that is
    missing, fails, or says "signed in" while runs still cannot sign in is not used: swarmupd then
    starts one run of the provider an hour instead, to try the sign-in.
  - A run that works clears the state, as do **Resume** in the app's banner, `swarmup daemon resume`,
    and pausing and resuming the provider in **Settings**.
  - When swarmupd starts, it checks the sign-in of each provider an agent runs on, and starts no run
    of a provider until its check answers, so a restart with an expired session does not start a
    burst of failing runs.
  - Work owned by `*:<role>` goes to the next provider in `roles.<role>.providers` meanwhile, as
    for a usage limit. Work owned by an agent of the signed-out provider by name, such as a
    change request sent back to `claude:engineer`, waits `signed_out_handoff_minutes` (default
    15; `0` never hands it over) from the later of the sign-out and the moment the task became
    `todo` for that agent, then swarmupd hands it to the same role on the next provider, with a
    handoff event that names the task's branch and worktree. Codex gets such work too: a writing
    Codex run commits in a worktree (AO-0155, AO-0234). Reviews that need the signed-out provider
    wait for it.
  - The state is kept in `signin.json` in the state folder. `swarmup usage`, `swarmup waits`, the
    **Agents** view and the **Board** show "signed out" as the reason work waits.
  - The chat answers a message it cannot send with how to sign in; your messages wait and go out
    once the provider is signed in again.
- **Failed starts.** A run that ends with an error within 10 seconds, without a sign-in error,
  is a failed start of its provider. swarmupd waits 1, 5 and then 15 minutes before the next run of
  that provider. After the fourth failed start in a row, it posts one message to you in
  `#general` and starts a run of that provider once an hour until one works. A run that works
  clears the count. To try again sooner, pause and resume the provider in **Settings**, use
  **Resume** or `swarmup daemon resume`, restart swarmupd, or send a chat message: chat turns skip the
  wait and never count. Usage limits have their own pause and do not count. The count lives in
  memory only.
- **Stuck tasks.** A run that ends without finishing frees its task, and the release note quotes
  the run log: its error lines and the agent's last message. When `stuck_runs` runs of a task in
  a row (default 3; `0` turns it off) end without finishing and with no work on the task between
  them (no progress, comment, ask, review or person; the lease renewals swarmupd writes while a
  run lives don't count as work), swarmupd stops starting it. It blocks the task for a waking,
  active PM of another provider than the stuck run's, and not signed out, else for you; never for
  a PM of the stuck run's own provider, which may be the broken one. It quotes the log with
  secret-looking lines removed, and files a `p1` finding owned by that PM. The same failure on
  other tasks is added to the open finding, so a broken sandbox is one finding. Unblock the task
  after the fix. This catches runs that fail in a way the failed-start count misses: codex:engineer
  ran 171 times on AO-0173, each run about a minute long and ending with exit 0 while its sandbox
  refused every shell call (AO-0173). Runs a person stopped, and providers paused for a sign-in, a
  usage limit or failed starts, do not trip it.
- **Review rounds.** When a task gets `review_rounds` `changes` verdicts in a row (default 3; `0`
  turns it off) with no approval between them, swarmupd does not wake its author for another
  round. At the next tick it blocks the task, as `opsd:watch`, for a waking, active PM that is
  not signed out, else for you. The block gives the count and the text of the last
  `review_rounds` verdicts, each cut to 600 characters. The PM narrows the task, splits it,
  changes the reviewer or escalates, then answers the block; the count starts again from there,
  and also after an approval or a reopen. Notes on the task do not reset it, and a task a person
  owns is left alone. swarmupd logs each stop as a `warn` line that starts with `review-rounds:`
  and names the task, the count, the limit, the author and the reviewers, so you can tune the
  limit from the log. Before, nothing acted on repeated change requests: AO-0110, a docs-only
  proposal, took at least six.
- Limits are per PC. A provider account spans PCs: with swarmupd on two PCs, set `usage_pause_at` or
  `max_live` on each to share it.
- `swarmup usage` and `GET /api/usage` show each provider's windows, live runs and whether it is
  paused. `swarmup waits` and `GET /api/waits` list the wake plan: what waking agents could start, in
  order, with why each waits (the first limit in the way for each agent, or a review backlog).
  `swarmup runs` ends with what waits, the desktop **Board** shows the reason on each waiting task,
  and the **Agents** view shows the plan and each provider's usage.

## Config

The `swarmupd` section of the user config (`%APPDATA%\swarmup\config.yml`,
`~/.config/swarmup/config.yml` or `SWARMUP_CONFIG`). A config from an earlier version names
the section by its earlier key; swarmupd reads and edits that section as it is while the file has
no `swarmupd` key. To move to the new name, rename the key in the file. When a file has both,
swarmupd uses `swarmupd` alone.

```yaml
me: human:dawid
swarmupd:
  port: 4747 # 0 picks a free port
  tick_seconds: 15
  proc_seconds: 5 # how often the processes of live runs are looked at
  max_runs: 24 # default: the number of CPU cores
  min_free_gb: 4 # no new run below this much free memory
  usage_pause_at: 0.9 # no new runs on a provider past 90% of a usage window
  usage_cooldown_minutes: 30 # pause after a usage-limit error that names no reset
  signed_out_handoff_minutes: 15 # hand named work of a signed-out provider to another; 0: never
  budget_minutes: 180
  wake_cooldown_minutes: 10
  outside_session_minutes: 30 # no run on a task a session outside swarmupd just worked on; 0: never
  stuck_runs: 3 # block a task for a PM after this many unfinished runs in a row; 0: never
  review_rounds: 3 # block a task for a PM after this many changes verdicts in a row; 0: never
  sync: true # commit, pull and push each root when its sync policy says so
  reclaim_worktrees: true # remove a closed task's clean worktree; its branch stays
  reclaim_after_minutes: 60 # how long a task stays closed before that
  scratch_days: 7 # how long a run's scratch folder stays after the run
  repair_stores: true # Windows: make what a Codex sandbox session left in a store writable again
  review_checks: true # run the merge checks for a Codex reviewer, whose sandbox cannot
  remove_stale_temp: false # delete temp files older than an hour from each root's .ops/tmp
  seeded: 1 # the defaults were written once; from then on runtimes lists every provider
  runtimes:
    claude: { command: claude, model: opus }
    codex: { command: codex, pause_at: 0.95 }
    hermes: { command: hermes, args: [run, --json, '-'], unset_env: [GH_TOKEN], paused: true } # paused: no new runs
    # sign_in_check: the status command's arguments after `command` and `args`; false: none, try a run hourly
    other: { command: other, sign_in_check: [whoami] }
  # Without `seeded`, entries merge into the default claude and codex key by key, as before.
  review_backlog: 3 # reviews waiting in a project that hold new work there
  roles:
    engineer: { per_project: 1, providers: [claude, codex], overflow: true, max_children: 2 }
    qa: { per_project: 3, burst: 6 } # qa and reviewer only read
  agents:
    codex:engineer: { wake: true, budget: 2h, model: gpt-5-codex }
    claude:qa: { wake: true, cwd: 'C:\dev\my-project' }
    claude:pm: {} # an agent with no settings of its own
  schedules:
    - name: digest
      at: '09:00' # daily, local time; or every: 30m
      agent: claude:pm
      prompt: Write the daily digest of open tasks and post it to the swarmup channel.
      paused: false # true keeps it without starting runs
  repeats: true # create the tasks of due repeats; false on every PC but one that shares a store
  test_changes: # per root: the test and check configuration files a review prompt lists changes of
    v2: { tests: ['**/test/**', '*.test.*'], checks: [package.json, 'vitest.config.*'] }
```

- **Wake:** each tick, swarmupd carries out the wake plan (see "Limits"): one run per review request,
  per task in the waking agents' queues that has no live run, and per agent with new inbox items
  and no run, as long as the limits have room. An inbox item counts as seen once an inbox run
  reads it, or once a run works on the task it is about.
- **Schedules** start their agent when due and the limits have room. The desktop **Schedules**
  view and `/api/schedules` add, change, pause, run and delete them in the user config.
- **Repeats** (repeating tasks, see [the protocol](protocol.md#repeating-tasks)) create their
  task each tick when a slot is due or a condition holds, before the wake plan, so the new task
  can start in the same tick. A schedule starts an agent run; a repeat creates a task. Paused
  swarmupd creates none; on resume or the next start each repeat fires once for the latest slot it
  missed. Repeats live in the task store (`repeats/<name>.md`), not in the user config; the
  desktop **Repeating** view and `/api/repeats` manage them.
- **Changes from the app:** `POST /api/settings` and `/api/schedules` edit the user config in
  place (comments kept, written through a temporary file), validate the result before writing, and
  reload it: roots, limits, agents and schedules apply from the next tick; `port` and
  `tick_seconds` at the next start.
- **Sync** runs `swarmup sync --auto` logic for each root only when a pull or push is due, so commits
  happen at sync times, not every tick.

## Chat

The desktop **Chat** view is one conversation with the PM (`swarmupd.chat.agent`, default `claude:pm`,
which every new config seeds).

- **Each message is a run.** swarmupd starts a run of the chat agent with no task, under every limit
  in [Limits](#limits). The `pm` role is read-only (`writes: false`, no `Edit` or
  `Write`, claims only `question` tasks unless its role file sets `can_claim`), so a chat turn
  never waits for an engineer run or a merge on the same checkout. One agent runs once at a time:
  a message sent while another run of the chat agent is live waits, and the view says why. Messages sent while a turn runs wait for the next turn,
  which reads them all.
- **One session.** The first turn starts a Claude session with `--session-id`; later turns pass
  `--resume`, so the context carries from message to message. The first turn's prompt holds the
  role file and the chat rules; later turns get a short reminder. A turn that fails without a
  reply drops the session, and the next message starts a new one. The chat runs on Claude only:
  only Claude runs get a session to resume and a streamed reply, so `swarmupd.chat.agent` refuses an
  agent on any other runtime.
- **What it may do.** A chat turn's tools are the role file's `tools`, else `Read`, `Grep`,
  `Glob`, `git log` and `git show`, plus `swarmup`. `Edit`, `Write`, `swarmup verdict` and `swarmup decide`
  are always denied. Its prompt allows creating tasks, comments, assigning, retyping, priority,
  parking, channel posts, findings and answering agents' asks; never a verdict, a vote decision,
  an answer for the human, or claiming and working a task.
- **Streaming.** swarmupd reads a live turn's log (`--include-partial-messages`) every 300 ms and
  sends the reply so far as a `chat` event. When the turn ends, the reply is saved with what the
  agent did in SwarmUp during the turn (task events, new tasks and channel posts by the agent
  between the run's start and end), shown as links.
- **Mentions.** With `swarmupd.chat.mentions` (default `true`), each tick reads channel posts that
  mention the chat agent (`@claude:pm` or `@*:pm`) and adds them to the chat.
  The turn answers in the channel with `swarmup channel post` and sums up in the chat. Those mentions
  never wake an inbox run of the chat agent. The first time, swarmupd reads mentions of the last 24
  hours.
- **Stop.** **Stop** ends the live turn and drops the messages no turn read yet. With no turn live,
  it ends the chat agent's other live run that queued messages wait for.
- **New conversation** starts a new session with no messages, refused while a turn runs. The old
  conversation stays in `chat-<id>.json` in the state folder.

The conversation lives in `chat.json` in the state folder, on this machine only.

```yaml
swarmupd:
  chat:
    agent: claude:pm # one Claude agent, no wildcard
    mentions: true # channel posts that mention it join the chat
    budget: 20m # one turn; default: the agent's budget
```

## Merging approved work

With `swarmupd.merge.<root name>` set, swarmupd merges a task's work into a base branch once a review
approves it. The setting lives in the user config, not in the task store's `config.yml`, so the
commands swarmupd runs are set on each machine and never arrive through a sync.

```yaml
swarmupd:
  merge:
    v2: # the root's name
      base: v2 # the branch approved work goes into
      checkout: 'C:\dev\my-project' # where the base is built; default: the root's git top
      checks: # run on the rebased work, in swarmupd's own worktree
        - npm ci --no-audit --no-fund
        - npm run typecheck
        - npm run lint
        - npm test
        - npm run leaks
      build: [npm run build] # run in `checkout` after the base moved
      install: [npm install --no-save --no-audit --no-fund] # before `build`, when a lockfile changed
      timeout_minutes: 30 # per command
```

- **What it merges.** A task whose last verdict approves it, when the review that verdict answers
  names `<commit> on branch <name>` (the form `swarmup review` asks for, and the one swarmupd's own
  leftover reviews use) or `branch <name>`, which merges the branch tip. The commit wins over the
  tip: swarmupd merges what the reviewer approved. A `branch <name>` counts only when `<name>` is a
  branch in the repo, since prose such as "this branch does not touch it" has the same shape.
  When that review names neither, swarmupd takes the newest earlier review that names a branch the
  repo has, and merges that branch's tip. Only verdicts after swarmupd first saw the root's
  setting count (`merge.json` in the state folder), so turning it on merges no old work.
- **How.** One merge at a time, started when no writing run is live in `checkout`. In its
  worktree (`<state>/merge/<root>`, kept between merges so installed packages stay), swarmupd rebases
  the commit onto the base and runs `checks`; writing runs in `checkout` start as usual
  meanwhile. Once the checks pass, swarmupd holds `checkout`: no writing run starts there until the
  build is over (`swarmup waits` says `swarmupd merges <task> into <base>`), and a writing run that
  started during the checks ends first. Then swarmupd fast-forwards the base: with
  `git merge --ff-only` where the base is checked out, so the work tree follows and local
  changes are never overwritten, else by moving the ref only if it did not move. When the base
  moved meanwhile (a task store sync, another merge), swarmupd rebases again, and runs the checks
  again only if code changed. Then it runs `build` in `checkout` and adds a `merge` event
  (`opsd:merge`) with the new commit to the task.
- **Tasks blocked on the work.** A task blocked `--on` an approved task stays blocked until
  swarmupd records the merge on that task, so no run starts on a base that lacks the work. A merge
  that fails keeps them blocked: a conflict or a failed check sends the approved task back, and a
  merge swarmupd cannot do (the commit or the base is missing, the base did not move) leaves a
  comment for the human. When swarmupd has nothing to merge for an approved task that others wait
  on (approved before the merge setting, or no review request names a branch or commit), it says
  so in a comment marked `no_merge`, which frees them. When the review requests name a commit and
  a branch that the repo lacks, the tasks stay blocked and swarmupd tells the human. To free a
  task by hand, run `swarmup unblock ID`.
- **New dependencies.** The checks install packages in swarmupd's worktree, not in `checkout`.
  Use `npm ci` there, as in the example: it installs the lockfile as written and never rewrites
  it, while a plain `npm install` saves the tree it resolved and can drop lockfile entries.
  When the merge changed a `package-lock.json` or `npm-shrinkwrap.json`, swarmupd runs `install`
  before `build` in each directory of `checkout` whose lockfile changed (`checkout` itself for a
  root lockfile, `site` for `site/package-lock.json`), so the build sees the new packages. Unset,
  `install` is `npm install --no-save --no-audit --no-fund` in each of those directories that
  still has an npm lockfile; `[]` turns it off. The default is not `npm ci`: that deletes
  `node_modules` first, and when swarmupd or the app runs from `checkout`, files they lock stop it
  halfway and leave both broken. `npm install` can leave out, or remove, optional platform
  packages that the lockfile lists (such as `lightningcss-win32-x64-msvc`) and still say
  `up to date`. So after the default install, swarmupd compares the lockfile with `node_modules`
  and installs by name each optional package that names this platform in `os`, `cpu` or `libc`
  and is missing from the top of `node_modules`; the merge event shows that command when it ran.
  An optional package with no such list, or with exclusions only (`!aix`), stays optional: npm
  may leave it out on purpose, and swarmupd does not install it by name. Nor does it install a
  package that the lockfile takes from git, a file or a tarball URL: by name, npm would fetch
  another package. A package counts as from the registry only when its `resolved` URL is
  `<registry>/<name>/-/<name>-<version>.tgz` for the registry that `npm config get registry` (or
  `@scope:registry`) names in that directory, or when the lockfile has no `resolved` for it; a
  mirror on another host, or a registry with another tarball layout, gets no repair. A configured
  `install`
  gets no such step. When a `build` command fails and `install` did not run in `checkout`
  itself, swarmupd runs it there and builds once more: `node_modules` may be gone, behind a
  lockfile another commit changed, or in the middle of an install. A failed install is the
  checkout's problem, not the merged code's: the human gets a comment on the task with the
  output, and the task stays closed.
- **Seeing it.** The merge under way shows on the app's **Board** and **Agents** views, in
  `swarmup runs` and `swarmup waits`, and as `merge` in `GET /api/waits`: the task, the base, the step
  (`rebase`, `checks`, `waiting` for a writing run, `build`), the command running now with its
  start, the timeout per command, and whether it holds `checkout`. Work it holds is marked
  `merge: true` in the waits. `opsd.log` has a `merge` line for its start, each check and build
  command as it starts and ends, the hold of `checkout`, and its end.
- **When it fails.** A conflict, a failed check, a check that timed out twice in a row, or a
  branch that changes task store files sends the task back to its owner: a `changes` verdict from `opsd:merge` with the end of
  the output, and the whole output in `<state>/merge/logs/`. Lines of the output that look like a
  secret (the patterns `swarmup` refuses in events), and private key blocks whole, are taken out
  before either is written. A failed build comes after the base
  moved: swarmupd records the merge and, when the build still fails after an install in `checkout`,
  sends the task back to fix it in a new commit. A merge swarmupd
  cannot do (the branch or commit is missing, the base kept moving, local changes in the way) gets
  a comment to the root's human, and swarmupd does not try that task again until it changes.
- **When a step hangs.** A check or build command stops at `timeout_minutes`, with everything it
  started. A check that timed out is not sent back the first time: swarmupd logs a warning and merges
  the task once more from the start, since a machine under load can stall a test run; the second
  timeout sends it back. The one more merge belongs to that merge: a later review of the task gets
  its own. Each git command of the merge (rebase, fast-forward) may take 5 minutes; then swarmupd stops
  git and what it started, such as a hook, and comments to the root's human with the command, the
  stage it hung in and the last lines it printed; the whole output goes to a log file. When a
  process it started outlives the stop and keeps git's output open, swarmupd stops reading after 5
  seconds. Either way the merge ends and frees `checkout`. The merge under way lives only in swarmupd's memory, so a
  restarted swarmupd holds nothing until it starts a merge itself.
- **When the PC sleeps.** While a check or build command runs, swarmupd looks at the wall clock every
  second. A gap of a minute or more means the PC slept or swarmupd stopped responding, and tests and
  timeouts then fail on wake for reasons that have nothing to do with the code. A check that
  fails after such a gap sends nothing back: swarmupd logs a warning and merges the task again from
  the start on the next tick. A build that fails after such a gap is handled like one stopped with
  swarmupd (see the next item), except that the same swarmupd runs it again on the next tick.
- swarmupd never forces a ref, never resets a work tree it did not create, and never restarts
  itself: after a merge that changes swarmupd's own code, restarting swarmupd stays a person's or the
  orchestrator's step. A merge stopped with swarmupd before the base moved starts again from the
  beginning in the next one. One stopped during the build, after the base moved, is recorded with
  the build left pending (`merge-builds.json` in the state folder): the next swarmupd runs the build
  first, before any other merge, and comments on the task when it passes or sends the task back
  when it fails.
- On Windows, each check and build command runs in a job object of its own, through a small
  PowerShell launcher that starts `cmd.exe` suspended, puts it in the job and only then lets it
  run. The job allows no breakaway, so everything the command starts is in it, detached
  processes and their children too. A stop or timeout ends the launcher, and with it the job and
  every process in it. When the command exits, the launcher ends what it left running. This needs
  no process list and no kill by PID, which a sandbox may refuse. Where no job can be made, the
  command does not run and fails with `could not run in a job object`.
- Off Windows, swarmupd follows each command's processes in a ledger, like a run's (on Linux, which
  gives exact creation times). A stop or timeout kills every process of the command, each checked
  by PID and creation time, and the command's process group gets SIGTERM. After a command exits,
  swarmupd kills what it left running. On every platform, a check or build must not start a process
  meant to outlive it.
- Off Windows, what survives every kill is kept in `merge-procs.json` in the state folder. Until
  it is gone, this swarmupd and the next start no merge and no build, and warn each tick, so a
  leftover build never races a new one in the same checkout. swarmupd stops reading a command's
  output 5 s after the command exits, so a leftover holding the output never holds a merge or a
  shutdown.

## Pushing task branches

Work that is not merged yet lives on task branches, and without a push only on this machine. At
each sync that pushes a root (the scheduled push under the root's sync policy, and the sync after
every run), swarmupd pushes the task branches of the root's repo to its remote. It is on for every
root; to turn it off for one, set it to `false` in the user config:

```yaml
swarmupd:
  push_branches:
    v2: false # the root's name
```

- **Which branches.** Branches named after a runtime swarmupd knows, such as `claude/*` and
  `codex/*`, which includes the branches swarmupd commits run leftovers to (`<runtime>/<task>-<run>`).
  A branch is pushed when it has commits whose changes neither the bases nor its remote branch
  have: the branch checked out in the root's checkout (`v2` for the engine), the root's
  `swarmupd.merge` base, and the remote's default branch. A branch merged by hand with a rebase or a
  cherry-pick has nothing new and is not pushed. A merge commit counts as new when its result
  differs from every parent somewhere, such as a conflict resolution; a clean merge of a base
  does not.
- **Where.** The remote of the checked-out branch, else `origin`, else the only remote. The push
  uses the machine's git sign-in, the one swarmupd runs with.
- **Never forced.** A push is always a fast-forward of the remote branch. When the remote branch
  has commits this clone lacks, or the remote refuses the push, swarmupd leaves it and warns once in
  the swarmupd log until either side changes. A base branch is never pushed here; it moves with the
  normal sync or a person's push.
- **No secrets.** Before a push, swarmupd reads every line the new commits add, including lines a
  merge commit adds in its conflict resolutions or edits. When one looks like a
  secret (the patterns `swarmup` refuses in events) or a commit adds a key file (`.pem`, `.key`,
  `id_rsa`, ...), the branch stays here and the log names the file, never the line. Messages from
  a failed push leave out URLs and sign-ins.
- **After a merge.** When swarmupd merges an approved branch (see the preceding section), it remembers
  the approved commit, so that branch is not pushed again unless new commits land on it. Once the
  remote's base has the merged commit, swarmupd deletes the remote branch, only while the remote
  branch holds nothing beyond the approved commit, and with a lease on the tip it checked, so a
  push that lands in between keeps it. The local branch stays. A review that names the base
  itself as its branch queues no delete: a base's remote branch is never deleted.
- **Pushing the base.** Before it moves the base, swarmupd records a key for each merged commit's
  patch in `approved.json` in the state folder, under the repo and the base it merged into, for
  30 days. swarmupd's task store sync then pushes the base when every unpushed commit that
  changes files outside the task store has a patch approved for that repo and branch, so merged
  code goes out with the store commits. An approval counts only in its own repo and branch, and
  not at all after 30 days, even before the next merge clears it out. The key leaves out blob ids
  and line numbers, so a commit the sync's pull rebased still matches. Any other code commit on
  the base holds the push back, as before ("push them yourself or pass --all-paths"); `swarmup
sync` run by hand does not know the approvals.
- An unreachable remote ends the round with a warning; the next sync tries again. What swarmupd
  decided and what it has to delete are kept in `branches.json` in the state folder.

## Machines

With `machine` set in the user config, swarmupd writes `machines/<machine>.json` in each data root it
syncs (not in mirror roots): last seen, live runs and their agents, swarmupd version and build. It
rewrites the file only when something changed or the record is 20 minutes old, so syncs carry it
without a commit every tick. A machine counts as alive when it wrote in the last 70 minutes.
`GET /api/machines` lists every machine seen; **Agents** shows them.

## Notifications

Set `swarmupd.notify.webhook` (a Discord or Slack incoming webhook, https; http only to this machine)
in **Settings** or the user config, never in a data root. Each tick, swarmupd posts new inbox items for
`me` (asks, reviews, findings to triage, decisions, mentions, messages) and runs that failed (non-zero exit, lost,
over budget) as one message, at most 6 messages per 10 minutes; items already waiting when
notifications start are not sent. `swarmupd.notify.kinds` limits what is sent. The URL is a secret:
settings never return it, and warnings say only the HTTP status.

## API

swarmupd listens on `127.0.0.1` only. Every request needs the token from `opsd.json` as
`Authorization: Bearer <token>` (only `GET /api/events` also takes `?token=`, because
`EventSource` cannot send headers) and a `127.0.0.1` or
`localhost` Host header, so a web page in a browser cannot call it.

### Run tokens

The token in `opsd.json` is the full token: the desktop app and `swarmup` outside a run use it, and it
acts as whoever `as` names. Each supervised run also gets its own random token in `SWARMUP_RUN_TOKEN`;
swarmupd keeps only its SHA-256 in the run record, so a swarmupd that adopts the run still knows it. Inside
a run, `swarmup` sends that token only to the swarmupd on `SWARMUP_RUN_STATE_DIR`; a swarmupd on another state
folder, such as one started by a test, gets the full token from its own `opsd.json`.

A run token:

- Acts as the run's agent and run id; swarmupd ignores `as`. A helper run's token cannot change task
  state, like `swarmup` inside the helper.
- Stops working when the run ends.
- Cannot change settings, roles, schedules, repeats or root mirroring; test notifications; answer or give
  verdicts; pause, resume or stop swarmupd; or launch runs for another agent.
- Can stop only its own run or a direct helper, and can clean up only a direct helper's processes.
  It cannot stop or clean up another run.

These checks prevent accidental or ordinary API use from crossing run boundaries. A run still
runs as your operating-system user, so it can read files that user can read. To request a daemon
restart or another human-only action, use `swarmup ask`.

| Method and path                                              | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                                            | pid, version, `build` (when the code swarmupd runs was built), live run count, `me`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /api/doctor`                                            | the `swarmup doctor` checks, run by swarmupd on the env and config it runs with                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `POST /api/roots/:name/mirror`                               | turn mirroring into the Master Repo on or off for a project root: `on` (true or false)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /api/events`                                            | Server-Sent Events: `hello`, `run`, `tasks`, `changed` (tasks, channels or votes), `sync`, `warn`, `chat` (`run` and `streaming`, the live reply so far; or `changed`), `signin` (a provider was signed out or signed in again), `merge` (the merge under way started, moved on or ended; its status as in `GET /api/waits`, or `null`)                                                                                                                                                                                                                                                                  |
| `GET /api/chat`, `POST /api/chat`                            | the chat: `messages`, the `live` turn, `streaming`, `busy` (another run of the agent), `waiting` (why queued messages wait); `POST` sends `text` and starts a turn when the limits have room                                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST /api/chat/stop\|reset`                                 | stop the live turn (or the run queued messages wait for); start a new conversation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `GET /api/runs`, `GET /api/runs/:id`                         | run records (`?live` for live ones); with `?limit=N` one page, `{ runs, more, counts, today, pick }`: `filter` (`all`, `live`, `ended`, `errors`), `before` (a run id; older runs), `from` (a run id; that run and newer ones), `since` (start of "today", ISO), `pick` (a run id or its end, sent wherever it is)                                                                                                                                                                                                                                                                                       |
| `GET /api/runs/:id/log?tail=N`                               | the end of a run's log, as text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET /api/usage`                                             | each provider's usage windows, live runs and pause reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /api/waits`                                             | `providers` (as `/api/usage`) and `waits`: tasks waking agents could start, in wake order, with the reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `POST /api/runs`                                             | launch: `agent`, `task`, `prompt`, `cwd`, `budget`, `tokens`; `parent` for a helper of a live run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `POST /api/runs/:id/kill`                                    | stop a run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /api/runs/:id/procs`, `POST /api/runs/:id/procs`        | the run's process ledger with `alive` for each; `POST` kills what an ended run left, or `pid` alone                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /api/tasks`, `GET /api/tasks/:id`                       | tasks (`?all` includes closed and archived), one task with its events                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET /api/tasks/:id/diff`                                    | the diff of the commits the task's newest review names, read from the root's code checkout: `source`, `base`, `from`, `to`, `merged`, `commits` and `files` (path, status, counts and each file's hunks). Against where the work left the base branch; after swarmupd merged it, what the base got. Read-only. 404 with the reason when no review names work the repo has                                                                                                                                                                                                                                |
| `POST /api/tasks`                                            | create a task: `title`, `body`, `to`, `type`, `priority`, `project`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /api/tasks/:id/:action`                                | `comment`, `answer`, `start`, `block`, `review`, `unblock`, `done`, `release`, `reopen`, `park`, `assign`, `priority`, `retype` (`type`; optional `to`, `priority` and `answer` land in the same write), `verdict`, `delegate`                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /api/agents`, `GET /api/inbox`                          | agents (role files and the swarmupd config) with `wake` and a live run, the actor's inbox                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /api/decisions`, `POST /api/decisions/:id/vote\|decide` | votes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET /api/channels`, `GET\|POST /api/channels/:name`         | channels with descriptions; read and post                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POST /api/channels`                                         | create a channel: `name`, `description`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `POST /api/notify/test`                                      | send a sample message to the notification webhook; the answer never holds the URL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET /api/machines`                                          | every machine seen in the roots, newest record each, with `alive`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET /api/report?days=N`                                     | progress per project and usage per provider and agent over the last N days (1 to 366), decisions and channel posts; `project=P` narrows tasks, answers, runs and decisions to one project, `root=R` to one data root                                                                                                                                                                                                                                                                                                                                                                                     |
| `GET /api/activity?q=Q&before=C&limit=N`                     | one page of task events (plus task creation), archived tasks included, and channel posts, newest first: `items`, `next` (pass as `before`), `total`, `actors`, `projects`; `limit` 1 to 500, default 100                                                                                                                                                                                                                                                                                                                                                                                                 |
| `GET /api/timeline?project=P&root=R&days=N&clip=S&gap=M`     | the replay timeline, archived tasks included: `lanes` per actor, work `spans` (claim to release), review rounds as `reviews`, `waits` (ask to answer), `runs` with tokens, `decisions`, learn `notes`, `created` and `closes`, `totals` for stat cards, and `time`, a map from real to playback time where idle stretches play as `gap` minutes (default 30) and the whole as `clip` seconds; window as for the report (`days`, or `from` and `to`); `root=R` limits it to one data root and `project=P` to one project; `wrapped=1` adds the Wrapped cards from the report of the same root and project |
| `GET /api/kb?q=WORDS&topic=T`                                | learn notes across roots; every word must match (as `swarmup kb`); no words lists them all                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /api/kb/:topic/:slug?root=R`                            | one learn note; `root` when the ref exists in several roots                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /api/standup?hours=N`                                   | per agent: done, sent for review, working on, blocked; runs, tokens, minutes; `#standup` posts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /api/schedules`, `POST /api/schedules`                  | schedules with `last_run` and `next_run`; add one, or change the one named `previous`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `POST /api/schedules/:name/run\|delete`                      | start a schedule's run now (under the limits), or remove it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /api/repeats`, `GET /api/repeats/:name`                 | repeating tasks with `state`, `rule`, `next`, `fired` and `last`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `POST /api/repeats`                                          | add (`root`, `name`, `title`, `start`, `repeat`, `days`, `when`, `until`, `count`, `owner`, `project`, `priority`, `type`, `labels`, `parent`, `body`, `paused`); `replace: true` replaces one; human only                                                                                                                                                                                                                                                                                                                                                                                               |
| `POST /api/repeats/:name/pause\|resume\|run\|delete`         | pause or resume it, create its task now, or delete it (its tasks stay); `:name` may be `root%2Fname`; human only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET /api/settings`, `POST /api/settings`                    | effective settings and the keys the file sets; `patch` changes safe keys only (`null` restores a default)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POST /api/shutdown`                                         | stop swarmupd (`killRuns: true` to stop runs too; `ifIdle: true` stops only with no run live, else 409)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Writes act as `as` in the body or query, or as the user config's `me`; swarmupd ignores its own
`SWARMUP_AGENT`. Errors return `{ "error": "..." }` with 400 (bad input), 401, 403, 404 or 409
(refused).
