import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { codexGitDirs, invocation } from '../src/index.js';

/**
 * End-to-end check of AO-0155 with the real Codex CLI: a writing Codex run in a worktree can
 * `git commit` there only with {@link codexGitDirs}. It starts two Codex runs and spends model
 * tokens, so it runs only with `SWARMUP_E2E_CODEX=1` (or the deprecated `OPS_E2E_CODEX=1`, read
 * until 0.4) and a signed-in `codex` on PATH.
 */
const enabled = (process.env.SWARMUP_E2E_CODEX ?? process.env.OPS_E2E_CODEX) === '1';
const here = dirname(fileURLToPath(import.meta.url));
// Under the checkout's out/, like a real task worktree, and not in the temp folder, which the
// Codex sandbox may leave writable.
const outDir = join(here, '..', '..', '..', 'out');
const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

/** A repo with one commit and a worktree at `<repo>/out/wt-e2e`, as swarmupd makes for a task. */
function repoWithWorktree(): string {
  mkdirSync(outDir, { recursive: true });
  const repo = mkdtempSync(join(outDir, 'codex-e2e-'));
  dirs.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'e2e');
  git(repo, 'config', 'user.email', 'e2e@example.invalid');
  writeFileSync(join(repo, 'README.md'), 'e2e\n');
  // A task store in the checkout, as in a real root: swarmupd adds the checkout to the run.
  mkdirSync(join(repo, '.swarmup'));
  writeFileSync(join(repo, '.swarmup', 'config.yml'), 'name: e2e\n');
  git(repo, 'add', 'README.md', '.swarmup/config.yml');
  git(repo, 'commit', '-q', '-m', 'base');
  const wt = join(repo, 'out', 'wt-e2e');
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'e2e-branch');
  writeFileSync(join(wt, 'change.txt'), 'from codex\n');
  return wt;
}

/**
 * Runs Codex as swarmupd would for codex:engineer in `wt`, asking it to commit change.txt. Like a
 * real launch, the run also gets the main checkout (`addDirs`) and its task store (`stores`):
 * the checkout's read-only `.git` above the git dirs is what broke every command of a run
 * (AO-0173), and a test without it passed.
 */
function codexCommit(wt: string, gitDirs: string[]): string {
  // The worktree is at `<repo>/out/wt-e2e`.
  const repo = dirname(dirname(wt));
  const { args } = invocation(
    { command: 'codex' },
    'codex:engineer',
    undefined,
    wt,
    [repo],
    [],
    undefined,
    false,
    false,
    [join(repo, '.swarmup')],
    gitDirs,
  );
  const prompt = [
    'Run these two commands in the current folder, one after the other, and nothing else:',
    '`git add change.txt`',
    '`git commit -m e2e-commit`',
    'Do not change any files and do not retry with other commands. Report the output.',
  ].join('\n');
  const r = spawnSync('codex', args, {
    cwd: wt,
    input: prompt,
    encoding: 'utf8',
    windowsHide: true,
    // codex is a .cmd shim on Windows; the arguments here hold no spaces or shell characters.
    shell: process.platform === 'win32',
    timeout: 240_000,
  });
  if (r.error) throw r.error;
  return git(wt, 'log', '-1', '--format=%s');
}

describe.runIf(enabled)('Codex sandbox commits in a worktree (SWARMUP_E2E_CODEX=1)', () => {
  it('commits with the git dirs as writable roots', { timeout: 300_000 }, () => {
    const wt = repoWithWorktree();
    const gitDirs = codexGitDirs(wt);
    expect(gitDirs.length).toBe(4);
    expect(codexCommit(wt, gitDirs)).toBe('e2e-commit');
  });

  it('cannot commit without them, so the check above means something', { timeout: 300_000 }, () => {
    const wt = repoWithWorktree();
    expect(codexCommit(wt, [])).toBe('base');
  });
});
