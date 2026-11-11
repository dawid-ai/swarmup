import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initRoot, Workspace } from '@swarmup/core';
import type { Timeline } from '@swarmup/core';
import { startApi, Supervisor } from '../src/index.js';

const dirs: string[] = [];
const sups: Supervisor[] = [];

// The test process's own config path: nothing here may write to it.
const guard = mkdtempSync(join(tmpdir(), 'swarmupd-timeline-guard-'));
const processConfig = join(guard, 'process-config.yml');
const savedConfig = process.env.SWARMUP_CONFIG;
beforeAll(() => {
  process.env.SWARMUP_CONFIG = processConfig;
});
afterAll(() => {
  if (savedConfig === undefined) delete process.env.SWARMUP_CONFIG;
  else process.env.SWARMUP_CONFIG = savedConfig;
  rmSync(guard, { recursive: true, force: true });
});
// `close` may wait about a minute for killed runs and their wrap-up (its own limits add up to
// 65 s), so the hook gets 90 s. It takes this test's supervisors and directories before it
// awaits anything: a hook that still runs after a timeout must never delete the next test's
// folders (AO-0194). The config check comes after the cleanup starts, so a failed check still
// stops the supervisors.
afterEach(async () => {
  const mine = sups.splice(0);
  const gone = dirs.splice(0);
  try {
    for (const s of mine) {
      s.stop({ killRuns: true });
      await s.close();
    }
    expect(existsSync(processConfig), 'an edit went to the process config').toBe(false);
  } finally {
    for (const d of gone) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  }
}, 90_000);

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmupd-timeline-'));
  dirs.push(d);
  return d;
}

