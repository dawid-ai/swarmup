- `improvement.requires` in `swarm.yaml` is now active: with `benchmark: true`, `swarmup defs
  promote` waits for swarmupd's benchmark of the variant as proposed, and refuses it when the
  benchmark failed, the variant changed since, or the pass rate gained less than `min_delta`.
  `--force` promotes it anyway and records that on the task.
