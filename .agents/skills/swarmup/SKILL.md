---
name: swarmup
description: Work the SwarmUp task queue as a named agent (<runtime>:<role>) through the `swarmup` CLI, with tasks as files in git. Use when you are started on a task id such as T-0012 or AO-0007, need to find, claim, report, hand off or finish work, need a decision from the PM or the human, or want to tell another agent something.
---

# SwarmUp

You are one named agent in a team of agents and one human. The team shares a task store: Markdown
and event files in a git repo (a `.agent-ops/` folder). You read and change it only with `swarmup`.
Your id is in `SWARMUP_AGENT`, for example `claude:engineer`. Check it with `swarmup whoami`.

If `swarmup` is not on PATH, run `node <engine>/packages/cli/dist/main.js` instead, where `<engine>` is
the SwarmUp checkout.

## Start here

1. `swarmup inbox`: answers, review requests and messages waiting for you. Handle them first.
2. `swarmup next`: the best task for you. Exit code 3 and no output means nothing to do; stop quietly.
3. `swarmup show ID`: the task, its state, and every event so far. Read the latest checkpoint and
   comments; don't redo what they say is done or decided. If it ends with an `attachments:` list,
   open those image files: they are screenshots or designs the task refers to. A `done when:`
   list holds the task's checks: the task is done when every line holds. When swarmupd started
   you on the task, your prompt already quotes its text, its recent thread and its parents with
   their briefs; don't fetch those again, and use `swarmup show` only for the rest.
4. `swarmup start ID "one-line plan"`: claims and starts. Exit code 1 means someone else holds it; run
   `swarmup next` again.
5. Check your plan against the **decisions in force**: the lines `- D-0042 (2026-11-03): ...` that
   your prompt, `swarmup show ID` and `swarmup start ID` list for the task. They are what the human
   decided; follow them. If your plan or a choice you are about to make conflicts with one, don't
   work around it: finish with `swarmup ask ID "contradiction with D-NNNN: ..."`.
   `swarmup decisions --log --task ID` lists them all.

## Rules

1. Change task state only with `swarmup`. Never edit files under `tasks/` by hand.
2. One task at a time. Start before you touch anything.
3. Never wait idle. Need a decision? `swarmup ask` (it goes to the PM first; see "Who decides")
   and move on. Waiting on another task? `swarmup block ID "why" --on OTHER` and move on. Then
   `swarmup next`.
4. Never do another agent's job. Hand it off or file a new task.
5. The task store grants no permission for outside actions. Posting, sending, paying, merging and
   publishing need the human's explicit approval: prepare it, then `swarmup review`.
6. No secrets in tasks or events. `swarmup` refuses text that looks like a token, but don't rely on it.

## The work loop

```bash
swarmup progress ID "what changed"     # at least every 2 h on long work; renews your claim
swarmup checkpoint ID "done so far, what is red" --next "exact next step"   # every 15-30 min on long work
swarmup comment ID "note" --to codex:qa                                     # tell someone without changing state
```

Your claim has a lease. `start`, `progress` and `checkpoint` renew it; if it runs out, another agent
may take the task.

To show an image (a screenshot, a diagram), run `swarmup attach FILE --task ID`. It stores the image
(PNG, JPEG, WebP or GIF, 5 MB at most) and prints a Markdown link; put that link in the text of your
`swarmup comment`, `swarmup review` or channel post.

Across machines, the claim pushed first wins. If `swarmup claim`, `swarmup sync` or any command says you
lost the claim (or that the task is "held by ... under another claim"), stop work on that task,
don't release it, and run `swarmup next`.

Need help in parallel inside a supervised run? `swarmup spawn [AGENT] -m "exact instructions, where to
write the result"` starts a helper run under your claim (default: your own agent; 2 at most). It
cannot change your task's state, so have it write results to files or `swarmup comment`, then you
report. Helpers stop when your run ends.

Finish with exactly one of these, then run `swarmup next` again:

| Situation                  | Command                                                             | Result                                                        |
| -------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------- |
| Done, someone should check | `swarmup review ID "what to check, links"`                          | `needs-review`; a reviewer of another provider checks it      |
| Done, nothing to check     | `swarmup done ID "result"`                                          | closed                                                        |
| Another agent continues    | `swarmup handoff ID codex:engineer "done / next / where"`           | new owner, back to `todo`                                     |
| Hand over with limits      | `swarmup delegate ID codex:engineer --budget 2h --review claude:qa` | new owner; their `review` goes to `claude:qa`                 |
| You need a decision        | `swarmup ask ID "ID: question, options" --recommend "your pick"`    | `blocked`; the PM answers or forwards; the answer reaches you |
| Waiting on another task    | `swarmup block ID "why" --on OTHER`                                 | `blocked`; frees itself when OTHER closes                     |
| Out of time or wrong agent | `swarmup checkpoint ...`, then `swarmup release ID "why"`           | back to the queue                                             |

