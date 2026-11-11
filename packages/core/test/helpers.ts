import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { initRoot, Workspace } from '../src/index.js';
import type { WorkspaceOptions } from '../src/index.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmup-test-'));
  dirs.push(d);
  return d;
}

/**
 * The test timeout for a test that runs many git processes (mirror scenarios, two-clone syncs):
 * a hang guard. Such a test takes 5-16 s alone on Windows. In the opsd merge checks, where every
 * worker runs git at once, mirror scenarios went past 120 s and syncs took 93 s (AO-0192).
 */
export const GIT_TEST_TIMEOUT = 240_000;

/**
 * One event-loop turn. Put it before each sync: a test runs git synchronously for many seconds,
 * and the vitest worker reads its RPC replies only when the loop turns. A reply left unread for
 * 60 s fails the run ('Timeout calling onTaskUpdate') however long the test timeout is.
 */
export function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
}

/** The identity test repos commit with; written to `.git/config` directly. */
export const TEST_IDENTITY = [
  '[user]',
  '\tname = Test',
  '\temail = test@example.invalid',
  '[commit]',
  '\tgpgsign = false',
  '',
].join('\n');

export function gitRepo(dir = tempDir()): string {
  git(dir, 'init', '-q', '-b', 'main');
  // One file write instead of three `git config` processes, which cost tens of ms each on Windows.
  appendFileSync(join(dir, '.git', 'config'), TEST_IDENTITY);
  return dir;
}

/** A git repo with a data root; returns a factory for workspaces acting as different ids. */
export function setup(opts: { prefix?: string; human?: string } = {}) {
  const repo = gitRepo();
  const rootDir = initRoot(repo, {
    name: 'test',
    prefix: opts.prefix,
    human: opts.human ?? 'human:dawid',
  });
  const env = { SWARMUP_CONFIG: join(repo, 'no-user-config.yml') } as NodeJS.ProcessEnv;
  const as = (actor: string, extra: Partial<WorkspaceOptions> = {}) =>
    new Workspace({ cwd: repo, env, actor, ...extra });
  return { repo, rootDir, env, as };
}

/** Builds a secret-looking string at runtime so this file never trips the leak check. */
export function fakeToken(): string {
  return ['gh', 'p_'].join('') + 'A'.repeat(36);
}
