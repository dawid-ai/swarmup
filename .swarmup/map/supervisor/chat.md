---
kind: service
summary: The desktop Chat with the PM; each message is a read-only Claude run that resumes one session
covers:
  - packages/supervisor/src/chat.ts
links: [prompts, wake]
---

# Chat

## Purpose

The desktop's **Chat** view is one conversation with the PM agent (`swarmupd.chat.agent`,
default `claude:pm`), which turns ideas into tasks and routes them.

## How it works

- Each message starts a run with no task, under the usual limits. Messages sent while a turn
  runs wait and the next turn reads them all.
- The first turn starts a Claude session with `--session-id`; later turns `--resume` it. A turn
  that fails without a reply drops the session.
- Tools: the role file's, else read-only tools plus `swarmup`. `Edit`, `Write`,
  `swarmup verdict` and `swarmup decide` are always denied.

## Invariants

- Chat runs on Claude only; a chat agent on another runtime is refused.
- A chat turn holds no checkout and never waits for a writing run.
