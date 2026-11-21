- A task store can keep the team's runtime models and efforts and its role limits in
  `swarm.yaml`, versioned in git; each machine's user config still wins. `swarmup validate` checks
  it and the agent files with line and column, `swarmup defs` shows, hashes and diffs it and imports
  it from the user config, and each run records which definitions it started with. A store without
  `swarm.yaml` works as before.