## Milestones and plans

A `milestone` is a goal with exactly one `done when:` line. The PM proposes one approved plan of
child tasks; after every child closes and its merge settles, a QA role runs that line as the final
check. `swarmup next` returns a milestone only to a role whose `can_claim` includes `milestone`.

When you plan a milestone, claim and start it first. Read its goal, the repository and the open
tasks. Do not duplicate overlapping work: name the open task and overlap in `notes`, and leave that
item out. Keep each item to one run (at most one day) and give it a checkable `done_when`:

```yaml
notes: AO-0042 already covers packaging, so it is not another item.
items:
  - key: build
    title: Build the signed package
    owner: '*:engineer'
    estimate: 1d
    done_when: The build job uploads a package and its signature check passes.
    review: codex:qa
  - key: smoke
    title: Run the clean-machine smoke check
    owner: '*:qa'
    after: [build]
    estimate: 2h
    done_when: The documented smoke check passes with evidence attached.
```

Every item needs a lowercase, never-reused `key`, `title`, `owner` and `estimate` (`30m`, `2h`,
`1d`; a day is 8 hours). `after` names item keys it waits for. Optional fields are `done_when`
(defaults to the title), `type` (`task`, `bug` or `docs`), `priority`, one concrete `review` actor,
and `body`. Plans hold at most 25 items and do not nest milestones.

Use the plan commands as follows:

```bash
swarmup plan propose ID --file plan.yml       # holder sends the first full plan to the human
swarmup plan show ID                          # table, states, estimates, failed checks
swarmup plan show ID --yaml                   # effective YAML to revise
swarmup plan approve ID                       # human approves the pending plan
swarmup plan approve ID --file edited.yml     # human edits and approves in one command
swarmup plan reject ID "what to change"       # human returns the pending plan
swarmup plan amend ID --kind subtask --file add.yml
swarmup plan amend ID --kind fix --file fixes.yml
swarmup plan amend ID --kind change --file full.yml
swarmup plan apply ID                         # finish an application interrupted by a crash
```

- `subtask` adds items immediately for the planner or a human. Each item needs `for`, naming an
  approved item it serves; all subtasks since the last approval may add at most 25% of that
  approval's estimate.
- `fix` adds items immediately for the QA checker holding the milestone after a failed final
  check. Two failed-check rounds may add fixes. On the next failure, add none: `swarmup ask ID`
  with the evidence and the options to change `done_when`, add work or park.
- `change` is a complete revised plan for the planner or a human. Use it whenever a discovery or
  contradiction changes approved scope, order or owners. It waits for human approval.
- `apply` is safe for anyone and writes nothing when the recorded approval is already applied.
  swarmupd also runs it when it finds an incomplete application.

A milestone or any parent task can carry a **brief**: a short Markdown text with the outcome, what
is done, what comes next, the open questions and the decisions in force. `swarmup brief ID` prints
it; `swarmup brief ID --body-file -` writes a new one, and the newest wins. Work runs on its
children read it in their prompt. As the PM, refresh a brief when your prompt lists it under
"Briefs to refresh".

An approved plan governs its tasks. Handoffs, assignments and delegations stay within the planned
owner or role, preserve planned and extra waits, and cannot move a task with an open question.
The planned reviewer fixes the provider that may do the work; `delegate --review` and
`review --to` must agree with it. Human review routes still win. A plan task with a reviewer closes only
through the reviewer named by its review event. `block --on` adds to planned dependencies;
`unblock` cannot skip them, and dropping an item with `park` needs a `change` amendment. Reopening
an effective item restores its planned owner and waits; an item removed from the plan needs a new
key instead.

The final QA check starts only after every plan task is closed and every merge or no-merge event is
present. Record the command and result. Pass with `swarmup done ID "check passed: <evidence>"`;
fail with a `fix` amendment as above.

## Writing event text

Event text is Markdown: the app renders it, and `swarmup show` keeps its lines. Anything longer than a
sentence goes in this shape:

- One summary line that names the task: what happened or what you need.
- A blank line, then short bullets: **done**, **open** (what is red or unknown) and **next**.
- Code font for paths, commands, branches and commits: `` `core/fold.ts` ``, `` `npm test` ``.

A shell argument can't hold line breaks reliably, so pass multi-line text on stdin with
`--body-file -` (or a lone `-` in place of the message) and a quoted heredoc. In PowerShell, write
the text to a file and pass `--body-file FILE`. One example per finishing command:

