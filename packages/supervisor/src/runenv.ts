import { delimiter } from 'node:path';
import { deleteEnvVars, envVar } from '@swarmup/core';

/**
 * The environment an agent run starts with: swarmupd's own, plus `extra`, with three adjustments.
 *
 * - `ELECTRON_RUN_AS_NODE`, `ELECTRON_NO_ASAR` and `SWARMUP_DAEMON_ENTRY` go: swarmupd may run
 *   inside the desktop app's executable as Node, and a run that inherits them would start any
 *   Electron app (a smoke check, the app itself) as Node or unable to read its `.asar`, or the
 *   installed swarmupd instead of its checkout's.
 * - The installed app's `bin` folder (`SWARMUP_BIN_DIR`, set by the app and its `swarmup` shims) goes to
 *   the front of PATH, so runs find `swarmup` without a change to the person's PATH.
 * - What an npm or pnpm script added to swarmupd's own environment goes (`withoutScriptEnv`).
 */
export function runEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...withoutScriptEnv(base), ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ASAR;
  // The installed app's swarmupd entry: a run working in a checkout must start that checkout's swarmupd
  // (its tests do). The installed `swarmup` sets it again for itself.
  deleteEnvVars(env, ['DAEMON_ENTRY']);
  const bin = envVar(env, 'BIN_DIR')?.replace(/[\\/]+$/, '');
  if (bin) {
    // Windows keeps it as `Path`; a copied env is a plain object, so match the name ourselves.
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    const parts = (env[key] ?? '').split(delimiter).filter(Boolean);
    const same = (p: string): boolean =>
      p.replace(/[\\/]+$/, '').toLowerCase() === bin.toLowerCase();
    env[key] = [bin, ...parts.filter((p) => !same(p))].join(delimiter);
  }
  return env;
}

/** Set by npm, pnpm and yarn for every script they run. */
const SCRIPT_TELLS = ['npm_config_user_agent', 'npm_lifecycle_event'];

/** What a package manager adds for a script besides the `npm_*` names. */
const SCRIPT_NAMES = new Set(['INIT_CWD', 'PNPM_SCRIPT_SRC_DIR']);

/**
 * A copy of `env` without the variables a package manager set for the script that started this
 * process (`pnpm swarmup`, `npm run swarmup`, `pnpm test`): every `npm_*` name, `INIT_CWD` and
 * `PNPM_SCRIPT_SRC_DIR`. They describe the engine checkout, not the project a run or a merge
 * command works in, and npm takes `npm_config_*` over an `.npmrc` file: with pnpm's
 * `npm_config_registry`, npm in a project with its own registry asked the public one (AO-0307).
 *
 * Without a sign of a script (`npm_config_user_agent`, `npm_lifecycle_event`) the copy is
 * complete: an `npm_config_*` variable a person set for their shell stays. Under a script it
 * goes with the rest, because nothing tells it from the script's own; a setting every project
 * needs belongs in the user's `.npmrc`. npm reads these names in any case, so any case goes.
 */
export function withoutScriptEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  const keys = Object.keys(out);
  const tells = keys.some((k) => SCRIPT_TELLS.includes(k.toLowerCase()) && out[k] !== undefined);
  if (!tells) return out;
  for (const k of keys) if (/^npm_/i.test(k) || SCRIPT_NAMES.has(k.toUpperCase())) delete out[k];
  return out;
}

/**
 * Deletes `names` from `env`. Windows environment names ignore case, but a copied env is a plain
 * object, so on Windows every key that matches a name in any case goes (`Github_Token` for
 * `GITHUB_TOKEN`).
 */
export function dropEnv(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32') {
    for (const k of names) delete env[k];
    return;
  }
  const drop = new Set(names.map((n) => n.toUpperCase()));
  for (const k of Object.keys(env)) if (drop.has(k.toUpperCase())) delete env[k];
}
