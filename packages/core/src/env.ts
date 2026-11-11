/**
 * Environment variables are named `SWARMUP_<NAME>`. Until 0.4 the old `OPS_<NAME>` is read when the
 * new one is unset, so hooks, scripts and runs started before the rename keep working.
 */
export const ENV_PREFIX = 'SWARMUP_';
/** The prefix before the rename; read as a fallback until 0.4. */
export const OLD_ENV_PREFIX = 'OPS_';

/** `SWARMUP_<name>`, else the deprecated `OPS_<name>`; undefined when neither is set. */
export function envVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[ENV_PREFIX + name] ?? env[OLD_ENV_PREFIX + name];
}

/** Removes `SWARMUP_<name>` and `OPS_<name>` for each name. */
export function deleteEnvVars(env: NodeJS.ProcessEnv, names: readonly string[]): void {
  for (const name of names) {
    delete env[ENV_PREFIX + name];
    delete env[OLD_ENV_PREFIX + name];
  }
}

/**
 * Both names for each entry, for a child process: a child built before the rename reads only
 * `OPS_<name>`. Undefined values are left out.
 */
export function envPairs(vars: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) continue;
    out[ENV_PREFIX + name] = value;
    out[OLD_ENV_PREFIX + name] = value;
  }
  return out;
}
