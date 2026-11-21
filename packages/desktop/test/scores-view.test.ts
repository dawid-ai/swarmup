// @vitest-environment happy-dom
// Scores in the desktop app (W4), with run stamps (W5) and resume (W3): an agent card lists each
// scorer with its trend, pass or fail and what to change; Reports adds trends and the worst tasks;
// the Runs view shows a run's model, effort, definition stamp, resume and orientation.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Nav } from '../ui/src/App';
import type { AgentScores, Report, RunPage, RunRecord, ScoreHistory } from '../ui/src/types';
import { subjectTarget } from '../ui/src/ui/score';
import { Agents } from '../ui/src/views/Agents';
import { Reports } from '../ui/src/views/Reports';
import { defsTitle, Runs, shortDefs } from '../ui/src/views/Runs';

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
    return (path.includes('/log') ? '' : (answer(path) ?? {})) as T;
  },
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let box: HTMLDivElement;
let nav: Nav;

const ENG = 'claude:engineer';

const scores: AgentScores[] = [
  {
    agent: ENG,
    scorers: [
      {
        scorer: 'review-rounds',
        level: 'task',
        unit: 'rounds',
        better: 'lower',
        pass: 1,
        description: "reviewers' changes verdicts before the approval",
        lever: "the author's role file, the task's done_when and the review prompt",
        n: 3,
        mean: 1.33,
        passed: 2,
        judged: 3,
        worst: [{ subject: 'site/T-0002', value: 3, evidence: [] }],
      },
      {
        scorer: 'stuck-runs',
        level: 'agent',
        unit: 'ratio',
        better: 'lower',
        pass: 0.1,
        description: "share of an agent's ended runs that failed",
        lever: "the role file's budget",
        n: 10,
        mean: 0,
        passed: 1,
        judged: 1,
        worst: [{ subject: ENG, value: 0, evidence: [] }],
      },
    ],
  },
];

