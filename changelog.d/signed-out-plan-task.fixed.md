- While a provider is signed out, swarmupd no longer tries to hand a plan task to an agent its
  plan does not allow. Such a handoff is refused, so it logged a warning on every tick.
