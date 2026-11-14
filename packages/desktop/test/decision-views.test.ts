// @vitest-environment happy-dom
// AO-0315, rendered: the Decision toggle on the answer, verdict, comment and triage forms sends
// `decision` and `scope` and refuses a line over 200 characters; the Decisions view lists the
// log, filters with Include superseded and records a replacement with Supersede; Accept change on
// an ask that names a contradiction fills in `supersedes`, or `narrows` for the task tree.
import { act, createElement } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Nav } from '../ui/src/App';
import type { InboxItem, LogEntry, Task, TaskDetail } from '../ui/src/types';
import { TriageActions } from '../ui/src/ui/triage';
import { Decisions } from '../ui/src/views/Decisions';
import { Inbox } from '../ui/src/views/Inbox';
import { TaskPanel } from '../ui/src/views/TaskPanel';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** GET answers by full path, query included. */
const answers = new Map<string, unknown>();
const gets: string[] = [];
const posts: Array<{ path: string; body: Record<string, unknown> }> = [];

let root: Root | undefined;
let box: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  answers.clear();
  gets.length = 0;
  posts.length = 0;
  const off = (): (() => void) => () => {};
  window.swarmup = {
    call: (method: string, path: string, body?: Record<string, unknown>) => {
      if (method !== 'GET') {
        posts.push({ path, body: body ?? {} });
        return Promise.resolve({ ok: true, data: { id: 'D-0009', events: [] } });
      }
      gets.push(path);
      return Promise.resolve({ ok: true, data: answers.get(path) ?? [] });
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
}

const nav = (me: string | null = 'human:dawid'): Nav => ({ me, openTask: vi.fn(), go: vi.fn() });

function button(label: string): HTMLButtonElement {
  const b = [...document.body.querySelectorAll('button')].find(
    (x) => x.textContent?.trim() === label,
  );
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

/** The Decision switch, its one-line field and a checkbox by its label. */
const toggle = (): HTMLButtonElement => button('Decision');
const line = (): HTMLInputElement =>
  box.querySelector<HTMLInputElement>('[data-decision-mark] input[type="text"]')!;
function checkbox(label: string): HTMLInputElement {
  const l = [...box.querySelectorAll('label')].find((x) => x.textContent?.trim() === label);
  if (!l) throw new Error(`no checkbox '${label}'`);
  return l.querySelector('input')!;
}

const ask: InboxItem = {
  kind: 'ask',
  task: 'r/AO-0110',
  root: 'r',
  title: 'Merge approved branches automatically',
  from: 'claude:engineer',
  summary: 'Which region, EU or US?',
};

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  root: 'r',
  id: 'D-0007',
  kind: 'record',
  text: 'swarmupd never merges; Dawid merges',
  scope: 'project',
  project: 'v2',
  source: 'AO-0107#01M6GN0000000000000000000A',
  by: 'human:dawid',
  at: '2026-10-12T05:00:00Z',
  supersedes: [],
  narrows: [],
  state: 'recorded',
  replaced: [],
  ...over,
});

