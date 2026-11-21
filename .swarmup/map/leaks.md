---
kind: module
summary: Secret scanning; one pattern set for the event write path, the leak check script and the pre-commit hook
covers:
  - packages/core/src/secrets.ts
  - scripts/check-leaks.mjs
  - .githooks
links: [tooling, core/workspace]
---

# Leak check

## Purpose

Keeps tokens, keys and webhook URLs out of tasks, events and this public repo.

## How it works

- `secrets.ts` holds the patterns: `secretKind(text)` names the first kind found (never the
  secret), and file names such as `.pem`, `.key` or `id_rsa` count as keys.
- `Workspace` refuses an event or task whose text has a hit (`assertNoSecret`); definition
  files get an error per line with a hit (`core/defs`).
- `scripts/check-leaks.mjs` (`pnpm run leaks`) scans tracked and untracked files, or only staged
  ones with `--staged` from `.githooks/pre-commit`. `--deny FILE` adds terms kept outside the repo,
  such as private org names.

## Invariants

- Never print, store or export a token or key, in code, tests, logs or messages.
