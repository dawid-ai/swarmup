- `swarmup defs rollback NAME -m WHY` puts back the agent and workflow files a promote changed,
  and records it on the proposal's task. It refuses when a file changed after the promote, unless
  you pass `--force`.
