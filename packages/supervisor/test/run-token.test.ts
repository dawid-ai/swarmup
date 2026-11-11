import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initRoot, Workspace } from '@swarmup/core';
import type { RunRecord } from '../src/index.js';
import { readDaemon, startApi, Supervisor } from '../src/index.js';

const dirs: string[] = [];
const sups: Supervisor[] = [];
const closers: (() => Promise<void>)[] = [];

// `close` may wait about a minute for runs and their wrap-up (its own limits add up to 65 s), so
// the hook gets 90 s. It takes this test's servers, supervisors and directories before it awaits
// anything: a hook that still runs after a timeout must never delete the next test's folders
// (AO-0194).
afterEach(async () => {
  const shut = closers.splice(0);
  const mine = sups.splice(0);
  const gone = dirs.splice(0);
  try {
    for (const c of shut) await c();
    for (const s of mine) {
      liveMap(s).clear();
      await s.close();
    }
  } finally {
    for (const d of gone) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  }
}, 90_000);

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmupd-runtoken-'));
  dirs.push(d);
  return d;
}

function liveMap(sup: Supervisor): Map<string, { record: RunRecord }> {
  return (sup as unknown as { live: Map<string, { record: RunRecord }> }).live;
}

function registerRun(
  sup: Supervisor,
  token: string,
  input: { id: string; agent?: string; parent?: string },
): RunRecord {
  const record: RunRecord = {
    id: input.id,
    agent: input.agent ?? 'fake:engineer',
    parent: input.parent,
    project: 'test',
    pid: 1,
    image: 'fake',
    command: 'fake',
    cwd: sup.context.cwd,
    log: sup.store.logPath(input.id),
    started_at: new Date().toISOString(),
    status: 'running',
    budget_minutes: 60,
    tokens: 0,
    token_sha256: createHash('sha256').update(token).digest('hex'),
  };
  sup.store.save(record);
  liveMap(sup).set(record.id, { record });
  return record;
}

