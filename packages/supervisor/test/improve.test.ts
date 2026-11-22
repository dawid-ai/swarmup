// The self-improvement loop (W6): variant runs, the improvement trigger, the benchmark gate, and
// the proposal routes of the API.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDefinitions, readProposal, shortHash } from '@swarmup/core';
import type { Workspace } from '@swarmup/core';
import type {
  BenchRunRequest,
  BenchRunView,
  Comparison,
  ImproveConfig,
  ImproveHost,
  ImproveState,
  ScoreResult,
} from '../src/index.js';
import {
  benchVerdict,
  checkImprove,
  DEFAULT_IMPROVE,
  failingByAgent,
  Improver,
  invocation,
  startApi,
} from '../src/index.js';
import { ended, FAKE_AGENT, setupAsync, temp } from './supervisor-setup.js';

const ENGINEER =
  '---\nid: claude:engineer\nstatus: active\ntools: [Read, Edit]\n---\n\nWrite the code.\n';
const IMPROVER = '---\nid: claude:improver\nstatus: active\ncan_claim: [task]\n---\n\nImprove.\n';

function put(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

function claudeRuntime(): Record<string, unknown> {
  const agentFile = join(temp(), 'fake-agent.mjs');
  writeFileSync(agentFile, FAKE_AGENT);
  return { claude: { command: process.execPath, args: [agentFile], sign_in_check: false } };
}

const score = (
  agent: string,
  subject: string,
  scorer = 'review-rounds',
  at = '2026-11-20T10:00:00.000Z',
  pass = false,
): ScoreResult => ({
  scorer,
  level: subject.includes('/') ? 'task' : 'run',
  subject,
  agent,
  value: 3,
  unit: 'rounds',
  pass,
  n: 1,
  evidence: [],
  at,
});

const NOW = Date.parse('2026-11-22T12:00:00.000Z');

describe('variant runs', () => {
  it('materializes the resolved role file in the scratch folder and stamps the variant', async () => {
    const prompt = join(temp(), 'prompt.txt');
    const { sup, as, repo } = await setupAsync({
      opsd: { runtimes: claudeRuntime() },
      env: { FAKE_PROMPT: prompt },
    });
    const store = join(repo, '.swarmup');
    put(store, 'swarm.yaml', 'swarmup_defs: 1\n');
    put(store, 'agents/claude-engineer.md', ENGINEER);
    put(
      store,
      'variants/tests-first/agents/claude-engineer.md',
      '---\neffort: low\n---\n\nRun the tests first.\n',
    );
    await sup.tick();
    as('human:dawid').newTask({ title: 'a', owner: 'claude:engineer' });
    const run = await sup.launchFresh({
      agent: 'claude:engineer',
      task: 'T-0001',
      variant: 'tests-first',
    });
    const r = await ended(sup, run.id);
    const hash = loadDefinitions(store, { variant: 'tests-first' }).hash;
    expect(r.variant).toBe('tests-first');
    expect(r.defs).toMatchObject({ root: 'test', hash, variant: 'tests-first' });
    expect(r.effort).toBe('low');
    const file = join(r.scratch!, 'role-claude-engineer.md');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('Run the tests first.');
    expect(text).toContain('effort: low');
    expect(text).toMatch(/tools: \[ ?Read, Edit ?\]/);
    expect(readFileSync(prompt, 'utf8')).toContain(`Read your role file first: ${file}`);
    const start = as('human:dawid')
      .showEvents('1')
      .events.find((e) => e.type === 'run-start')!;
    expect(start).toMatchObject({ variant: 'tests-first', defs: shortHash(hash) });
    expect(start.body).toContain('variant tests-first');
    // The store's role file is what a base run reads.
    expect(readFileSync(join(store, 'agents', 'claude-engineer.md'), 'utf8')).toBe(ENGINEER);
    await expect(sup.launchFresh({ agent: 'claude:engineer', variant: 'missing' })).rejects.toThrow(
      /no variant 'missing'/,
    );
    await sup.defsSettled();
  });

  it('lets an improver run edit only in its scratch folder', () => {
    const inv = invocation(
      { command: 'claude' },
      'claude:improver',
      {
        id: 'claude:improver',
        status: 'active',
        file: '',
        body: '',
        tools: ['Read', 'Edit', 'Write'],
      },
      'C:\\work\\repo',
      ['C:\\work\\store', 'C:\\state\\scratch\\R1'],
      [],
      undefined,
      true,
      false,
      [],
      [],
      'C:\\state\\scratch\\R1',
    );
    const allow = inv.args[inv.args.indexOf('--allowedTools') + 1]!.split(',');
    const deny = inv.args[inv.args.indexOf('--disallowedTools') + 1]!.split(',');
    expect(allow).toContain('Edit(//c/state/scratch/R1/**)');
    expect(allow).toContain('Write(//c/state/scratch/R1/**)');
    expect(allow).not.toContain('Edit');
    expect(deny).toContain('Edit(//c/work/repo/**)');
    expect(deny).toContain('Write(//c/work/store/**)');
    expect(deny).not.toContain('Edit');
    // A reviewer stays fully read-only.
    const reviewer = invocation(
      { command: 'claude' },
      'claude:reviewer',
      undefined,
      'C:\\work\\repo',
      [],
      [],
      undefined,
      true,
      false,
      [],
      [],
      'C:\\state\\scratch\\R2',
    );
    expect(reviewer.args[reviewer.args.indexOf('--disallowedTools') + 1]!.split(',')).toContain(
      'Edit',
    );
  });
});

describe('improvement trigger', () => {
  it('counts distinct failing task and run scores per agent in the window', () => {
    const out = failingByAgent(
      [
        score('claude:engineer', 'test/T-0001'),
        score('claude:engineer', 'test/T-0001', 'merge-failures'),
        score('claude:engineer', 'R1', 'stuck-runs'),
        score('claude:engineer', 'test/T-0002', 'review-rounds', '2026-11-01T00:00:00.000Z'),
        score('claude:engineer', 'test/T-0003', 'review-rounds', '2026-11-21T00:00:00.000Z', true),
        score('human:dawid', 'test/T-0004'),
      ],
      { now: NOW, maxAgeDays: 7 },
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.subjects).toEqual(['R1', 'test/T-0001']);
    expect(out[0]!.byScorer.map((s) => s.scorer)).toEqual([
      'merge-failures',
      'review-rounds',
      'stuck-runs',
    ]);
  });

  it('checks swarmupd.improve', () => {
    expect(checkImprove(undefined)).toEqual(DEFAULT_IMPROVE);
    expect(
      checkImprove({ enabled: true, threshold: 3, benchmark: { set: 's.yaml', repo: 'r' } }),
    ).toMatchObject({
      enabled: true,
      threshold: 3,
      benchmark: { set: 's.yaml', repo: 'r', repeat: 1 },
    });
    expect(() => checkImprove({ threshold: 0 })).toThrow(/threshold: use a number of at least 1/);
    expect(() => checkImprove({ benchmark: { set: 's.yaml' } })).toThrow(/benchmark.repo/);
    expect(() => checkImprove({ agent: 'improver' })).toThrow(/<runtime>:<role>/);
  });

  function world(cfg: Partial<ImproveConfig> = {}) {
    return (async () => {
      const w = await setupAsync({ opsd: { runtimes: claudeRuntime() } });
      const store = join(w.repo, '.swarmup');
      put(store, 'swarm.yaml', 'swarmup_defs: 1\n');
      put(store, 'agents/claude-engineer.md', ENGINEER);
      put(store, 'agents/claude-improver.md', IMPROVER);
      let state: ImproveState = { gates: {} };
      let scores: ScoreResult[] = [];
      const started: BenchRunRequest[] = [];
      const runs = new Map<string, BenchRunView>();
      const warnings: string[] = [];
      const comparison = (passA: number, passB: number): Comparison => ({
        a: { set: 'tally', agent: 'claude:engineer', out: 'a' },
        b: { set: 'tally', agent: 'claude:engineer', variant: 'tests-first', out: 'b' },
        rows: [],
        overall: {
          a: {
            attempts: 1,
            passRate: passA,
            hiddenPassRate: null,
            costUsd: 1,
            costPerAttempt: 1,
            wallMs: 1000,
            toolCallsBeforeEdit: 3,
          },
          b: {
            attempts: 1,
            passRate: passB,
            hiddenPassRate: null,
            costUsd: 1,
            costPerAttempt: 1.2,
            wallMs: 1200,
            toolCallsBeforeEdit: 3,
          },
          delta: {
            attempts: 0,
            judged: null,
            judgeCostUsd: null,
            passRate: passB - passA,
            hiddenPassRate: null,
            costUsd: 0,
            costPerAttempt: 0.2,
            wallMs: 200,
            toolCallsBeforeEdit: 0,
          },
        },
      });
      const host: ImproveHost = {
        now: () => NOW,
        config: () => ({ ...DEFAULT_IMPROVE, enabled: true, threshold: 2, ...cfg }),
        ws: (actor?: string): Workspace => w.as(actor ?? 'human:dawid'),
        scores: () => scores,
        runs: () => [],
        bench: {
          start: (req) => {
            started.push(req);
            const id = `run-${started.length}`;
            runs.set(id, { id, dir: id, state: 'running', fromApp: true });
            return { id };
          },
          run: (id) => runs.get(id),
          compare: () => comparison(0.5, 1),
        },
        readState: () => state,
        writeState: (s) => {
          state = JSON.parse(JSON.stringify(s)) as ImproveState;
        },
        warn: (m) => warnings.push(m),
      };
      return {
        ...w,
        store,
        host,
        improver: new Improver(host),
        setScores: (s: ScoreResult[]) => (scores = s),
        started,
        runs,
        warnings,
        state: () => state,
      };
    })();
  }

  it('files one task when an agent passes the threshold, and none while it is open', async () => {
    const w = await world();
    w.setScores([
      score('claude:engineer', 'test/T-0009'),
      score('claude:engineer', 'R7', 'stuck-runs'),
    ]);
    const filed = w.improver.triggerTick();
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({
      title: 'Improve claude:engineer: 2 failing score(s)',
      type: 'task',
      owner: 'claude:improver',
      labels: ['improve'],
      created_by: 'opsd:improve',
    });
    const body = w.as('human:dawid').showEvents(filed[0]!.id).body;
    expect(body).toContain('Agent: claude:engineer');
    expect(body).toContain('Scorers: review-rounds, stuck-runs');
    expect(body).toContain('Evidence: test/T-0009, R7');
    expect(body).toContain('swarmup defs propose');
    // Within check_hours nothing runs; forced, the open task stops a second one.
    expect(w.improver.triggerTick()).toEqual([]);
    expect(w.improver.triggerTick(true)).toEqual([]);
    expect(
      w
        .as('human:dawid')
        .list()
        .filter((t) => t.meta.labels?.includes('improve')),
    ).toHaveLength(1);
  });

  it('files nothing below the threshold or when turned off', async () => {
    const w = await world({ threshold: 3 });
    w.setScores([score('claude:engineer', 'test/T-0009'), score('claude:engineer', 'R7')]);
    expect(w.improver.triggerTick()).toEqual([]);
    const off = await world({ enabled: false });
    off.setScores([score('claude:engineer', 'test/T-0009'), score('claude:engineer', 'R7')]);
    expect(off.improver.triggerTick(true)).toEqual([]);
  });

  it('files the task on request from a person, and refuses an agent with no failing score', async () => {
    const w = await world({ enabled: false });
    w.setScores([
      score('claude:engineer', 'test/T-0009', 'review-rounds', '2026-01-01T00:00:00.000Z'),
    ]);
    const meta = w.improver.request('claude:engineer', 'human:dawid');
    expect(meta.created_by).toBe('human:dawid');
    expect(() => w.improver.request('claude:engineer', 'human:dawid')).toThrow(
      /already has an open/,
    );
    expect(() => w.improver.request('claude:qa', 'human:dawid')).toThrow(/no failing/);
  });

  it('benchmarks a new proposal base against variant and comments the verdict', async () => {
    const w = await world({
      benchmark: { set: 'C:\\sets\\tally.yaml', repo: 'C:\\repo', repeat: 2, entries: ['TB-02'] },
    });
    w.setScores([score('claude:engineer', 'test/T-0009'), score('claude:engineer', 'R7')]);
    const task = w.improver.triggerTick()[0]!.id;
    const overlay = join(temp(), 'overlay');
    put(overlay, 'agents/claude-engineer.md', 'Run the tests before you ask for review.\n');
    w.as('claude:improver').defsPropose(task, {
      dir: overlay,
      name: 'tests-first',
      message: 'Untested changes.',
    });
    w.improver.gateTick();
    expect(w.started).toEqual([
      {
        set: 'C:\\sets\\tally.yaml',
        repo: 'C:\\repo',
        mode: 'agent',
        agent: 'claude:engineer',
        repeat: 2,
        role_file: true,
        root: w.store,
        entries: ['TB-02'],
      },
      {
        set: 'C:\\sets\\tally.yaml',
        repo: 'C:\\repo',
        mode: 'agent',
        agent: 'claude:engineer',
        repeat: 2,
        role_file: true,
        root: w.store,
        entries: ['TB-02'],
        variant: 'tests-first',
      },
    ]);
    // While the runs go on, nothing more starts and nothing is posted.
    w.improver.gateTick();
    expect(w.started).toHaveLength(2);
    for (const id of ['run-1', 'run-2'])
      w.runs.set(id, { id, dir: id, state: 'done', fromApp: true });
    w.improver.gateTick();
    const gate = Object.values(w.state().gates)[0]!;
    expect(gate).toMatchObject({
      state: 'done',
      verdict: 'better',
      commented: true,
      base: 'run-1',
      run: 'run-2',
    });
    expect(gate.delta?.passRate).toBeCloseTo(0.5);
    // The result goes into the proposal, where `defs promote` checks improvement.requires.
    expect(readProposal(w.store, 'tests-first')?.benchmark).toMatchObject({
      hash: gate.hash,
      state: 'done',
      verdict: 'better',
      base_run: 'run-1',
      run: 'run-2',
    });
    expect(readProposal(w.store, 'tests-first')?.benchmark?.pass_delta).toBeCloseTo(0.5);
    const comment = w
      .as('human:dawid')
      .showEvents(task)
      .events.filter((e) => e.type === 'comment')
      .at(-1)!;
    expect(comment.actor).toBe('opsd:improve');
    expect(comment.body).toContain('**better** than the base (pass rate +50 pts');
    expect(comment.body).toContain('| Entry | Pass rate |');
    const listed = w.improver.proposals();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      name: 'tests-first',
      status: 'proposed',
      benchmark: { verdict: 'better' },
    });
    expect(listed[0]!.diffs[0]!.lines).toContain('+Run the tests before you ask for review.');
    // An agent with an open proposal gets no second task.
    w.as('human:dawid').park(task, 'done for now');
    expect(w.improver.triggerTick(true)).toEqual([]);
  });

  it('calls a change better, worse or the same on pass rate, then hidden pass rate', () => {
    const c = (pass: number | null, hidden: number | null) =>
      ({ overall: { delta: { passRate: pass, hiddenPassRate: hidden } } }) as unknown as Comparison;
    expect(benchVerdict(c(0.1, null)).verdict).toBe('better');
    expect(benchVerdict(c(-0.1, 0.5)).verdict).toBe('worse');
    expect(benchVerdict(c(0, 0.2)).verdict).toBe('better');
    expect(benchVerdict(c(0, 0)).verdict).toBe('same');
  });
});

