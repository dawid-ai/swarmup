- A task blocked with `--on` no longer frees when a reviewer approves the dependency but swarmupd
  has not merged its branch yet. Where `swarmupd.merge` is set for the dependency's root, the task
  frees after swarmupd records the merge, and `swarmup show` says which merge it waits for.
  `swarmup report` counts such a task as unblocked after the merge, not at the approval.
