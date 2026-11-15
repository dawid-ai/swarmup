- The PM chat can read releases, tags, PRs and CI runs: every chat turn gets read-only
  `gh release list|view`, `gh pr list|view|checks`, `gh run list|view`, `git tag -l`,
  `git describe` and `git -C <dir> log|show` on top of its role file's `tools`, so an older role
  file no longer blocks them. The `claude:pm` template lists the same commands for its other runs.
