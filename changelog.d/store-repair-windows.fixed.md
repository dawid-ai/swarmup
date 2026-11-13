- On Windows, swarmupd repairs what a Codex sandbox session leaves in a task store, so the next
  session no longer fails with `EPERM` on a task, note or lock an earlier session made: it makes
  each file and folder the sandbox user owns again under your account, and removes the stale
  locks of a crashed session. It runs every 10 minutes and after each Codex run;
  `swarmupd.repair_stores: false` turns it off. Temp files older than an hour in `.ops/tmp` are
  named in the swarmupd log, and deleted only with `swarmupd.remove_stale_temp: true`.