describe('the Decision toggle on the answer form', () => {
  it('sends no decision fields while it is off', async () => {
    await mount(createElement(Inbox, { nav: nav(), items: [ask], error: null }));
    type(box.querySelector('textarea')!, 'EU. It is cheaper.');
    await click(button('Answer'));
    expect(posts).toEqual([
      {
        path: '/api/tasks/r%2FAO-0110/answer',
        body: { as: 'human:dawid', message: 'EU. It is cheaper.' },
      },
    ]);
  });

  it('prefills the line from the first sentence and sends decision and scope', async () => {
    await mount(createElement(Inbox, { nav: nav(), items: [ask], error: null }));
    type(box.querySelector('textarea')!, 'The database lives in the EU. It is cheaper.');
    await click(toggle());
    expect(line().value).toBe('The database lives in the EU');
    expect(box.querySelector('[data-decision-count]')!.textContent).toBe('28/200');
    await click(button('Answer'));
    expect(posts[0]).toEqual({
      path: '/api/tasks/r%2FAO-0110/answer',
      body: {
        as: 'human:dawid',
        message: 'The database lives in the EU. It is cheaper.',
        decision: 'The database lives in the EU',
        scope: 'tree',
      },
    });
  });

  it('sends the project scope with Project-wide and an edited line', async () => {
    await mount(createElement(Inbox, { nav: nav(), items: [ask], error: null }));
    type(box.querySelector('textarea')!, 'EU.');
    await click(toggle());
    type(line(), 'Databases live in the EU');
    await click(checkbox('Project-wide'));
    // The edited line stays when the message changes.
    type(box.querySelector('textarea')!, 'EU, as before.');
    await click(button('Answer'));
    expect(posts[0]!.body).toMatchObject({
      message: 'EU, as before.',
      decision: 'Databases live in the EU',
      scope: 'project',
    });
  });

  it('refuses a line over 200 characters and says so', async () => {
    await mount(createElement(Inbox, { nav: nav(), items: [ask], error: null }));
    type(box.querySelector('textarea')!, 'EU.');
    await click(toggle());
    type(line(), 'x'.repeat(201));
    expect(box.querySelector('[data-decision-count]')!.textContent).toBe('201/200');
    expect(box.querySelector('[data-decision-error]')!.textContent).toBe(
      'A decision is one line of 200 characters at most; this one has 201',
    );
    expect(button('Answer').disabled).toBe(true);
    await click(button('Answer'));
    expect(posts).toEqual([]);
    type(line(), 'x'.repeat(200));
    expect(button('Answer').disabled).toBe(false);
  });

  it('shows no toggle to an agent: only a person decides', async () => {
    await mount(createElement(Inbox, { nav: nav('claude:pm'), items: [ask], error: null }));
    expect(box.querySelector('[data-decision-mark]')).toBeNull();
  });
});

describe('the Decision toggle on the verdict form', () => {
  const review: InboxItem = {
    kind: 'review',
    task: 'r/AO-0111',
    root: 'r',
    title: 'Tray icon',
    from: 'claude:engineer',
    summary: 'abc1234 on branch tray',
  };

  it('marks an approval and a request for changes', async () => {
    await mount(createElement(Inbox, { nav: nav(), items: [review], error: null }));
    type(box.querySelector('textarea')!, 'Icons stay monochrome. Good work.');
    await click(toggle());
    await click(button('Approve'));
    expect(posts[0]).toEqual({
      path: '/api/tasks/r%2FAO-0111/verdict',
      body: {
        as: 'human:dawid',
        verdict: 'approve',
        message: 'Icons stay monochrome. Good work.',
        decision: 'Icons stay monochrome',
        scope: 'tree',
      },
    });
  });
});

describe('the Decision toggle on the comment form', () => {
  const task: Task = {
    id: 'AO-0200',
    root: 'r',
    title: 'Dark mode for the board',
    type: 'task',
    priority: 'p2',
    status: 'todo',
    owner: null,
    claimedBy: null,
    leaseUntil: null,
    reviewer: null,
    waitingOn: null,
    checkpoint: null,
    updatedAt: '2026-11-05T10:00:00Z',
  };

  it('marks a comment, and shows the mark on the event', async () => {
    const detail: TaskDetail = {
      task,
      body: '',
      events: [
        {
          id: '01M6GN0000000000000000000A',
          type: 'comment',
          actor: 'human:dawid',
          at: '2026-11-05T10:00:00Z',
          decision: 'D-0042',
          body: 'Subtasks need no approval.',
        },
      ],
    };
    answers.set('/api/tasks/r%2FAO-0200', detail);
    await mount(createElement(TaskPanel, { id: 'r/AO-0200', nav: nav(), onClose: vi.fn() }));
    expect(box.querySelector('[data-event-decision]')!.textContent).toBe('decision D-0042');
    type(
      box.querySelector<HTMLTextAreaElement>('textarea[placeholder^="Comment"]')!,
      'Dark mode follows the system setting.',
    );
    await click(toggle());
    await click(checkbox('Project-wide'));
    await click(button('Comment Ctrl+Enter'));
    expect(posts[0]).toEqual({
      path: '/api/tasks/r%2FAO-0200/comment',
      body: {
        as: 'human:dawid',
        message: 'Dark mode follows the system setting.',
        decision: 'Dark mode follows the system setting',
        scope: 'project',
      },
    });
  });
});