const history: ScoreHistory = {
  since: '2026-10-23T00:00:00.000Z',
  until: '2026-11-21T12:00:00.000Z',
  bucket: 'day',
  series: [
    {
      agent: ENG,
      scorer: 'review-rounds',
      level: 'task',
      unit: 'rounds',
      better: 'lower',
      pass: 1,
      points: [
        { at: '2026-11-19T00:00:00.000Z', value: 2, n: 1 },
        { at: '2026-11-20T00:00:00.000Z', value: 1, n: 2 },
      ],
    },
  ],
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

const button = (text: string, within: ParentNode = box): HTMLButtonElement | undefined =>
  [...within.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

describe('Agents view: scores on the agent card', () => {
  beforeEach(() => {
    net.data = [
      ['/api/agents', [{ id: ENG, status: 'active', wake: false, live: null }]],
      ['/api/runs?live', []],
      ['/api/tasks', []],
      ['/api/machines', []],
      ['/api/waits', { providers: {}, waits: [] }],
      ['/api/directory', []],
      ['/api/settings', { opsd: { agents: {}, runtimes: {} } }],
      ['/api/scores/history', history],
      ['/api/scores', { agents: scores, scorers: [] }],
    ];
  });

  it('lists each scorer with its value, count, pass or fail and trend', () => {
    mount(createElement(Agents, { nav }));
    const block = box.querySelector('[data-testid="agent-scores"]')!;
    expect(block.textContent).toContain('1 failing');
    const rounds = block.querySelector('[data-testid="agent-score-review-rounds"]')!;
    expect(rounds.textContent).toContain('Review rounds');
    expect(rounds.textContent).toContain('1.33');
    expect(rounds.textContent).toContain('3 tasks, 67% pass');
    expect(rounds.textContent).toContain('fail');
    expect(rounds.querySelector('[data-testid="sparkline"]')).not.toBeNull();
    // The hover hint explains the scorer and what to change.
    expect(rounds.querySelector('button')!.title).toMatch(/Passes at <= 1\. When it fails, change/);
    const stuck = block.querySelector('[data-testid="agent-score-stuck-runs"]')!;
    expect(stuck.textContent).toContain('0%');
    expect(stuck.textContent).toContain('of 10 runs');
    expect(stuck.textContent).toContain('pass');
    // The trend asks for the last 30 local days.
    expect(net.asked.some((p) => /^\/api\/scores\/history\?since=.*&tz=-?\d+$/.test(p))).toBe(true);
  });

  it('gives an agent with scores but no role file or config a card', () => {
    net.data[0] = ['/api/agents', []];
    mount(createElement(Agents, { nav }));
    expect(box.querySelector('[data-testid="agent-scores"]')).not.toBeNull();
  });

  it('opens a failing scorer with its lever and links its worst task to the task panel', async () => {
    mount(createElement(Agents, { nav }));
    const rounds = box.querySelector('[data-testid="agent-score-review-rounds"]')!;
    expect(rounds.textContent).toContain("Change the author's role file");
    await click(button('T-00023', rounds));
    expect(nav.openTask).toHaveBeenCalledWith('site/T-0002');
    // A passing scorer stays closed until clicked.
    const stuck = box.querySelector('[data-testid="agent-score-stuck-runs"]')!;
    expect(stuck.textContent).not.toContain('Change');
    await click(stuck.querySelector('button'));
    expect(stuck.textContent).toContain("Change the role file's budget");
  });
});

describe('Reports: scores with trends and the worst tasks', () => {
  const report: Report = {
    from: '2026-11-14T00:00:00.000Z',
    to: '2026-11-21T00:00:00.000Z',
    projects: [{ project: 'site', opened: 1, closed: 1, parked: 0, open: 1, blocked: 0 }],
    agents: [],
    providers: [],
    decisions: [],
    channels: [],
    scores,
    totals: { opened: 1, closed: 1, runs: 0, minutes: 0, tokens: 0 },
  };

  beforeEach(() => {
    net.data = [
      ['/api/scores/history', history],
      ['/api/report', report],
    ];
  });

  it("asks for trends over the report's window and draws them per agent", () => {
    mount(createElement(Reports, { nav }));
    const table = box.querySelector('[data-testid="report-scores"]')!;
    expect(net.asked).toContain(
      `/api/scores/history?since=${encodeURIComponent(report.from)}&until=${encodeURIComponent(report.to)}&tz=${new Date().getTimezoneOffset()}`,
    );
    expect(table.querySelectorAll('[data-testid="sparkline"]')).toHaveLength(1);
    const header = [...table.querySelectorAll('th')].find(
      (th) => th.textContent === 'Review rounds',
    )!;
    expect(header.title).toMatch(
      /^Reviewers' changes verdicts before the approval\. Passes at <= 1\./,
    );
  });

  it('lists the worst tasks per scorer, each a link to its task', async () => {
    mount(createElement(Reports, { nav }));
    const worst = box.querySelector('[data-testid="report-worst"]')!;
    expect(worst.textContent).toContain('Review rounds');
    await click(button('T-00023', worst));
    expect(nav.openTask).toHaveBeenCalledWith('site/T-0002');
  });
});

describe('Runs view: run stamps, resume and orientation', () => {
  const run = (patch: Partial<RunRecord> = {}): RunRecord =>
    ({
      id: '01JRXN0000000000000000000B',
      agent: ENG,
      pid: 7,
      cwd: '.',
      started_at: new Date(Date.now() - 60_000).toISOString(),
      ended_at: new Date().toISOString(),
      status: 'ended',
      reason: 'exit',
      exit: 0,
      budget_minutes: 60,
      tokens: 1200,
      task: 'T-0002',
      root: 'site',
      ...patch,
    }) as RunRecord;
  const stamped = run({
    model: 'opus',
    effort: 'high',
    defs: {
      root: 'site',
      hash: 'd:0123456789abcdef0123456789abcdef',
      commit: 'abc1234',
      local: ['runtimes.claude.model'],
    },
    resumed: 'S-1',
    resumed_from: '01JRXN0000000000000000000A',
  });
  const page = (runs: RunRecord[]): RunPage => ({
    runs,
    more: false,
    counts: { all: runs.length, live: 0, ended: runs.length, errors: 0 },
    today: { runs: runs.length, tokens: 0, errors: 0 },
    total: runs.length,
    live: 0,
    pick: null,
    models: ['opus', 'sonnet'],
    orientation: { [stamped.id]: { calls: 42, share: 0.61, edited: true, pass: false } },
  });

  beforeEach(() => {
    net.data = [['/api/runs?', page([stamped])]];
  });

  it("shows the picked run's model, effort, definition stamp, resume and orientation", async () => {
    mount(createElement(Runs, { nav, selected: stamped.id }));
    const text = box.textContent ?? '';
    expect(text).toContain('opus · high');
    expect(text).toContain('d:0123456789ab');
    expect(text).toContain('+1 local');
    expect(text).toContain('42 calls to edit');
    expect(text).toContain('61% read');
    const resumed = box.querySelector('[data-testid="run-resumed"]')!;
    expect(resumed.getAttribute('title')).toContain('S-1');
    await click(button('00000A', resumed));
    expect(nav.go).toHaveBeenCalledWith('runs', '01JRXN0000000000000000000A');
  });

  it('asks for resumed runs or one model when you narrow the list', async () => {
    mount(createElement(Runs, { nav }));
    await click(button('Resumed'));
    expect(net.asked.at(-1)).toContain('&resumed=1');
    const select = box.querySelector<HTMLSelectElement>('select[aria-label="Model"]')!;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'opus', 'sonnet']);
    await act(async () => {
      select.value = 'sonnet';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(net.asked.at(-1)).toContain('&model=sonnet');
  });

  it('shortens the definition hash and names commit, dirty and local overrides on hover', () => {
    expect(shortDefs('d:0123456789abcdef')).toBe('d:0123456789ab');
    expect(defsTitle(stamped.defs!)).toBe(
      'Definitions of site: d:0123456789abcdef0123456789abcdef\n' +
        'Last definition commit: abc1234\n' +
        'Overridden on this machine: runtimes.claude.model',
    );
    expect(defsTitle({ root: 'site', hash: 'd:1', dirty: true, commit: 'x' })).toContain(
      'uncommitted changes',
    );
  });

  it('links run ids to the Runs view and anything else to the task panel', () => {
    expect(subjectTarget('01JRXN0000000000000000000A')).toEqual({
      kind: 'run',
      ref: '01JRXN0000000000000000000A',
    });
    expect(subjectTarget('site/T-0002')).toEqual({ kind: 'task', ref: 'site/T-0002' });
    expect(subjectTarget('T-0002#E0004')).toEqual({ kind: 'task', ref: 'T-0002#E0004' });
  });
});
