- A review run's prompt now lists the test files and the check configuration (test, lint and CI
  configuration, package scripts) that the reviewed work changes, deletes or skips, and tells the
  reviewer to check that the task needs each change. It flags only and blocks nothing. Set the
  patterns per root with `swarmupd.test_changes.<root>`, or turn the list off with `false`.
