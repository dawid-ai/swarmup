---
kind: module
summary: Runtime invocations and run prompts; work, review, question and check prompts, tools and deny lists
covers:
  - packages/supervisor/src/runtimes.ts
  - packages/supervisor/src/review-checks.ts
  - packages/supervisor/src/test-changes.ts
  - packages/supervisor/src/releases.ts
links: [wake, /core/knowledge, /core/map]
---

# Runtimes and prompts

## Purpose

Turns a launch into a command line and a prompt for Claude Code, Codex or any configured CLI.

## How it works

- `invocation` builds the args per runtime: Claude's allowed tools and `CLAUDE_DENY`, Codex's
  sandbox and writable dirs, read-only roles, model and effort.
- `runPrompt` assembles the standard prompt: role file, learn notes (up to 3), the project map
  block, then the work, review, question or milestone-check lines, decisions in force, and the
  rules for supervised runs. `chatPrompt` is the chat turn's prompt.
- Review prompts: the reviewer judges the work against the task and its "Done when", runs no
  tests, and gets `test-changes.ts`'s list of changed tests and check configuration.
- `review-checks.ts` runs merge checks for a reviewer that cannot; `releases.ts` gives a Codex PM
  the releases it cannot fetch.

## Invariants

- A custom prompt (schedules) is used as given, plus the folder rules.
- A line in the prompt is read every time; prefer it over a command the agent may skip.

## Gotchas

- Prompt wording is tested by exact strings in `packages/supervisor/test/`; update them together.
