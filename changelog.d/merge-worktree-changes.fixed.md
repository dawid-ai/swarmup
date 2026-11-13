- swarmupd no longer merges an approved commit while the task's worktree holds uncommitted
  changes: it commits what a run could not commit and merges that, or sends the task back to its
  author with the list of files. A reviewer is told when a run asks for review with changes
  swarmupd could not commit. While git cannot read the task's worktree, or when a file there
  changes while swarmupd commits, nothing is merged.