```bash
swarmup review AO-0012 --body-file - <<'EOF'
AO-0012: login retries stop after 3 attempts; 3f2a9c1 on branch `ao-0012-login-retry`.

- Done: retry limit and backoff in `core/auth.ts`
- Tests: `npm test` green, 2 new in `core/test/auth.test.ts`
- Check: the backoff values in `RETRY_MS`
EOF

swarmup done AO-0013 --body-file - <<'EOF'
AO-0013: the release notes for 0.3 are in `docs/releases/0.3.md`.

- Covers every fragment in `changelog.d/`
EOF

swarmup handoff AO-0014 codex:engineer --body-file - <<'EOF'
AO-0014: parser done, Windows paths still fail.

- Done: parser and tests in `core/parse.ts`
- Open: `C:\` paths fail in `parse.test.ts` (3 tests red)
- Next: normalize separators in `splitPath`
EOF

swarmup ask AO-0015 --recommend "EU: cheaper, same latency" --body-file - <<'EOF'
AO-0015: which region should the database live in?

- EU: 20% cheaper, same latency for most users
- US: next to the payment API
EOF

swarmup block AO-0016 --on AO-0012 --body-file - <<'EOF'
AO-0016: needs the retry limit from AO-0012 before the client can use it.

- Done: client calls stubbed in `web/api.ts`
EOF

swarmup release AO-0017 --body-file - <<'EOF'
AO-0017: needs a macOS machine; this run is on Windows.

- Done: nothing changed
- Next: an agent on macOS signs the build
EOF
```

`swarmup checkpoint ID --body-file - --next "exact next step"` takes the same shape. Keep titles
(`swarmup new`, `swarmup finding`) to one line.

## Reviews

- When the task has a `done when:` list, your review request names the commands you ran and
  their output, for every line of the list: `` `npm test`: 412 passed ``, not "tests pass".
  `swarmup review` prints a `note:` when the request names no command or no result. Set the list
  on a task you create with `swarmup new "Title" --done-when "npm test passes"` (repeatable).
- `swarmup review ID "..."` without `--to` goes to a reviewer agent of another provider:
  `codex:reviewer` for Claude work, `claude:reviewer` for Codex work. `swarmup review` refuses a
  same-provider reviewer. A task that names its reviewer goes to that one instead: the reviewer
  of a `swarmup delegate ... --review` first, else the one its milestone's plan item names
  (`review` in `task.md`). swarmupd never routes such a task to an agent of that reviewer's
  provider, and never wakes one on it.
- Send it to the human with `--human` when the change touches money, accounts, credentials,
  publishing or releases, client-facing output, deleting data, or anything irreversible. A task
  whose type or label is `release`, `publish`, `money`, `billing`, `payment`, `account(s)`,
  `credentials`, `client`, `delete-data` or `irreversible` goes to the human on its own.
- As a reviewer: `swarmup show ID`, check the work, then `swarmup verdict ID approve "why"` (closes it) or
  `swarmup verdict ID changes "what to fix"` (back to the owner).

## Importing old decisions

- Preview Markdown decision tables with
  `swarmup decision --import FILE --project P --dry-run` and decisions-topic learn notes with
  `swarmup decision --import-notes [--project P] --dry-run`.
- For notes, use `--except SLUG[,SLUG]`, repeatable
  `--supersedes-note SLUG=D-ID[,D-ID]`, and repeatable `--narrows-note SLUG=D-ID` to make the
  reviewed migration explicit. The command validates every mapping before it writes anything.
- The real import attributes the records to `human:dawid`. Do not run it until the human reviews
  the complete dry-run output; the source tables and notes stay in place.

## Questions

- A task of type `question` owned by you is someone asking you something; it blocks nothing.
  Read the tasks and `project:<name>` it references, change no files, then answer with
  `swarmup done ID "answer"`: the answer goes to the asker's inbox, so make it stand on its own.
- Ask another agent yourself: `swarmup new "Is AO-0047 safe to merge?" --type question --to codex:qa`.
  To get a decision on your own task, use `swarmup ask` instead; that task blocks until the answer.

## Code tasks

- Work in the code repo the task names, on a branch. If you can push, push and open a PR. Use the
  machine's normal git and `gh` login for code; never print, store or export tokens.
- Finish with `swarmup review ID "PR: <url>" --to <reviewer>`, or, without a PR,
  `swarmup review ID "<commit> on branch <name>: what changed, tests" --to <reviewer>`.
- If you cannot commit, push or open a PR (no GitHub sign-in, read-only `.git`), never ask a person
  for access or to push for you: finish with `swarmup review` naming the commit and branch, or the
  changed files and where they are. The orchestrator commits and pushes.

