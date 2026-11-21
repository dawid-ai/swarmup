- `swarmup bench run SET.yaml --repo DIR` replays the entries of a benchmark set against an agent
  configuration: each attempt gets a throwaway worktree at the entry's base, a non-interactive
  Claude or Codex run with swarmupd's command line and a time budget, and a score of its
  `done_when` criteria, with hidden acceptance tests copied in only while they run. It writes
  `results.json` per attempt and a `summary.json` and `summary.md` table with pass rate, hidden
  pass, cost, time and tool calls before the first edit. `--reference-dir` and `--agent none`
  check the harness without spending tokens. `swarmup bench compare A B` prints the deltas between
  two runs. See `docs/benchmarks.md`.
