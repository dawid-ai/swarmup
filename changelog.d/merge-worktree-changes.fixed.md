- swarmupd no longer merges an approved commit while the task's worktree holds uncommitted
  changes: it commits what a run could not commit and merges that, or sends the task back to its
  author with the list of files. A reviewer is told when a run asks for review with changes
  swarmupd could not commit. While git cannot read the task's worktree or swarmupd cannot look at its folder, or when a file there
  changes while swarmupd commits, or stays changed after that commit, nothing is merged. The
  repo's own checkout is looked at too when it has the review's branch checked out. Only the run
  that asked for the approved review counts for that commit: what an earlier run of the same
  author left is not committed or merged for a later review. A `review` event now names the run
  that asked (`run`), so a `run-end` that arrives late cannot stand in for another run's.
