// @vitest-environment happy-dom
// The Activity view, rendered: the Range buttons ask swarmupd for one time window, the feed shows
// only the events in it, and the picked range comes back on the next visit.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Nav } from '../ui/src/App';
import type { ActivityItem } from '../ui/src/types';
import { ACTIVITY_RANGE_KEY, Activity } from '../ui/src/views/Activity';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const DAY = 86_400_000;

function item(task: string, daysAgo: number): ActivityItem {
  return {
    id: `01M6GN2PZGYB4SFGHXJYTD${task.replace(/\D/g, '').padStart(4, '0')}`,
    at: new Date(Date.now() - daysAgo * DAY).toISOString(),
    kind: 'task',
    type: 'comment',
    actor: 'claude:engineer',
    root: 'r',
    task,
    title: `Title of ${task}`,
    body: '',
  };
}

const ITEMS = [item('AO-0001', 0.1), item('AO-0002', 3), item('AO-0003', 20), item('AO-0004', 200)];

let asked: string[] = [];
let root: Root | undefined;
let box: HTMLDivElement;

/** The window of an `/api/activity` path, as swarmupd reads it: `days`, or `from` and `to`. */
function inWindow(path: string, at: string): boolean {
  const p = new URLSearchParams(path.split('?')[1]);
  const t = Date.parse(at);
  const days = p.get('days');
  if (days) return t >= Date.now() - Number(days) * DAY;
  const from = p.get('from');
  if (!from) return true;
  const to = p.get('to');
  return t >= Date.parse(from) && t < (to ? Date.parse(to) : Date.now());
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  asked = [];
  window.localStorage.clear();
  window.swarmup = {
    call: (_method: string, path: string) => {
      asked.push(path);
      const items = ITEMS.filter((i) => inWindow(path, i.at));
      return Promise.resolve({
        ok: true,
        data: { items, next: null, total: items.length, actors: ['claude:engineer'], projects: [] },
      });
    },
  } as unknown as NonNullable<Window['swarmup']>;
  box = document.createElement('div');
  document.body.append(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
  delete window.swarmup;
  window.localStorage.clear();
});

/** Lets the feed's 200 ms wait pass and its answer land. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 250));
  });
}

async function mount(): Promise<void> {
  const nav = { me: null, openTask: vi.fn(), go: vi.fn() } as unknown as Nav;
  root = createRoot(box);
  await act(async () => root!.render(createElement(Activity, { nav })));
  await settle();
}

function rangeButton(label: string): HTMLButtonElement {
  const group = document.body.querySelector('[role="group"][aria-label="Range"]');
  const b = [...(group?.querySelectorAll('button') ?? [])].find((x) => x.textContent === label);
  if (!b) throw new Error(`no Range button '${label}'`);
  return b as HTMLButtonElement;
}

async function pick(label: string): Promise<void> {
  await act(async () => {
    rangeButton(label).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

/** The task ids of the rows the feed shows. */
function shown(): string[] {
  return [...document.body.querySelectorAll('li button.row-open')].map((b) => b.textContent ?? '');
}

function setDate(label: string, value: string): void {
  const input = document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('shows every event until a range is picked, then only the events inside it', async () => {
  await mount();
  expect(rangeButton('All time').getAttribute('aria-pressed')).toBe('true');
  expect(shown()).toEqual(['AO-0001', 'AO-0002', 'AO-0003', 'AO-0004']);
  expect(asked.at(-1)).not.toMatch(/days=|from=/);

  await pick('Day');
  expect(asked.at(-1)).toContain('days=1');
  expect(shown()).toEqual(['AO-0001']);

  await pick('Week');
  expect(shown()).toEqual(['AO-0001', 'AO-0002']);

  await pick('30 days');
  expect(shown()).toEqual(['AO-0001', 'AO-0002', 'AO-0003']);
  expect(document.body.textContent).toContain('3 events');

  await pick('All time');
  expect(shown()).toHaveLength(4);
});

it('filters by a custom from and to', async () => {
  await mount();
  await pick('Custom');
  const day = (n: number): string => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
  setDate('From', day(25));
  setDate('To', day(10));
  await settle();
  // The to date counts in full: swarmupd gets the day after it.
  expect(asked.at(-1)).toContain(`from=${day(25)}&to=${day(9)}`);
  expect(shown()).toEqual(['AO-0003']);
});

it('remembers the picked range on the next visit', async () => {
  await mount();
  await pick('Week');
  act(() => root!.unmount());
  root = undefined;
  expect(JSON.parse(window.localStorage.getItem(ACTIVITY_RANGE_KEY)!)).toMatchObject({ days: 7 });
  await mount();
  expect(rangeButton('Week').getAttribute('aria-pressed')).toBe('true');
  expect(shown()).toEqual(['AO-0001', 'AO-0002']);
});

it('works when storage throws', async () => {
  const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  try {
    await mount();
    await pick('Day');
    expect(shown()).toEqual(['AO-0001']);
  } finally {
    get.mockRestore();
    set.mockRestore();
  }
});
