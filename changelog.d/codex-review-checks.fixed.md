- A Codex reviewer no longer reviews without test results. Its sandbox cannot build, install or
  test, so swarmupd now runs the root's merge `checks` on the reviewed commit before the review
  run starts, in a worktree of its own, and puts each command's result and a failed command's
  output in the run's prompt. `swarmup waits` shows the review as waiting for the checks;
  `swarmupd.review_checks: false` turns it off.
- A Codex run of a role that does not write can write its scratch folder, where `TEMP` points.
- `swarmup sync --session-end` in a supervised run whose sandbox refuses git or has no network
  says that swarmupd syncs the store when the run ends, and exits 0 instead of failing on
  `.git/index.lock`.
