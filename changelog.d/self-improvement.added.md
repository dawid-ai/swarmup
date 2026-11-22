- Variants: a sparse overlay folder `variants/<name>/` in a task store changes the definitions
  for the runs and benchmarks that ask for it. YAML deep-merges (maps merge, lists replace, `null`
  deletes), agent frontmatter merges the same way, a non-empty body replaces the instructions, and
  each variant has its own hash. `swarmup validate --variant NAME` checks one. A run started with
  a variant reads its resolved role file from its scratch folder and records the variant.
- Proposals: `swarmup defs propose ID --dir DIR --name NAME -m WHY` records an overlay on a task
  as a variant, after checking it against the store's improvement policy (`improvement.may_change`
  and `frozen` in `swarm.yaml`; an agent's `tools`, `writes`, `can_claim` and `id` are always
  frozen) and the cap on open proposals (`max_open_proposals`, default 2). A person runs
  `swarmup defs promote NAME` to write it onto the definitions or `swarmup defs reject NAME -m WHY`;
  `swarmup defs variants` lists them. Each step is a `defs-propose`, `defs-promote` or `defs-reject`
  event on the task.
- The improver: a `claude:improver` role template that turns an agent's failing scores into one
  small proposal. It runs read-only and may edit only in its scratch folder. With
  `swarmupd.improve.enabled: true` (off by default), swarmupd files an improvement task when an
  agent has `threshold` distinct failing task and run scores in `max_age_days` days.
- The benchmark gate: with `swarmupd.improve.benchmark` set, swarmupd replays the set with the base
  and with each new proposal's variant and comments the comparison on its task. Off unless set: it
  spends tokens. `swarmup bench run` takes `--role-file` and `--variant` with `--root` to put an
  agent's role file in each prompt.
- The desktop **Agents** view lists proposals with their diff, the scorers they address and their
  benchmark, with **Promote** and **Reject**. A failing scorer offers **Propose an improvement**.