async function setup() {
  const repo = temp();
  execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  initRoot(repo, { name: 'test', human: 'human:dawid' });
  const file = join(temp(), 'config.yml');
  writeFileSync(file, 'me: human:dawid\nopsd:\n  sync: false\n');
  const env = {
    ...process.env,
    SWARMUP_CONFIG: file,
    SWARMUP_STATE_DIR: temp(),
  } as NodeJS.ProcessEnv;
  delete env.SWARMUP_AGENT;
  delete env.SWARMUP_ROOTS;
  const sup = new Supervisor({ env, cwd: repo, freeMem: () => 64 * 2 ** 30 });
  sups.push(sup);
  const api = await startApi(sup, { port: 0, token: 'timeline-token', version: 't', build: '1' });
  const call = async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${api.port}${path}`, {
      headers: { authorization: 'Bearer timeline-token' },
    });
    return { status: res.status, data: (await res.json()) as Timeline & { error?: string } };
  };
  return { call, env, repo };
}

describe('timeline route', () => {
  it('answers the timeline of a project for a window, scaled to a clip', async () => {
    const { call, env, repo } = await setup();
    let now = Date.parse('2026-10-01T09:00:00Z');
    const as = (actor: string) => new Workspace({ cwd: repo, env, actor, now: () => now });
    const h = as('human:dawid');
    h.newTask({ title: 'Login page', project: 'site', owner: 'claude:engineer' });
    h.newTask({ title: 'Rate limits', project: 'api', owner: 'claude:engineer' });
    const c = as('claude:engineer');
    now += 10 * 60_000;
    c.start('1', 'plan');
    now += 20 * 60_000;
    c.ask('1', 'Email or username?');
    now += 60 * 60_000;
    h.answer('1', 'Email');
    c.start('2', 'limits');

    const window = 'from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z';
    const res = await call(`/api/timeline?project=site&${window}&clip=60&gap=10`);
    expect(res.status).toBe(200);
    expect(res.data.spans.map((s) => [s.task, s.agent, s.endedBy])).toEqual([
      ['T-0001', 'claude:engineer', 'ask'],
    ]);
    expect(res.data.waits).toMatchObject([{ task: 'T-0001', human: true, answered: true }]);
    expect(res.data.totals).toMatchObject({ asksAnswered: 1, humanWaitMinutes: 60 });
    expect(res.data.time).toMatchObject({ playbackMs: 60_000, maxGapMs: 600_000 });
    expect(res.data.from).toBe('2026-10-01T00:00:00.000Z');

    // Without a project, every project of the root.
    const all = await call(`/api/timeline?root=test&${window}`);
    expect(new Set(all.data.spans.map((s) => s.task))).toEqual(new Set(['T-0001', 'T-0002']));

    expect((await call(`/api/timeline?${window}&clip=0`)).status).toBe(400);
    expect((await call(`/api/timeline?${window}&gap=1.5`)).status).toBe(400);
    expect((await call('/api/timeline?days=0')).status).toBe(400);
    const bad = await call('/api/timeline?to=2026-10-02');
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/^timeline: give from with to/);
    expect((await call(`/api/timeline?root=nope&${window}`)).status).toBe(400);
  });

  it('adds task links and file mentions with graph=1 (AO-0080)', async () => {
    const { call, env, repo } = await setup();
    let now = Date.now() - 3_600_000;
    const as = (actor: string) => new Workspace({ cwd: repo, env, actor, now: () => now });
    const h = as('human:dawid');
    h.newTask({ title: 'Login page', project: 'site', owner: 'claude:engineer' });
    h.newTask({ title: 'Login copy', project: 'site', parent: '1' });
    now += 60_000;
    as('claude:engineer').start('1', 'edit `packages/site/src/login.tsx`');

    expect((await call('/api/timeline?days=7&project=site')).data).not.toHaveProperty('graph');
    const res = await call('/api/timeline?days=7&project=site&graph=1');
    expect(res.status).toBe(200);
    expect(res.data.graph!.tasks.map((t) => [t.task, t.parent])).toEqual([
      ['T-0001', undefined],
      ['T-0002', 'T-0001'],
    ]);
    expect(res.data.graph!.files).toMatchObject([
      { task: 'T-0001', actor: 'claude:engineer', path: 'packages/site/src/login.tsx' },
    ]);
    expect(res.data.graph!.touches).toContainEqual(
      expect.objectContaining({ task: 'T-0001', actor: 'claude:engineer', type: 'start' }),
    );
  });

  it('adds the Wrapped cards with wrapped=1, matching the report route (AO-0084)', async () => {
    const { call, env, repo } = await setup();
    let now = Date.now() - 3 * 3_600_000;
    const as = (actor: string) => new Workspace({ cwd: repo, env, actor, now: () => now });
    const h = as('human:dawid');
    h.newTask({ title: 'Login page', project: 'site', owner: 'claude:engineer' });
    h.newTask({ title: 'Rate limits', project: 'api', owner: 'claude:engineer' });
    const c = as('claude:engineer');
    c.start('1', 'plan');
    c.ask('1', 'Email or username?');
    now += 4 * 60_000;
    h.answer('1', 'Email');
    h.done('1', 'shipped');

    const plain = await call('/api/timeline?days=7&project=site');
    expect(plain.data).not.toHaveProperty('wrapped');
    const res = await call('/api/timeline?days=7&project=site&wrapped=1');
    expect(res.status).toBe(200);
    const w = (res.data as Timeline & { wrapped: Record<string, unknown> }).wrapped;
    expect(w).toMatchObject({
      project: 'site',
      closed: 1,
      opened: 1,
      fastest: { task: 'T-0001', minutes: 4, asked: 'human:dawid' },
    });
    const report = (await call('/api/report?days=7&project=site')).data as unknown as {
      project: string;
      totals: { closed: number; opened: number; minutes: number };
    };
    expect(report.project).toBe('site');
    expect(w.closed).toBe(report.totals.closed);
    expect(w.opened).toBe(report.totals.opened);
    expect(w.agentMinutes).toBe(report.totals.minutes);
  });
});
