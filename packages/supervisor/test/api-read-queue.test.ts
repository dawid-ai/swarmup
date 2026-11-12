import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initRoot, Workspace } from '@swarmup/core';
import { startApi, Supervisor, TurnQueue } from '../src/index.js';

const dirs: string[] = [];
const sups: Supervisor[] = [];

// The hook takes this test's supervisors and directories before it awaits anything, so one that
// still runs after a timeout never deletes the next test's folders (AO-0194).
afterEach(async () => {
  const mine = sups.splice(0);
  const gone = dirs.splice(0);
  try {
    for (const s of mine) {
      s.stop({ killRuns: true });
      await s.close();
    }
  } finally {
    for (const d of gone) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  }
}, 90_000);

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmupd-read-queue-'));
  dirs.push(d);
  return d;
}

const turn = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('TurnQueue', () => {
  it('runs one job per turn of the event loop, in order', async () => {
    const q = new TurnQueue();
    const order: string[] = [];
    q.push(() => order.push('a'));
    q.push(() => order.push('b'));
    q.push(() => order.push('c'));
    // Nothing runs inside the push: the caller's own turn ends first.
    expect(order).toEqual([]);
    // Stands for a request that arrives after the reads were queued.
    setImmediate(() => order.push('arrived'));
    await turn();
    expect(order).toEqual(['a', 'arrived']);
    await turn();
    expect(order).toEqual(['a', 'arrived', 'b']);
    await turn();
    expect(order).toEqual(['a', 'arrived', 'b', 'c']);
  });

  it('takes jobs pushed by a job and after it ran dry', async () => {
    const q = new TurnQueue();
    const order: string[] = [];
    q.push(() => {
      order.push('a');
      q.push(() => order.push('from a'));
    });
    await turn();
    await turn();
    expect(order).toEqual(['a', 'from a']);
    await turn();
    q.push(() => order.push('later'));
    await turn();
    expect(order).toEqual(['a', 'from a', 'later']);
  });
});

describe('API reads and writes', () => {
  it('answers a write before the round of reads that came with it is through (AO-0277)', async () => {
    const repo = temp();
    execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
    initRoot(repo, { name: 'test', human: 'human:dawid' });
    const config = join(temp(), 'config.yml');
    writeFileSync(config, 'me: human:dawid\nopsd:\n  sync: false\n');
    const env = {
      ...process.env,
      SWARMUP_CONFIG: config,
      SWARMUP_STATE_DIR: temp(),
    } as NodeJS.ProcessEnv;
    delete env.SWARMUP_AGENT;
    delete env.SWARMUP_ROOTS;
    const ws = new Workspace({ cwd: repo, env, actor: 'human:dawid', user: {} });
    for (let i = 0; i < 30; i++) ws.newTask({ title: `task ${i}` });
    const sup = new Supervisor({ env, cwd: repo, freeMem: () => 64 * 2 ** 30 });
    sups.push(sup);
    const api = await startApi(sup, { port: 0, token: 'queue-token', version: 't', build: '1' });
    try {
      const base = `http://127.0.0.1:${api.port}`;
      const headers = { authorization: 'Bearer queue-token', 'content-type': 'application/json' };
      const READS = 40;
      let readsDone = 0;
      let readsDoneAtWrite = -1;
      const write = fetch(`${base}/api/tasks/T-0001/comment`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ as: 'human:dawid', message: 'a write among the reads' }),
      }).then(async (res) => {
        await res.arrayBuffer();
        readsDoneAtWrite = readsDone;
        return res.status;
      });
      const reads = Array.from({ length: READS }, () =>
        fetch(`${base}/api/tasks?all`, { headers }).then(async (res) => {
          await res.arrayBuffer();
          readsDone++;
          return res.status;
        }),
      );
      expect(await write).toBe(200);
      expect(await Promise.all(reads)).toEqual(Array(READS).fill(200));
      // Answered back to back, the reads all end before the write, whose body takes a turn to
      // arrive.
      expect(readsDoneAtWrite).toBeLessThan(READS);
    } finally {
      await api.close();
    }
  });
});
