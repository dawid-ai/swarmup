- Scorers in git: `scorers/<id>.yaml` sets a built-in scorer's `pass` and `applies_to` (types,
  labels, roles, workflows) for a store's own work, under the machine's `swarmupd.scorers`.
  Rubric scorers (`kind: rubric`, with a rubric, judge, `sample` and `blind`) are checked and
  listed by `swarmup defs scorers`, but not run yet; a machine may only lower their `sample`.
  Runs may not edit `scorers/`.
