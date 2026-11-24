// Proposals from the app (W6): the improver's status and switches, a person's own change to an
// agent's role file recorded as a variant proposal (on a new improvement task or a task named),
// and each proposal's `improvement.requires` state. A run token, or an `as` that is not a
// person, writes nothing.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearDefinitionsCache, initRoot, Workspace } from '@swarmup/core';
import type { ImproveStatus, ProposalView, RunRecord } from '../src/index.js';
import { startApi, Supervisor } from '../src/index.js';

const ENGINEER =
  '---\nid: claude:engineer\nstatus: active\ntools: [Read, Edit]\n---\n\nWrite the code.\n';

const dirs: string[] = [];
const sups: Supervisor[] = [];
const closers: (() => Promise<void>)[] = [];

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
  const d = mkdtempSync(join(tmpdir(), 'swarmupd-propose-'));
  dirs.push(d);
  return d;
}

function liveMap(sup: Supervisor): Map<string, { record: RunRecord }> {
  return (sup as unknown as { live: Map<string, { record: RunRecord }> }).live;
}

function registerRun(sup: Supervisor, token: string, id: string): void {
  const record: RunRecord = {
    id,
    agent: 'claude:engineer',
    project: 'test',
    pid: 1,
    image: 'fake',
    command: 'fake',
    cwd: sup.context.cwd,
    log: sup.store.logPath(id),
    started_at: new Date().toISOString(),
    status: 'running',
    budget_minutes: 60,
    tokens: 0,
    token_sha256: createHash('sha256').update(token).digest('hex'),
  };
  sup.store.save(record);
  liveMap(sup).set(record.id, { record });
}

async function setup(swarm = 'swarmup_defs: 1\n') {
  const repo = temp();
  execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  initRoot(repo, { name: 'test', human: 'human:dawid' });
  const store = join(repo, '.swarmup');
  writeFileSync(join(store, 'swarm.yaml'), swarm);
  writeFileSync(join(store, 'agents', 'claude-engineer.md'), ENGINEER);
  clearDefinitionsCache();
  const userConfig = join(temp(), 'config.yml');
  writeFileSync(userConfig, 'me: human:dawid\nmachine: desk\nopsd:\n  sync: false\n');
  const env = {
    ...process.env,
    SWARMUP_CONFIG: userConfig,
    SWARMUP_STATE_DIR: temp(),
  } as NodeJS.ProcessEnv;
  for (const k of ['AGENT', 'ROOTS', 'RUN', 'RUN_TOKEN', 'RUN_STATE_DIR']) {
    delete env[`SWARMUP_${k}`];
    delete env[`OPS_${k}`];
  }
  const sup = new Supervisor({
    env,
    cwd: repo,
    user: { me: 'human:dawid', machine: 'desk' },
    freeMem: () => 64 * 2 ** 30,
  });
  sups.push(sup);
  const api = await startApi(sup, { port: 0, token: 'full-token', version: 't', build: '1' });
  closers.push(api.close);
  const call = async (token: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${api.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, data: JSON.parse(text) as Record<string, unknown> };
  };
  const ws = (actor: string) =>
    new Workspace({ cwd: repo, env: { SWARMUP_CONFIG: userConfig }, actor, user: {} });
  return { sup, repo, store, userConfig, call, ws };
}

