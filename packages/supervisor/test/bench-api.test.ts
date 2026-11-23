// The bench API (W7): sets swarmupd finds, a dry run's plan, runs started as a detached runner and
// read back from their folders, compare and stop. A fake runner stands in for `swarmup bench run`,
// so no test starts an agent or spends tokens.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { opsdConfig, startApi } from '../src/index.js';
import { setupAsync, temp } from './supervisor-setup.js';
import { until } from './until.js';

/**
 * A stand-in for the CLI: `<runner> bench run SET --repo R --out O ...`. It writes its arguments,
 * then `status.json`; `done` writes one attempt and `summary.json`, `hang` waits to be stopped.
 */
const FAKE_RUNNER = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const out = args[args.indexOf('--out') + 1];
const now = new Date().toISOString();
writeFileSync(join(out, 'args.json'), JSON.stringify(args));
const status = (s) => writeFileSync(join(out, 'status.json'), JSON.stringify({
  pid: process.pid, startedAt: now, updatedAt: new Date().toISOString(), ...s }));
status({ state: 'running', done: 0, total: 1, current: 'E-1 #1' });
console.error('set demo: 1 attempts');
// A hung run ends on its own after a minute, so a test that misses its stop leaks no process.
if (process.env.FAKE_BENCH === 'hang') { setInterval(() => {}, 1000); setTimeout(() => process.exit(1), 60_000); }
else {
  const dir = join(out, 'E-1', '1');
  mkdirSync(dir, { recursive: true });
  const score = { checkable: 1, passed: 1, passRate: 1, hidden: { total: 0, passed: 0 }, pending: 0 };
  writeFileSync(join(dir, 'results.json'), JSON.stringify({
    set: 'demo', entry: 'E-1', attempt: 1, mode: 'none', agent: 'none',
    base: { ref: 'main', sha: 'abc' }, startedAt: now,
    run: { exitCode: 0, timedOut: false, wallMs: 5 },
    metrics: { costUsd: null, tokens: null, turns: null, toolCalls: null, toolCallsBeforeEdit: null, edited: null },
    diff: { files: 0, insertions: 0, deletions: 0 },
    criteria: [{ id: 'ok', kind: 'command', what: 'node', result: 'pass' }], score, dir }));
  writeFileSync(join(dir, 'diff.patch'), 'diff --git a/x b/x\\n+one\\n');
  const entry = { entry: 'E-1', attempts: 1, passRate: 1, hiddenPass: null, pending: 0,
    costUsd: null, wallMs: 5, toolCallsBeforeEdit: null, timedOut: 0, errors: 0 };
  const overall = { attempts: 1, passRate: 1, hiddenPassRate: null, costUsd: null,
    costPerAttempt: null, wallMs: 5, toolCallsBeforeEdit: null };
  writeFileSync(join(out, 'summary.json'), JSON.stringify({ set: 'demo', mode: 'none',
    agent: 'none', repo: 'r', out, startedAt: now, finishedAt: new Date().toISOString(),
    entries: [entry], overall }));
  status({ state: 'done', done: 1, total: 1, finishedAt: new Date().toISOString() });
}
`;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, windowsHide: true, stdio: 'ignore' });
}

/** A repo under test with one commit on main. */
function testRepo(): string {
  const dir = temp();
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'base');
  return dir;
}

const SET = (id: string): string =>
  [
    `id: ${id}`,
    'defaults: { agent: claude:engineer, budget: 20, repeat: 2 }',
    'entries:',
    '  - id: E-1',
    '    base: { ref: main }',
    '    prompt: Write done.txt.',
    '    done_when:',
    '      - { kind: command, run: node -v }',
    '      - Reads well.',
    '  - id: E-2',
    '    base: { ref: main }',
    '    task: { title: Fix it, body: Fix the bug. }',
    '    done_when: [{ kind: command, run: node -v }]',
    '',
  ].join('\n');

async function benchApi(mode: 'done' | 'hang' = 'done') {
  const repo = temp();
  const extra = temp();
  const extraSet = join(extra, 'extra.yaml');
  writeFileSync(extraSet, SET('extra'));
  const runner = join(temp(), 'fake-runner.mjs');
  writeFileSync(runner, FAKE_RUNNER);
  const { sup } = await setupAsync({
    repo,
    opsd: { bench: { sets: [extraSet, join(extra, 'missing.yaml')] } },
    env: { SWARMUP_BENCH_CLI: runner, FAKE_BENCH: mode },
  });
  // A set in the root's own benchmarks folder, and one that does not read.
  mkdirSync(join(repo, '.swarmup', 'benchmarks'), { recursive: true });
  writeFileSync(join(repo, '.swarmup', 'benchmarks', 'demo.yaml'), SET('demo'));
  writeFileSync(join(repo, '.swarmup', 'benchmarks', 'bad.yaml'), 'id: bad\nentries: []\n');
  const api = await startApi(sup, { port: 0, token: 'bench-token', version: 't', build: '1' });
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${api.port}${path}`, {
      method,
      headers: { authorization: 'Bearer bench-token', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      // A plain-text answer, such as a diff.
    }
    return { status: res.status, data: data as Record<string, unknown> & unknown[] };
  };
  const demo = join(repo, '.swarmup', 'benchmarks', 'demo.yaml');
  return { sup, api, call, demo, extraSet, under: testRepo() };
}

