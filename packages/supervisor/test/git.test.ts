import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type GitFailure, gitAsync } from '../src/git.js';

const dirs: string[] = [];
const pids: number[] = [];

afterEach(() => {
  // Only the processes these tests started, by the PID they wrote.
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      // Already gone.
    }
  }
  // A process killed just now may hold its folder for a moment on Windows. A hook shell that
  // `taskkill /T` missed, as it now and then does, holds it until it ends: the folder stays.
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch {
      // Left in the temp folder.
    }
  }
});

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmupd-git-'));
  dirs.push(d);
  return d;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Starts a process that holds the hook's output open, then exits, so the process is no longer
 * under git: neither `taskkill /T` nor git's process group reaches it.
 */
const ORPHAN = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'inherit' });
writeFileSync(process.env.ORPHAN_PID, String(c.pid));
c.unref();
`;

describe('gitAsync', () => {
  it('ends a timed-out call even when a process git started keeps its output open (AO-0172)', async () => {
    const repo = temp();
    const state = temp();
    const pidFile = join(state, 'orphan.txt');
    const orphan = join(state, 'orphan.mjs');
    writeFileSync(orphan, ORPHAN);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, windowsHide: true });
    writeFileSync(
      join(repo, '.git', 'hooks', 'pre-commit'),
      [
        '#!/bin/sh',
        `node '${orphan.split(sep).join('/')}'`,
        "echo 'hook waits for the lock' >&2",
        `while :; do printf x >> '${join(state, 'beat.txt').split(sep).join('/')}'; sleep 0.1; done`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      ORPHAN_PID: pidFile,
      GIT_AUTHOR_NAME: 'opsd',
      GIT_AUTHOR_EMAIL: 'swarmupd@example.com',
      GIT_COMMITTER_NAME: 'opsd',
      GIT_COMMITTER_EMAIL: 'swarmupd@example.com',
    };
    const started = Date.now();
    const err = await gitAsync(repo, ['commit', '-q', '--allow-empty', '-m', 'x'], {
      env,
      timeoutMs: 2_000,
      tree: true,
    }).catch((e: unknown) => e as GitFailure);
    if (existsSync(pidFile)) pids.push(Number(readFileSync(pidFile, 'utf8')));

    expect(err).toMatchObject({ code: 'ETIMEDOUT' });
    expect((err as GitFailure).stderr).toContain('hook waits for the lock');
    // The timeout, the stop and a few seconds for the output; not until the orphan ends.
    expect(Date.now() - started).toBeLessThan(20_000);
    // The orphan outlived the stop, so the call did not end by the output closing.
    expect(pids).toHaveLength(1);
    expect(alive(pids[0]!)).toBe(true);
    // The hook itself was stopped: its marks stop.
    const beat = join(state, 'beat.txt');
    const size = statSync(beat).size;
    await new Promise((r) => setTimeout(r, 800));
    expect(statSync(beat).size).toBe(size);
    // Ended here, by its PID, and waited for, so its folder can go.
    const pid = pids.pop()!;
    process.kill(pid);
    const end = Date.now() + 10_000;
    while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(false);
  }, 40_000);

  it('reports a timeout when git exits 0 but a process it started keeps its output open (AO-0172)', async () => {
    const repo = temp();
    const state = temp();
    const pidFile = join(state, 'orphan.txt');
    const orphan = join(state, 'orphan.mjs');
    writeFileSync(orphan, ORPHAN);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, windowsHide: true });
    writeFileSync(
      join(repo, '.git', 'hooks', 'pre-commit'),
      [
        '#!/bin/sh',
        `node '${orphan.split(sep).join('/')}'`,
        "echo 'hook left a holder' >&2",
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      ORPHAN_PID: pidFile,
      GIT_AUTHOR_NAME: 'opsd',
      GIT_AUTHOR_EMAIL: 'swarmupd@example.com',
      GIT_COMMITTER_NAME: 'opsd',
      GIT_COMMITTER_EMAIL: 'swarmupd@example.com',
    };
    const started = Date.now();
    const result = await gitAsync(repo, ['commit', '-q', '--allow-empty', '-m', 'x'], {
      env,
      timeoutMs: 4_000,
      tree: true,
    }).catch((e: unknown) => e as GitFailure);
    if (existsSync(pidFile)) pids.push(Number(readFileSync(pidFile, 'utf8')));

    // git itself succeeded: the commit is there.
    expect(
      execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    ).toBe('1');
    // The call still ran past its deadline, so it is a timeout with git's output, not a success.
    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({ code: 'ETIMEDOUT' });
    expect((result as GitFailure).stderr).toContain('hook left a holder');
    expect(Date.now() - started).toBeLessThan(20_000);
    // The holder kept the output open until the drain ended the call.
    expect(pids).toHaveLength(1);
    expect(alive(pids[0]!)).toBe(true);
    const pid = pids.pop()!;
    process.kill(pid);
    const end = Date.now() + 10_000;
    while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(false);
  }, 40_000);

  // The tree path collects git's output itself; it reports too much output as `execFile` does.
  it('keeps stdout up to maxBuffer and names stdout when it overflows on a tree call', async () => {
    const repo = temp();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, windowsHide: true });
    const content = Array.from({ length: 2_000 }, (_, i) => `line ${i}\n`).join('');
    writeFileSync(join(repo, 'big.txt'), content);
    const blob = execFileSync('git', ['hash-object', '-w', '--no-filters', 'big.txt'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();

    const err = await gitAsync(repo, ['cat-file', '-p', blob], {
      timeoutMs: 20_000,
      tree: true,
      maxBuffer: 1_000,
    }).catch((e: unknown) => e as GitFailure);

    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      message: 'stdout maxBuffer length exceeded',
    });
    // The chunk that crossed the limit is kept up to the limit, not dropped.
    expect((err as GitFailure).stdout).toBe(content.slice(0, 1_000));
    expect((err as GitFailure).stderr).toBe('');
  }, 40_000);

  it('keeps stderr up to maxBuffer and names stderr when it overflows on a tree call', async () => {
    const repo = temp();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, windowsHide: true });
    writeFileSync(
      join(repo, '.git', 'hooks', 'pre-commit'),
      ['#!/bin/sh', `node -e "process.stderr.write('e'.repeat(20000))"`, 'exit 0', ''].join('\n'),
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'opsd',
      GIT_AUTHOR_EMAIL: 'swarmupd@example.com',
      GIT_COMMITTER_NAME: 'opsd',
      GIT_COMMITTER_EMAIL: 'swarmupd@example.com',
    };

    const err = await gitAsync(repo, ['commit', '-q', '--allow-empty', '-m', 'x'], {
      env,
      timeoutMs: 20_000,
      tree: true,
      maxBuffer: 1_000,
    }).catch((e: unknown) => e as GitFailure);

    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      message: 'stderr maxBuffer length exceeded',
    });
    expect((err as GitFailure).stderr).toBe('e'.repeat(1_000));
    expect((err as GitFailure).stdout).toBe('');
  }, 40_000);
});
