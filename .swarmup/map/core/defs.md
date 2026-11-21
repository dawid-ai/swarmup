---
kind: module
summary: 'Definitions as code: swarm.yaml and agent file schemas, validate, hash, merge under the machine config, run stamps'
covers:
  - packages/core/src/defs
  - packages/core/schemas
  - packages/core/templates/swarm.yaml
  - scripts/gen-schemas.mjs
  - packages/supervisor/src/defs-config.ts
  - packages/supervisor/src/defs-state.ts
  - packages/cli/src/defs-cmd.ts
  - docs/definitions.md
links: [store, /cli, /supervisor, /supervisor/runs, /leaks]
---

# Definitions as code

## Purpose

A task store's `swarm.yaml` and agent files hold the team's runtime models, efforts and role
limits in git; each machine's user config still wins. Phase 1 of W5; see `docs/definitions.md`.

## How it works

- `defs/schema.ts` is a small schema language: one schema checks parsed YAML (problems with file,
  key path, line, column, severity) and emits JSON Schema 2020-12. `swarm.ts` and `agent.ts`
  define the two schemas; `scripts/gen-schemas.mjs` writes `packages/core/schemas/`.
- `load.ts` `loadDefinitions(dir)` reads `swarm.yaml` and `agents/**`, checks them, runs the
  cross-file checks in `validate.ts`, and caches by paths, sizes and change times. `hash.ts` gives
  the definition hash, `d:` and a SHA-256 over normalized texts.
- In swarmupd, `defs-state.ts` re-reads the roots when the fingerprint changes and
  `defs-config.ts` `withDefinitions` merges git values under the machine config; the supervisor
  keeps both configs and stamps each run (`RunRecord.defs`, `run-start.defs`, `state.db`).
- `defs-cmd.ts` holds `swarmup validate` and `swarmup defs show|hash|diff|import-config`.

## Invariants

- A store without `swarm.yaml` changes nothing: same config object, no new run fields or events.
- Git never names a command swarmupd runs: runtime commands, args, env and capacity keys are
  refused in `swarm.yaml`.
- No synchronous git in `launch`: the store commit is looked up off the event loop (AO-0171).

## Gotchas

- `packages/core/schemas/` is generated and in `.prettierignore`; a test compares it with the
  schema language, so run `node scripts/gen-schemas.mjs` after a schema change.
