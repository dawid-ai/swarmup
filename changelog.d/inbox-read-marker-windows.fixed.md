- `swarmup inbox --mark-read` no longer fails with `EPERM` on Windows when the agent's read marker
  cannot be replaced, as happens to a marker made by an earlier Codex sandbox session: the new
  position goes to a spare marker file next to it, so items you have handled stop coming back. A
  write that fails no longer leaves its temp file in `.ops/tmp`.
