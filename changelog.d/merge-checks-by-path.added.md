- A merge check in `swarmupd.merge.<root>.checks` can name the paths it checks, as
  `{ run, paths }`. A merge runs it only when the work changes one of those paths, so a task that
  changes only Markdown, copy or assets skips the code checks. The `merge` event lists the checks
  it did not run.
