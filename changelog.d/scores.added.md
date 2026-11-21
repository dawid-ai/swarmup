- `swarmup scores` grades agents from what SwarmUp already records: review rounds, merge failures,
  tokens per merged task, human touches, escalations, recommendations taken, stuck runs and tool
  calls before the first edit, with the worst tasks per scorer. `swarmup report` and the
  **Reports** view show each agent's scores for the window, and swarmupd keeps them in `state.db`.
  Thresholds are set under `swarmupd.scorers` in the user config.