describe('the Decision toggle on the triage form', () => {
  const control = (): ReactElement =>
    createElement(TriageActions, { task: 'r/AO-0201', me: 'human:dawid' });

  it('marks the accept', async () => {
    await mount(control());
    await click(toggle());
    expect(button('Accept as task').disabled).toBe(true);
    type(line(), 'Login bugs are p1');
    await click(button('Accept as task'));
    expect(posts[0]).toEqual({
      path: '/api/tasks/r%2FAO-0201/retype',
      body: {
        as: 'human:dawid',
        type: 'task',
        message: 'Accepted in triage',
        decision: 'Login bugs are p1',
        scope: 'tree',
      },
    });
  });

  it('prefills from the reason when parking', async () => {
    await mount(control());
    await click(button('Park'));
    type(
      box.querySelector<HTMLInputElement>('input[placeholder="Why it is not planned"]')!,
      'No dark mode before 1.0. Too much churn.',
    );
    await click(toggle());
    expect(line().value).toBe('No dark mode before 1.0');
    await click(button('Park it'));
    expect(posts[0]).toEqual({
      path: '/api/tasks/r%2FAO-0201/park',
      body: {
        as: 'human:dawid',
        message: 'No dark mode before 1.0. Too much churn.',
        decision: 'No dark mode before 1.0',
        scope: 'tree',
      },
    });
  });
});

describe('Accept change on an ask that names a contradiction', () => {
  const conflict: InboxItem = {
    ...ask,
    summary: 'AO-0110: contradiction with D-0007: the task merges approved branches by itself',
    recommend: 'keep: open a PR instead',
  };
  const logPath = '/api/decisions?log&task=r%2FAO-0110';

  it('shows the decision, and fills in supersedes with the scope it takes', async () => {
    answers.set(logPath, [entry()]);
    await mount(createElement(Inbox, { nav: nav(), items: [conflict], error: null }));
    const row = box.querySelector('[data-contradiction="D-0007"]')!;
    expect(row.textContent).toContain('swarmupd never merges; Dawid merges');
    expect(row.textContent).toContain('project v2');
    await click(button('Accept change'));
    expect(box.querySelector('[data-decision-hint]')!.textContent).toBe(
      'Supersedes D-0007 and takes its scope: project v2.',
    );
    type(box.querySelector('textarea')!, 'swarmupd merges approved branches. Change it.');
    await click(button('Answer'));
    expect(posts[0]).toEqual({
      path: '/api/tasks/r%2FAO-0110/answer',
      body: {
        as: 'human:dawid',
        message: 'swarmupd merges approved branches. Change it.',
        decision: 'swarmupd merges approved branches',
        supersedes: ['D-0007'],
      },
    });
  });

  it('switches to narrows with Only this task tree', async () => {
    answers.set(logPath, [entry()]);
    await mount(createElement(Inbox, { nav: nav(), items: [conflict], error: null }));
    await click(button('Accept change'));
    await click(checkbox('Only this task tree'));
    expect(box.querySelector('[data-decision-hint]')!.textContent).toContain('Narrows D-0007');
    type(box.querySelector('textarea')!, 'This task merges by itself.');
    await click(button('Answer'));
    expect(posts[0]!.body).toEqual({
      as: 'human:dawid',
      message: 'This task merges by itself.',
      decision: 'This task merges by itself',
      scope: 'tree',
      narrows: ['D-0007'],
    });
  });

  it('offers no narrowing when the decision covers this task tree and no more', async () => {
    answers.set(logPath, [entry({ scope: 'tree', task: 'AO-0110', project: 'v2' })]);
    await mount(createElement(Inbox, { nav: nav(), items: [conflict], error: null }));
    await click(button('Accept change'));
    expect(box.textContent).not.toContain('Only this task tree');
    // Keep takes the change back: the answer records nothing.
    await click(button('Keep D-0007'));
    type(box.querySelector('textarea')!, 'keep');
    await click(button('Answer'));
    expect(posts[0]!.body).toEqual({ as: 'human:dawid', message: 'keep' });
  });

  it('shows nothing on an ask without a contradiction', async () => {
    await mount(createElement(Inbox, { nav: nav(), items: [ask], error: null }));
    expect(box.querySelector('[data-contradiction]')).toBeNull();
    expect(gets.filter((p) => p.includes('log'))).toEqual([]);
  });
});

