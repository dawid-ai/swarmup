- An update no longer gives up while swarmupd finishes a store sync or merge: once swarmupd has
  agreed to stop, the update waits for it to exit, up to 15 minutes, and then installs.
