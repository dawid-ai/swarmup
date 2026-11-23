- Git triggers: `triggers/<name>.yaml` in a task store starts a run, a workflow or a repeat's task
  `every` interval, `at` a daily time or on a five-field `cron` in local time. A machine runs a
  store's triggers only after `swarmupd.triggers.<root>: true` (`swarmup triggers on --root NAME`)
  and after a person trusts the exact trigger set there (`swarmup defs trust`); any change stops
  them until trusted again. Only triggers whose `runs_on` names the machine fire, and a `run`
  trigger needs the agent's `wake: true` there; each fire time starts once, across restarts.
  `swarmup triggers list` shows when each fires next here, `swarmup validate` checks their targets,
  and `swarmup defs import-schedules` moves `swarmupd.schedules` into trigger files.
