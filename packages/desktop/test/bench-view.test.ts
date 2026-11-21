// @vitest-environment happy-dom
// Benchmarks, rendered: the runs list with progress, a run started only after its dry run's plan
// (and, for an agent, an explicit cost confirmation), a run's attempts and criteria, and two runs
// compared. The bridge is a fake: nothing reaches swarmupd.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Nav } from '../ui/src/App';
import type {
  BenchAttempt,
  BenchComparison,
  BenchPlan,
  BenchRunView,
  BenchSetView,
} from '../ui/src/types';
import { Bench } from '../ui/src/views/Bench';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let box: HTMLDivElement;
let calls: Array<{ method: string; path: string; body?: Record<string, unknown> }>;
let answers: Record<string, unknown>;

const SET: BenchSetView = {
  id: 'tally',
  file: 'C:\\sets\\tally.yaml',
  source: 'config',
  hiddenDir: 'C:\\sets\\hidden',
  defaults: { agent: 'claude:engineer', budget: 30, repeat: 1 },
  entries: [
    {
      id: 'TB-02',
      title: 'Fix totals',
      base: 'df7b1f4a612f',
      repeat: 1,
      criteria: { visible: 2, hidden: 1, pending: 1 },
    },
    {
      id: 'TB-08',
      title: 'Add a flag',
      base: 'df7b1f4a612f',
      repeat: 1,
      criteria: { visible: 1, hidden: 1, pending: 2 },
    },
  ],
};

const overall = (passRate: number) => ({
  attempts: 2,
  passRate,
  hiddenPassRate: passRate,
  costUsd: 1.5,
  costPerAttempt: 0.75,
  wallMs: 60_000,
  toolCallsBeforeEdit: 4,
});

const RUNS: BenchRunView[] = [
  {
    id: 'tally-2',
    dir: 'd2',
    state: 'running',
    set: 'tally',
    mode: 'agent',
    agent: 'claude:engineer',
    model: 'opus',
    startedAt: '2026-11-21T10:00:00.000Z',
    done: 1,
    total: 4,
    current: 'TB-08 #1',
    fromApp: true,
  },
  {
    id: 'tally-1',
    dir: 'd1',
    state: 'done',
    set: 'tally',
    mode: 'reference',
    agent: 'reference',
    startedAt: '2026-11-20T10:00:00.000Z',
    finishedAt: '2026-11-20T10:01:00.000Z',
    overall: overall(1),
    fromApp: true,
  },
  {
    id: 'tally-0',
    dir: 'd0',
    state: 'done',
    set: 'tally',
    mode: 'none',
    agent: 'none',
    startedAt: '2026-11-19T10:00:00.000Z',
    finishedAt: '2026-11-19T10:00:30.000Z',
    overall: overall(0.5),
    fromApp: false,
  },
];

const plan = (spends: boolean): BenchPlan => ({
  set: 'tally',
  file: SET.file,
  mode: spends ? 'agent' : 'reference',
  agent: spends ? 'claude:engineer' : 'reference',
  repo: 'C:\\repo',
  entries: ['TB-02', 'TB-08'],
  repeat: spends ? 2 : 1,
  attempts: spends
    ? [
        { entry: 'TB-02', attempt: 1, base: 'abc', budgetMin: 30 },
        { entry: 'TB-02', attempt: 2, base: 'abc', budgetMin: 30 },
        { entry: 'TB-08', attempt: 1, base: 'abc', budgetMin: 30 },
        { entry: 'TB-08', attempt: 2, base: 'abc', budgetMin: 30 },
      ]
    : [
        { entry: 'TB-02', attempt: 1, base: 'abc', budgetMin: 30 },
        { entry: 'TB-08', attempt: 1, base: 'abc', budgetMin: 30 },
      ],
  skipped: [],
  maxMinutes: spends ? 120 : 0,
  spends,
  lines: ['set tally: 4 attempts'],
});

