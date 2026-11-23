- Merge checks in git: `swarm.yaml` `checks.<name>` keeps the commands swarmupd runs before it
  moves the base. They run on a machine only after a person there runs `swarmup defs trust`, which
  keeps the hash of the exact command set in `swarmupd.trusted_defs.<root>.checks`; any change to a
  command or its paths skips them again until trusted, with a warning in `swarmup validate`,
  `swarmup doctor` and the merge log. A machine's own `swarmupd.merge.<root>.checks` still wins.
