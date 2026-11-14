- Mark a decision as you write it: `--decision "one line"` on `swarmup answer`, `verdict`,
  `comment`, `retype` and `park` records the line in the decision log with that event as its
  source, for the task and the tasks below it (`--scope project` widens it; `--supersedes` and
  `--narrows` replace an earlier decision). `swarmup show` prints the mark under the event, and
  `swarmup doctor` reports a recorded decision whose source event does not exist.
