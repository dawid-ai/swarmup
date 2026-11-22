---
kind: module
summary: swarmup adopt, new-project and init; repo survey, project templates and the role templates they copy
covers:
  - packages/core/src/adopt.ts
  - packages/core/templates
links: [store, map]
verified: 0837bfc6
---

# Adopt and templates

## Purpose

Starts a data root for a repo: survey it, propose roles and first tasks, create the root.

## How it works

- `surveyRepo` reads manifests (package.json, pyproject, Cargo.toml, go.mod and others) for
  stacks, frameworks, test, build and lint commands, docs and CI. Python tests that import
  `unittest` get `python -m unittest` when no pytest config is found.
- `adoptPlan` proposes roles that fit the stack; `applyPlan` writes the root, role files and
  tasks. `swarmup adopt --store DIR` keeps the store apart from the repo.
- `PROJECT_TEMPLATES` (`web-app`, `library`, `docs-site`, ...) back `swarmup new-project`.
- `templates/agents/*.md` are the role files `init --with-agents` copies; `templates/people/`
  holds the owner template; `templates/swarm.yaml` is the commented starter that
  **Create swarm.yaml** writes (see `defs`). `init.ts` exports the folder as `TEMPLATES_DIR`;
  the installer ships it as `resources/templates`.

## Invariants

- Nothing is written before the plan is checked (role templates exist, the folder is empty for
  `new-project`).
- The desktop's **Add project** uses the same functions.
