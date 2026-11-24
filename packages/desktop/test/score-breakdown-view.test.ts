// @vitest-environment happy-dom
// Score breakdowns (W4): every score number opens a breakdown of its scorer for that agent or
// task, worst first, with each subject's value, pass or fail, note, criteria, runs and linked
// evidence; "How scores work" explains each scorer. From the agent card, Reports and a task.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Nav } from '../ui/src/App';
import type { AgentScores, Report, ScoreBreakdown } from '../ui/src/types';
import { breakdownPath, evidenceRef } from '../ui/src/ui/score-breakdown';
import { TaskScoresSection } from '../ui/src/ui/task-scores';
import { Agents } from '../ui/src/views/Agents';
import { Reports } from '../ui/src/views/Reports';

/** A fake swarmupd: each path answers from the first entry of `net.data` it starts with. */
const net = vi.hoisted(() => ({
  data: [] as Array<[string, unknown]>,
  asked: [] as string[],
}));

const answer = (path: string): unknown => net.data.find(([p]) => path.startsWith(p))?.[1];

vi.mock(import('../ui/src/api'), async (original) => ({
  ...(await original()),
  useData: <T>(path: string | null) => {
    if (path !== null) net.asked.push(path);
    return {
      data: (path === null ? undefined : answer(path)) as T | undefined,
      error: null,
      reload: () => {},
      set: () => {},
    };
  },
  api: async <T>(_method: string, path: string): Promise<T> => {
    net.asked.push(path);
    return (answer(path) ?? {}) as T;
  },
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let box: HTMLDivElement;
let nav: Nav;

const ENG = 'claude:engineer';
const RUN = '01JRXN0000000000000000000C';

const scores: AgentScores[] = [
  {
    agent: ENG,
    scorers: [
      {
        scorer: 'criteria-pass-rate',
        level: 'task',
        unit: 'ratio',
        better: 'higher',
        pass: 1,
        description: "share of the task's criteria marked pass on the approving verdict",
        lever: "the task's done_when criteria and the reviewer role file",
        n: 2,
        mean: 0.75,
        passed: 1,
        judged: 2,
        worst: [{ subject: 'site/T-0002', value: 0.5, evidence: [] }],
      },
    ],
  },
];

const breakdown: ScoreBreakdown = {
  scorer: {
    id: 'criteria-pass-rate',
    description: "share of the task's criteria marked pass on the approving verdict",
    level: 'task',
    unit: 'ratio',
    better: 'higher',
    pass: 1,
    lever: "the task's done_when criteria and the reviewer role file",
  },
  agent: ENG,
  mean: 0.75,
  passed: 1,
  judged: 2,
  rows: [
    {
      scorer: 'criteria-pass-rate',
      level: 'task',
      subject: 'site/T-0002',
      title: 'Parser',
      agent: ENG,
      value: 0.5,
      unit: 'ratio',
      pass: false,
      n: 2,
      evidence: ['E0009'],
      at: '2026-11-20T10:00:00.000Z',
      note: 'failed: c2',
      criteria: [
        { id: 'c1', kind: 'prose', text: 'Parses empty input', result: 'pass' },
        { id: 'c2', kind: 'prose', text: 'Docs mention it', result: 'fail', note: 'no docs' },
      ],
    },
    {
      scorer: 'criteria-pass-rate',
      level: 'task',
      subject: 'site/T-0001',
      title: 'Lexer',
      agent: ENG,
      value: 1,
      unit: 'ratio',
      pass: true,
      n: 1,
      evidence: ['E0003'],
      at: '2026-11-19T10:00:00.000Z',
    },
  ],
};

const cost: ScoreBreakdown = {
  scorer: { ...breakdown.scorer, id: 'cost-per-merged-task', unit: 'tokens', better: 'lower' },
  mean: 1000,
  passed: 0,
  judged: 0,
  rows: [
    {
      ...breakdown.rows[1]!,
      scorer: 'cost-per-merged-task',
      unit: 'tokens',
      value: 1000,
      pass: undefined,
      evidence: [RUN],
      runs: [{ id: RUN, agent: ENG, tokens: 1000, started_at: '2026-11-19T09:00:00.000Z' }],
    },
  ],
};

const rubric: ScoreBreakdown = {
  scorer: { ...breakdown.scorer, id: 'copy-quality', pass: 0.7 },
  mean: 0.4,
  passed: 0,
  judged: 1,
  rows: [
    {
      ...breakdown.rows[1]!,
      scorer: 'copy-quality',
      value: 0.4,
      pass: false,
      note: 'The voice drifts.',
      extra: { clarity: 2, voice: 1 },
      rubric: { id: 'copy', pass: 0.7 },
    },
  ],
};

const report: Report = {
  from: '2026-11-14T00:00:00.000Z',
  to: '2026-11-21T00:00:00.000Z',
  projects: [],
  agents: [],
  providers: [],
  decisions: [],
  channels: [],
  scores,
  totals: { opened: 0, closed: 0, runs: 0, minutes: 0, tokens: 0 },
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  net.asked = [];
  nav = { me: null, openTask: vi.fn(), go: vi.fn() } as unknown as Nav;
  box = document.createElement('div');
  document.body.append(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
  document.body.innerHTML = '';
});

function mount(el: ReturnType<typeof createElement>): void {
  root = createRoot(box);
  act(() => root!.render(el));
}

async function click(el: Element | null | undefined): Promise<void> {
  expect(el).toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const button = (text: string, within: ParentNode = document.body): HTMLButtonElement | undefined =>
  [...within.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

const inBody = (sel: string): Element => {
  const el = document.body.querySelector(sel);
  if (!el) throw new Error(`no ${sel}`);
  return el;
};

describe('Score breakdown', () => {
  it('opens from an agent card value, worst first, with each criterion and linked evidence', async () => {
    net.data = [
      ['/api/agents', [{ id: ENG, status: 'active', wake: false, live: null }]],
      ['/api/runs?live', []],
      ['/api/tasks', []],
      ['/api/machines', []],
      ['/api/waits', { providers: {}, waits: [] }],
      ['/api/directory', []],
      ['/api/settings', { opsd: { agents: {}, runtimes: {} } }],
      ['/api/scores/history', { since: '', until: '', bucket: 'day', series: [] }],
      ['/api/scores?detail=1', { detail: breakdown }],
      ['/api/scores', { agents: scores, scorers: [breakdown.scorer] }],
    ];
    mount(createElement(Agents, { nav }));
    await click(box.querySelector('[data-score-value="criteria-pass-rate"]'));
    expect(net.asked).toContain(
      `/api/scores?detail=1&scorer=criteria-pass-rate&agent=${encodeURIComponent(ENG)}`,
    );
    const dialog = inBody('[data-score-breakdown="criteria-pass-rate"]');
    expect(dialog.textContent).toContain("When it fails, change the task's done_when criteria");
    expect(dialog.textContent).toContain('Passes at >= 100%');
    expect(dialog.textContent).toContain('Pass 1 of 2');
    const rows = [...dialog.querySelectorAll('[data-breakdown-row]')];
    expect(rows.map((r) => r.getAttribute('data-breakdown-row'))).toEqual([
      'site/T-0002',
      'site/T-0001',
    ]);
    expect(rows[0]!.textContent).toContain('Parser');
    expect(rows[0]!.textContent).toContain('failed: c2');
    expect(rows[0]!.querySelector('[data-criterion="c2"]')!.textContent).toContain('no docs');
    // A task score's event evidence opens the task at that event and closes the breakdown.
    await click(button('event …E0009', rows[0]!));
    expect(nav.openTask).toHaveBeenCalledWith('site/T-0002#E0009');
    expect(document.body.querySelector('[data-score-breakdown]')).toBeNull();
  });

  it("opens from a report cell for the report's window, and lists a token score's runs", async () => {
    net.data = [
      ['/api/scores/history', { since: '', until: '', bucket: 'day', series: [] }],
      ['/api/report', report],
      ['/api/scores?detail=1', { detail: cost }],
    ];
    mount(createElement(Reports, { nav }));
    await click(box.querySelector(`[data-score-cell="${ENG}/criteria-pass-rate"]`));
    expect(net.asked).toContain(
      `/api/scores?detail=1&scorer=criteria-pass-rate&agent=${encodeURIComponent(ENG)}&since=${encodeURIComponent(report.from)}`,
    );
    const runs = inBody('[data-testid="breakdown-runs"]');
    expect(runs.textContent).toContain('1k');
    await click(button('…00000C', runs));
    expect(nav.go).toHaveBeenCalledWith('runs', RUN);
  });

  it("opens from a task's score with the task, and shows a judge's scores and reasons", async () => {
    net.data = [
      ['/api/scores?detail=1', { detail: rubric }],
      [
        '/api/scores?task=',
        { agents: [], scorers: [], results: [{ ...rubric.rows[0]!, subject: 'site/T-0001' }] },
      ],
    ];
    mount(createElement(TaskScoresSection, { task: 'site/T-0001', nav }));
    await click(box.querySelector('[data-task-score-value="copy-quality"]'));
    expect(net.asked).toContain(
      `/api/scores?detail=1&scorer=copy-quality&agent=${encodeURIComponent(ENG)}&task=site%2FT-0001`,
    );
    const judge = inBody('[data-testid="breakdown-judge"]');
    expect(judge.textContent).toContain('rubrics/copy.md');
    expect(judge.textContent).toContain('clarity 2');
    expect(inBody('[data-score-breakdown]').textContent).toContain('The voice drifts.');
  });

  it('explains how scores work, scorer by scorer', async () => {
    net.data = [
      ['/api/scores/history', { since: '', until: '', bucket: 'day', series: [] }],
      ['/api/report', report],
      ['/api/scores', { agents: scores, scorers: [breakdown.scorer] }],
    ];
    mount(createElement(Reports, { nav }));
    await click(button('How scores work', box.querySelector('[data-testid="report-scores"]')!));
    const help = inBody('[data-scores-help]');
    expect(help.textContent).toContain('task events');
    const item = help.querySelector('[data-scorer="criteria-pass-rate"]')!;
    expect(item.textContent).toContain('Passes at >= 100%');
    expect(item.textContent).toContain("When it fails, change the task's done_when criteria");
  });

  it('links evidence by what the scorer reads', () => {
    const task = { scorer: 'review-rounds', level: 'task' as const, subject: 'site/T-1' };
    expect(evidenceRef(task, 'E1')).toEqual({ kind: 'task', ref: 'site/T-1#E1' });
    expect(evidenceRef({ ...task, scorer: 'cost-per-merged-task' }, RUN)).toEqual({
      kind: 'run',
      ref: RUN,
    });
    expect(
      evidenceRef({ ...task, level: 'agent', scorer: 'recommendation-acceptance' }, 'T-1#E2'),
    ).toEqual({ kind: 'task', ref: 'T-1#E2' });
    expect(breakdownPath({ scorer: 'orientation', task: 'site/T-1', agent: ENG })).toBe(
      `/api/scores?detail=1&scorer=orientation&agent=${encodeURIComponent(ENG)}&task=site%2FT-1`,
    );
  });
});
