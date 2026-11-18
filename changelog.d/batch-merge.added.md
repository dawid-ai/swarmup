- swarmupd merges approved tasks that wait together in one batch: it rebases them in turn onto
  one candidate branch, runs the root's merge checks once, and moves the base once. When the
  checks fail, it splits the batch and checks the halves, so only the task that breaks the checks
  goes back. Each task keeps its own merge event. `swarmupd.merge.<root>.batch` sets the most
  tasks per batch (default 8); `1` merges each task alone.
