---
kind: flow
summary: Content projects (W8); campaign and content templates, review artifacts, publish records and the artifact route
covers:
  - packages/core/src/content-templates.ts
  - packages/core/src/artifacts.ts
  - packages/supervisor/src/artifact-api.ts
  - docs/content-projects.md
links: [adopt, fold, workspace, /supervisor/merge, /supervisor/prompts, /desktop/ui]
---

# Content projects

## Purpose

Lets non-code work (campaigns, blogs, submissions) run like code: drafts on branches, review by
commit, criteria at merge, and a publish step only a person takes. `main` means approved.

## How it works

- `content-templates.ts`: `CONTENT_TEMPLATES` (`campaign`, `content`) add to
  `PROJECT_TEMPLATES`: `AGENTS.md`, `brand/voice.md`, `facts/claims.md`, three 0-4 rubrics,
  `calendar.md`, `posts/`, `assets/`, map nodes, `workspace_types`, merge checks and
  test-change paths, and first tasks with typed criteria (the draft names `codex:editor`).
  `campaign` copies the starter workflows `content-piece` and `campaign-launch` into the store,
  `content` copies `content-piece`: brief, a gate the person decides, a draft the editor reviews,
  and a publish task owned by the person (see `/core/defs`).

- `artifacts.ts`: review artifacts (`namedArtifacts`, `changedArtifacts` minus
  `.swarmup/map/`), `workspacePath` (refuses paths outside the workspace) and `publishTarget`
  (tags `published/<ID>`, then `-2` and up). Git comes in as a `GitRun`, so the CLI runs it
  directly and swarmupd off the event loop.
- `Workspace.published` writes the `publish` event (a person outside a run only; a `publish`
  task closes with it); `publishChecks` runs `when: publish` criteria with `{url}`.
- `artifact-api.ts`: `GET /api/tasks/:id/artifact`, a file at the reviewed commit with its
  merge-base text, or an image as a data URL.
- The desktop task panel's **Mark published** (on an open `publish` task a person owns) posts
  to `POST /api/tasks/:id/published`, as `swarmup published` does.

## Invariants

- Publishing is never a criterion; `publish` tasks are owned and claimed by people unless
  `--force`, which is recorded.
- Runs cannot edit the store's `rubrics/`, `workflows/` or `triggers/`.
