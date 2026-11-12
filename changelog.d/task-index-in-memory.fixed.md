- swarmupd no longer stalls for about a quarter of a second after each task change while the app
  reads the tasks again: it keeps the task index in memory between reads, and it no longer folds a
  task and rewrites the index on every read in the 2 seconds after an event.