const attempt: BenchAttempt = {
  set: 'tally',
  entry: 'TB-02',
  attempt: 1,
  mode: 'agent',
  agent: 'claude:engineer',
  base: { ref: 'main', sha: 'abc' },
  startedAt: '2026-11-21T10:00:00.000Z',
  run: { exitCode: 0, timedOut: false, wallMs: 90_000 },
  metrics: { costUsd: 0.42, turns: 5, toolCalls: 9, toolCallsBeforeEdit: 3, edited: true },
  diff: { files: 2, insertions: 10, deletions: 1 },
  criteria: [
    { id: 'tests', kind: 'command', what: 'python -m unittest', result: 'pass', evidence: 'OK' },
    { id: 'hidden', kind: 'command', hidden: true, what: 'hidden test', result: 'fail' },
    { id: 'c3', kind: 'prose', what: 'Reads well.', result: 'pending' },
  ],
  score: { checkable: 2, passed: 1, passRate: 0.5, hidden: { total: 1, passed: 0 }, pending: 1 },
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  calls = [];
  answers = {
    '/api/bench/sets': [SET],
    '/api/bench/runs': RUNS,
  };
  window.swarmup = {
    call: (method: string, path: string, body?: Record<string, unknown>) => {
      calls.push({ method, path, body });
      if (path === '/api/bench/run') {
        const spends = body?.mode === 'agent';
        return Promise.resolve({
          ok: true,
          data: body?.dry_run ? { plan: plan(spends) } : { plan: plan(spends), id: 'tally-3' },
        });
      }
      const data = answers[path.split('?')[0]!];
      return Promise.resolve(
        data === undefined ? { ok: false, error: `no ${path}` } : { ok: true, data },
      );
    },
  } as unknown as NonNullable<Window['swarmup']>;
  box = document.createElement('div');
  document.body.append(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
  document.body.innerHTML = '';
  delete window.swarmup;
});

const nav = (): Nav => ({ me: 'human:dawid', openTask: vi.fn(), go: vi.fn() });