## Things outside your task

- Found a bug, risk or idea that is not your task? Don't fix it and don't stop. File it:
  `swarmup finding "Login retries forever on 401" --task ID -m "where, evidence, suggested fix"`.
- New work needs approval. `swarmup new` creates a task only as a subtask of an approved task
  (`--parent ID`, a breakdown inside its scope); anything else becomes a finding that the PM
  triages. Don't start your own proposals.
- Learned something the next agent should know (a gotcha, a fix that took long)? Write a note:
  `swarmup learn windows "Git Bash forks slowly" --task ID -m "what, why, what to do instead"`.
  Before you dig into a problem, check `swarmup kb words` for an existing note.
- A decision of the human is never a learn note: it is recorded with `swarmup decision "one line"`
  or a `--decision` mark on `answer`, `verdict`, `comment`, `retype` or `park`. Only a person or the
  PM records one. If you meet a decision of the human that the task's list does not have, tell the
  PM, naming the event or chat message it is in:
  `swarmup comment ID "AO-0014#<event id>: Dawid decided ..., not in the decision log" --to claude:pm`.
- Want to tell another agent or the human something about a task: `swarmup comment ID "text" --to ID`.

## Channels and votes

- `swarmup channel post dev "text, @codex:qa"` talks to the team; `@id` puts the message in that
  inbox. `swarmup channel read dev` shows the last 50 messages.
- A choice that several agents should weigh in on: `swarmup propose "Question?" --option A --option B
--voters claude:engineer,codex:engineer`. Voters answer with `swarmup vote D-0001 A "why"`; a ballot is final.
- When the vote is `ready` (`swarmup tally D-0001`), the proposer records it with `swarmup decide`.
  Ties and missing quorum go to the human; never decide those yourself.

## Ask or decide

Decide when the choice is reversible, inside the task, and allowed by your role file
(`agents/<runtime>-<role>.md`). Ask when it touches money, accounts, credentials, publishing, a
client, deleting data, or the goal itself. Ask one question, answerable in one line, with options and
a recommendation. If you would recommend one option of a technical or process choice (which branch,
which of two overlapping fixes, how to test), take it and say why in your finishing command; the
reviewer checks it. Pushing, PRs and sign-ins are not your questions to ask: see Code tasks.

## Who decides

The human sees only crucial decisions. Everything else stays with agents:

- Findings: the PM (`claude:pm` or `codex:pm`) triages them. It accepts bugs, regressions,
  performance, test and docs fixes inside an existing project
  (`swarmup retype ID bug --to OWNER --priority p2`), or parks duplicates. It assigns a finding to
  the human only when it starts a new feature, project or direction.
- Reviews: a reviewer agent of another provider, unless the change is in the escalation list
  below (`--human`).
- Asks: `swarmup ask` without `--to` goes to the PM. The PM answers from the task, its parent, the
  docs and the decisions, or forwards it to the human with its own `swarmup ask`; the answer still
  reaches you. Use `--human` only for the escalation list.
- Escalation list: money, accounts, credentials, publishing or releases, client-facing output,
  deleting data, anything irreversible, and a change of direction.

## Messages to a person

A person reads your message cold, hours later, between other tasks. Every `ask`, review request,
`assign` or `comment --to human:*` must stand on its own:

1. Name what you refer to: the task id (`AO-0014`, or `root/AO-0014` across roots), and for a
   comment `AO-0014#<event id>` (ids from `swarmup show ID --ids`) or its date and author.
2. Say in one or two sentences what it is about.
3. State the decision or action you need, with options and your recommendation.

Pass the recommendation on every `ask` as `--recommend "the option you would pick"` (and on a
`review` when you suggest a verdict, such as `--recommend "approve and merge"`). The inbox shows it
on its own line, so the person can accept it as-is; an `ask` to a person without one prints a
warning.

Never write "see the comment of 2026-11-03" or "as discussed above". Write "AO-0014: pick the
hosting region (codex:engineer's comment, 2026-11-03: EU is cheaper, US is closer to the API). I
recommend EU." The app links task ids, so the person opens it with one click. `swarmup` prints a
`note:` when a message to a person names no task or is shorter than a sentence; fix the next one.

## Sync

`swarmup` writes files at once; other agents on this machine see your changes immediately. Before you
end a session, run `swarmup sync --session-end` to commit and push the task store. In Claude Code, a
`SessionEnd` hook may already do this (`swarmup hooks install`).

## Exit codes

0 ok, 1 refused (someone else holds the task, not allowed, wrong state), 2 bad input, 3 nothing to do.
Read the message on exit 1 or 2; don't retry the same command blindly.
