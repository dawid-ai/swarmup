// @vitest-environment happy-dom
// AO-0321, rendered: a milestone's plan in the app (AO-0110). The inbox shows a plan review in its
// own group, Plans, with the item count and estimate sum; the task panel of a milestone shows the
// goal, `done_when` and the plan table, with Approve plan, Edit and Send back while a plan waits
// and the check history after; edit mode edits, adds, removes, reorders and replaces rows; the
// board shows a milestone's progress on its card and groups tasks in Milestone lanes.
import { act, createElement } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Nav } from '../ui/src/App';
import { lanesOf } from '../ui/src/lib/filters';
import {
  addRow,
  checkHistory,
  editRows,
  estimateMinutes,
  milestoneOf,
  minutesText,
  moveRow,
  planEdited,
  planOf,
  planSize,
  progressText,
  removeRow,
  replaceRow,
  rowsMinutes,
} from '../ui/src/lib/plan';
import type {
  InboxItem,
  OpsEvent,
  PlanProgress,
  PlanReport,
  PlanRow,
  Task,
  TaskDetail,
} from '../ui/src/types';
import { Board } from '../ui/src/views/Board';
import { Inbox } from '../ui/src/views/Inbox';
import { TaskPanel } from '../ui/src/views/TaskPanel';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const answers = new Map<string, unknown>();
const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
/** What the next write answers with. */
let written: unknown = { events: [], created: [] };

