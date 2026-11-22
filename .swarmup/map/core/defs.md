---
kind: module
summary: 'Definitions as code: swarm.yaml, agent folders, workflows; validate, hash, migrate, merge, run stamps'
covers:
  - packages/core/src/defs
  - packages/core/schemas
  - packages/core/templates/swarm.yaml
  - scripts/gen-schemas.mjs
  - packages/supervisor/src/defs-config.ts
  - packages/supervisor/src/defs-state.ts
  - packages/supervisor/src/defs-import.ts
  - packages/desktop/ui/src/ui/defs.tsx
  - packages/desktop/test/defs-view.test.ts
  - packages/cli/src/defs-cmd.ts
  - docs/definitions.md
links: [store, /cli, /supervisor, /supervisor/runs, /leaks]
---

# Definitions as code

## Purpose

A task store's `swarm.yaml`, agent files and workflows hold the team's runtime models, efforts,
role limits, policy and repeatable plans in git; each machine's user config still wins. W5
phases 1 to 3; see `docs/definitions.md` and `docs/protocol.md` ("Workflows").

## How it works

- `defs/schema.ts` is a small schema language: one schema checks parsed YAML (problems with file,
  key path, line, column, severity) and emits JSON Schema 2020-12. `swarm.ts` and `agent.ts`
  define the two schemas; `scripts/gen-schemas.mjs` writes `packages/core/schemas/`.
- `load.ts` `loadDefinitions(dir)` reads `swarm.yaml`, `agents/**` and `workflows/**`, checks
  them (legacy files with `AGENT_SCHEMA`, `agents/<role>/agent.md` with `FOLDER_AGENT_SCHEMA`,
  addenda with `ADDENDUM_SCHEMA`), runs the cross-file checks in `validate.ts` (shadowed folders,
  addenda that never apply, `work_types` workflows), and caches by paths, sizes and change times.
  `hash.ts` gives the definition hash, `d:` and a SHA-256 over normalized texts.
- Agent folders are read in `core/src/agents.ts` (`agentFilesFromTexts`): one agent per provider,
  addenda overlaid with `mergeValues`, a legacy file of the same id wins. `migrate.ts` plans and
  applies `swarmup defs migrate`, refusing unless the folders give every agent the same fields.
- `workflow.ts`: the workflow schema, `readWorkflows`, and `compileWorkflow` to a `PlanDoc`
  (parameters, `when`, gates, `criteria.<type>`, `rework`), checked with `validatePlan`.
- `swarm.ts` activates `policy.*`, `defaults.budget_min` and `work_types`; `withDefinitions` puts
  policy only under top-level keys the machine leaves unset (`OpsdConfig.explicit`), and an agent
  file's `writes` under the machine's role `writes`.
- In swarmupd, `defs-state.ts` re-reads the roots when the fingerprint changes and
  `defs-config.ts` `withDefinitions` merges git values under the machine config; the supervisor
  keeps both configs and stamps each run (`RunRecord.defs`, `run-start.defs`, `state.db`).
- `defs-cmd.ts` holds `swarmup validate` and `swarmup defs show|hash|diff|import-config`.
- `withDefinitions` also returns `values`: each git key with its effective value and source
  (`git`, `machine`, `unused`), which `GET /api/defs` serves with each root's `swarm.yaml` text.
- `defs-import.ts` holds what the CLI and the API share to write `swarm.yaml`: the importable part
  of the user config, the import preview and line diff, the template, and an atomic write that
  checks the text and refuses a file changed since it was read. The API adds
  `POST /api/defs/{validate,import,create,save}`.
- `variants.ts`: overlay folders `variants/<name>/` merged onto the base texts (YAML deep-merge,
  agent frontmatter merge, body replace, `.delete`), `loadDefinitions(dir, { variant })` and a hash
  per variant. `proposals.ts`: the `improvement` policy of `swarm.yaml`, `policyProblems`,
  `proposal.json`, `listVariants` and `applyVariantToBase`; `defs-cmd.ts` adds
  `defs propose|promote|reject|variants` and `validate --variant` (see `/improve`).
- `desktop/ui/src/ui/defs.tsx` is **Settings > Definitions**: a card per root with the hash and
  commit, effective values, problems, the YAML with problem lines marked, and in-place edits.

## Invariants

- A store without `swarm.yaml` changes nothing: same config object, no new run fields or events.
- Git never names a command swarmupd runs: runtime commands, args, env and capacity keys are
  refused in `swarm.yaml`.
- No synchronous git in `launch`: the store commit is looked up off the event loop (AO-0171).
- Folder writes from the app need `swarmup_defs: 1` in the store's `swarm.yaml`, so a fleet on a
  version that reads only legacy files keeps its agents.

## Gotchas

- `packages/core/schemas/` is generated and in `.prettierignore`; a test compares it with the
  schema language, so run `node scripts/gen-schemas.mjs` after a schema change.
- `packages/core/test/fixtures/workflows/` holds golden plans of the starter workflows, compared
  byte for byte and kept out of Prettier; regenerate them when a template changes.