describe('bench API', () => {
  it('lists the sets of each root and of swarmupd.bench.sets, with why a set does not read', async () => {
    const { api, call, extraSet } = await benchApi();
    try {
      const sets = await call('GET', '/api/bench/sets');
      expect(sets.status).toBe(200);
      const list = sets.data as unknown as Array<Record<string, unknown>>;
      expect(list.map((s) => [s.id, s.source])).toEqual([
        ['bad', 'root:test'],
        ['demo', 'root:test'],
        ['extra', 'config'],
        ['missing', 'config'],
      ]);
      expect(list[0]!.error).toMatch(/entries must be a list/);
      expect(list[3]!.error).toMatch(/cannot read/);
      expect(list[2]!.file).toBe(extraSet);
      expect(list[1]).toMatchObject({
        defaults: { agent: 'claude:engineer', budget: 20, repeat: 2 },
        entries: [
          { id: 'E-1', title: 'Write done.txt.', criteria: { visible: 1, hidden: 0, pending: 1 } },
          { id: 'E-2', title: 'Fix it', base: 'main' },
        ],
      });
    } finally {
      await api.close();
    }
  });

  it('plans a dry run without writing, and refuses a set it does not list', async () => {
    const { sup, api, call, demo, under } = await benchApi();
    try {
      const agent = await call('POST', '/api/bench/run', {
        set: demo,
        repo: under,
        mode: 'agent',
        entries: ['E-2'],
        dry_run: true,
      });
      expect(agent.status).toBe(200);
      expect(agent.data.id).toBeUndefined();
      expect(agent.data.plan).toMatchObject({
        set: 'demo',
        mode: 'agent',
        agent: 'claude:engineer',
        entries: ['E-2'],
        repeat: 2,
        maxMinutes: 40,
        spends: true,
      });
      expect((agent.data.plan as { attempts: unknown[] }).attempts).toHaveLength(2);
      // A dollar cap goes into the plan and its dry-run lines; a bad one is refused.
      const capped = await call('POST', '/api/bench/run', {
        set: demo,
        repo: under,
        mode: 'agent',
        entries: ['E-2'],
        max_usd: 2.5,
        dry_run: true,
      });
      expect(capped.data.plan).toMatchObject({ maxUsd: 2.5 });
      expect((capped.data.plan as { lines: string[] }).lines.join('\n')).toContain('cost cap');
      const badCap = await call('POST', '/api/bench/run', {
        set: demo,
        repo: under,
        mode: 'agent',
        max_usd: 0,
        dry_run: true,
      });
      expect(badCap.status).toBe(400);
      expect(badCap.data.error).toMatch(/max_usd/);
      const none = await call('POST', '/api/bench/run', {
        set: demo,
        repo: under,
        mode: 'none',
        repeat: 3,
        dry_run: true,
      });
      // A run that changes nothing runs each entry once and spends nothing.
      expect(none.data.plan).toMatchObject({
        agent: 'none',
        repeat: 1,
        spends: false,
        maxMinutes: 0,
      });
      expect(existsSync(join(sup.store.dir, 'bench'))).toBe(false);

      const elsewhere = join(temp(), 'other.yaml');
      writeFileSync(elsewhere, SET('other'));
      const refused = await call('POST', '/api/bench/run', {
        set: elsewhere,
        repo: under,
        mode: 'none',
      });
      expect(refused.status).toBe(400);
      expect(refused.data.error).toMatch(/no set swarmupd lists/);
      const noRef = await call('POST', '/api/bench/run', {
        set: demo,
        repo: under,
        mode: 'reference',
      });
      expect(noRef.status).toBe(400);
      expect(
        (await call('POST', '/api/bench/run', { set: demo, repo: under, mode: 'x' })).status,
      ).toBe(400);
    } finally {
      await api.close();
    }
  });

  it('starts the runner as a detached child and reads the run back from its folder', async () => {
    const { sup, api, call, demo, under } = await benchApi('done');
    try {
      const started = await call('POST', '/api/bench/run', {
        set: demo,
        repo: under,
        mode: 'none',
        entries: 'E-1',
      });
      expect(started.status).toBe(201);
      const id = started.data.id as string;
      expect(id).toMatch(/^demo-\d{8}-\d{6}$/);
      const dir = join(sup.store.dir, 'bench', id);
      const status = join(dir, 'status.json');
      await until(
        () =>
          existsSync(status) &&
          (JSON.parse(readFileSync(status, 'utf8')) as { state: string }).state === 'done',
      );
      const args = JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8')) as string[];
      expect(args.slice(0, 3)).toEqual(['bench', 'run', demo]);
      expect(args).toEqual(expect.arrayContaining(['--repo', '--out', dir, '--entries', 'E-1']));
      expect(args).toContain('none');
      const runs = await call('GET', '/api/bench/runs');
      expect(runs.data[0]).toMatchObject({
        id,
        state: 'done',
        set: 'demo',
        mode: 'none',
        agent: 'none',
        fromApp: true,
        overall: { passRate: 1 },
      });
      const detail = await call('GET', `/api/bench/runs/${id}`);
      expect(detail.data).toMatchObject({
        run: { id, state: 'done' },
        request: { mode: 'none', entries: ['E-1'] },
        attempts: [{ entry: 'E-1', attempt: 1, criteria: [{ id: 'ok', result: 'pass' }] }],
      });
      expect(detail.data.log).toContain('set demo');
      const diff = await call('GET', `/api/bench/runs/${id}/attempt?entry=E-1&n=1&file=diff`);
      expect(diff.data).toContain('+one');
      expect(
        (await call('GET', `/api/bench/runs/${id}/attempt?entry=E-1&n=1&file=log`)).status,
      ).toBe(400);
      expect(
        (await call('GET', `/api/bench/runs/${id}/attempt?entry=../x&n=1&file=diff`)).status,
      ).toBe(400);
      const cmp = await call('POST', '/api/bench/compare', { a: id, b: id });
      expect(cmp.data).toMatchObject({
        rows: [{ entry: 'E-1' }],
        overall: { delta: { passRate: 0 } },
      });
      expect((await call('GET', '/api/bench/runs/nope')).status).toBe(400);
    } finally {
      await api.close();
    }
  });

  it('shows a run under way with its progress, and stops it', async () => {
    const { sup, api, call, demo, under } = await benchApi('hang');
    try {
      const started = await call('POST', '/api/bench/run', {
        set: demo,
        repo: under,
        mode: 'none',
      });
      const id = started.data.id as string;
      const status = join(sup.store.dir, 'bench', id, 'status.json');
      await until(() => existsSync(status));
      const runs = await call('GET', '/api/bench/runs');
      expect(runs.data[0]).toMatchObject({
        id,
        state: 'running',
        done: 0,
        total: 1,
        current: 'E-1 #1',
      });
      const stopped = await call('POST', `/api/bench/runs/${id}/stop`);
      expect(stopped.data).toMatchObject({ id, state: 'failed', error: 'stopped from the app' });
      const { pid } = JSON.parse(readFileSync(status, 'utf8')) as { pid: number };
      await until(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      });
      expect((await call('POST', `/api/bench/runs/${id}/stop`)).status).toBe(409);
    } finally {
      await api.close();
    }
  });
});