async function setup() {
  const repo = temp();
  execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  initRoot(repo, { name: 'test', human: 'human:dawid' });
  const userConfig = join(temp(), 'config.yml');
  writeFileSync(userConfig, 'me: human:dawid\nopsd:\n  sync: false\n');
  const env = {
    ...process.env,
    SWARMUP_CONFIG: userConfig,
    SWARMUP_STATE_DIR: temp(),
  } as NodeJS.ProcessEnv;
  delete env.SWARMUP_AGENT;
  delete env.SWARMUP_ROOTS;
  delete env.SWARMUP_RUN_TOKEN;
  delete env.SWARMUP_RUN_STATE_DIR;
  const sup = new Supervisor({
    env,
    cwd: repo,
    user: { me: 'human:dawid' },
    freeMem: () => 64 * 2 ** 30,
  });
  sups.push(sup);
  let shutdowns = 0;
  const api = await startApi(sup, {
    port: 0,
    token: 'full-token',
    version: 't',
    build: '1',
    onShutdown: () => shutdowns++,
  });
  closers.push(api.close);
  const call = async (token: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${api.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };
  const as = (actor: string) => new Workspace({ cwd: repo, env, actor, user: {} });
  return { sup, call, as, env, shutdowns: () => shutdowns };
}

describe('per-run API tokens', () => {
  it('recognizes only the hash of a live run token', async () => {
    const { sup } = await setup();
    const run = registerRun(sup, 'run-token', { id: 'RUN-ONE' });
    expect(sup.runByToken('run-token')).toBe(run);
    expect(sup.runByToken('wrong-token')).toBeUndefined();
    expect(JSON.stringify(sup.store.get(run.id))).not.toContain('run-token');
    liveMap(sup).delete(run.id);
    expect(sup.runByToken('run-token')).toBeUndefined();
  });

  it("acts as the run's agent and binds task writes to its run", async () => {
    const { sup, call, as } = await setup();
    as('human:dawid').newTask({ title: 'work', owner: 'fake:engineer' });
    registerRun(sup, 'run-token', { id: 'RUN-ONE' });

    const res = await call('run-token', 'POST', '/api/tasks/T-0001/comment', {
      as: 'human:dawid',
      message: 'from the run',
    });
    expect(res.status).toBe(200);
    expect(res.data.events).toEqual([
      expect.objectContaining({ type: 'comment', actor: 'fake:engineer' }),
    ]);
    const human = await call('full-token', 'POST', '/api/tasks/T-0001/comment', {
      as: 'human:dawid',
      message: 'from the app',
    });
    expect(human.data.events).toEqual([expect.objectContaining({ actor: 'human:dawid' })]);
  });

  it('gives a helper-token workspace helper restrictions', async () => {
    const { sup, call, as } = await setup();
    as('human:dawid').newTask({ title: 'work', owner: 'fake:engineer' });
    registerRun(sup, 'helper-token', {
      id: 'HELPER',
      agent: 'fake:qa',
      parent: 'PARENT',
    });
    const done = await call('helper-token', 'POST', '/api/tasks/T-0001/done', { message: 'x' });
    expect(done.status).toBe(409);
    expect(String(done.data.error)).toMatch(/helper run cannot change task state/);
    const note = await call('helper-token', 'POST', '/api/tasks/T-0001/comment', {
      message: 'seen',
    });
    expect(note.data.events).toEqual([expect.objectContaining({ actor: 'fake:qa' })]);
  });

  it('refuses every human-only mutation from a run token without changing state', async () => {
    const { sup, call, as, env, shutdowns } = await setup();
    as('human:dawid').newTask({ title: 'work', owner: 'fake:engineer' });
    registerRun(sup, 'run-token', { id: 'RUN-ONE' });
    const before = readFileSync(env.SWARMUP_CONFIG!, 'utf8');

    const refused: [string, unknown][] = [
      ['/api/tasks/T-0001/verdict', { as: 'human:dawid', verdict: 'approve', message: 'ok' }],
      ['/api/tasks/T-0001/answer', { as: 'human:dawid', message: 'yes' }],
      ['/api/settings', { patch: { max_runs: 99 } }],
      ['/api/roles', { as: 'human:dawid', create: true, role: { id: 'fake:writer' } }],
      ['/api/runs', { agent: 'fake:qa', prompt: 'x' }],
      ['/api/runs', { agent: 'fake:engineer', parent: 'OTHER', prompt: 'x' }],
      ['/api/schedules', { name: 'daily', agent: 'fake:engineer', every: '1h' }],
      ['/api/schedules/daily/run', {}],
      ['/api/schedules/daily/delete', {}],
      ['/api/repeats', { name: 'daily', title: 'x', start: '2026-11-05 09:00' }],
      ['/api/repeats/daily/pause', {}],
      ['/api/repeats/daily/run', {}],
      ['/api/repeats/daily/delete', {}],
      ['/api/notify/test', {}],
      ['/api/roots/test/mirror', { on: true }],
      ['/api/shutdown', { killRuns: true }],
    ];
    for (const [path, body] of refused) {
      const res = await call('run-token', 'POST', path, body);
      expect(res.status, path).toBe(403);
      expect(String(res.data.error), path).toMatch(/is for the human/);
    }
    expect(readFileSync(env.SWARMUP_CONFIG!, 'utf8')).toBe(before);
    expect(shutdowns()).toBe(0);
    expect((await call('full-token', 'POST', '/api/settings', { patch: {} })).status).toBe(200);
  });

  it('allows only its own and direct-helper run mutations', async () => {
    const { sup, call } = await setup();
    const parent = registerRun(sup, 'parent-token', { id: 'PARENT' });
    const helper = registerRun(sup, 'helper-token', {
      id: 'HELPER',
      agent: 'fake:qa',
      parent: parent.id,
    });
    const other = registerRun(sup, 'other-token', { id: 'OTHER' });
    const kill = vi.spyOn(sup, 'kill').mockImplementation((id) => sup.run(id));
    const reap = vi.spyOn(sup, 'reapNow').mockResolvedValue([]);

    for (const path of [`/api/runs/${other.id}/kill`, `/api/runs/${other.id}/procs`]) {
      const res = await call('parent-token', 'POST', path, {});
      expect(res.status, path).toBe(403);
    }
    expect(kill).not.toHaveBeenCalled();
    expect(reap).not.toHaveBeenCalled();

    expect((await call('parent-token', 'POST', `/api/runs/${helper.id}/kill`, {})).status).toBe(
      200,
    );
    expect((await call('parent-token', 'POST', `/api/runs/${helper.id}/procs`, {})).status).toBe(
      200,
    );
    expect((await call('parent-token', 'POST', `/api/runs/${parent.id}/kill`, {})).status).toBe(
      200,
    );
    expect(kill).toHaveBeenCalledWith(helper.id, 'killed');
    expect(kill).toHaveBeenCalledWith(parent.id, 'killed');
    expect(reap).toHaveBeenCalledWith(helper.id, undefined);
  });

  it('allows only same-agent runs or direct helpers to be launched', async () => {
    const { sup, call } = await setup();
    const parent = registerRun(sup, 'parent-token', { id: 'PARENT' });
    const launch = vi.spyOn(sup, 'launch').mockImplementation((req) => ({
      ...parent,
      id: req.parent ? 'NEW-HELPER' : 'NEW-RUN',
      agent: req.agent,
      parent: req.parent,
    }));

    expect(
      (await call('parent-token', 'POST', '/api/runs', { agent: 'fake:qa', prompt: 'x' })).status,
    ).toBe(403);
    expect(
      (
        await call('parent-token', 'POST', '/api/runs', {
          agent: 'fake:engineer',
          parent: 'OTHER',
          prompt: 'x',
        })
      ).status,
    ).toBe(403);
    expect(
      (await call('parent-token', 'POST', '/api/runs', { agent: 'fake:engineer' })).status,
    ).toBe(201);
    expect(
      (
        await call('parent-token', 'POST', '/api/runs', {
          agent: 'fake:qa',
          parent: parent.id,
          prompt: 'help',
        })
      ).status,
    ).toBe(201);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("reads the run's token only for the swarmupd on the run's own state folder", () => {
    const state = temp();
    writeFileSync(
      join(state, 'opsd.json'),
      JSON.stringify({ pid: process.pid, port: 1, token: 'full', started_at: '', version: 't' }),
    );
    const base = { SWARMUP_STATE_DIR: state, SWARMUP_RUN_TOKEN: 'run-token' };
    expect(readDaemon({ ...base, SWARMUP_RUN_STATE_DIR: state })?.token).toBe('run-token');
    expect(readDaemon({ ...base, SWARMUP_RUN_STATE_DIR: temp() })?.token).toBe('full');
    expect(readDaemon({ SWARMUP_STATE_DIR: state })?.token).toBe('full');
  });
});