describe('proposal routes', () => {
  it('lists proposals, and lets a person promote or reject one and file an improvement task', async () => {
    const { sup, as, repo } = await setupAsync({ opsd: { runtimes: claudeRuntime() } });
    const store = join(repo, '.swarmup');
    put(store, 'swarm.yaml', 'swarmup_defs: 1\n');
    put(store, 'agents/claude-engineer.md', ENGINEER);
    put(store, 'agents/claude-improver.md', IMPROVER);
    const dawid = as('human:dawid');
    const task = dawid.newTask({ title: 'Improve', owner: 'claude:improver' }).id;
    for (const name of ['tests-first', 'smaller-diffs']) {
      const overlay = join(temp(), name);
      put(overlay, 'agents/claude-engineer.md', `${name} rules.\n`);
      as('claude:improver').defsPropose(task, { dir: overlay, name, message: 'why' });
    }
    await sup.tick();
    const api = await startApi(sup, { port: 0, token: 'w6-token', version: 't', build: '1' });
    const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${api.port}${path}`, {
        method,
        headers: { authorization: 'Bearer w6-token', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, data: (await res.json()) as unknown };
    };
    try {
      const list = await call('GET', '/api/defs/variants');
      expect(list.status).toBe(200);
      expect((list.data as Array<{ name: string }>).map((v) => v.name).sort()).toEqual([
        'smaller-diffs',
        'tests-first',
      ]);
      const refused = await call('POST', '/api/defs/variants/tests-first/promote', {
        as: 'claude:improver',
      });
      expect(refused.status).toBe(409);
      expect(JSON.stringify(refused.data)).toMatch(/only a person promotes/);
      const promoted = await call('POST', '/api/defs/variants/tests-first/promote', {
        as: 'human:dawid',
      });
      expect(promoted.status).toBe(200);
      expect(readFileSync(join(store, 'agents', 'claude-engineer.md'), 'utf8')).toContain(
        'tests-first rules.',
      );
      const rejected = await call('POST', '/api/defs/variants/smaller-diffs/reject', {
        as: 'human:dawid',
        message: 'Not now.',
      });
      expect(rejected.status).toBe(200);
      expect(existsSync(join(store, 'variants', 'smaller-diffs'))).toBe(false);
      const types = dawid.showEvents(task).events.map((e) => e.type);
      expect(types.filter((t) => t.startsWith('defs-'))).toEqual([
        'defs-propose',
        'defs-propose',
        'defs-promote',
        'defs-reject',
      ]);
      const none = await call('POST', '/api/improve', {
        as: 'human:dawid',
        agent: 'claude:engineer',
      });
      expect(none.status).toBe(409);
    } finally {
      await api.close();
      await sup.defsSettled();
    }
  });
});