describe('the Decisions view', () => {
  const log = [
    entry({ id: 'D-0042', text: 'Subtasks of an approved task need no approval' }),
    entry({
      id: 'D-0031',
      scope: 'tree',
      task: 'AO-0051',
      text: 'Desktop ships as a tray app first',
      source: undefined,
      replaced: [{ by: 'D-0055', how: 'narrowed', where: 'under AO-0063' }],
    }),
  ];
  const old = entry({
    id: 'D-0007',
    state: 'superseded',
    replaced: [{ by: 'D-0042', how: 'superseded', where: 'in project v2' }],
  });

  it('lists the log with its scopes and notes, and opens the source event', async () => {
    answers.set('/api/decisions?log', log);
    const n = nav();
    await mount(createElement(Decisions, { nav: n }));
    const rows = [...box.querySelectorAll('[data-log-entry]')];
    expect(rows.map((r) => r.getAttribute('data-log-entry'))).toEqual(['D-0042', 'D-0031']);
    expect(rows[0]!.textContent).toContain('Subtasks of an approved task need no approval');
    expect(rows[0]!.querySelector('[data-scope]')!.textContent).toBe('project v2');
    expect(rows[1]!.querySelector('[data-scope]')!.textContent).toBe('tree AO-0051');
    expect(rows[1]!.querySelector('[data-log-note]')!.textContent).toContain(
      'narrowed under AO-0063 by D-0055',
    );
    await click(button('AO-0107'));
    expect(n.openTask).toHaveBeenCalledWith('r/AO-0107#01M6GN0000000000000000000A');
  });

  it('adds the superseded ones with Include superseded', async () => {
    answers.set('/api/decisions?log', log);
    answers.set('/api/decisions?log&all', [...log, old]);
    await mount(createElement(Decisions, { nav: nav() }));
    expect(box.querySelector('[data-log-entry="D-0007"]')).toBeNull();
    await click(button('Include superseded'));
    const row = box.querySelector('[data-log-entry="D-0007"]')!;
    expect(row.getAttribute('data-state')).toBe('superseded');
    expect(row.textContent).toContain('superseded by D-0042');
    // A superseded decision has no Supersede: the record that replaced it has.
    expect([...row.querySelectorAll('button')].map((b) => b.textContent)).not.toContain(
      'Supersede',
    );
  });

  it('Supersede opens a new record with supersedes filled in and refuses over 200 characters', async () => {
    answers.set('/api/decisions?log', log);
    await mount(createElement(Decisions, { nav: nav() }));
    const row = box.querySelector('[data-log-entry="D-0042"]')!;
    await click([...row.querySelectorAll('button')].find((b) => b.textContent === 'Supersede')!);
    const form = row.querySelector('[data-supersede-form]')!;
    expect(form.textContent).toContain('supersedes D-0042');
    expect(form.textContent).toContain('Takes the scope of D-0042: project v2');
    const input = form.querySelector<HTMLInputElement>('input')!;
    expect(button('Record').disabled).toBe(true);
    type(input, 'y'.repeat(201));
    expect(button('Record').disabled).toBe(true);
    expect(form.querySelector('[data-decision-error]')!.textContent).toContain('201');
    type(input, 'Subtasks need approval above 2 hours');
    const before = gets.length;
    await click(button('Record'));
    expect(posts).toEqual([
      {
        path: '/api/decisions',
        body: {
          as: 'human:dawid',
          root: 'r',
          text: 'Subtasks need approval above 2 hours',
          supersedes: ['D-0042'],
        },
      },
    ]);
    // The form closes and the log is read again.
    expect(box.querySelector('[data-supersede-form]')).toBeNull();
    expect(gets.slice(before)).toContain('/api/decisions?log');
  });

  it('opens on the votes while one is open, and on the log from its tab', async () => {
    answers.set('/api/decisions', [
      {
        root: 'r',
        meta: {
          id: 'D-0001',
          question: 'Which queue?',
          options: ['A', 'B'],
          quorum: 2,
          created_by: 'claude:pm',
        },
        body: '',
        ballots: [],
        outcome: null,
        tally: { counts: { A: 0, B: 0 }, votes: 0, leaders: [], state: 'open', missing: [] },
      },
    ]);
    answers.set('/api/decisions?log', log);
    await mount(createElement(Decisions, { nav: nav() }));
    expect(box.textContent).toContain('Which queue?');
    expect(box.querySelector('[data-log-entry]')).toBeNull();
    await click(box.querySelector('[role="tab"]')!);
    expect(box.querySelector('[data-log-entry="D-0042"]')).not.toBeNull();
  });

  it('shows no Supersede to an agent', async () => {
    answers.set('/api/decisions?log', log);
    await mount(createElement(Decisions, { nav: nav('claude:pm') }));
    expect(box.querySelector('[data-log-entry]')).not.toBeNull();
    expect([...box.querySelectorAll('button')].map((b) => b.textContent)).not.toContain(
      'Supersede',
    );
  });
});
