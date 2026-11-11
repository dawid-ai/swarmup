import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initRoot } from '@swarmup/core';
import type { RunPage, RunRecord } from '../src/index.js';
import { pageRuns, RunStore, startApi, Supervisor } from '../src/index.js';

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];

// A closer may be `Supervisor.close()`, which may wait about a minute for runs and their wrap-up
// (its own limits add up to 65 s), so the hook gets 90 s. It takes this test's closers and
// directories before it awaits anything: a hook that still runs after a timeout must never
// delete the next test's folders (AO-0194).
afterEach(async () => {
  const shut = closers.splice(0);
  const gone = dirs.splice(0);
  try {
    for (const c of shut) await c();
  } finally {
    for (const d of gone) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  }
}, 90_000);

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmupd-runspage-'));
  dirs.push(d);
  return d;
}

function rec(id: string, patch: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    agent: 'fake:engineer',
    pid: 1,
    image: 'fake',
    command: 'fake',
    cwd: '.',
    log: `${id}.log`,
    started_at: '2026-11-08T10:00:00.000Z',
    ended_at: '2026-11-08T10:10:00.000Z',
    status: 'ended',
    reason: 'exit',
    exit: 0,
    budget_minutes: 60,
    tokens: 10,
    ...patch,
  };
}

describe('RunStore.list cache', () => {
  it('sees files changed, added and removed outside the store', () => {
    const dir = temp();
    const store = new RunStore(dir);
    store.save(rec('A'));
    store.save(rec('B'));
    expect(store.list().map((r) => r.id)).toEqual(['B', 'A']);

    // A write that changes the size, as another process would do it.
    writeFileSync(join(dir, 'runs', 'A.json'), JSON.stringify(rec('A', { tokens: 123456 })));
    writeFileSync(join(dir, 'runs', 'C.json'), JSON.stringify(rec('C')));
    unlinkSync(join(dir, 'runs', 'B.json'));
    const after = store.list();
    expect(after.map((r) => r.id)).toEqual(['C', 'A']);
    expect(after[1]!.tokens).toBe(123456);
  });

  it('sees a save of the same size and hands out copies', () => {
    const store = new RunStore(temp());
    store.save(rec('A', { tokens: 11 }));
    const first = store.list()[0]!;
    first.tokens = 99;
    expect(store.list()[0]!.tokens).toBe(11);
    store.save(rec('A', { tokens: 22 }));
    expect(store.list()[0]!.tokens).toBe(22);
  });
});

describe('pageRuns', () => {
  const all = [
    rec('05', { status: 'running', reason: undefined, exit: undefined }),
    rec('04', { exit: 1, tokens: 5 }),
    rec('03', { reason: 'killed', exit: null }),
    rec('02', { started_at: '2026-11-07T10:00:00.000Z', reason: 'lost', exit: null }),
    rec('01', { started_at: '2026-11-07T09:00:00.000Z' }),
  ];
  const since = '2026-11-08T00:00:00.000Z';

  it('counts every run and lists one page of the filter', () => {
    const page = pageRuns(all, { limit: 2, since });
    expect(page.runs.map((r) => r.id)).toEqual(['05', '04']);
    expect(page.more).toBe(true);
    expect(page.counts).toEqual({ all: 5, live: 1, ended: 4, errors: 2 });
    expect(page.today).toEqual({ runs: 3, tokens: 25, errors: 1 });
    expect(page.pick).toBeNull();
  });

  it('pages on with before and filters', () => {
    expect(pageRuns(all, { limit: 2, before: '04', since }).runs.map((r) => r.id)).toEqual([
      '03',
      '02',
    ]);
    const errors = pageRuns(all, { limit: 5, filter: 'errors', since });
    expect(errors.runs.map((r) => r.id)).toEqual(['04', '02']);
    expect(errors.more).toBe(false);
    expect(pageRuns(all, { limit: 5, filter: 'live', since }).runs.map((r) => r.id)).toEqual([
      '05',
    ]);
  });

  it('lists from a run id up to the newest with from', () => {
    const head = pageRuns(all, { limit: 10, from: '03', since });
    expect(head.runs.map((r) => r.id)).toEqual(['05', '04', '03']);
    expect(head.more).toBe(false);
    expect(head.counts.all).toBe(5);
    const ended = pageRuns(all, { limit: 10, from: '03', filter: 'ended', since });
    expect(ended.runs.map((r) => r.id)).toEqual(['04', '03']);
  });

  it('finds the picked run outside the page, by id or its end', () => {
    expect(pageRuns(all, { limit: 1, pick: '01', since }).pick?.id).toBe('01');
    expect(pageRuns([rec('01ABCDEF')], { limit: 1, pick: 'cdef' }).pick?.id).toBe('01ABCDEF');
    expect(pageRuns(all, { limit: 1, pick: 'ZZ', since }).pick).toBeNull();
  });
});

describe('GET /api/runs', () => {
  async function setup() {
    const repo = temp();
    execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
    initRoot(repo, { name: 'test', human: 'human:dawid' });
    const userConfig = join(temp(), 'config.yml');
    writeFileSync(userConfig, 'me: human:dawid\nopsd:\n  sync: false\n');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SWARMUP_CONFIG: userConfig,
      SWARMUP_STATE_DIR: temp(),
    };
    delete env.SWARMUP_AGENT;
    delete env.SWARMUP_ROOTS;
    delete env.SWARMUP_RUN_TOKEN;
    delete env.SWARMUP_RUN_STATE_DIR;
    const sup = new Supervisor({ env, cwd: repo, user: { me: 'human:dawid' } });
    closers.push(() => sup.close());
    const api = await startApi(sup, { port: 0, token: 'tok', version: 't', build: '1' });
    closers.unshift(api.close);
    const get = async (path: string) => {
      const res = await fetch(`http://127.0.0.1:${api.port}${path}`, {
        headers: { authorization: 'Bearer tok' },
      });
      return { status: res.status, data: (await res.json()) as unknown };
    };
    return { sup, get };
  }

  it('sends one page with limit and every run without it', async () => {
    const { sup, get } = await setup();
    for (const id of ['01', '02', '03']) sup.store.save(rec(id));

    const whole = await get('/api/runs');
    expect((whole.data as RunRecord[]).map((r) => r.id)).toEqual(['03', '02', '01']);

    const res = await get('/api/runs?limit=1&filter=ended&pick=01');
    expect(res.status).toBe(200);
    const page = res.data as RunPage;
    expect(page.runs.map((r) => r.id)).toEqual(['03']);
    expect(page.more).toBe(true);
    expect(page.counts.all).toBe(3);
    expect(page.pick?.id).toBe('01');

    const next = (await get('/api/runs?limit=5&before=03')).data as RunPage;
    expect(next.runs.map((r) => r.id)).toEqual(['02', '01']);
    expect(next.more).toBe(false);

    const head = (await get('/api/runs?limit=5&from=02')).data as RunPage;
    expect(head.runs.map((r) => r.id)).toEqual(['03', '02']);
  });

  it('refuses a bad limit, filter or since', async () => {
    const { get } = await setup();
    expect((await get('/api/runs?limit=0')).status).toBe(400);
    expect((await get('/api/runs?limit=10&filter=nope')).status).toBe(400);
    expect((await get('/api/runs?limit=10&since=never')).status).toBe(400);
  });
});
