- A swarmupd started through a package script (`npm run swarmup`, `pnpm swarmup`) no longer hands
  the script's `npm_*` variables, `INIT_CWD` and `PNPM_SCRIPT_SRC_DIR` to agent runs, merge and
  review commands, and its own registry lookup. With pnpm's `npm_config_registry` in the
  environment, npm in a project with its own registry in `.npmrc` asked the public registry instead.
  An `npm_config_*` variable you set in your shell stays when no script starts swarmupd.
