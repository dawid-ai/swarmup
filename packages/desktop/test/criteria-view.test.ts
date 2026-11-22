// @vitest-environment happy-dom
// Typed criteria and goal briefs in the app: the task panel's Done when (spec, last result,
// the builder, Run checks), the review form with a result per criterion and a forced approval,
// the thread's criteria, brief and resumed-run events, the Brief section, the New task builder,
// and the inbox's per-criterion review. A plan row with a typed `done_when` keeps it through
// edit mode.
import { act, createElement } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Nav } from '../ui/src/App';
import { doneWhenText, editRows, planOf } from '../ui/src/lib/plan';
import type {
  CriteriaCheckJob,
  InboxItem,
  OpsEvent,
  PlanRow,
  Task,
  TaskDetail,
} from '../ui/src/types';
import { closedHint } from '../ui/src/ui/brief';
import { draftOf, draftsProblem, entryOf, newDraft, verdictCriteria } from '../ui/src/ui/criteria';
import { Inbox } from '../ui/src/views/Inbox';
import { NewTask } from '../ui/src/views/NewTask';
import { TaskPanel } from '../ui/src/views/TaskPanel';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const answers = new Map<string, unknown>();
const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
/** POST answers by path; a string is an error swarmupd sends back. */
const replies = new Map<string, unknown>();
let root: Root | undefined;
let box: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  answers.clear();
  replies.clear();
  posts.length = 0;
  const off = (): (() => void) => () => {};
  window.swarmup = {
    call: (method: string, path: string, body?: Record<string, unknown>) => {
      if (method === 'GET') return Promise.resolve({ ok: true, data: answers.get(path) ?? [] });
      posts.push({ path, body: body ?? {} });
      const r = replies.get(path);
      if (typeof r === 'string') return Promise.resolve({ ok: false, error: r });
      return Promise.resolve({ ok: true, data: r ?? { events: [] } });
    },
    info: () => Promise.resolve({ me: 'human:dawid', pid: 1, roots: [] }),
    onService: off,
    onEvent: off,
    onStatus: off,
    onNavigate: off,
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

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount(el: ReactElement): Promise<void> {
  root = createRoot(box);
  await act(async () => root!.render(el));
  await settle();
  await settle();
}

const nav = (): Nav => ({ me: 'human:dawid', openTask: vi.fn(), go: vi.fn() });

function button(label: string, within: ParentNode = document.body): HTMLButtonElement {
  const b = [...within.querySelectorAll('button')].find((x) => x.textContent?.trim() === label);
  if (!b) throw new Error(`no button '${label}'`);
  return b;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
}

function type(el: HTMLTextAreaElement | HTMLInputElement, text: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const set = Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!;
  act(() => {
    set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function choose(el: HTMLSelectElement, value: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  act(() => {
    set.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const task: Task = {
  id: 'T-0001',
  root: 'r',
  title: 'Write the post',
  type: 'content',
  priority: 'p2',
  status: 'needs-review',
  owner: 'claude:writer',
  claimedBy: null,
  leaseUntil: null,
  reviewer: 'human:dawid',
  waitingOn: null,
  checkpoint: null,
  updatedAt: '2026-11-21T10:00:00Z',
};

const PATH = `/api/tasks/${encodeURIComponent('r/T-0001')}`;

function detail(over: Partial<TaskDetail> = {}): TaskDetail {
  return {
    task,
    body: 'A post about the price change.',
    events: [],
    criteria: [
      { id: 'c1', kind: 'prose', text: 'the intro names the price' },
      { id: 'words', kind: 'check', check: 'word-count', args: { path: 'post.md', max: 900 } },
      { id: 'tests', kind: 'command', run: 'npm test' },
      { id: 'voice', kind: 'rubric', rubric: 'rubrics/voice.md', pass: 0.8 },
      { id: 'angle', kind: 'human', ask: 'Is the change clear?' },
    ],
    criteriaResults: {
      c1: {
        result: 'fail',
        note: 'no price',
        event: 'E1',
        actor: 'human:dawid',
        at: '2026-11-21T09:00:00Z',
        type: 'verdict',
      },
      words: {
        result: 'pass',
        evidence: '812 words',
        event: 'E2',
        actor: 'opsd:merge',
        at: '2026-11-21T09:30:00Z',
        type: 'merge',
      },
      voice: {
        result: 'pass',
        score: 0.9,
        event: 'E1',
        actor: 'human:dawid',
        at: '2026-11-21T09:00:00Z',
        type: 'verdict',
      },
    },
    ...over,
  };
}

async function openPanel(d: TaskDetail): Promise<void> {
  answers.set(PATH, d);
  await mount(createElement(TaskPanel, { id: 'r/T-0001', nav: nav(), onClose: vi.fn() }));
}

const items = (): HTMLElement[] => [
  ...box.querySelectorAll<HTMLElement>('[data-criteria] [data-criterion]'),
];

describe('Done when in the task panel', () => {
  it('shows each criterion with its kind, spec and last result', async () => {
    await openPanel(detail());
    const rows = items();
    expect(rows.map((i) => i.getAttribute('data-criterion'))).toEqual([
      'c1',
      'words',
      'tests',
      'voice',
      'angle',
    ]);
    expect(rows.map((r) => r.querySelector('[data-kind]')!.textContent)).toEqual([
      'Prose',
      'Check',
      'Command',
      'Rubric',
      'Human',
    ]);
    expect(rows[0]!.textContent).toContain('the intro names the price');
    expect(rows[0]!.querySelector('[data-result]')!.getAttribute('data-result')).toBe('fail');
    expect(rows[0]!.textContent).toContain('no price');
    expect(rows[0]!.textContent).toContain('verdict');
    expect(rows[1]!.textContent).toContain('word-count');
    expect(rows[1]!.textContent).toContain('path post.md');
    expect(rows[1]!.textContent).toContain('max 900');
    expect(rows[1]!.querySelector('details')!.textContent).toContain('812 words');
    expect(rows[2]!.querySelector('code')!.textContent).toBe('npm test');
    expect(rows[2]!.textContent).toContain('no result yet');
    expect(rows[3]!.textContent).toContain('passes at 0.8');
    expect(rows[3]!.querySelector('[data-score]')!.textContent).toBe('score 0.9');
    expect(rows[4]!.textContent).toContain('Is the change clear?');
  });

  it('edits the criteria with the builder and saves a criteria event', async () => {
    await openPanel(
      detail({
        task: { ...task, status: 'in-progress', reviewer: null },
        criteria: [
          { id: 'c1', kind: 'prose', text: 'the intro names the price' },
          { id: 'tests', kind: 'command', run: 'npm test' },
        ],
        criteriaResults: {},
      }),
    );
    await click(button('Edit'));
    const form = box.querySelector('[data-criteria-form]')!;
    // The plain-text criterion stays plain text until it gets an id or another kind.
    expect(form.querySelector('[data-draft="0"] [data-plain]')).not.toBeNull();
    expect(form.querySelector('[data-draft="1"] [data-plain]')).toBeNull();
    // Convert it: a human question with its own id.
    const first = form.querySelector('[data-draft="0"]')!;
    choose(first.querySelector('select')!, 'human');
    const [id, ask] = [...first.querySelectorAll('input')];
    type(id!, 'angle');
    type(ask!, 'Is the price clear?');
    // Add a check, fill it, and move it to the top.
    await click(form.querySelector('[data-add-kind="check"]')!);
    const third = form.querySelector('[data-draft="2"]')!;
    const inputs = [...third.querySelectorAll('input')];
    type(inputs[1]!, 'post.md');
    await click(third.querySelector('[aria-label="Move up"]')!);
    await click(form.querySelector('[data-draft="1"] [aria-label="Move up"]')!);
    // Remove the command.
    await click(form.querySelector('[data-draft="2"] [aria-label="Remove criterion"]')!);
    await click(button('Save criteria'));
    expect(posts.at(-1)).toEqual({
      path: `${PATH}/criteria`,
      body: {
        as: 'human:dawid',
        done_when: [
          { kind: 'check', check: 'file-exists', args: { path: 'post.md' } },
          {
            id: 'angle',
            kind: 'human',
            text: 'the intro names the price',
            ask: 'Is the price clear?',
          },
        ],
      },
    });
  });

  it("shows swarmupd's refusal under the form", async () => {
    await openPanel(detail({ task: { ...task, status: 'in-progress', reviewer: null } }));
    replies.set(
      `${PATH}/criteria`,
      'only human:dawid (who filed T-0001), a person, the orchestrator or the PM changes its criteria (use --force to override)',
    );
    await click(button('Edit'));
    await click(button('Save criteria'));
    expect(box.querySelector('[data-criteria-form]')!.textContent).toContain(
      'the PM changes its criteria',
    );
  });

  it('runs the checks and shows the progress and results', async () => {
    const running: CriteriaCheckJob = {
      task: 'r/T-0001',
      by: 'human:dawid',
      cwd: 'C:/code',
      startedAt: '2026-11-21T10:00:00Z',
      ids: ['words', 'tests'],
      current: 'tests',
      results: { words: { result: 'fail', note: 'too long' } },
    };
    answers.set(`${PATH}/criteria-check`, { job: running });
    await openPanel(detail());
    const rows = items();
    expect(rows[1]!.querySelector('[data-result]')!.getAttribute('data-result')).toBe('fail');
    expect(rows[1]!.textContent).toContain('too long');
    expect(rows[2]!.textContent).toContain('running…');
    expect(box.querySelector('[data-check-progress]')!.textContent).toBe('1 of 2 done');
    expect(button('Running checks').disabled).toBe(true);
  });

  it('starts a check run with Run checks', async () => {
    await openPanel(detail());
    replies.set(`${PATH}/criteria-check`, {
      job: {
        task: 'r/T-0001',
        by: 'human:dawid',
        cwd: 'C:/code',
        startedAt: '2026-11-21T10:00:00Z',
        endedAt: '2026-11-21T10:00:05Z',
        ids: ['words', 'tests'],
        results: { words: { result: 'pass' }, tests: { result: 'pass' } },
        event: 'E9',
      },
    });
    await click(button('Run checks'));
    expect(posts.at(-1)).toEqual({ path: `${PATH}/criteria-check`, body: { as: 'human:dawid' } });
    expect(box.querySelector('[data-check-progress]')!.textContent).toContain('2 passed');
  });

  it('judges the rubric criteria with Judge and shows the score and reasons', async () => {
    await openPanel(detail());
    replies.set(`${PATH}/criteria-judge`, {
      job: {
        task: 'r/T-0001',
        by: 'human:dawid',
        cwd: 'C:/code',
        startedAt: '2026-11-21T10:00:00Z',
        endedAt: '2026-11-21T10:00:40Z',
        ids: ['voice'],
        results: {
          voice: {
            result: 'fail',
            score: 0.55,
            note: 'The intro buries the price.',
            evidence: 'voice: tone 2, clarity 2.4 (scale 0 to 4)',
          },
        },
        event: 'E10',
        costUsd: 0.0123,
      },
    });
    await click(button('Judge'));
    expect(posts.at(-1)).toEqual({ path: `${PATH}/criteria-judge`, body: { as: 'human:dawid' } });
    expect(box.querySelector('[data-judge-progress]')!.textContent).toContain(
      '1 of 1 below the pass mark · $0.0123',
    );
    const voice = items().find((li) => li.dataset.criterion === 'voice')!;
    const result = voice.querySelector('[data-criterion-result]')!;
    expect(result.querySelector('[data-score]')!.textContent).toBe('score 0.55');
    expect(result.textContent).toContain('The intro buries the price.');
    expect(result.textContent).toContain('Judge');
  });
});

describe('the review form with criteria', () => {
  it('asks before an approval with a failed criterion, then sends force', async () => {
    await openPanel(detail());
    const form = box.querySelector('[data-review-form]')!;
    expect(form).not.toBeNull();
    const c1 = form.querySelector('[data-review-criterion="c1"]')!;
    await click(c1.querySelector('[data-mark="fail"]')!);
    type(c1.querySelector('input')!, 'no price');
    const voice = form.querySelector('[data-review-criterion="voice"]')!;
    await click(voice.querySelector('[data-mark="pass"]')!);
    type([...voice.querySelectorAll('input')][1]!, '0.85');
    // The checks judge the command: it shows that, and stays unmarked.
    expect(form.querySelector('[data-review-criterion="tests"]')!.textContent).toContain(
      'the checks judge this one',
    );
    await click(button('Approve', form));
    expect(posts).toEqual([]);
    expect(form.querySelector('[role="alertdialog"]')!.textContent).toContain('c1 fail');
    await click(button('Approve anyway', form));
    expect(posts.at(-1)).toEqual({
      path: `${PATH}/verdict`,
      body: {
        as: 'human:dawid',
        verdict: 'approve',
        message: '',
        criteria: {
          c1: { result: 'fail', note: 'no price' },
          voice: { result: 'pass', score: 0.85 },
        },
        force: true,
      },
    });
  });

  it('requests changes with the results and a message', async () => {
    await openPanel(detail());
    const form = box.querySelector('[data-review-form]')!;
    await click(form.querySelector('[data-review-criterion="angle"] [data-mark="fail"]')!);
    expect(button('Request changes', form).disabled).toBe(true);
    type(form.querySelector('textarea')!, 'Name the price in the first line.');
    await click(button('Request changes', form));
    expect(posts.at(-1)).toEqual({
      path: `${PATH}/verdict`,
      body: {
        as: 'human:dawid',
        verdict: 'changes',
        message: 'Name the price in the first line.',
        criteria: { angle: { result: 'fail' } },
      },
    });
  });
});

describe('the thread', () => {
  const ev = (over: Partial<OpsEvent>): OpsEvent => ({
    id: `E${Math.random()}`,
    type: 'comment',
    actor: 'human:dawid',
    at: '2026-11-21T09:00:00Z',
    body: '',
    ...over,
  });

  it('shows per-criterion results, criteria changes, briefs and resumed runs', async () => {
    await openPanel(
      detail({
        events: [
          ev({
            id: 'E1',
            type: 'verdict',
            verdict: 'changes',
            body: 'Name the price.',
            criteria: { c1: { result: 'fail', note: 'no price' }, angle: { result: 'pass' } },
          }),
          ev({
            id: 'E2',
            type: 'criteria',
            done_when: [
              'the intro names the price',
              { id: 'tests', kind: 'command', run: 'npm test' },
            ],
          }),
          ev({ id: 'E3', type: 'brief', body: '## Outcome\n\nThe post ships.' }),
          ev({
            id: 'E4',
            type: 'run-start',
            actor: 'claude:writer',
            run: 'R1',
            session: 'sess-42',
            body: 'resumed session sess-42 of run R0',
          }),
          ev({ id: 'E5', type: 'run-start', actor: 'claude:writer', run: 'R2' }),
        ],
      }),
    );
    const verdict = box.querySelector('#ev-E1 [data-event-criteria]')!;
    expect(
      [...verdict.querySelectorAll('[data-event-criterion]')].map((r) => r.textContent),
    ).toEqual(['c1failno price', 'anglepass']);
    const change = box.querySelector('#ev-E2 [data-event-done-when]')!;
    expect(change.textContent).toContain('the intro names the price');
    expect(change.textContent).toContain('npm test');
    expect(box.querySelector('#ev-E2')!.textContent).toContain('changed the criteria');
    expect(box.querySelector('#ev-E3')!.textContent).toContain('wrote the brief');
    expect(box.querySelector('#ev-E3 .md')!.textContent).toContain('The post ships.');
    const badge = box.querySelector('#ev-E4 [data-resumed]')!;
    expect(badge.textContent!.trim()).toBe('Resumed');
    expect(badge.getAttribute('title')).toBe('Resumed session sess-42');
    expect(box.querySelector('#ev-E5 [data-resumed]')).toBeNull();
  });
});

describe('the Brief section', () => {
  const parent = (over: Partial<TaskDetail> = {}): TaskDetail => ({
    task: { ...task, type: 'task', status: 'in-progress', reviewer: null },
    body: 'Ship the site.',
    events: [],
    children: [
      { id: 'T-0002', title: 'Header', status: 'done', updatedAt: '2026-11-21T09:00:00Z' },
      { id: 'T-0003', title: 'Footer', status: 'todo', updatedAt: '2026-11-21T08:00:00Z' },
    ],
    ...over,
  });

  it('shows the brief with its author, the children and those closed since it', async () => {
    await openPanel(
      parent({
        brief: {
          event: 'E1',
          actor: 'claude:pm',
          at: '2026-11-20T09:00:00Z',
          body: '## Outcome\n\nThe site ships.',
        },
        closedSinceBrief: ['T-0002'],
      }),
    );
    const brief = box.querySelector('[data-brief]')!;
    expect(brief.querySelector('.md')!.textContent).toContain('The site ships.');
    expect(brief.textContent).toContain('claude:pm');
    expect(brief.querySelector('[data-brief-children]')!.textContent).toBe(
      '· 1 of 2 children done',
    );
    expect(brief.querySelector('[data-brief-stale]')!.textContent).toContain(
      '1 child closed since this brief: T-0002',
    );
  });

  it('writes a brief with Edit', async () => {
    await openPanel(parent());
    const brief = box.querySelector('[data-brief]')!;
    expect(brief.textContent).toContain('No brief yet');
    await click(button('Write a brief', brief));
    const area = brief.querySelector('textarea')!;
    expect(area.value).toContain('## Outcome');
    type(area, '## Outcome\n\nThe site ships on Friday.');
    await click(button('Save brief', brief));
    expect(posts.at(-1)).toEqual({
      path: `${PATH}/brief`,
      body: { as: 'human:dawid', message: '## Outcome\n\nThe site ships on Friday.' },
    });
  });

  it('stays out of a task without children or a brief', async () => {
    await openPanel(detail());
    expect(box.querySelector('[data-brief]')).toBeNull();
  });
});

describe('the Scores section', () => {
  it("lists the task's scores with pass or fail and the lever on hover", async () => {
    answers.set(`/api/scores?task=${encodeURIComponent('r/T-0001')}`, {
      agents: [],
      results: [
        {
          scorer: 'review-rounds',
          level: 'task',
          subject: 'r/T-0001',
          agent: 'claude:writer',
          value: 2,
          unit: 'count',
          pass: false,
          n: 1,
          evidence: [],
          at: '2026-11-21T10:00:00Z',
        },
        {
          scorer: 'orientation',
          level: 'run',
          subject: 'R1',
          agent: 'claude:writer',
          value: 7,
          unit: 'calls',
          n: 1,
          evidence: [],
          at: '2026-11-21T10:00:00Z',
        },
      ],
      scorers: [
        {
          id: 'review-rounds',
          description: 'changes verdicts before approval',
          level: 'task',
          unit: 'count',
          better: 'lower',
          pass: 1,
          lever: 'the role prompt or the criteria',
        },
      ],
    });
    await openPanel(detail());
    const rows = [...box.querySelectorAll<HTMLElement>('[data-task-scores] [data-score-row]')];
    expect(rows.map((r) => r.textContent)).toEqual(['Review rounds2fail', 'Calls to editrun R17']);
    expect(rows[0]!.title).toBe(
      'Changes verdicts before approval. Passes at <= 1. When it fails, change the role prompt or the criteria.',
    );
  });

  it('stays out without scores', async () => {
    await openPanel(detail());
    expect(box.querySelector('[data-task-scores]')).toBeNull();
  });
});

describe('the New task criteria', () => {
  it('sends typed and plain criteria as done_when', async () => {
    replies.set('/api/tasks', { id: 'T-0009', root: 'r' });
    await mount(
      createElement(NewTask, {
        me: 'human:dawid',
        onClose: vi.fn(),
        onCreated: vi.fn(),
        roots: [{ name: 'r' } as never],
      }),
    );
    const modal = document.body.querySelector('[data-new-criteria]')!;
    type(document.body.querySelector<HTMLInputElement>('input[autofocus], input')!, 'Fix login');
    await click(modal.querySelector('[data-add-kind="prose"]')!);
    await click(modal.querySelector('[data-add-kind="command"]')!);
    const rows = [...modal.querySelectorAll('[data-draft]')];
    type([...rows[0]!.querySelectorAll('input')][1]!, 'login works on Safari');
    // A command without its command line blocks Create.
    expect(button('Create task').disabled).toBe(true);
    type([...rows[1]!.querySelectorAll('input')][1]!, 'pnpm test -- login');
    expect(button('Create task').disabled).toBe(false);
    await click(button('Create task'));
    expect(posts[0]!.body).toMatchObject({
      title: 'Fix login',
      done_when: ['login works on Safari', { kind: 'command', run: 'pnpm test -- login' }],
    });
  });
});

describe('the inbox review with criteria', () => {
  it('reads the criteria when opened and sends the results with the verdict', async () => {
    const review: InboxItem = {
      kind: 'review',
      task: 'r/T-0001',
      root: 'r',
      title: 'Write the post',
      from: 'claude:writer',
      summary: 'draft in post.md',
    };
    answers.set(PATH, detail());
    await mount(createElement(Inbox, { nav: nav(), items: [review], error: null }));
    await click(button('Criteria'));
    await settle();
    const angle = box.querySelector('[data-review-criterion="angle"]')!;
    await click(angle.querySelector('[data-mark="pass"]')!);
    await click(button('Approve'));
    expect(posts.at(-1)).toMatchObject({
      path: `${PATH}/verdict`,
      body: { verdict: 'approve', criteria: { angle: { result: 'pass' } } },
    });
  });
});

describe('the criteria builder logic', () => {
  it('keeps plain text plain and typed criteria typed through a round trip', () => {
    const list = [
      'npm test passes',
      {
        id: 'links',
        kind: 'check' as const,
        check: 'links-resolve',
        args: { path: 'a.md', extra: 1 },
      },
      { id: 'c3', kind: 'prose' as const, text: 'reads well' },
    ];
    expect(list.map(draftOf).map(entryOf)).toEqual([
      'npm test passes',
      { id: 'links', kind: 'check', check: 'links-resolve', args: { extra: 1, path: 'a.md' } },
      'reads well',
    ]);
  });

  it('reports what keeps a list from saving', () => {
    const cmd = { ...newDraft('command'), run: 'x' };
    expect(draftsProblem([cmd])).toBeNull();
    expect(draftsProblem([newDraft('command')])).toBe('Criterion 1: Write the command');
    expect(
      draftsProblem([
        { ...cmd, id: 'a' },
        { ...cmd, id: 'a' },
      ]),
    ).toBe('Two criteria have the id a');
    expect(
      draftsProblem([{ ...newDraft('check'), check: 'word-count', args: { path: 'a' } }]),
    ).toBe('Criterion 1: Set Min or Max');
  });

  it('sends only marked criteria in a verdict', () => {
    expect(verdictCriteria({ a: { note: 'x', score: '' } })).toBeUndefined();
    expect(verdictCriteria({ a: { result: 'na', note: ' ', score: '' } })).toEqual({
      a: { result: 'na' },
    });
  });

  it('says how many children closed since the brief', () => {
    expect(closedHint([], true)).toBeNull();
    expect(closedHint(['A', 'B'], false)).toBe(
      '2 children closed and there is no brief yet: A, B.',
    );
  });
});

describe('a typed done_when in a plan row', () => {
  it('shows it in one line and keeps it through edit mode', () => {
    const typed = { id: 'tests', kind: 'command' as const, run: 'npm test' };
    expect(doneWhenText(typed)).toBe('command: npm test');
    expect(doneWhenText('it works')).toBe('it works');
    const rows: PlanRow[] = [
      { key: 'a', title: 'A', owner: '*:engineer', after: [], estimate: '1h', done_when: typed },
    ];
    const edit = editRows(rows);
    expect(edit[0]!.done_when).toBe('');
    expect(planOf(edit).items[0]!.done_when).toEqual(typed);
  });
});
