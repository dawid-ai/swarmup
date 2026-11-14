import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type GitFailure, gitAsync, taskkillLeft, taskkillSettled } from '../src/git.js';

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
    // The stop went through, so the failure names nothing left running.
    expect((err as GitFailure).treeLeft).toBeUndefined();
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
    // On Windows nothing leads from an exited git to the holder, and the failure says so.
    if (process.platform === 'win32') {
      expect((result as GitFailure).treeLeft).toContain('git had exited');
    }
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

  it('says why what git started may still run when the stop of its tree is refused (AO-0251)', async () => {
    const repo = temp();
    const state = temp();
    const beat = join(state, 'beat.txt');
    const go = join(state, 'go.txt');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, windowsHide: true });
    // A hook that leaves a mark every 100 ms until `go.txt` exists.
    writeFileSync(
      join(repo, '.git', 'hooks', 'pre-commit'),
      [
        '#!/bin/sh',
        `while [ ! -f '${go.split(sep).join('/')}' ]; do printf x >> '${beat.split(sep).join('/')}'; sleep 0.1; done`,
        'exit 1',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'opsd',
      GIT_AUTHOR_EMAIL: 'swarmupd@example.com',
      GIT_COMMITTER_NAME: 'opsd',
      GIT_COMMITTER_EMAIL: 'swarmupd@example.com',
    };
    const asked: number[] = [];
    const started = Date.now();
    const err = await gitAsync(repo, ['commit', '-q', '--allow-empty', '-m', 'x'], {
      env,
      timeoutMs: 2_000,
      tree: true,
      // As where a sandbox refuses `taskkill /T`: nothing under git is stopped.
      stopTree: (pid) => {
        asked.push(pid);
        return Promise.resolve('`taskkill /T` exited 1: Access is denied.');
      },
    }).catch((e: unknown) => e as GitFailure);

    try {
      expect(err).toBeInstanceOf(Error);
      expect(err).toMatchObject({
        code: 'ETIMEDOUT',
        treeLeft: '`taskkill /T` exited 1: Access is denied.',
      });
      expect(asked).toHaveLength(1);
      // The call still ends: git is killed, and the drain stops reading the hook's output.
      expect(Date.now() - started).toBeLessThan(20_000);
      // The hook outlived the call, as the failure says: its marks go on.
      const size = statSync(beat).size;
      const end = Date.now() + 5_000;
      while (statSync(beat).size === size && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(statSync(beat).size).toBeGreaterThan(size);
    } finally {
      // Ends the hook, so nothing has to kill it; waits for its marks to stop.
      writeFileSync(go, 'go\n');
      let size = -1;
      const end = Date.now() + 10_000;
      while (Date.now() < end && size !== statSync(beat).size) {
        size = statSync(beat).size;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }, 40_000);

  it('names nothing left running on a tree call that fails without a timeout', async () => {
    const repo = temp();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, windowsHide: true });
    // No timeout, so the stop is never asked: a plain failure carries no `treeLeft`.
    const err = await gitAsync(repo, ['rev-parse', '--verify', '-q', 'nope'], {
      timeoutMs: 20_000,
      tree: true,
      stopTree: () => Promise.reject(new Error('never asked')),
    }).catch((e: unknown) => e as GitFailure);

    expect(err).toBeInstanceOf(Error);
    expect((err as GitFailure).code).toBe(1);
    expect((err as GitFailure).treeLeft).toBeUndefined();
  }, 40_000);

  it('tells a refused taskkill from one that met a process already gone (AO-0251)', () => {
    const denied =
      'ERROR: The process with PID 4321 (child process of PID 1234) could not be terminated.\r\nReason: Access is denied.\r\n';
    // A process it names still runs: the stop was refused.
    expect(taskkillLeft({ code: 1, message: 'x' }, denied, (pid) => pid === 4321)).toBe(
      '`taskkill /T` exited 1: Reason: Access is denied.',
    );
    // None of the processes it names runs any more: they ended by themselves, nothing is left.
    const gone =
      'ERROR: The process with PID 4321 (child process of PID 1234) could not be terminated.\r\nReason: There is no running instance of the task.\r\n';
    expect(taskkillLeft({ code: 255, message: 'x' }, gone, () => false)).toBeUndefined();
    // It names no process, so nothing shows the tree ended.
    expect(taskkillLeft({ code: 1, message: 'x' }, 'Access is denied.\r\n', () => false)).toBe(
      '`taskkill /T` exited 1: Access is denied.',
    );
    // It did not run at all, or did not end.
    expect(taskkillLeft({ code: 'ENOENT', message: 'spawn taskkill ENOENT' }, '')).toBe(
      '`taskkill /T` did not start (ENOENT)',
    );
    expect(taskkillLeft({ code: null, killed: true, message: 'x' }, '')).toBe(
      '`taskkill /T` did not end in 15 s',
    );
  });

  it('waits for a process taskkill names to end before it reports it as left (AO-0326)', async () => {
    // What taskkill prints when a hook's `sleep` ended by itself: the sleep and its parent shell.
    const gone =
      'ERROR: The process with PID 46060 (child process of PID 22316) could not be terminated.\r\nReason: There is no running instance of the task.\r\r\n';
    const err = { code: 255, message: 'x' };
    // The shell, which taskkill ended next, still counts as running at the first two checks.
    let asked = 0;
    const ending = (pid: number) => pid === 22316 && ++asked <= 2;
    expect(taskkillLeft(err, gone, (pid) => pid === 22316)).toBe(
      '`taskkill /T` exited 255: Reason: There is no running instance of the task.',
    );
    expect(await taskkillSettled(err, gone, ending, 5_000)).toBeUndefined();
    expect(asked).toBe(3);
    // A refused stop leaves its process running for the whole wait, so it still reports.
    const denied =
      'ERROR: The process with PID 4321 (child process of PID 1234) could not be terminated.\r\nReason: Access is denied.\r\n';
    expect(
      await taskkillSettled({ code: 1, message: 'x' }, denied, (pid) => pid === 4321, 150),
    ).toBe('`taskkill /T` exited 1: Reason: Access is denied.');
    // Nothing to wait for when taskkill did not run or names no process.
    const started = Date.now();
    expect(
      await taskkillSettled({ code: 'ENOENT', message: 'spawn taskkill ENOENT' }, '', () => true),
    ).toBe('`taskkill /T` did not start (ENOENT)');
    expect(await taskkillSettled({ code: 1, message: 'x' }, 'Access is denied.\r\n')).toBe(
      '`taskkill /T` exited 1: Access is denied.',
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });

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