async function render(selected?: string, n = nav()): Promise<Nav> {
  root = createRoot(box);
  await act(async () => {
    root!.render(createElement(Bench, { nav: n, selected }));
    await new Promise((r) => setTimeout(r, 0));
  });
  return n;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function button(label: string, within: ParentNode = document.body): HTMLButtonElement {
  const b = [...within.querySelectorAll('button')].find((x) => x.textContent?.trim() === label);
  if (!b) throw new Error(`no button ${label}`);
  return b as HTMLButtonElement;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

function type(input: HTMLInputElement, text: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function field(label: string): HTMLInputElement {
  const l = [...document.querySelectorAll('label')].find(
    (x) => x.querySelector('.label-caps')?.textContent === label,
  );
  if (!l) throw new Error(`no field ${label}`);
  return l.querySelector('input')!;
}

describe('Benchmarks runs', () => {
  it('lists runs with live progress, and compares two finished runs', async () => {
    const n = await render();
    const rows = [...box.querySelectorAll('[data-run]')];
    expect(rows.map((r) => r.getAttribute('data-run'))).toEqual(['tally-2', 'tally-1', 'tally-0']);
    expect(rows[0]!.textContent).toContain('Running 1/4');
    expect(rows[0]!.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('1');
    expect(rows[0]!.textContent).toContain('claude:engineer · opus');
    expect(rows[1]!.textContent).toContain('100%');
    expect(rows[1]!.textContent).toContain('$1.50');
    // A run under way cannot be compared.
    expect(rows[0]!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true);
    const compare = button('Compare', box);
    expect(compare.disabled).toBe(true);
    await click(rows[1]!.querySelector('input')!);
    await click(rows[2]!.querySelector('input')!);
    expect(compare.disabled).toBe(false);
    await click(compare);
    expect(n.go).toHaveBeenCalledWith('bench', 'compare:tally-1:tally-0');
    // The sets and their entries.
    const set = box.querySelector('[data-set="tally"]')!;
    await click(set.querySelector('button[aria-expanded]')!);
    expect(set.textContent).toContain('Fix totals');
  });
});

describe('Benchmarks run dialog', () => {
  it('shows the plan and a cost warning, and starts an agent run only after the confirmation', async () => {
    const n = await render();
    await click(button('Run benchmark'));
    type(field('Repo under test'), 'C:\\repo');
    await click(button('TB-02'));
    await click(button('Review plan'));
    const dry = calls.find((c) => c.path === '/api/bench/run')!;
    expect(dry.body).toMatchObject({
      set: SET.file,
      repo: 'C:\\repo',
      mode: 'agent',
      entries: ['TB-02'],
      hidden_dir: SET.hiddenDir,
      dry_run: true,
    });
    expect(document.querySelector('[data-testid="bench-plan-size"]')?.textContent).toBe(
      '2 × 2 = 4 attempts',
    );
    expect(document.querySelector('[data-testid="bench-cost-warning"]')?.textContent).toContain(
      'spends tokens',
    );
    const start = button('Start 4 agent runs');
    expect(start.disabled).toBe(true);
    await click(
      document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!,
    );
    expect(start.disabled).toBe(false);
    await click(start);
    const real = calls.filter((c) => c.path === '/api/bench/run');
    expect(real).toHaveLength(2);
    expect(real[1]!.body).toMatchObject({ mode: 'agent', dry_run: false });
    expect(n.go).toHaveBeenCalledWith('bench', 'tally-3');
  });

  it('says reference mode costs nothing and starts it without a cost confirmation', async () => {
    await render();
    await click(button('Run benchmark'));
    await click(button('Reference'));
    type(field('Repo under test'), 'C:\\repo');
    type(field('Reference patches folder'), 'C:\\sets\\reference');
    await click(button('Review plan'));
    expect(calls[calls.length - 1]!.body).toMatchObject({
      mode: 'reference',
      reference_dir: 'C:\\sets\\reference',
      dry_run: true,
    });
    expect(document.querySelector('[data-testid="bench-cost-warning"]')).toBeNull();
    expect(document.querySelector('[data-testid="bench-free"]')?.textContent).toContain(
      'costs nothing',
    );
    expect(button('Start run').disabled).toBe(false);
  });
});

describe('Benchmarks run page', () => {
  it('shows each attempt with its criteria, hidden result, cost and orientation, and opens its diff', async () => {
    answers['/api/bench/runs/tally-2'] = {
      run: RUNS[0],
      attempts: [attempt],
      log: 'set tally: 4 attempts',
    };
    answers['/api/bench/runs/tally-2/attempt'] = 'diff --git a/x b/x\n+added line\n-removed line\n';
    await render('tally-2');
    expect(box.querySelector('[data-testid="bench-progress"]')?.textContent).toContain(
      '1 of 4 attempts done; now TB-08 #1',
    );
    const card = box.querySelector('[data-attempt="TB-02#1"]')!;
    expect(card.textContent).toContain('1/2 pass');
    expect(card.querySelector('[data-testid="bench-hidden"]')?.textContent).toBe('hidden 0/1');
    expect(card.textContent).toContain('$0.42');
    expect(card.textContent).toContain('orientation 3');
    const results = [...card.querySelectorAll('[data-criterion]')].map((r) => [
      r.getAttribute('data-criterion'),
      r.lastElementChild?.textContent,
    ]);
    expect(results).toEqual([
      ['tests', 'pass'],
      ['hidden', 'fail'],
      ['c3', 'pending'],
    ]);
    expect(card.querySelector('[data-criterion="hidden"]')?.textContent).toContain('hidden');
    // The entries table works from the attempts while the summary is not written yet.
    expect(box.querySelector('[data-entry="TB-02"]')?.textContent).toContain('50%');
    await click(button('Diff', card));
    await settle();
    expect(calls.some((c) => c.path.includes('/attempt?entry=TB-02&n=1&file=diff'))).toBe(true);
    expect(document.querySelector('[data-testid="bench-diff"]')?.textContent).toContain(
      '+added line',
    );
    expect(button('Stop', box)).toBeTruthy();
  });

  it('compares two runs per entry with deltas', async () => {
    const e = (passRate: number, costUsd: number) => ({
      entry: 'TB-02',
      attempts: 1,
      passRate,
      hiddenPass: { passed: passRate === 1 ? 1 : 0, attempts: 1 },
      pending: 0,
      costUsd,
      wallMs: 1000,
      toolCallsBeforeEdit: 2,
      timedOut: 0,
      errors: 0,
    });
    const cmp: BenchComparison = {
      a: { set: 'tally', agent: 'none', out: 'a' },
      b: { set: 'tally', agent: 'reference', out: 'b' },
      rows: [{ entry: 'TB-02', a: e(0.5, 1), b: e(1, 0.5) }],
      overall: {
        a: overall(0.5),
        b: overall(1),
        delta: {
          attempts: 0,
          passRate: 0.5,
          hiddenPassRate: 0.5,
          costUsd: 0,
          costPerAttempt: 0,
          wallMs: 0,
          toolCallsBeforeEdit: 0,
        },
      },
    };
    answers['/api/bench/compare'] = cmp;
    await render('compare:tally-0:tally-1');
    await settle();
    expect(calls.find((c) => c.path === '/api/bench/compare')?.body).toEqual({
      a: 'tally-0',
      b: 'tally-1',
    });
    const row = box.querySelector('[data-entry="TB-02"]')!;
    expect(row.textContent).toContain('50%→100%+50 pts');
    expect(row.textContent).toContain('0/1→1/1');
    expect(row.textContent).toContain('$1.00→$0.50-$0.50');
  });
});
