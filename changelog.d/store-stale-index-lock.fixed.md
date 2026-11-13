- A git process that dies mid-write in a task store no longer blocks every later `swarmup sync`
  with `Unable to create index.lock: File exists`. A sync, from the CLI or from swarmupd, removes
  the store's `.git/index.lock` when it is at least 2 minutes old and no live git process started
  before it was made, and says so in a note. A lock that a live git process may hold stays.
