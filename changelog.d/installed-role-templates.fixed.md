- The installed app ships the role templates, so `swarmup init --with-agents`, `swarmup adopt`
  and `swarmup new-project` add roles again. A build without them now stops with a message
  instead of creating a root with an empty `agents/` folder.
- `swarmup agents` also lists the agents `swarmup setup` writes into your user config, so a fresh
  install no longer prints `no agents defined`.
