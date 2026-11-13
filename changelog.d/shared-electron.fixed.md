- A task worktree that runs the tests no longer holds its own Electron binary (about 350 MB).
  swarmupd keeps one unpacked copy per Electron version in its state folder (`electron/`) and
  names it in `ELECTRON_OVERRIDE_DIST_PATH` for agent runs and for merge and review checks. The
  copy comes from a checkout that already holds that version; when none does, the first run
  downloads it as before and swarmupd moves it to the shared place after the run.
