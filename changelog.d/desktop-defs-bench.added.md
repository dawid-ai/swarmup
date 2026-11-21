- **Settings > Definitions** shows each project's `swarm.yaml`: the definition hash and commit,
  the value swarmupd runs with for each key and whether it comes from git or your user config,
  and the problems, with their lines marked in a view of the file. **Validate**, **Import from my
  settings** (a preview, then a write; your user config keeps its keys), **Create swarm.yaml** from
  the template, and **Edit** with checks as you type.
- A **Benchmarks** view lists benchmark sets and runs, shows a run's attempts with each
  criterion's result, cost, time, diff and agent log, follows a run under way, and compares two
  runs with deltas. **Run benchmark** shows the plan of a dry run first and starts an agent run
  only after you confirm its cost; reference and no-agent runs cost nothing. Sets come from each
  project's `.swarmup/benchmarks/` and the new `swarmupd.bench.sets` key.
- `swarmup bench run` keeps a `status.json` in its out folder with the run's state and progress.
