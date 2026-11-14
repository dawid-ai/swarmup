- A decision log: `swarmup decision "one line"` records a decision a person made, for a project
  or for one task tree, and `swarmup decisions --log` lists the decisions in force, also for one
  task (`--task ID`). `--supersedes` and `--narrows` replace an earlier decision without editing
  it. Decided votes are in the log too, and a redecision with `--force` now adds an outcome file
  instead of rewriting one. Decisions mirror to the Master Repo.
