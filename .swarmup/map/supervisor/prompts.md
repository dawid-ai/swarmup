---
kind: module
summary: Runtime invocations and run prompts; work, review, question and check prompts, run context, resumes, tools, deny lists
covers:
  - packages/supervisor/src/runtimes.ts
  - packages/supervisor/src/review-checks.ts
  - packages/supervisor/src/test-changes.ts
  - packages/supervisor/src/releases.ts
  - packages/supervisor/src/run-context.ts
  - packages/supervisor/src/resume.ts
links: [wake, /core/knowledge, /core/map]
verified: 0837bfc6
---

# Runtimes and prompts

## Purpose

Turns a launch into a command line and a prompt for Claude Code, Codex or any configured CLI.

## How it works

- `invocation` builds the args per runtime: Claude's allowed tools and `CLAUDE_DENY`, Codex's
  sandbox and writable dirs, read-only roles, model and effort. A read-only scratch writer (the
  improver) gets `Edit` and `Write` for its scratch folder only, denied everywhere else it
  reads. For Claude and Codex it also
  returns the `model` and `effort` it passed, for the run record.
- `runPrompt` assembles the standard prompt: role file, learn notes (up to 3), the project map
  block, then the work, review, question or milestone-check lines with the task's criteria, the
  run context, decisions in force, and the rules for supervised runs. `chatPrompt` is the chat turn's prompt.
- Review prompts: the reviewer judges the work against the task and its "Done when", runs no
  tests, and gets `test-changes.ts`'s list of changed tests and check configuration, and the
  review's artifacts with `git show <commit>:<path>` for each file.
- `run-context.ts` inlines what a run would otherwise fetch first: the task text, its recent
  thread and its parents with their briefs; for a PM's inbox run, the briefs behind their
  closed children (`briefsToRefresh`, through `task-criteria.ts`'s `closedSinceBrief`).
- `resume.ts` decides whether a work run that came back with changes resumes its earlier
  session (`swarmupd.resume_on_changes`, `resume_max_hours`) and builds that invocation and
  its short delta prompt.
- `review-checks.ts` runs merge checks for a reviewer that cannot; `releases.ts` gives a Codex PM
  the releases it cannot fetch.

## Invariants

- A custom prompt (schedules) is used as given, plus the folder rules.
- A line in the prompt is read every time; prefer it over a command the agent may skip.

## Gotchas

- Prompt wording is tested by exact strings in `packages/supervisor/test/`; update them together.
