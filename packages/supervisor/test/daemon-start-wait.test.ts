import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { awaitDaemon, PROC_START_TIMEOUT_MS, START_WAIT_MS } from '../src/index.js';

// startDaemon's wait for a new swarmupd, which on a loaded Windows machine can spend each of its
// blocking creation-time reads (lock, stale holder, adopted runs) up to the PowerShell timeout
// before its API answers.

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'swarmup-start-wait-'));
  env = { SWARMUP_STATE_DIR: dir };
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

/** What a started swarmupd writes once its API listens; `pid` must be alive for readDaemon. */
function writeInfo(pid: number): void {
  writeFileSync(
    join(dir, 'opsd.json'),
    JSON.stringify({ pid, port: 1, token: 't', started_at: '', version: '' }),
  );
}

/** What swarmupd writes when it takes the per-state-folder lock, before its API listens. */
function writeLock(pid: number): void {
  writeFileSync(join(dir, 'opsd.lock'), JSON.stringify({ pid, start: null }));
}

function track<T>(p: Promise<T>): { settled: boolean; value?: T } {
  const s: { settled: boolean; value?: T } = { settled: false };
  void p.then((v) => {
    s.settled = true;
    s.value = v;
  });
  return s;
}

describe('awaitDaemon', () => {
  it('waits for a live swarmupd whose initial creation-time read takes longer than 15 s', async () => {
    const child = { pid: process.pid, exitCode: null };
    const wait = track(awaitDaemon(child, env));
    // The new swarmupd sits in its own blocking read past the 15 s a start used to get.
    await vi.advanceTimersByTimeAsync(PROC_START_TIMEOUT_MS + 5_000);
    expect(wait.settled).toBe(false);
    writeInfo(process.pid);
    await vi.advanceTimersByTimeAsync(400);
    expect(wait.settled).toBe(true);
    expect(wait.value).toMatchObject({ pid: process.pid, port: 1 });
  });

  it('covers four timed-out reads, then gives up on a live swarmupd that never answers', async () => {
    expect(START_WAIT_MS).toBeGreaterThanOrEqual(15_000 + 4 * PROC_START_TIMEOUT_MS);
    const wait = track(awaitDaemon({ pid: process.pid, exitCode: null }, env));
    await vi.advanceTimersByTimeAsync(START_WAIT_MS - 1_000);
    expect(wait.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(wait.settled).toBe(true);
    expect(wait.value).toBeNull();
  });

  it('stops at once when the child exited and no swarmupd answers', async () => {
    const wait = track(awaitDaemon({ pid: process.pid, exitCode: 1 }, env));
    await vi.advanceTimersByTimeAsync(400);
    expect(wait.settled).toBe(true);
    expect(wait.value).toBeNull();
  });

  it('waits for the lock holder to answer when the child exited before it wrote its address', async () => {
    // The child lost the lock to a slower swarmupd (this process stands in for it).
    writeLock(process.pid);
    const wait = track(awaitDaemon({ pid: 999_999, exitCode: 1 }, env));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(wait.settled).toBe(false);
    writeInfo(process.pid);
    await vi.advanceTimersByTimeAsync(400);
    expect(wait.settled).toBe(true);
    expect(wait.value).toMatchObject({ pid: process.pid, port: 1 });
  });

  it('gives up at the deadline on a lock holder that never answers', async () => {
    writeLock(process.pid);
    const wait = track(awaitDaemon({ pid: 999_999, exitCode: 1 }, env));
    await vi.advanceTimersByTimeAsync(START_WAIT_MS - 1_000);
    expect(wait.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(wait.settled).toBe(true);
    expect(wait.value).toBeNull();
  });

  it('stops at once when the child exited and the lock names a dead process or the child', async () => {
    writeLock(999_999);
    const dead = track(awaitDaemon({ pid: 999_998, exitCode: 1 }, env));
    await vi.advanceTimersByTimeAsync(400);
    expect(dead.settled).toBe(true);
    expect(dead.value).toBeNull();
    writeLock(process.pid);
    const own = track(awaitDaemon({ pid: process.pid, exitCode: 1 }, env));
    await vi.advanceTimersByTimeAsync(400);
    expect(own.settled).toBe(true);
    expect(own.value).toBeNull();
  });

  it('returns the swarmupd that won the lock when the child exited', async () => {
    writeInfo(process.pid);
    const wait = track(awaitDaemon({ pid: 999_999, exitCode: 1 }, env));
    await vi.advanceTimersByTimeAsync(400);
    expect(wait.value).toMatchObject({ pid: process.pid });
  });
});
