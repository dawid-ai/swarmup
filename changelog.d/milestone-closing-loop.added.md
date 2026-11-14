- The check that closes a milestone (step 3 of the milestone design). When every task of a
  milestone's plan is closed and merged, swarmupd starts a `qa` run on it with a check prompt: run
  the `done_when` line, record the evidence, then `swarmup done <milestone> "check passed: ..."`.
  A failed check adds one fix task per gap with `swarmup plan amend <milestone> --kind fix`, which
  blocks the milestone until the fixes close and merge. After two failed checks the next one adds
  none: `--kind fix` is refused, and the run asks with a plain `swarmup ask`, which reaches the PM.
  An approved plan change or a reopen starts a new count.
- `swarmup plan show` lists the failed checks, with the fix keys and the checker's note of each,
  and the parked items by key.
- `swarmup done` on a milestone is refused while a plan task is open or waits for its merge. A
  person passes, and anyone else with `--force`, recorded.
