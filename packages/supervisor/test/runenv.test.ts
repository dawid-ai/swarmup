import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dropEnv, runEnv, withoutScriptEnv } from '../src/index.js';

describe('run environment', () => {
  it('drops what only swarmupd inside the desktop app needs', () => {
    const env = runEnv(
      {
        ELECTRON_RUN_AS_NODE: '1',
        ELECTRON_NO_ASAR: '1',
        SWARMUP_DAEMON_ENTRY: 'C:/app/swarmupd.mjs',
        KEEP: 'yes',
      },
      { SWARMUP_AGENT: 'claude:engineer' },
    );
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.ELECTRON_NO_ASAR).toBeUndefined();
    expect(env.SWARMUP_DAEMON_ENTRY).toBeUndefined();
    expect(env).toMatchObject({ KEEP: 'yes', SWARMUP_AGENT: 'claude:engineer' });
  });

  it("puts the installed app's bin folder first on PATH, once, whatever the key's case", () => {
    // No drive letters: on Linux the PATH delimiter is a colon.
    const bin = '/opt/SwarmUp/resources/bin';
    const env = runEnv(
      { SWARMUP_BIN_DIR: `${bin}/`, Path: ['/opt/tools', bin, '/opt/other'].join(delimiter) },
      {},
    );
    expect(env.Path).toBe([bin, '/opt/tools', '/opt/other'].join(delimiter));
    expect(env.PATH).toBeUndefined();
  });

  it('leaves PATH alone without a bin folder', () => {
    expect(runEnv({ PATH: 'a' }, {}).PATH).toBe('a');
    expect(runEnv({}, {}).PATH).toBeUndefined();
  });
});

describe('withoutScriptEnv (AO-0307)', () => {
  // What `pnpm swarmup` adds to the environment of the script it runs.
  const script = {
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_user_agent: 'pnpm/9.15.4 npm/? node/v22.0.0 win32 x64',
    npm_config_frozen_lockfile: '',
    npm_execpath: 'C:/pnpm/bin/pnpm.cjs',
    npm_lifecycle_event: 'swarmup',
    npm_package_name: 'swarmup',
    NPM_CONFIG_CACHE: 'C:/cache',
    INIT_CWD: 'C:/engine',
    PNPM_SCRIPT_SRC_DIR: 'C:/engine',
  };

  it('drops what a package manager set for its script', () => {
    const env = { ...script, PATH: 'a', NPMRC: 'keep' };
    expect(withoutScriptEnv(env)).toEqual({ PATH: 'a', NPMRC: 'keep' });
    // A copy: the caller's environment stays as it is.
    expect(env.npm_config_registry).toBe('https://registry.npmjs.org/');
    // One sign of a script is enough, in any case.
    expect(withoutScriptEnv({ NPM_LIFECYCLE_EVENT: 'test', npm_config_registry: 'x' })).toEqual({});
  });

  it('keeps an npm setting of the shell when no script started the process', () => {
    const env = { npm_config_registry: 'https://npm.example.com/', INIT_CWD: 'C:/x', PATH: 'a' };
    expect(withoutScriptEnv(env)).toEqual(env);
    expect(
      withoutScriptEnv({ npm_config_user_agent: undefined, npm_config_registry: 'x' }),
    ).toEqual({ npm_config_user_agent: undefined, npm_config_registry: 'x' });
  });

  it('gives a run the environment without them, and keeps what the run itself adds', () => {
    const env = runEnv({ ...script, KEEP: 'yes' }, { npm_config_cache: 'C:/run-cache' });
    expect(env).toEqual({ KEEP: 'yes', npm_config_cache: 'C:/run-cache' });
  });
});

describe('dropEnv', () => {
  it('drops a name in any case on Windows', () => {
    const env = { Github_Token: 'a', gh_token: 'b', KEEP: 'c' };
    dropEnv(env, ['GITHUB_TOKEN', 'GH_TOKEN'], 'win32');
    expect(env).toEqual({ KEEP: 'c' });
  });

  it('drops only the exact name elsewhere', () => {
    const env = { GITHUB_TOKEN: 'a', Github_Token: 'b' };
    dropEnv(env, ['GITHUB_TOKEN'], 'linux');
    expect(env).toEqual({ Github_Token: 'b' });
  });
});
