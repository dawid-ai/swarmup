// AO-0315: the decision log over the API, as the desktop app uses it. A task write with
// `decision` records it (the CLI's `--decision`); `GET /api/decisions?log` lists what
// `swarmup decisions --log` lists; `POST /api/decisions` writes a record, such as a replacement.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initRoot } from '@swarmup/core';
import type { LogEntry } from '@swarmup/core';
import { startApi, Supervisor } from '../src/index.js';

const dirs: string[] = [];
const sups: Supervisor[] = [];

// As in attachments-api.test.ts: take this test's supervisors and folders before awaiting.
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
  const d = mkdtempSync(join(tmpdir(), 'swarmupd-decisions-'));
  dirs.push(d);
  return d;
}

function repo(name: string, prefix: string): string {
  const dir = temp();
  execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
  initRoot(dir, { name, prefix, human: 'human:dawid' });
  return dir;
}

async function setup() {
  const site = repo('site', 'SITE');
  const web = repo('web', 'WEB');
  const config = join(temp(), 'config.yml');
  writeFileSync(config, 'me: human:dawid\nopsd:\n  sync: false\n');
  const env = {
    ...process.env,
    SWARMUP_CONFIG: config,
    SWARMUP_STATE_DIR: temp(),
  } as NodeJS.ProcessEnv;
  delete env.SWARMUP_AGENT;
  delete env.SWARMUP_ROOTS;
  const sup = new Supervisor({
    env,
    cwd: site,
    user: { me: 'human:dawid', roots: [web] },
    freeMem: () => 64 * 2 ** 30,
  });
  sups.push(sup);
  const api = await startApi(sup, { port: 0, token: 'dec-token', version: 't', build: '1' });
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${api.port}${path}`, {
      method,
      headers: { authorization: 'Bearer dec-token', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };
  const log = async (query = 'log'): Promise<LogEntry[]> =>
    (await call('GET', `/api/decisions?${query}`)).data as unknown as LogEntry[];
  const ws = sup.ws('human:dawid');
  ws.addTask({ title: 'Header', owner: 'human:dawid' });
  return { sup, call, log };
}

const me = { as: 'human:dawid' };

describe('a decision marked on a task write', () => {
  it('is recorded for the task tree, shows in the log and on the event', async () => {
    const { sup, call, log } = await setup();
    const res = await call('POST', '/api/tasks/SITE-0001/comment', {
      ...me,
      message: 'Headers stay sticky. No exceptions.',
      decision: 'Headers stay sticky',
      scope: 'tree',
    });
    expect(res.status).toBe(200);
    expect(res.data.decision).toBe('D-0001');
    const events = res.data.events as Array<{ id: string; decision?: string }>;
    expect(events[0]!.decision).toBe('D-0001');

    const entries = await log();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      root: 'site',
      id: 'D-0001',
      kind: 'record',
      text: 'Headers stay sticky',
      scope: 'tree',
      task: 'SITE-0001',
      source: `SITE-0001#${events[0]!.id}`,
      by: 'human:dawid',
      state: 'recorded',
    });
    // The same list `swarmup decisions --log` prints.
    expect(sup.ws('human:dawid').decisionLog()).toEqual(entries);
    expect(await log('log&task=SITE-0001')).toEqual(entries);
  });

  it('takes the project scope with scope: project', async () => {
    const { call, log } = await setup();
    await call('POST', '/api/tasks/SITE-0001/comment', {
      ...me,
      message: 'Sticky everywhere.',
      decision: 'Headers stay sticky',
      scope: 'project',
    });
    expect((await log())[0]).toMatchObject({ scope: 'project', project: 'site' });
  });

  it('refuses a line over 200 characters and writes neither the record nor the event', async () => {
    const { sup, call, log } = await setup();
    const res = await call('POST', '/api/tasks/SITE-0001/comment', {
      ...me,
      message: 'Too long.',
      decision: 'x'.repeat(201),
    });
    expect(res.status).toBe(400);
    expect(String(res.data.error)).toContain('200 characters at most');
    expect(await log()).toEqual([]);
    expect(
      sup
        .ws()
        .showEvents('SITE-0001')
        .events.filter((e) => e.type === 'comment'),
    ).toEqual([]);
  });

  it('refuses a scope without a decision, and a decision on a write that cannot mark one', async () => {
    const { call } = await setup();
    const lone = await call('POST', '/api/tasks/SITE-0001/comment', {
      ...me,
      message: 'Hello',
      scope: 'project',
    });
    expect(lone.status).toBe(400);
    expect(lone.data.error).toBe('scope describes a decision: add decision, its one line');
    const done = await call('POST', '/api/tasks/SITE-0001/done', {
      ...me,
      message: 'Done',
      decision: 'Headers stay sticky',
    });
    expect(done.status).toBe(400);
    expect(done.data.error).toBe("'done' cannot mark a decision");
  });
});

describe('POST /api/decisions', () => {
  it('records a replacement that takes the old scope and hides the old decision', async () => {
    const { call, log } = await setup();
    await call('POST', '/api/tasks/SITE-0001/comment', {
      ...me,
      message: 'Sticky everywhere.',
      decision: 'Headers stay sticky',
      scope: 'project',
    });
    const res = await call('POST', '/api/decisions', {
      ...me,
      root: 'site',
      text: 'Headers scroll with the page',
      supersedes: ['D-0001'],
    });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ root: 'site', id: 'D-0002' });

    const now = await log();
    expect(now.map((e) => e.id)).toEqual(['D-0002']);
    expect(now[0]).toMatchObject({
      text: 'Headers scroll with the page',
      scope: 'project',
      project: 'site',
      supersedes: ['D-0001'],
    });
    const all = await log('log&all');
    expect(all.map((e) => `${e.id}:${e.state}`).sort()).toEqual([
      'D-0001:superseded',
      'D-0002:recorded',
    ]);
  });

  it('writes to the root it names, and refuses one that is not loaded', async () => {
    const { call, log } = await setup();
    const there = await call('POST', '/api/decisions', { ...me, root: 'web', text: 'Use pnpm' });
    expect(there.status).toBe(201);
    expect(there.data).toMatchObject({ root: 'web', id: 'D-0001' });
    expect((await log()).map((e) => e.root)).toEqual(['web']);
    const none = await call('POST', '/api/decisions', { ...me, root: 'shop', text: 'Use pnpm' });
    expect(none.status).toBe(400);
    expect(none.data.error).toBe("no root named 'shop': use one of site, web");
  });

  it('refuses an agent that is not a person or the PM, and a line over 200 characters', async () => {
    const { call, log } = await setup();
    const agent = await call('POST', '/api/decisions', {
      as: 'claude:engineer',
      text: 'Use pnpm',
    });
    expect(agent.status).toBeGreaterThanOrEqual(400);
    expect(String(agent.data.error)).toContain('cannot record a decision');
    const long = await call('POST', '/api/decisions', { ...me, text: 'x'.repeat(201) });
    expect(long.status).toBe(400);
    expect(await log()).toEqual([]);
  });
});