describe('Proposals from the app', () => {
  it("shows the improver's state and lets a person turn its switches on and off", async () => {
    const { call, userConfig, sup } = await setup();
    const status = (await call('full-token', 'GET', '/api/improve'))
      .data as unknown as ImproveStatus;
    expect(status).toMatchObject({ enabled: false, notes: false, benchmark: null });
    expect(status.roots).toEqual([
      expect.objectContaining({
        root: 'test',
        open: 0,
        policy: expect.objectContaining({ requires: { benchmark: false, min_delta: 0 } }),
      }),
    ]);
    const on = await call('full-token', 'POST', '/api/improve/settings', {
      as: 'human:dawid',
      enabled: true,
    });
    expect(on.status).toBe(200);
    expect(on.data.enabled).toBe(true);
    expect(readFileSync(userConfig, 'utf8')).toMatch(/improve:\s*\n\s*enabled: true/);
    const off = await call('full-token', 'POST', '/api/improve/settings', {
      as: 'human:dawid',
      enabled: false,
    });
    expect(off.data.enabled).toBe(false);
    expect(readFileSync(userConfig, 'utf8')).not.toContain('enabled: true');
    const bad = await call('full-token', 'POST', '/api/improve/settings', {
      as: 'human:dawid',
      enabled: 'yes',
    });
    expect(bad.status).toBe(400);
    // The settings route takes only the switches, never the benchmark gate.
    const gate = await call('full-token', 'POST', '/api/settings', {
      as: 'human:dawid',
      patch: { opsd: { improve: { benchmark: { set: 'x' } } } },
    });
    expect(gate.status).toBe(400);
    registerRun(sup, 'run-token', 'RUN-ONE');
    const run = await call('run-token', 'POST', '/api/improve/settings', { enabled: true });
    expect(run.status).toBe(403);
    const agent = await call('full-token', 'POST', '/api/improve/settings', {
      as: 'claude:engineer',
      enabled: true,
    });
    expect(agent.status).toBe(403);
    expect(readFileSync(userConfig, 'utf8')).not.toContain('enabled: true');
  });

  it("records a person's change to a role file as a proposal on a new improvement task", async () => {
    const { call, ws, store } = await setup();
    const role = (await call('full-token', 'GET', '/api/roles/claude:engineer')).data;
    expect(role).toMatchObject({ path: 'agents/claude-engineer.md', text: ENGINEER });
    const text = ENGINEER.replace('Write the code.', 'Write the code. Run the tests first.');
    const same = await call('full-token', 'POST', '/api/defs/propose', {
      as: 'human:dawid',
      agent: 'claude:engineer',
      text: ENGINEER,
      message: 'why',
    });
    expect(same.status).toBe(400);
    const why = await call('full-token', 'POST', '/api/defs/propose', {
      as: 'human:dawid',
      agent: 'claude:engineer',
      text,
      message: ' ',
    });
    expect(why.status).toBe(400);
    const made = await call('full-token', 'POST', '/api/defs/propose', {
      as: 'human:dawid',
      agent: 'claude:engineer',
      text,
      message: 'Reviews keep sending back untested work.',
    });
    expect(made.status).toBe(201);
    expect(made.data).toMatchObject({ variant: 'engineer-by-hand', root: 'test' });
    const task = String(made.data.task);
    const shown = ws('human:dawid').showEvents(task);
    expect(shown.meta).toMatchObject({ owner: 'human:dawid', labels: ['improve'] });
    expect(shown.events.map((e) => e.type)).toContain('defs-propose');
    // The role file is untouched until a person promotes.
    expect(readFileSync(join(store, 'agents', 'claude-engineer.md'), 'utf8')).toBe(ENGINEER);
    const list = (await call('full-token', 'GET', '/api/defs/variants'))
      .data as unknown as ProposalView[];
    expect(list).toEqual([
      expect.objectContaining({
        name: 'engineer-by-hand',
        agents: ['claude:engineer'],
        requires: { benchmark: false, min_delta: 0, problems: [] },
        proposal: expect.objectContaining({ by: 'human:dawid', task }),
      }),
    ]);
    // A second one on a task you name gets the next free name.
    const own = ws('human:dawid').newTask({ title: 'Tighten the engineer', owner: 'human:dawid' });
    const second = await call('full-token', 'POST', '/api/defs/propose', {
      as: 'human:dawid',
      agent: 'claude:engineer',
      text: ENGINEER.replace('Write the code.', 'Write small diffs.'),
      message: 'Smaller diffs review faster.',
      task: own.id,
    });
    expect(second.status).toBe(201);
    expect(second.data).toMatchObject({ variant: 'engineer-by-hand-2', task: `test/${own.id}` });
  });

  it('shows what improvement.requires still needs on each proposal', async () => {
    const { call } = await setup(
      'swarmup_defs: 1\nimprovement:\n  requires:\n    benchmark: true\n    min_delta: 0.1\n',
    );
    const made = await call('full-token', 'POST', '/api/defs/propose', {
      as: 'human:dawid',
      agent: 'claude:engineer',
      text: ENGINEER.replace('Write the code.', 'Write tests.'),
      message: 'Tests first.',
    });
    expect(made.status).toBe(201);
    const [p] = (await call('full-token', 'GET', '/api/defs/variants'))
      .data as unknown as ProposalView[];
    expect(p!.requires).toMatchObject({ benchmark: true, min_delta: 0.1 });
    expect(p!.requires!.problems[0]).toMatch(/requires a benchmark/);
  });

  it('refuses a proposal from a run token or an agent, and writes nothing', async () => {
    const { call, sup, store } = await setup();
    const role = join(store, 'agents', 'claude-engineer.md');
    registerRun(sup, 'run-token', 'RUN-ONE');
    const body = {
      agent: 'claude:engineer',
      text: ENGINEER.replace('Write the code.', 'Anything.'),
      message: 'why',
    };
    const run = await call('run-token', 'POST', '/api/defs/propose', {
      as: 'human:dawid',
      ...body,
    });
    expect(run.status).toBe(403);
    expect(String(run.data.error)).toContain('run RUN-ONE cannot do it');
    const agent = await call('full-token', 'POST', '/api/defs/propose', {
      as: 'claude:improver',
      ...body,
    });
    expect(agent.status).toBe(403);
    expect(String(agent.data.error)).toContain('only a person');
    expect((await call('full-token', 'GET', '/api/defs/variants')).data).toEqual([]);
    expect(readFileSync(role, 'utf8')).toBe(ENGINEER);
    // Reading the improver's state stays open to runs.
    expect((await call('run-token', 'GET', '/api/improve')).status).toBe(200);
  });
});