let root: Root | undefined;
let box: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  answers.clear();
  writes.length = 0;
  written = { events: [], created: [] };
  const off = (): (() => void) => () => {};
  window.swarmup = {
    call: (method: string, path: string, body?: Record<string, unknown>) => {
      if (method !== 'GET') {
        writes.push({ path, body: body ?? {} });
        return Promise.resolve({ ok: true, data: written });
      }
      return Promise.resolve({ ok: true, data: answers.get(path.split('?')[0]!) ?? [] });
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

const nav = (): Nav => ({ me: 'human:dawid', openTask: vi.fn(), go: vi.fn() });

function buttons(text: string): HTMLButtonElement[] {
  return [...document.body.querySelectorAll('button')].filter(
    (x) => x.textContent?.trim() === text,
  );
}

function button(text: string, within: ParentNode = document.body): HTMLButtonElement {
  const b = [...within.querySelectorAll('button')].find((x) => x.textContent?.trim() === text);
  if (!b) throw new Error(`no ${text} button`);
  return b;
}

async function click(b: Element): Promise<void> {
  await act(async () => {
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
}

function type(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const set = Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!;
  act(() => {
    set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** The field `name` of the edit row of item `key`. */
function field(key: string, name: string): HTMLInputElement {
  const el = box.querySelector<HTMLInputElement>(`[data-edit-row="${key}"] [name="${name}"]`);
  if (!el) throw new Error(`no field ${name} in row ${key}`);
  return el;
}

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  root: 'r',
  title: `task ${id}`,
  type: 'task',
  priority: 'p2',
  status: 'todo',
  owner: null,
  claimedBy: null,
  leaseUntil: null,
  reviewer: null,
  waitingOn: null,
  checkpoint: null,
  updatedAt: '2026-11-14T10:00:00Z',
  ...over,
});

const row = (key: string, over: Partial<PlanRow> = {}): PlanRow => ({
  key,
  title: `Item ${key}`,
  owner: '*:engineer',
  after: [],
  estimate: '2h',
  ...over,
});

const PROPOSED: PlanRow[] = [
  row('apple', { title: 'Apple Developer account', owner: 'human:dawid', estimate: '1h' }),
  row('ci', {
    title: 'Build and sign the .dmg in CI',
    after: ['apple'],
    estimate: '4h',
    done_when: 'codesign --verify passes in CI',
    review: 'codex:qa',
  }),
  row('smoke', {
    title: 'Smoke check on a clean Mac',
    owner: '*:qa',
    after: ['ci'],
    estimate: '1h',
  }),
];

function report(over: Partial<PlanReport> = {}): PlanReport {
  return {
    id: 'AO-0120',
    root: 'r',
    title: 'Desktop app ships on macOS',
    doneWhen: 'A signed .dmg from CI installs on a clean Mac',
    status: 'needs-review',
    approval: null,
    planner: null,
    items: [],
    minutes: 0,
    spent: 0,
    pending: {
      event: 'E-PLAN',
      actor: 'claude:pm',
      stale: false,
      notes: 'Signing needs an Apple Developer account.',
      items: PROPOSED,
      minutes: 360,
      changes: [],
    },
    incomplete: null,
    yaml: '',
    ...over,
  };
}

const MILESTONE = task('AO-0120', {
  title: 'Desktop app ships on macOS',
  type: 'milestone',
  status: 'needs-review',
  owner: 'claude:pm',
  reviewer: 'human:dawid',
});

async function panel(
  plan: PlanReport,
  opts: { t?: Task; events?: OpsEvent[]; editPlan?: boolean } = {},
): Promise<Nav> {
  const t = opts.t ?? MILESTONE;
  const detail: TaskDetail = {
    task: t,
    body: 'Dawid can install the app on his Mac from a release.',
    events: opts.events ?? [],
  };
  const ref = encodeURIComponent(`${t.root}/${t.id}`);
  answers.set(`/api/tasks/${ref}`, detail);
  answers.set(`/api/tasks/${ref}/plan`, plan);
  const n = nav();
  await mount(
    createElement(TaskPanel, {
      id: `${t.root}/${t.id}`,
      nav: n,
      editPlan: opts.editPlan,
      onClose: vi.fn(),
    }),
  );
  return n;
}

describe('plan helpers', () => {
  it('writes sums as core does and reads estimates', () => {
    expect([45, 360, 90].map(minutesText)).toEqual(['45 min', '6 h', '1 h 30 min']);
    expect(['30m', '2h', '1d', ' 4h '].map(estimateMinutes)).toEqual([30, 120, 480, 240]);
    expect(['', '2', '0h', '1.5h', 'soon'].map(estimateMinutes)).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(planSize(3, 360)).toBe('3 items, 6 h');
    expect(planSize(1, 30)).toBe('1 item, 30 min');
  });

  it('sends the rows as a plan file holds them, and only when they differ', () => {
    const rows = editRows(PROPOSED);
    expect(planEdited(rows, PROPOSED)).toBe(false);
    expect(planOf(rows, ' Signing first. ')).toEqual({
      notes: 'Signing first.',
      items: [
        { key: 'apple', title: 'Apple Developer account', owner: 'human:dawid', estimate: '1h' },
        {
          key: 'ci',
          title: 'Build and sign the .dmg in CI',
          owner: '*:engineer',
          estimate: '4h',
          after: ['apple'],
          done_when: 'codesign --verify passes in CI',
          review: 'codex:qa',
        },
        {
          key: 'smoke',
          title: 'Smoke check on a clean Mac',
          owner: '*:qa',
          estimate: '1h',
          after: ['ci'],
        },
      ],
    });
    const changed = rows.map((r) => (r.key === 'ci' ? { ...r, estimate: '6h' } : r));
    expect(planEdited(changed, PROPOSED)).toBe(true);
    expect(rowsMinutes(changed)).toEqual({ minutes: 480, bad: 0 });
    expect(rowsMinutes([...changed, ...addRow(changed).slice(-1)])).toEqual({
      minutes: 480,
      bad: 1,
    });
  });

  it('adds, removes and reorders rows, and keeps `after` in step', () => {
    const rows = editRows(PROPOSED);
    const added = addRow(rows);
    expect(added.at(-1)).toMatchObject({ key: 'item4', title: '', owner: '*:qa' });
    const moved = moveRow(rows, rows[2]!.uid, -1);
    expect(moved.map((r) => r.key)).toEqual(['apple', 'smoke', 'ci']);
    expect(moveRow(rows, rows[0]!.uid, -1).map((r) => r.key)).toEqual(['apple', 'ci', 'smoke']);
    const removed = removeRow(rows, rows[1]!.uid);
    expect(removed.map((r) => [r.key, r.after])).toEqual([
      ['apple', ''],
      ['smoke', ''],
    ]);
  });

  it('replaces an item that has a task: a new key, no task, and `after` moved to it', () => {
    const rows = editRows([
      row('apple', { task: 'AO-0121' }),
      row('ci', { after: ['apple'], task: 'AO-0122', for: 'apple' }),
      row('ci2', { after: ['ci'] }),
      row('smoke', { after: ['ci', 'apple'] }),
    ]);
    const out = replaceRow(rows, rows[1]!.uid);
    expect(out.map((r) => [r.key, r.task, r.after])).toEqual([
      ['apple', 'AO-0121', ''],
      ['ci3', undefined, 'apple'],
      ['ci2', undefined, 'ci3'],
      ['smoke', undefined, 'ci3, apple'],
    ]);
    expect(out[1]!.for).toBeUndefined();
    expect(out[1]!.uid).not.toBe(rows[1]!.uid);
  });

  it('names the milestone of a card, and groups cards in Milestone lanes by root and id', () => {
    const tasks = [
      task('AO-0120', { type: 'milestone' }),
      task('AO-0121', { labels: ['ui', 'milestone:AO-0120'] }),
      task('AO-0130', { labels: ['milestone:AO-0125'] }),
      task('AO-0140'),
      task('AO-0120', { root: 'other', type: 'milestone' }),
      task('AO-0150', { labels: ['milestone:'] }),
    ];
    expect(tasks.map(milestoneOf)).toEqual([
      'AO-0120',
      'AO-0120',
      'AO-0125',
      null,
      'AO-0120',
      null,
    ]);
    expect(lanesOf(tasks, 'milestone').map((l) => [l.key, l.tasks.map((t) => t.id)])).toEqual([
      ['other/AO-0120', ['AO-0120']],
      ['r/AO-0120', ['AO-0120', 'AO-0121']],
      ['r/AO-0125', ['AO-0130']],
      ['', ['AO-0140', 'AO-0150']],
    ]);
  });

  it('writes a card progress line, and the check history from the events after the approval', () => {
    const p: PlanProgress = {
      root: 'r',
      id: 'AO-0120',
      title: 'x',
      total: 7,
      done: 4,
      parked: 0,
      minutes: 840,
      spent: 540,
      pending: null,
    };
    expect(progressText(p)).toBe('4/7 done, 9 h of 14 h');
    expect(progressText({ ...p, parked: 1 })).toBe('4/7 done, 1 parked, 9 h of 14 h');
    expect(progressText({ ...p, total: 0, done: 0, pending: { items: 3, minutes: 360 } })).toBe(
      'plan waits: 3 items, 6 h',
    );
    const ev = (id: string, type: string, over: Partial<OpsEvent> = {}): OpsEvent => ({
      id,
      type,
      actor: 'codex:qa',
      at: '2026-11-14T10:00:00Z',
      body: '',
      ...over,
    });
    const events = [
      ev('1', 'checkpoint'),
      ev('2', 'plan'),
      ev('3', 'plan-approve'),
      ev('4', 'claim'),
      ev('5', 'checkpoint'),
      ev('6', 'plan-amend', { plan_kind: 'subtask' }),
      ev('7', 'plan-amend', { plan_kind: 'fix' }),
      ev('8', 'checkpoint'),
      ev('9', 'done'),
    ];
    expect(checkHistory(events).map((s) => [s.event.id, s.label])).toEqual([
      ['5', 'Check evidence'],
      ['7', 'Check failed: fix tasks added'],
      ['8', 'Check evidence'],
      ['9', 'Check passed'],
    ]);
    expect(checkHistory(events.slice(0, 2))).toEqual([]);
  });
});

describe('Inbox: Plans', () => {
  const plan: InboxItem = {
    kind: 'review',
    task: 'AO-0120',
    root: 'r',
    title: 'Desktop app ships on macOS',
    from: 'claude:pm',
    event: 'E-PLAN',
    summary: 'Plan for AO-0120: 3 items, 6 h. Approve it with `swarmup plan approve AO-0120`.',
    plan: { event: 'E-PLAN', items: 3, minutes: 360, change: false },
  };
  const change: InboxItem = {
    ...plan,
    task: 'AO-0130',
    title: 'Docs ship',
    summary: 'Plan change for AO-0130: 4 items, 8 h',
    plan: { event: 'E-2', items: 4, minutes: 480, change: true },
  };
  const review: InboxItem = {
    kind: 'review',
    task: 'AO-0007',
    root: 'r',
    title: 'Fix the header',
    from: 'claude:engineer',
    summary: 'ready',
  };

  it('groups plan reviews apart from reviews, with the item count and the estimate sum', async () => {
    await mount(createElement(Inbox, { nav: nav(), items: [plan, change, review], error: null }));
    const group = box.querySelector('#inbox-plan')!;
    expect(group.querySelector('h2')!.textContent).toBe('Plans');
    expect(group.querySelector('[data-group-total]')!.textContent).toBe('7 items, 14 h');
    const items = [...group.querySelectorAll('[data-plan-item]')].map((el) => el.textContent);
    expect(items[0]).toContain('proposes a plan');
    expect(items[0]).toContain('3 items, 6 h');
    expect(items[1]).toContain('proposes a change to the plan');
    expect(items[1]).toContain('4 items, 8 h');
    // The plan's verdict is Approve plan or Send back, never a plain Approve.
    expect(group.textContent).not.toContain('Request changes');
    expect(buttons('Approve')).toHaveLength(1);
    const reviews = box.querySelector('#inbox-review')!;
    expect(reviews.textContent).toContain('AO-0007');
    expect(reviews.textContent).not.toContain('AO-0120');
  });

  it('approves the plan as proposed, and sends it back only with a note', async () => {
    written = { events: [], created: [{}, {}, {}] };
    const n = nav();
    await mount(createElement(Inbox, { nav: n, items: [plan], error: null }));
    expect(button('Send back').disabled).toBe(true);
    expect(button('Send back').title).toBe('Write what to change first');
    await click(button('Approve plan'));
    expect(writes).toEqual([
      { path: '/api/tasks/AO-0120/plan-approve', body: { as: 'human:dawid' } },
    ]);
    type(box.querySelector('textarea')!, 'AO-0120: split the CI item');
    await click(button('Send back'));
    expect(writes[1]).toEqual({
      path: '/api/tasks/AO-0120/plan-reject',
      body: { as: 'human:dawid', message: 'AO-0120: split the CI item' },
    });
    await click(button('Review and edit'));
    expect(n.openTask).toHaveBeenCalledWith('AO-0120');
  });
});

describe('the task panel of a milestone', () => {
  it('shows the goal, done_when and the plan that waits, and approves it as proposed', async () => {
    written = { events: [], created: [{}, {}, {}] };
    await panel(report());
    const plan = box.querySelector('[data-milestone-plan]')!;
    expect(plan.textContent).toContain('Dawid can install the app on his Mac from a release.');
    expect(plan.querySelector('[data-done-when]')!.textContent).toBe(
      'A signed .dmg from CI installs on a clean Mac',
    );
    const pending = plan.querySelector('[data-plan-pending]')!;
    expect(pending.textContent).toContain('Plan waits for approval');
    expect(pending.querySelector('[data-plan-size]')!.textContent).toBe('3 items, 6 h');
    expect(pending.textContent).toContain('Signing needs an Apple Developer account.');
    const rows = [...pending.querySelectorAll('[data-plan-row]')];
    expect(rows.map((r) => r.getAttribute('data-plan-row'))).toEqual(['apple', 'ci', 'smoke']);
    expect(rows[1]!.textContent).toContain('after apple');
    expect(rows[1]!.textContent).toContain('review codex:qa');
    expect(rows[1]!.textContent).toContain('4h');
    // No task yet, so no task, status or time columns; and no plain verdict on a milestone.
    expect(pending.querySelector('thead')!.textContent).toBe('ItemOwnerEstimate');
    expect(buttons('Approve')).toEqual([]);
    expect(buttons('Request changes')).toEqual([]);
    // The goal shows once, with the plan.
    expect(box.textContent).not.toContain('Description');

    await click(button('Approve plan'));
    expect(writes).toEqual([
      { path: '/api/tasks/r%2FAO-0120/plan-approve', body: { as: 'human:dawid' } },
    ]);
  });

  it('edits rows, adds, removes and reorders them, and approves the edited plan', async () => {
    await panel(report());
    await click(button('Edit'));
    expect(box.querySelector('[data-plan-table]')).toBeNull();
    for (const name of ['title', 'owner', 'estimate', 'after', 'done_when', 'review']) {
      expect(field('ci', name).disabled).toBe(false);
    }
    for (const name of ['type', 'priority', 'key']) expect(field('ci', name).disabled).toBe(false);
    expect(buttons('Replace item')).toEqual([]);

    type(field('ci', 'estimate'), '6h');
    type(field('ci', 'owner'), 'claude:engineer');
    expect(box.querySelector('[data-plan-size]')!.textContent).toBe('3 items, 8 h');
    await click(button('Remove', box.querySelector('[data-edit-row="apple"]')!));
    expect(field('ci', 'after').value).toBe('');
    await click(button('Add item'));
    expect(box.querySelector('[data-plan-size]')!.textContent).toBe(
      '3 items, 7 h (1 without an estimate)',
    );
    type(field('item3', 'title'), 'Notarize the build');
    type(field('item3', 'estimate'), '30m');
    type(field('item3', 'after'), 'ci');
    const added = box.querySelector('[data-edit-row="item3"]')!;
    await click(added.querySelector('[aria-label="Move up"]')!);
    expect(
      [...box.querySelectorAll('[data-edit-row]')].map((r) => r.getAttribute('data-edit-row')),
    ).toEqual(['ci', 'item3', 'smoke']);

    await click(button('Approve plan'));
    expect(writes).toEqual([
      {
        path: '/api/tasks/r%2FAO-0120/plan-approve',
        body: {
          as: 'human:dawid',
          plan: {
            notes: 'Signing needs an Apple Developer account.',
            items: [
              {
                key: 'ci',
                title: 'Build and sign the .dmg in CI',
                owner: 'claude:engineer',
                estimate: '6h',
                done_when: 'codesign --verify passes in CI',
                review: 'codex:qa',
              },
              {
                key: 'item3',
                title: 'Notarize the build',
                owner: '*:qa',
                estimate: '30m',
                after: ['ci'],
              },
              {
                key: 'smoke',
                title: 'Smoke check on a clean Mac',
                owner: '*:qa',
                estimate: '1h',
                after: ['ci'],
              },
            ],
          },
        },
      },
    ]);
  });

  it('sends an unedited plan as proposed from edit mode, and leaves edit mode on Cancel edit', async () => {
    await panel(report(), { editPlan: true });
    expect(box.querySelector('[data-plan-editor]')).not.toBeNull();
    await click(button('Cancel edit'));
    expect(box.querySelector('[data-plan-editor]')).toBeNull();
    await click(button('Edit'));
    await click(button('Approve plan'));
    expect(writes[0]!.body).toEqual({ as: 'human:dawid' });
  });

  it('keeps the fixed fields of a row that has a task read-only, and replaces the item', async () => {
    const effective = [
      row('apple', { task: 'AO-0121', status: 'done', taskOwner: 'human:dawid', spent: 30 }),
      row('ci', { after: ['apple'], task: 'AO-0122', status: 'todo', taskOwner: '*:engineer' }),
    ];
    await panel(
      report({
        status: 'blocked',
        approval: 'E-APPROVE',
        planner: 'claude:pm',
        items: effective,
        minutes: 240,
        spent: 30,
        pending: {
          event: 'E-CHANGE',
          actor: 'claude:pm',
          stale: false,
          base: 'E-APPROVE',
          items: [...effective, row('smoke', { owner: '*:qa', after: ['ci'], estimate: '1h' })],
          minutes: 300,
          changes: ['added: smoke'],
        },
      }),
      { t: { ...MILESTONE, status: 'blocked', owner: '*:qa', reviewer: null } },
    );
    expect(box.querySelector('[data-plan-pending]')!.textContent).toContain(
      'Plan change waits for approval',
    );
    expect(box.querySelector('[data-plan-changes]')!.textContent).toBe('added: smoke');
    await click(button('Edit'));
    for (const name of ['title', 'done_when', 'review', 'type', 'priority']) {
      expect(field('ci', name).disabled).toBe(true);
      expect(field('smoke', name).disabled).toBe(false);
    }
    for (const name of ['owner', 'estimate', 'after'])
      expect(field('ci', name).disabled).toBe(false);
    expect(box.querySelector('[data-edit-row="ci"] [name="key"]')).toBeNull();

    await click(button('Replace item', box.querySelector('[data-edit-row="ci"]')!));
    expect(box.querySelector('[data-edit-row="ci"]')).toBeNull();
    expect(field('ci2', 'title').disabled).toBe(false);
    expect(field('ci2', 'title').value).toBe('Item ci');
    expect(field('smoke', 'after').value).toBe('ci2');
    type(field('ci2', 'title'), 'Build, sign and notarize');
    await click(button('Approve plan'));
    expect((writes[0]!.body.plan as { items: Array<{ key: string }> }).items).toMatchObject([
      { key: 'apple' },
      { key: 'ci2', title: 'Build, sign and notarize', after: ['apple'] },
      { key: 'smoke', after: ['ci2'] },
    ]);
  });

  it('sends the plan back with a note', async () => {
    await panel(report());
    await click(button('Send back'));
    const send = button('Send back');
    expect(send.disabled).toBe(true);
    type(
      box.querySelector<HTMLTextAreaElement>('[data-send-back] textarea')!,
      'AO-0120: add a smoke check',
    );
    await click(button('Send back'));
    expect(writes).toEqual([
      {
        path: '/api/tasks/r%2FAO-0120/plan-reject',
        body: { as: 'human:dawid', message: 'AO-0120: add a smoke check' },
      },
    ]);
  });

  it('shows what swarmupd refuses, and keeps the edit', async () => {
    await panel(report(), { editPlan: true });
    const read = window.swarmup!.call;
    window.swarmup!.call = (method, path, body) =>
      method === 'GET'
        ? read(method, path, body)
        : Promise.resolve({ ok: false, error: "item 'ci' waits for itself" });
    type(field('ci', 'after'), 'ci');
    await click(button('Approve plan'));
    expect(box.textContent).toContain("item 'ci' waits for itself");
    expect(field('ci', 'after').value).toBe('ci');
  });

  it('shows the approved plan with each task, its status and time, and the check history', async () => {
    const n = await panel(
      report({
        status: 'blocked',
        approval: 'E-APPROVE',
        planner: 'claude:pm',
        pending: null,
        minutes: 360,
        spent: 150,
        items: [
          row('apple', {
            task: 'AO-0121',
            status: 'done',
            taskOwner: 'human:dawid',
            spent: 30,
            estimate: '1h',
            origin: 'approve',
          }),
          row('ci', {
            task: 'AO-0122',
            status: 'in-progress',
            taskOwner: 'claude:engineer',
            spent: 120,
            estimate: '4h',
            after: ['apple'],
            origin: 'approve',
          }),
          row('smoke', { owner: '*:qa', estimate: '1h', after: ['ci'], origin: 'fix' }),
        ],
        incomplete: { missing: ['smoke'], unapplied: [] },
      }),
      {
        t: { ...MILESTONE, status: 'blocked', owner: '*:qa', reviewer: null },
        events: [
          { id: 'E1', type: 'plan', actor: 'claude:pm', at: '2026-11-13T10:00:00Z', body: '' },
          {
            id: 'E2',
            type: 'plan-approve',
            actor: 'human:dawid',
            at: '2026-11-13T11:00:00Z',
            body: '',
          },
          {
            id: 'E3',
            type: 'checkpoint',
            actor: 'codex:qa',
            at: '2026-11-14T09:00:00Z',
            body: 'The .dmg does not open on macOS 14.',
          },
          {
            id: 'E4',
            type: 'plan-amend',
            plan_kind: 'fix',
            actor: 'codex:qa',
            at: '2026-11-14T09:05:00Z',
            body: 'One fix task.',
          },
        ],
      },
    );
    const plan = box.querySelector('[data-plan-approved]')!;
    expect(plan.querySelector('h3')!.textContent).toContain('1/3 done, 2 h 30 min of 6 h');
    expect(plan.querySelector('thead')!.textContent).toBe('ItemTaskOwnerStatusEstimateSpent');
    const ci = plan.querySelector('[data-plan-row="ci"]')!;
    expect(ci.textContent).toContain('AO-0122');
    expect(ci.textContent).toContain('In progress');
    expect(ci.textContent).toContain('2 h');
    expect(plan.querySelector('[data-plan-row="smoke"]')!.textContent).toContain('fix');
    expect(plan.textContent).toContain('no task yet for smoke');
    await click(button('AO-0122', plan));
    expect(n.openTask).toHaveBeenCalledWith('r/AO-0122');
    // Nothing waits: no plan actions.
    expect(box.querySelector('[data-plan-pending]')).toBeNull();
    expect(buttons('Approve plan')).toEqual([]);

    const history = box.querySelector('[data-check-history]')!;
    expect([...history.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      expect.stringContaining('Check evidence'),
      expect.stringContaining('Check failed: fix tasks added'),
    ]);
    expect(history.textContent).toContain('The .dmg does not open on macOS 14.');
  });

  it('offers no plan actions to an agent', async () => {
    const t = MILESTONE;
    const ref = encodeURIComponent(`${t.root}/${t.id}`);
    answers.set(`/api/tasks/${ref}`, { task: t, body: 'Goal.', events: [] });
    answers.set(`/api/tasks/${ref}/plan`, report());
    await mount(
      createElement(TaskPanel, {
        id: `${t.root}/${t.id}`,
        nav: { ...nav(), me: 'claude:pm' },
        onClose: vi.fn(),
      }),
    );
    expect(box.querySelector('[data-plan-pending]')).not.toBeNull();
    for (const label of ['Approve plan', 'Edit', 'Send back']) expect(buttons(label)).toEqual([]);
  });
});

describe('the board', () => {
  const tasks = [
    task('AO-0120', {
      title: 'Desktop app ships on macOS',
      type: 'milestone',
      status: 'blocked',
      owner: '*:qa',
    }),
    task('AO-0121', { owner: 'human:dawid', status: 'done', labels: ['milestone:AO-0120'] }),
    task('AO-0122', { owner: '*:engineer', labels: ['milestone:AO-0120'] }),
    task('AO-0140', { owner: 'claude:engineer' }),
  ];
  const progress: PlanProgress[] = [
    {
      root: 'r',
      id: 'AO-0120',
      title: 'Desktop app ships on macOS',
      total: 7,
      done: 4,
      parked: 0,
      minutes: 840,
      spent: 540,
      pending: null,
    },
  ];

  it("shows a milestone's progress on its card", async () => {
    answers.set('/api/tasks', tasks);
    answers.set('/api/milestones', progress);
    await mount(createElement(Board, { nav: nav() }));
    const lines = [...box.querySelectorAll('[data-milestone-progress]')];
    expect(lines.map((l) => l.textContent)).toEqual(['4/7 done, 9 h of 14 h']);
    expect(lines[0]!.closest('[draggable]')!.textContent).toContain('AO-0120');
  });

  it('groups tasks by their milestone label in Milestone lanes', async () => {
    answers.set('/api/tasks', tasks);
    answers.set('/api/milestones', progress);
    await mount(createElement(Board, { nav: nav(), preset: 'lanes:milestone' }));
    const lane = box.querySelector('[data-milestone-lane="r/AO-0120"]')!;
    expect(lane.textContent).toBe('AO-0120Desktop app ships on macOS4/7 done, 9 h of 14 h');
    const group = lane.closest('button')!.parentElement!;
    const cards = [...group.querySelectorAll('[draggable]')].map((c) => c.textContent);
    expect(cards).toHaveLength(3);
    for (const id of ['AO-0120', 'AO-0121', 'AO-0122']) {
      expect(cards.some((c) => c?.includes(id))).toBe(true);
    }
    expect(box.textContent).toContain('No milestone');
    const select = box.querySelector('select')!;
    expect([...select.options].map((o) => o.textContent)).toContain('Milestone');
  });
});
