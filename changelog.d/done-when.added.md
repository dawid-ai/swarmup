- A task can say when it is done: `swarmup new --done-when "CHECK"` (repeatable) stores a list of
  checks in the task's `done_when` field, and `swarmup show` prints it. Run and review prompts
  point at the list.
- `swarmup review` prints a note when a request on a task with `done_when` names no command or no
  result. The request is still sent.
