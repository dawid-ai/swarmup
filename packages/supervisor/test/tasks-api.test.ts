// POST /api/tasks with `root` (AO-0323): the task goes to the named data root, not the default one.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initRoot } from '@swarmup/core';
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
  const d = mkdtempSync(join(tmpdir(), 'swarmupd-tasks-'));
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
  const api = await startApi(sup, { port: 0, token: 'tasks-token', version: 't', build: '1' });
  const post = async (body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${api.port}/api/tasks`, {
      method: 'POST',
      headers: { authorization: 'Bearer tasks-token', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${api.port}${path}`, {
      method,
      headers: { authorization: 'Bearer tasks-token', 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };
  return { sup, post, call };
}

describe('POST /api/tasks', () => {
  it('creates the task in the root it names, and in the default root without one', async () => {
    const { sup, post } = await setup();
    const there = await post({ title: 'Fix the header', root: 'web' });
    expect(there.status).toBe(201);
    expect(there.data).toMatchObject({ id: 'WEB-0001', root: 'web', project: 'web' });

    const here = await post({ title: 'Fix the footer' });
    expect(here.status).toBe(201);
    expect(here.data).toMatchObject({ id: 'SITE-0001', root: 'site', project: 'site' });

    const ws = sup.ws('human:dawid');
    expect(
      ws
        .list({ all: true })
        .map((v) => `${v.root}/${v.meta.id}`)
        .sort(),
    ).toEqual(['site/SITE-0001', 'web/WEB-0001']);
  });

  it('refuses a root that is not loaded, with the names of those that are', async () => {
    const { sup, post } = await setup();
    const res = await post({ title: 'Fix the header', root: 'shop' });
    expect(res.status).toBe(400);
    expect(res.data.error).toBe("no root named 'shop': use one of site, web");
    expect(sup.ws('human:dawid').list({ all: true })).toEqual([]);
  });
});

// The desktop's plan review (AO-0321): the routes call the functions behind `swarmup plan show`,
// `approve` and `reject`.
describe('a milestone plan through the API (AO-0110)', () => {
  const PLAN = [
    'items:',
    '  - key: build',
    '    title: Build the installer',
    "    owner: '*:engineer'",
    '    estimate: 4h',
    '  - key: smoke',
    '    title: Smoke check',
    "    owner: '*:qa'",
    '    estimate: 1h',
    '    after: [build]',
    '',
  ].join('\n');

  async function pending() {
    const s = await setup();
    const human = s.sup.ws('human:dawid');
    human.newTask({
      title: 'Installer ships',
      type: 'milestone',
      owner: 'claude:pm',
      doneWhen: ['The installer runs on a clean PC'],
    });
    const pm = s.sup.ws('claude:pm');
    const propose = (): void => {
      pm.start('SITE-0001', 'write the plan');
      pm.planPropose('SITE-0001', PLAN);
    };
    propose();
    return { ...s, human, propose };
  }

  it('shows the plan in the inbox and reports it, then creates the tasks on Approve plan', async () => {
    const { call, human } = await pending();
    const inbox = await call('GET', '/api/inbox?as=human:dawid');
    expect(inbox.data).toMatchObject([
      { kind: 'review', task: 'site/SITE-0001', plan: { items: 2, minutes: 300, change: false } },
    ]);
    const report = await call('GET', '/api/tasks/site%2FSITE-0001/plan');
    expect(report.data).toMatchObject({
      id: 'SITE-0001',
      doneWhen: 'The installer runs on a clean PC',
      approval: null,
      pending: { actor: 'claude:pm', minutes: 300, items: [{ key: 'build' }, { key: 'smoke' }] },
    });

    const approved = await call('POST', '/api/tasks/site%2FSITE-0001/plan-approve', {
      as: 'human:dawid',
    });
    expect(approved.status).toBe(200);
    expect(approved.data).toMatchObject({
      task: { id: 'SITE-0001', status: 'blocked', owner: '*:qa' },
      created: [
        { key: 'build', id: 'SITE-0002' },
        { key: 'smoke', id: 'SITE-0003' },
      ],
    });
    expect(human.view('SITE-0003').meta).toMatchObject({
      parent: 'SITE-0001',
      blocked_by: ['SITE-0002'],
      labels: ['milestone:SITE-0001'],
    });
    const progress = await call('GET', '/api/milestones');
    expect(progress.data).toEqual([
      {
        root: 'site',
        id: 'SITE-0001',
        title: 'Installer ships',
        total: 2,
        done: 0,
        parked: 0,
        minutes: 300,
        spent: 0,
        pending: null,
      },
    ]);
    expect((await call('GET', '/api/inbox?as=human:dawid')).data).toEqual([]);
  });

  it('records the diff of an edited plan, and refuses one that breaks a rule as core says it', async () => {
    const { call, human } = await pending();
    const path = '/api/tasks/site%2FSITE-0001/plan-approve';
    const build = { key: 'build', title: 'Build the installer', owner: '*:engineer' };
    const cycle = await call('POST', path, {
      as: 'human:dawid',
      plan: { items: [{ ...build, estimate: '4h', after: ['build'] }] },
    });
    expect(cycle).toMatchObject({ status: 400, data: { error: "item 'build' waits for itself" } });
    expect((await call('POST', path, { as: 'human:dawid', plan: 'items' })).status).toBe(400);

    const edited = await call('POST', path, {
      as: 'human:dawid',
      plan: {
        items: [
          { ...build, estimate: '6h' },
          {
            key: 'sign',
            title: 'Sign it',
            owner: 'codex:engineer',
            estimate: '1h',
            after: ['build'],
          },
        ],
      },
    });
    expect(edited.status).toBe(200);
    expect(edited.data.created).toEqual([
      { key: 'build', id: 'SITE-0002' },
      { key: 'sign', id: 'SITE-0003' },
    ]);
    const approval = human.showEvents('SITE-0001').events.find((e) => e.type === 'plan-approve')!;
    expect(approval.body).toMatch(
      /^Edited before approval: removed: smoke; estimate of build: 4h -> 6h; added: sign\./,
    );
  });

  it('returns the plan to the planner on Send back, with the note', async () => {
    const { call, human } = await pending();
    const path = '/api/tasks/site%2FSITE-0001/plan-reject';
    const empty = await call('POST', path, { as: 'human:dawid', message: ' ' });
    expect(empty.status).toBe(400);
    const back = await call('POST', path, {
      as: 'human:dawid',
      message: 'SITE-0001: add a signing step',
    });
    expect(back.status).toBe(200);
    expect(back.data).toMatchObject({ task: { status: 'todo', owner: 'claude:pm' }, created: [] });
    const reject = human.showEvents('SITE-0001').events.at(-1)!;
    expect(reject).toMatchObject({ type: 'plan-reject', to: 'claude:pm' });
    expect(reject.body.trim()).toBe('SITE-0001: add a signing step');
    expect(human.planShow('SITE-0001').pending).toBeNull();
    // Only a person approves: an agent's call is refused by the same check as the CLI's.
    const agent = await call('POST', '/api/tasks/site%2FSITE-0001/plan-approve', {
      as: 'claude:pm',
    });
    expect(agent.status).toBe(409);
  });
});
