---
kind: area
summary: User and contributor docs, the agent skill copies, and the README media and promo pipeline
covers:
  - README.md
  - docs
  - AGENTS.md
  - CLAUDE.md
  - CONTRIBUTING.md
  - CODE_OF_CONDUCT.md
  - SECURITY.md
  - LICENSE
  - skills
  - .agents/skills
  - .claude/skills/swarmup
  - scripts/readme-media.mjs
  - scripts/promo-video.mjs
  - scripts/promo
links: [release, core/map]
---

# Docs and skills

## Purpose

What people and agents read to use and change SwarmUp. The website builds its docs pages from
`README.md` and `docs/`.

## Where things are

- `docs/protocol.md`: ids, the state machine, commands, permissions, events, sync, decisions.
- `docs/supervisor.md`: swarmupd runs, prompts, limits, config, chat, merging, pushing, API.
- `docs/desktop.md`: the app. `docs/map.md`: the project map format and commands.
- `docs/definitions.md`: `swarm.yaml`, its precedence under the user config, run stamps.
- `docs/benchmarks.md`: benchmark sets, hidden tests, `swarmup bench run|judge|compare`, and
  judging rubric criteria.
- `docs/protocol.md` ("Rubric files") is the rubric format and how the judge scores; the judge's
  settings and its merge hook are in `docs/supervisor.md`.
- `skills/swarmup/SKILL.md`: the skill agents load to work the queue; `.agents/` and
  `.claude/skills/swarmup` are copies for Codex and Claude Code in this repo.
- `AGENTS.md`: rules for agents in this repo; `CLAUDE.md` points to it.
- `docs/media/`: README images; `scripts/readme-media.mjs` renders them against scratch roots
  with a fake agent, and `scripts/promo*` renders the promo video.

## Invariants

- A behavior change updates the doc that describes it in the same change.
- Docs follow the plain, second-person style of the existing pages; no private names or ids.
