---
kind: flow
summary: Wake planning, launch and limits; which agent runs which task where, usage pauses, sign-in and stuck runs
covers:
  - packages/supervisor/src/supervisor.ts
  - packages/supervisor/src/stuck.ts
  - packages/supervisor/src/quota.ts
  - packages/supervisor/src/usage.ts
  - packages/supervisor/src/signin.ts
links: [runs, prompts, merge, /docs]
verified: 0837bfc6
---

# Wake, launch and limits

## Purpose

Decides when an agent run starts, for which task and in which folder, and stops runs that pass
their budget.

## How it works

- Agents with `wake: true` in the user config get a run when a task they may claim is ready.
  `swarmup launch` starts one by hand; `swarmup waits` shows why a wake waits.
- `launch` checks every limit, claims the task before the process starts, builds the prompt
  (see `prompts`) and spawns the runtime with the prompt on stdin.
- Limits (`docs/supervisor.md`, "Limits"): runs per PC and free memory, per provider, usage
  allowance, role per project, role total, and one writing run per checkout.
- `usage.ts` counts tokens from the run's log; `quota.ts` reads provider plan windows and pauses
  new runs near the limit; `signin.ts` checks a signed-out CLI without sending a prompt.
- `stuck.ts` stops a task whose runs keep ending without work.
- Config is two layers: `machineConfig` (the user config, what Settings edits) and the
  effective `config` with each root's `swarm.yaml` merged under it (`DefsState`, see
  `/core/defs`). Each tick re-merges when a definition file changed, before limits are read.
- A run's model and effort: Settings, then the role file's `runtimes.<rt>`, then its own
  values, then the provider's. With a `swarm.yaml`, `run-start` records the `defs` hash.
- `mapTopOf` finds a root's map folder; `criteriaDir` is where **Run checks** runs criteria.

## Invariants

- One task never has two live runs; a refused launch leaves the task as it was.
- A writing run starts only on a clean checkout (task stores and caches excluded).

## Gotchas

- The file is over 6000 lines and shared by many changes: put new logic in its own module and
  keep edits here small (the map prompt is `map-prompt.ts`).
