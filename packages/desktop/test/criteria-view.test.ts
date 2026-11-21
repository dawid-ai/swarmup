// @vitest-environment happy-dom
// Typed criteria in the app: the task panel lists a task's criteria with their kinds and last
// results, and a plan row with a typed `done_when` keeps it through edit mode.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Nav } from '../ui/src/App';
import { doneWhenText, editRows, planOf } from '../ui/src/lib/plan';
import type { PlanRow, Task, TaskDetail } from '../ui/src/types';
import { TaskPanel } from '../ui/src/views/TaskPanel';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const answers = new Map<string, unknown>();
let root: Root | undefined;
let box: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  answers.clear();
  const off = (): (() => void) => () => {};
  window.swarmup = {
    call: (method: string, path: string) =>
      Promise.resolve({ ok: true, data: method === 'GET' ? (answers.get(path) ?? []) : {} }),
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
  delete window.swarmup;
});

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

describe('criteria in the task panel', () => {
  it('lists each criterion with its kind and last result', async () => {
    const detail: TaskDetail = {
      task,
      body: 'A post about the price change.',
      events: [],
      criteria: [
        { id: 'c1', kind: 'prose', text: 'the intro names the price' },
        { id: 'words', kind: 'check', check: 'word-count', args: { max: 900 } },
        { id: 'angle', kind: 'human', ask: 'Is the change clear?' },
      ],
      criteriaResults: {
        c1: {
          result: 'fail',
          note: 'no price',
          event: 'E1',
          actor: 'human:dawid',
          at: '',
          type: 'verdict',
        },
        words: { result: 'pass', event: 'E2', actor: 'opsd:merge', at: '', type: 'merge' },
      },
    };
    answers.set(`/api/tasks/${encodeURIComponent('r/T-0001')}`, detail);
    const nav: Nav = { me: 'human:dawid', openTask: vi.fn(), go: vi.fn() };
    root = createRoot(box);
    await act(async () =>
      root!.render(createElement(TaskPanel, { id: 'r/T-0001', nav, onClose: vi.fn() })),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const items = [...box.querySelectorAll('[data-criteria] [data-criterion]')];
    expect(items.map((i) => i.getAttribute('data-criterion'))).toEqual(['c1', 'words', 'angle']);
    expect(items[0]!.textContent).toBe('c1prosethe intro names the pricefail');
    expect(items[1]!.textContent).toBe('wordscheckword-count {"max":900}pass');
    expect(items[2]!.textContent).toBe('anglehumanIs the change clear?-');
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
