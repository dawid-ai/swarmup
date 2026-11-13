import { execFileSync } from 'node:child_process';
import { Agent, request } from 'node:http';
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

interface Answer {
  status: number;
  reused: boolean;
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
    // Every request of the round goes over a connection that is already open. A new connection
    // costs the server a turn of its loop to accept on Linux and macOS (libuv accepts one per
    // turn), and fetch connects for a POST last. With 41 new connections the write was the last
    // one accepted, after a read had run in each turn before it (AO-0279).
    const agent = new Agent({ keepAlive: true });
    const call = (method: string, path: string, body?: unknown): Promise<Answer> =>
      new Promise((done, fail) => {
        const text = body === undefined ? undefined : JSON.stringify(body);
        const req = request(
          {
            agent,
            host: '127.0.0.1',
            port: api.port,
            method,
            path,
            headers: {
              authorization: 'Bearer queue-token',
              ...(text === undefined
                ? {}
                : {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(text),
                  }),
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => done({ status: res.statusCode ?? 0, reused: req.reusedSocket }));
            res.on('error', fail);
          },
        );
        req.on('error', fail);
        req.end(text);
      });
    try {
      const READS = 40;
      const read = (): Promise<Answer> => call('GET', '/api/tasks?all');
      // One request per connection opens them all; an answered request leaves its socket free.
      const opened = await Promise.all(Array.from({ length: READS + 1 }, read));
      expect(opened.map((a) => a.status)).toEqual(Array(READS + 1).fill(200));
      await turn();
      await turn();

      // The round: the reads first, the write last, all sent before the loop turns again, so
      // the server takes them in together. Answered in the order they came, the write is last.
      let readsDone = 0;
      let readsDoneAtWrite = -1;
      const reads = Array.from({ length: READS }, () =>
        read().then((a) => {
          readsDone++;
          return a;
        }),
      );
      const write = call('POST', '/api/tasks/T-0001/comment', {
        as: 'human:dawid',
        message: 'a write among the reads',
      }).then((a) => {
        readsDoneAtWrite = readsDone;
        return a;
      });
      const answers = [await write, ...(await Promise.all(reads))];
      expect(answers.map((a) => a.status)).toEqual(Array(READS + 1).fill(200));
      // A request that opened a connection would not have arrived with the others.
      expect(answers.map((a) => a.reused)).toEqual(Array(READS + 1).fill(true));
      // The write is answered in the turn it arrives; the reads take a turn each after that.
      expect(readsDoneAtWrite).toBeLessThan(5);
    } finally {
      agent.destroy();
      await api.close();
    }
  });
});
