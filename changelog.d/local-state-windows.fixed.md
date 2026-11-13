- Claiming a task, syncing and mirroring no longer fail with `EPERM` on Windows when a state file
  in `.ops` cannot be replaced, as happens to a file made by an earlier Codex sandbox session: the
  new content goes to a spare file next to it (`<name>.<ulid>.json`), and reads take the newest of
  them. The task index and the activity index use the same spare instead of waiting about 0.6 s
  for the refused file on every read.
