import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Scripted failures for the next `openSync` calls, and for the next `rmSync` calls on a lock file;
// empty means the real call runs.
const openFailures: string[] = [];
const rmLockFailures: string[] = [];

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    openSync: (...args: Parameters<typeof real.openSync>) => {
      const code = openFailures.shift();
      if (code) throw Object.assign(new Error(`${code}: scripted`), { code });
      return real.openSync(...args);
    },
    rmSync: (...args: Parameters<typeof real.rmSync>) => {
      const code = String(args[0]).endsWith('.lock') ? rmLockFailures.shift() : undefined;
      if (code) throw Object.assign(new Error(`${code}: scripted`), { code });
      real.rmSync(...args);
    },
  };
});

const { withLock, withLockAsync } = await import('../src/lock.js');

describe('withLock', () => {
  let dir: string;
  let lock: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'swarmup-lock-'));
    lock = join(dir, 'locks', 'task-T-0001.lock');
    openFailures.length = 0;
    rmLockFailures.length = 0;
  });

  afterEach(() => {
    rmLockFailures.length = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  it('retries EPERM and EBUSY on Windows, where a lock being deleted reports them', () => {
    openFailures.push('EPERM', 'EBUSY', 'EPERM');
    expect(withLock(lock, () => 'ran', 5_000, 'win32')).toBe('ran');
    expect(openFailures).toHaveLength(0);
    expect(existsSync(lock)).toBe(false);
  });

  it('fails at once on EPERM outside Windows', () => {
    openFailures.push('EPERM');
    const fn = vi.fn();
    expect(() => withLock(lock, fn, 5_000, 'linux')).toThrow(/EPERM/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('rethrows a Windows EPERM that outlasts the timeout instead of reporting a busy lock', () => {
    openFailures.push(...Array<string>(1_000).fill('EPERM'));
    expect(() => withLock(lock, () => 'ran', 50, 'win32')).toThrow(/EPERM/);
  });

  /** Leaves a lock file with no owner pid, last written a minute ago, so `withLock` takes it over. */
  function writeStaleLock(): void {
    mkdirSync(join(dir, 'locks'), { recursive: true });
    writeFileSync(lock, 'stale\n');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
  }

  it('retries a Windows EPERM from removing a stale lock, then takes the lock', () => {
    writeStaleLock();
    rmLockFailures.push('EPERM', 'EBUSY');
    expect(withLock(lock, () => 'ran', 5_000, 'win32')).toBe('ran');
    expect(rmLockFailures).toHaveLength(0);
    expect(existsSync(lock)).toBe(false);
  });

  it('rethrows a Windows EPERM from removing a stale lock that outlasts the timeout', () => {
    writeStaleLock();
    rmLockFailures.push(...Array<string>(1_000).fill('EPERM'));
    const fn = vi.fn();
    expect(() => withLock(lock, fn, 50, 'win32')).toThrow(/EPERM/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('fails at once on EPERM from removing a stale lock outside Windows', () => {
    writeStaleLock();
    rmLockFailures.push('EPERM');
    expect(() => withLock(lock, () => 'ran', 5_000, 'linux')).toThrow(/EPERM/);
    expect(rmLockFailures).toHaveLength(0);
  });
});

describe('withLockAsync', () => {
  let dir: string;
  let lock: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'swarmup-lock-'));
    lock = join(dir, 'locks', 'git.lock');
    openFailures.length = 0;
    rmLockFailures.length = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('holds the lock until the work settles, and a sync wait for it fails at once', async () => {
    let release!: () => void;
    const held = withLockAsync(lock, () => new Promise<string>((r) => (release = () => r('ran'))));
    // Let the holder take the lock.
    await new Promise((r) => setTimeout(r, 10));
    expect(existsSync(lock)).toBe(true);
    // Waiting would block the event loop the holder needs, until the 15 s timeout.
    const started = Date.now();
    expect(() => withLock(lock, () => 'sync')).toThrow(/busy: this process holds it/);
    expect(Date.now() - started).toBeLessThan(1_000);
    release();
    expect(await held).toBe('ran');
    expect(existsSync(lock)).toBe(false);
    expect(withLock(lock, () => 'sync')).toBe('sync');
  });

  it('lets async holders in one process take turns', async () => {
    const order: string[] = [];
    const work = (name: string) => async () => {
      order.push(`${name} in`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`${name} out`);
    };
    await Promise.all([withLockAsync(lock, work('a')), withLockAsync(lock, work('b'))]);
    expect(order).toEqual(['a in', 'a out', 'b in', 'b out']);
  });

  it('keeps the event loop free while it waits for a lock another process holds', async () => {
    mkdirSync(join(dir, 'locks'), { recursive: true });
    // A live pid that is not this process: the parent, which outlives the test.
    writeFileSync(lock, `${process.ppid} ${new Date().toISOString()}\n`);
    let timers = 0;
    const timer = setInterval(() => timers++, 5);
    await expect(withLockAsync(lock, async () => 'ran', 200)).rejects.toThrow(/timed out/);
    clearInterval(timer);
    expect(timers).toBeGreaterThan(5);
  });
});
