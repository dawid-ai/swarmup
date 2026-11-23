---
kind: flow
summary: 'Inbound webhook triggers (W8 phase 4); the listener, verifiers, dedupe, fenced findings, swarmup trigger fire|test'
covers:
  - packages/supervisor/src/hooks.ts
  - packages/cli/src/trigger-cmd.ts
  - packages/supervisor/test/hooks.test.ts
  - packages/cli/test/trigger-cmd.test.ts
links: [index, wake, /core/triggers, /supervisor/mcp, /cli]
---

# Inbound webhook triggers

## Purpose

Lets a signed delivery from outside (Linear, Slack, GitHub-style HMAC, a bearer token) reach a
store's trigger, without opening the API or letting outside text act as instructions. See
`docs/definitions.md#webhook-triggers` and `docs/supervisor.md#inbound-webhook-triggers`.

## How it works

- `core/defs/trigger.ts`: the `webhook` section (`verify`, `secret` by name, `header`,
  `delivery_header`, `rate`) and its part of `triggersHash`.
- `supervisor/src/triggers.ts` `hookTarget`: the trigger a delivery fires here, or why none
  (consent, trust, a webhook section, enabled, `runs_on`); `approved`/`notDirect` say whether
  the action may run (`swarmupd.hooks.direct.<root>.<name>`, then the agent's wake and role).
- `hooks.ts` `HookListener`: its own `node:http` server, started by `daemon.ts` when
  `swarmupd.hooks.enabled`. Order: 404 for anything not a live hook, per-trigger rate (429), body
  cap (413), secret from `secrets.yml` (503), `verifyDelivery` (401), Slack's URL challenge,
  dedupe in `hooks-seen.json` (200), then `runHookEffect`; every outcome goes to `hooks.log`.
- `runHookEffect`: a finding via `newTask` in the trigger's root (owner `triagePm`, else the
  root's human), or the approved action (`launchBlocker` then `launchFresh`, `workflowStart`,
  `runRepeat` plus a comment), falling back to the finding with the reason. `fenceUntrusted`
  builds the payload block.
- `cli/src/trigger-cmd.ts`: `swarmup trigger fire` runs `runHookEffect` in the CLI as
  `opsd:trigger` (a run goes through `POST /api/runs` with `extra`); `trigger test` signs with
  `signDelivery` and posts to the local listener. `doctor.ts` `hooksChecks` reads
  `hooks-listener.json` and the hook triggers' secrets.

## Invariants

- No API or run token is valid on the listener, and it answers 404 alike for every trigger that
  does not take deliveries here.
- A payload reaches a task, prompt or note only through `fenceUntrusted`.
- An action runs only where a person set `swarmupd.hooks.direct.<root>.<name>: true`; otherwise,
  and whenever the action cannot run, the delivery is a finding.
- Secrets are read from `secrets.yml` by name and never logged, returned or written to a task.
