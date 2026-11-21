- A task run's prompt quotes the task text, its recent thread and its parents, so the agent no
  longer spends its first tool calls on `swarmup show` for the task, its parent and its milestone.
- A milestone or parent task can carry a goal brief (`swarmup brief ID --body-file -`; the newest
  wins). Runs on its children read it in their prompt, and the PM's inbox runs list the briefs
  whose children closed since they were written.
- A task that comes back with `changes` resumes the session of the run that did the work, for
  Claude and for Codex runs in a task worktree (`swarmupd.resume_on_changes`, on by default; up to
  `resume_max_hours`, 24, after that run). `scripts/orientation.mjs` reports how many tool calls
  runs make before their first edit.