describe('swarmupd.bench', () => {
  it('takes sets and results as lists of paths, or one path, and refuses other keys', () => {
    const cfg = (bench: unknown) => opsdConfig({ swarmupd: { bench } } as never).bench;
    expect(cfg(undefined)).toEqual({ sets: [], results: [] });
    expect(cfg({ sets: 'a.yaml', results: ['out'] })).toEqual({
      sets: ['a.yaml'],
      results: ['out'],
    });
    expect(() => cfg({ set: ['a.yaml'] })).toThrow(/unknown key set/);
    expect(() => cfg({ sets: [1] })).toThrow(/bench.sets: use a list of paths/);
  });

  it('takes prices by model and refuses a bad price', () => {
    const cfg = (bench: unknown) => opsdConfig({ swarmupd: { bench } } as never).bench;
    expect(cfg({ prices: { 'gpt-x': { input: 1, cached_input: 0.1, output: 8 } } })).toEqual({
      sets: [],
      results: [],
      prices: { 'gpt-x': { input: 1, cached_input: 0.1, output: 8 } },
    });
    expect(() => cfg({ prices: { 'gpt-x': { input: '1', cached_input: 0, output: 8 } } })).toThrow(
      /swarmupd\.bench\.prices\.gpt-x\.input: use a number of 0 or more/,
    );
  });
});
