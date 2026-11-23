- Desktop app: an **Automation** view next to **Schedules** shows each project's git triggers
  (schedule, action, `runs_on`, next fire here or why not), its merge checks and whether this
  machine trusts them. **Turn on here**, **Review and trust** (the exact trigger fields and check
  commands, then a confirm), and **Revoke trust** replace the CLI round trip.
- The same view shows the inbound webhook listener (off, listening, or failed), turns it on with
  an offer to restart swarmupd, shows whether each webhook trigger's secret is set (never its
  value), approves **Direct action** per trigger behind a warning, and shows the last 20 lines of
  `hooks.log`. Runs and agents cannot change any of it.
