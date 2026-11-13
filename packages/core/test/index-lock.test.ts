import { execFileSync, spawn } from 'node:child_process';
import { existsSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSteps, runStepsAsync } from '../src/git-steps.js';
import { gitProcsCommand } from '../src/index-lock.js';
import {
  clearStaleIndexLock,
  initRoot,
  parseGitProcs,
  Root,
  STALE_INDEX_LOCK_MS,
  syncRoot,
  syncRootAsync,
} from '../src/index.js';
import { GIT_TEST_TIMEOUT, gitRepo, turn } from './helpers.js';

/** A store with one uncommitted root and an `index.lock` made `ageMs` ago. */
function lockedStore(ageMs: number) {
  const repo = gitRepo();
  initRoot(repo, { name: 'solo' });
  const lock = join(repo, '.git', 'index.lock');
  writeFileSync(lock, '');
  const made = new Date(Date.now() - ageMs);
  utimesSync(lock, made, made);
  return { repo, lock, madeMs: statSync(lock).mtimeMs, root: new Root(join(repo, '.swarmup')) };
}

const STALE = 5 * 60_000;

describe('a stale index.lock in the store (AO-0302)', { timeout: GIT_TEST_TIMEOUT }, () => {
  it('is removed by a sync when no live git process is older than it', async () => {
    const { lock, madeMs, root } = lockedStore(STALE);
    // A git that started after the lock was made cannot be its maker.
    const res = await syncRootAsync(
      root,
      {},
      { gitProcs: () => [{ pid: 7, startMs: madeMs + 60_000 }] },
    );
    expect(existsSync(lock)).toBe(false);
    expect(res.committed).toBeGreaterThan(0);
    expect(res.notes[0]).toMatch(/^removed a stale index\.lock in .+ \(5 min old\)/);
  });

  it('is removed by the synchronous sync that `swarmup sync` runs', async () => {
    const { lock, root } = lockedStore(STALE);
    await turn();
    expect(syncRoot(root, {}, { gitProcs: () => [] }).committed).toBeGreaterThan(0);
    expect(existsSync(lock)).toBe(false);
  });

  it('is left alone while a git process that started before it is alive', async () => {
    const { repo, lock, madeMs, root } = lockedStore(STALE);
    const gitProcs = () => [{ pid: 4242, startMs: madeMs - 1000 }];
    await expect(syncRootAsync(root, {}, { gitProcs })).rejects.toThrow(/index\.lock/);
    expect(existsSync(lock)).toBe(true);
    // The same for a process whose start time the system does not give.
    const unknown = () => [{ pid: 4242, startMs: null }];
    const res = await runStepsAsync(clearStaleIndexLock(repo, Date.now(), { gitProcs: unknown }));
    expect(res).toMatchObject({ removed: false, heldBy: [4242] });
    expect(existsSync(lock)).toBe(true);
  });

  it('is left alone when the processes cannot be listed', () => {
    const { repo, lock } = lockedStore(STALE);
    const res = runSteps(clearStaleIndexLock(repo, Date.now(), { gitProcs: () => null }));
    expect(res.removed).toBe(false);
    expect(existsSync(lock)).toBe(true);
  });

  it('is left alone while it is younger than the set age, without a process listing', () => {
    const { repo, lock } = lockedStore(STALE_INDEX_LOCK_MS - 30_000);
    const gitProcs = () => {
      throw new Error('no listing for a young lock');
    };
    expect(runSteps(clearStaleIndexLock(repo, Date.now(), { gitProcs }))).toEqual({
      removed: false,
    });
    expect(existsSync(lock)).toBe(true);
  });

  it('finds a real live git process and keeps the lock it may hold', async () => {
    const repo = gitRepo();
    // A git that stays alive until its standard input closes.
    const child = spawn('git', ['cat-file', '--batch'], {
      cwd: repo,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    const lock = join(repo, '.git', 'index.lock');
    try {
      await new Promise((resolve, reject) => {
        child.on('spawn', resolve);
        child.on('error', reject);
      });
      writeFileSync(lock, '');
      const held = await runStepsAsync(
        clearStaleIndexLock(repo, Date.now() + 1000, { minAgeMs: 0 }),
      );
      expect(held.removed).toBe(false);
      expect(held.heldBy).toContain(child.pid);
      expect(existsSync(lock)).toBe(true);
    } finally {
      child.stdin.end();
      await exited;
    }
    // Other git processes of this machine may still be older than the lock; this one is gone.
    const after = await runStepsAsync(
      clearStaleIndexLock(repo, Date.now() + 1000, { minAgeMs: 0 }),
    );
    expect(after.heldBy ?? []).not.toContain(child.pid);
    expect(existsSync(lock)).toBe(!after.removed);
  });
});

describe.runIf(process.platform === 'win32')(
  'the Windows process listing',
  { timeout: GIT_TEST_TIMEOUT },
  () => {
    /** Runs the listing after `prelude` while one git process is alive; its line in the output. */
    async function listed(prelude: string): Promise<{ pid: number; fields: string[] }> {
      const repo = gitRepo();
      const child = spawn('git', ['cat-file', '--batch'], {
        cwd: repo,
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      const exited = new Promise((resolve) => child.on('exit', resolve));
      try {
        await new Promise((resolve, reject) => {
          child.on('spawn', resolve);
          child.on('error', reject);
        });
        const { cmd, args } = gitProcsCommand('win32', prelude);
        const out = execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true });
        const line = out.split(/\r?\n/).find((l) => l.startsWith(`${child.pid}\t`));
        return { pid: child.pid!, fields: line?.split('\t') ?? [] };
      } finally {
        child.stdin.end();
        await exited;
      }
    }

    // The Codex sandbox, where the stale lock of AO-0302 came from, denies Win32_Process.
    it('lists git with its start time when CIM answers "Access denied"', async () => {
      const before = Date.now();
      const { pid, fields } = await listed("function Get-CimInstance { throw 'Access denied' }; ");
      expect(fields[0]).toBe(String(pid));
      expect(Math.abs(Date.parse(fields[1]!) - before)).toBeLessThan(60_000);
      // No command line without CIM, so a daemon cannot be told apart and counts as a holder.
      expect(fields[2]).toBe('');
    });

    it('adds the command line when CIM answers', async () => {
      const { fields } = await listed('');
      expect(fields[2]).toMatch(/cat-file/);
    });

    it('fails when the processes cannot be listed, so the lock stays', () => {
      const { cmd, args } = gitProcsCommand('win32', "function Get-Process { throw 'denied' }; ");
      expect(() => execFileSync(cmd, args, { stdio: 'pipe', windowsHide: true })).toThrow();
    });
  },
);

describe('parseGitProcs', () => {
  it('reads the Windows listing and skips the daemons that never write the index', () => {
    const out = [
      '4120\t2026-11-13T13:10:40.1234567Z\t"C:\\Program Files\\Git\\cmd\\git.exe" add -A -- .swarmup',
      '5000\t\tgit.exe status',
      '6000\t2026-11-13T09:00:00.0000000Z\tgit.exe fsmonitor--daemon run --detach',
      '',
    ].join('\r\n');
    expect(parseGitProcs(out, 0, 'win32')).toEqual([
      { pid: 4120, startMs: Date.parse('2026-11-13T13:10:40.123Z') },
      { pid: 5000, startMs: null },
    ]);
  });

  it('reads the ps listing, with start times from the elapsed time', () => {
    const now = 1_000_000_000;
    const out = [
      '  812       00:07 git status',
      ' 9001  1-02:03:04 /usr/bin/git gc --auto',
      '   77    10:00:00 /usr/lib/git-core/git credential-cache--daemon /tmp/sock',
      '   12       05:00 vim .gitignore',
      '   13       05:00 node /srv/gitea/main.js',
      '',
    ].join('\n');
    expect(parseGitProcs(out, now, 'linux')).toEqual([
      { pid: 812, startMs: now - 7_000 },
      { pid: 9001, startMs: now - (26 * 3600 + 3 * 60 + 4) * 1000 },
    ]);
  });
});
