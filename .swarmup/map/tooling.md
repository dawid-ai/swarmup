---
kind: area
summary: Workspace build, lint, format, typecheck, tests and CI configuration, plus dev scripts
covers:
  - package.json
  - pnpm-workspace.yaml
  - pnpm-lock.yaml
  - tsconfig.base.json
  - tsconfig.json
  - tsconfig.test.json
  - eslint.config.js
  - .prettierrc.json
  - .prettierignore
  - .editorconfig
  - .gitattributes
  - .gitignore
  - .npmrc
  - vitest.config.ts
  - vitest.setup.ts
  - .github/workflows/ci.yml
  - .claude/settings.json
  - scripts/setup-hooks.mjs
  - scripts/bench-next.mjs
  - scripts/desktop-smoke.mjs
  - scripts/orientation.mjs
  - scripts/prettier-check.mjs
links: [leaks, release]
---

# Tooling

## Purpose

How the monorepo builds and checks itself, locally and in CI.

## How it works

- pnpm workspace (`pnpm-workspace.yaml`); `tsc -b` builds `core`, `supervisor`, `cli` and
  `desktop` through project references (`tsconfig.json`).
- `pnpm run typecheck` also checks tests (`tsconfig.test.json`) and the UI.
- `pnpm run lint` is ESLint plus `prettier --check .` (print width 100, single quotes).
- Vitest runs `packages/*/test/**/*.test.ts` against sources via aliases, at most 4 workers:
  process creation on Windows is the bottleneck.
- CI (`ci.yml`): lint, typecheck, tests and the leak check, then the desktop smoke under xvfb.
- `scripts/setup-hooks.mjs` points git at `.githooks/` on install; `.claude/settings.json` holds
  the Claude Code hooks that sync the task store at session end and before compaction.

## Invariants

- Install with `pnpm install --frozen-lockfile`; never symlink `node_modules` between checkouts.
- Prettier checks every Markdown file too, `.swarmup/map/` included.
