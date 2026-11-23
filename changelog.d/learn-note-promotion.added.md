- Learn notes that keep mattering can become rules in a role file. `swarmup kb --promote` lists
  the notes shown in many run prompts, read often or learned again, with why and the agents they
  are for. With `swarmupd.improve.notes: true`, swarmupd files an `improve` task for the improver
  to fold them into the agent's role file as a proposal; **Fold into role** in the Knowledge view
  files it on request. After `swarmup defs promote`, a person archives the folded notes with
  `swarmup kb archive TOPIC/SLUG... -m "why"` (or **Archive** in the app), which moves them to
  `kb/.archive/`, where search and run prompts skip them.
