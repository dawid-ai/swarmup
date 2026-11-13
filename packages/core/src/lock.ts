import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { OpsError } from './ids.js';

const STALE_MS = 30_000;
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));

function sleep(ms: number): void {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether a lock file may be taken over: its process is gone, or it is older than 30 s. False
 * for a file that cannot be read.
 */
export function lockIsStale(path: string): boolean {
  return isStale(path);
}

function isStale(path: string): boolean {
  try {
    const age = Date.now() - statSync(path).mtimeMs;
    const pid = Number(readFileSync(path, 'utf8').split(' ')[0]);
    if (Number.isInteger(pid) && pid > 0 && !pidAlive(pid)) return true;
    return age > STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Windows reports EPERM (and sometimes EBUSY) while another process deletes the lock file, which
 * stays "delete pending" until its last handle closes, or while a scanner holds it open. Those
 * clear in milliseconds, so they count as a busy lock there. On other platforms EPERM is a real
 * permission error and fails at once.
 */
function transientOnWindows(code: string | undefined, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && (code === 'EPERM' || code === 'EBUSY');
}

/**
 * One try at the lock file: its descriptor, or that it is busy. `again` means a stale lock was
 * removed and the next try may follow at once; `transientErr` is a Windows EPERM or EBUSY from
 * this try, from opening or from removing a stale lock.
 */
type Attempt = { fd: number } | { busy: true; again?: boolean; transientErr?: unknown };

function tryAcquire(path: string, platform: NodeJS.Platform): Attempt {
  try {
    return { fd: openSync(path, 'wx') };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && !transientOnWindows(code, platform)) throw err;
    if (code !== 'EEXIST') return { busy: true, transientErr: err };
    if (!isStale(path)) return { busy: true };
    try {
      rmSync(path, { force: true });
      return { busy: true, again: true };
    } catch (rmErr) {
      if (!transientOnWindows((rmErr as NodeJS.ErrnoException).code, platform)) throw rmErr;
      return { busy: true, transientErr: rmErr };
    }
  }
}

function timedOut(path: string, transientErr: unknown): never {
  // A Windows EPERM that never clears is a real access error; surface it as such.
  if (transientErr !== undefined) throw transientErr;
  throw new OpsError(`timed out waiting for lock ${path}`);
}

function writeOwner(fd: number): void {
  writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
  closeSync(fd);
}

/**
 * Lock files an async holder in this process has, by path. A synchronous wait for one of them
 * would block the event loop the holder needs to finish, until the wait timed out.
 */
const heldAsync = new Set<string>();

/**
 * Runs `fn` while holding an exclusive lock file. The lock is a file created with `wx`; a lock
 * whose process is gone, or that is older than 30 s, is taken over. A lock that
 * {@link withLockAsync} holds in this process fails at once instead of waiting.
 */
export function withLock<T>(
  path: string,
  fn: () => T,
  timeoutMs = 15_000,
  platform: NodeJS.Platform = process.platform,
): T {
  if (heldAsync.has(path)) {
    throw new OpsError(`lock ${path} is busy: this process holds it for async work`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let wait = 5;
  for (;;) {
    const a = tryAcquire(path, platform);
    if ('fd' in a) {
      try {
        writeOwner(a.fd);
        return fn();
      } finally {
        rmSync(path, { force: true });
      }
    }
    if (a.again) continue;
    if (Date.now() > deadline) timedOut(path, a.transientErr);
    sleep(wait);
    wait = Math.min(wait * 2, 100);
  }
}

/**
 * {@link withLock} for async work: waits for the lock without blocking the event loop, and holds
 * it until `fn` settles. Async holders in this process take turns.
 */
export async function withLockAsync<T>(
  path: string,
  fn: () => Promise<T>,
  timeoutMs = 15_000,
  platform: NodeJS.Platform = process.platform,
): Promise<T> {
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let wait = 5;
  for (;;) {
    // Held by another async holder in this process: its lock file is not stale, so wait.
    const a: Attempt = heldAsync.has(path) ? { busy: true } : tryAcquire(path, platform);
    if ('fd' in a) {
      heldAsync.add(path);
      try {
        writeOwner(a.fd);
        return await fn();
      } finally {
        heldAsync.delete(path);
        rmSync(path, { force: true });
      }
    }
    if (a.again) continue;
    if (Date.now() > deadline) timedOut(path, a.transientErr);
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(wait * 2, 100);
  }
}
