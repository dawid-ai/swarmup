- `swarm.yaml` `experiments` run a variant on a share of matching task runs (`id`, `variant`,
  `share`, `scope`, `until`). The side is fixed per task by `sha256("experiment:" + id + task)` and kept across
  runs, the run record and `run-start` event name the experiment, and a machine opts out with
  `swarmupd.experiments: false`.
- `swarmup scores --by-variant` splits each agent's task and run scores by variant, and score rows
  carry `defs_hash`, `variant` and `experiment`. `swarmup launch --variant NAME` runs one run with
  a variant.
