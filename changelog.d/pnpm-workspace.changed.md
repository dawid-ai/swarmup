- The engine repo installs with pnpm (`pnpm install`, one `pnpm-lock.yaml`) instead of npm. pnpm
  hard-links packages from one store, so each task worktree's `node_modules` takes about 30 MB of
  its own disk instead of about 260 MB.
- After a merge changed a `pnpm-lock.yaml`, swarmupd runs `pnpm install --frozen-lockfile` in
  that directory of the build checkout before the build. A configured `install` still wins.
- Claude runs may use `pnpm` commands by default (`Bash(pnpm *)`).
