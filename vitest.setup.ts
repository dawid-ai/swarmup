import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, afterEach } from 'vitest';

// Tests never see the real user config or swarmupd state: anything that falls back to the process
// environment lands in a scratch folder instead of the developer's own files.
const scratch = mkdtempSync(join(tmpdir(), 'swarmup-test-env-'));
process.env.SWARMUP_CONFIG = join(scratch, 'config.yml');
process.env.SWARMUP_STATE_DIR = join(scratch, 'swarmupd');

// Inside a supervised run, swarmupd gives the agent its identity, its run, and the roots it may use.
// Tests that copy `process.env` would inherit them: `SWARMUP_ROOTS_ONLY` hides the root found from a
// test's own folder, and `SWARMUP_AGENT` or `SWARMUP_RUN` make a test act as the live run. Tests set the
// ones they need themselves.
// Both prefixes: the old OPS_* names are still read when the new ones are unset.
for (const key of [
  'AGENT',
  'RUN',
  'PARENT_RUN',
  'RUN_TOKEN',
  'RUN_STATE_DIR',
  'ROOTS',
  'ROOTS_ONLY',
]) {
  delete process.env[`SWARMUP_${key}`];
  delete process.env[`OPS_${key}`];
}

// Git settings for test repos only, passed to every git process through the environment. They
// change no behavior the tests check; they drop work that costs a process or a disk flush per
// call, which on Windows adds up in the git-heavy tests: background maintenance and `gc --auto`
// after commits, fetches and pushes, and an fsync of each object.
const testGitConfig: Array<[string, string]> = [
  ['maintenance.auto', 'false'],
  ['gc.auto', '0'],
  ['receive.autogc', 'false'],
  ['core.fsync', 'none'],
];
process.env.GIT_CONFIG_COUNT = String(testGitConfig.length);
testGitConfig.forEach(([key, value], i) => {
  process.env[`GIT_CONFIG_KEY_${i}`] = key;
  process.env[`GIT_CONFIG_VALUE_${i}`] = value;
});

// A git identity for machines that have none, such as a CI runner (AO-0240): store syncs commit
// with the machine's identity, as swarmupd does. The scratch global config sets one, then includes
// the real global config, so a developer's own settings still apply and win over it. A repo's or
// a test's own identity wins over both.
// Read once per process: a later test file in the same worker sees the scratch file set here.
process.env.SWARMUP_TEST_GIT_GLOBAL ??= process.env.GIT_CONFIG_GLOBAL ?? '';
const realGlobal = process.env.SWARMUP_TEST_GIT_GLOBAL
  ? [process.env.SWARMUP_TEST_GIT_GLOBAL]
  : [
      join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'git', 'config'),
      join(homedir(), '.gitconfig'),
    ];
const testGlobal = join(scratch, 'gitconfig');
writeFileSync(
  testGlobal,
  [
    '[user]',
    '\tname = SwarmUp Test',
    '\temail = test@example.invalid',
    // Git skips an include whose file does not exist.
    ...realGlobal.map((p) => `[include]\n\tpath = ${JSON.stringify(p.split(sep).join('/'))}`),
    '',
  ].join('\n'),
);
process.env.GIT_CONFIG_GLOBAL = testGlobal;

// The runner moves from test to test on microtasks only, so a file of synchronous tests (git via
// execFileSync) never lets the worker read its IPC replies. Once such a file runs past 60 s, the
// worker's pending `onTaskUpdate` call times out even though the reply is already waiting, and the
// run exits non-zero. Two setImmediate turns guarantee one poll phase between tests, which delivers
// those replies. The 60 s RPC timeout is fixed inside vitest, so the config cannot raise it.
afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
});
