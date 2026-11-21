// @vitest-environment happy-dom
// The Runs view pages its list (AO-0167): swarmupd sends one page, and **Show more** appends the
// next page for the chosen filter, so every run stays reachable without sending all of them.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pageRuns } from '../../supervisor/src/runs';
import type { RunFilter } from '../../supervisor/src/runs';
import type { Nav } from '../ui/src/App';
import type { RunRecord } from '../ui/src/types';
import { HEAD_MAX, PAGE, Runs } from '../ui/src/views/Runs';

/** A fake swarmupd: `GET /api/runs?limit=` over `net.runs`, with every path it was asked for. */
const net = vi.hoisted(() => ({
  runs: [] as unknown[],
  asked: [] as string[],
  answer: (_path: string): unknown => undefined,
}));

vi.mock(import('../ui/src/api'), async (original) => ({
  ...(await original()),
  useData: <T>(path: string | null) => {
    if (path !== null) net.asked.push(path);
    return {
      data: (path === null ? undefined : net.answer(path)) as T | undefined,
      error: null,
      reload: () => {},
      set: () => {},
    };
  },
  api: async <T>(method: string, path: string): Promise<T> => {
    net.asked.push(path);
    if (method === 'GET' && path.startsWith('/api/runs?')) return net.answer(path) as T;
    // The picked run's log.
    return '' as T;
  },
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let box: HTMLDivElement;

/** Run ids sort like swarmupd's ULIDs: a larger number is a newer run. */
const id = (n: number): string => `R${String(n).padStart(4, '0')}`;

function rec(n: number, patch: Partial<RunRecord> = {}): RunRecord {
  return {
    id: id(n),
    agent: 'claude:engineer',
    pid: n,
    // Seconds apart and within the hour before noon: every run is in the default range, Day.
    started_at: new Date(Date.now() - (3000 - n) * 1000).toISOString(),
    ended_at: new Date(Date.now() - (3000 - n) * 1000 + 500).toISOString(),
    status: 'ended',
    reason: 'exit',
    exit: 0,
    budget_minutes: 60,
    tokens: 10,
    // The row shows the task, so each row reads differently.
    task: `T-${n}`,
    root: 'C:/ops',
    ...patch,
  } as RunRecord;
}

/** Newest first, as swarmupd lists them. */
function setRuns(runs: RunRecord[]): void {
  net.runs = [...runs].sort((a, b) => (a.id < b.id ? 1 : -1));
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // Noon, local time: the ranges count from local midnight.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 21, 12, 0, 0));
  net.asked = [];
  net.answer = (path) => {
    const p = new URL(path, 'http://swarmupd').searchParams;
    return pageRuns(net.runs as never, {
      limit: Number(p.get('limit')),
      before: p.get('before') ?? undefined,
      from: p.get('from') ?? undefined,
      filter: (p.get('filter') ?? 'all') as RunFilter,
      since: p.get('since') ?? undefined,
      start: p.get('start') ?? undefined,
      end: p.get('end') ?? undefined,
      pick: p.get('pick') ?? undefined,
    });
  };
  box = document.createElement('div');
  document.body.append(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
  vi.useRealTimers();
});

function mount(): void {
  const nav = { me: null, openTask: vi.fn(), go: vi.fn() } as unknown as Nav;
  root = createRoot(box);
  act(() => root!.render(createElement(Runs, { nav })));
}

function rerender(): void {
  const nav = { me: null, openTask: vi.fn(), go: vi.fn() } as unknown as Nav;
  act(() => root!.render(createElement(Runs, { nav })));
}

const buttons = (): HTMLButtonElement[] => [...box.querySelectorAll('button')];
const button = (text: string): HTMLButtonElement | undefined =>
  buttons().find((b) => b.textContent?.trim() === text);
/** The rows of the list. */
const rows = (): HTMLButtonElement[] =>
  buttons().filter((b) => b.className.includes('group relative'));
/** The task of each row, top to bottom. */
const tasks = (): string[] =>
  rows().map((r) => r.querySelector('.font-mono.text-signal')?.textContent ?? '');

async function click(b: HTMLButtonElement | undefined): Promise<void> {
  expect(b).toBeDefined();
  await act(async () => {
    b!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('Runs view: paging (AO-0167)', () => {
  it('shows one page, then appends the next pages with before', async () => {
    const total = PAGE * 2 + 7;
    setRuns(Array.from({ length: total }, (_, i) => rec(i + 1)));
    mount();
    expect(rows()).toHaveLength(PAGE);
    expect(box.textContent).toContain(`${PAGE} of ${total}`);

    await click(button('Show more'));
    const next = net.asked.find((p) => p.includes('before='));
    // The last row on screen is the cursor: run `total - PAGE + 1`.
    expect(next).toContain(`before=${id(total - PAGE + 1)}`);
    expect(rows()).toHaveLength(PAGE * 2);
    // Refreshes now ask for every run from the first page's last row up.
    expect(net.asked.at(-1)).toContain(`from=${id(total - PAGE + 1)}`);

    await click(button('Show more'));
    expect(rows()).toHaveLength(total);
    expect(button('Show more')).toBeUndefined();
    // Every run is on screen once, newest first.
    expect(tasks()).toEqual(Array.from({ length: total }, (_, i) => `T-${total - i}`));
  });

  it('keeps rows from both pages when new runs push rows off the first page', async () => {
    const total = PAGE + 10;
    setRuns(Array.from({ length: total }, (_, i) => rec(i + 1)));
    mount();
    await click(button('Show more'));
    expect(rows()).toHaveLength(total);

    // Three new runs: a one-page refresh would drop runs 11 to 13 between the pages.
    setRuns([...Array.from({ length: total }, (_, i) => rec(i + 1)), rec(901), rec(902), rec(903)]);
    rerender();
    expect(rows()).toHaveLength(total + 3);
    expect(new Set(tasks()).size).toBe(total + 3);
  });

  it('moves the boundary when more than HEAD_MAX runs arrive above it', async () => {
    const old = Array.from({ length: PAGE + 10 }, (_, i) => rec(i + 1));
    setRuns(old);
    mount();
    await click(button('Show more'));
    expect(net.asked.at(-1)).toContain(`from=${id(11)}`);

    // HEAD_MAX + 1 new runs: the capped head ends at run 1002, so run 1001 and runs 60 to 11 are
    // not in it. Merging it with runs 10 to 1 would hide them.
    const added = Array.from({ length: HEAD_MAX + 1 }, (_, i) => rec(1001 + i));
    setRuns([...old, ...added]);
    rerender();
    expect(rows()).toHaveLength(HEAD_MAX);
    expect(tasks()).not.toContain('T-10');
    expect(net.asked.at(-1)).toContain(`from=${id(1002)}`);

    await click(button('Show more'));
    expect(net.asked.find((p) => p.includes(`before=${id(1002)}`))).toBeDefined();
    await click(button('Show more'));
    expect(button('Show more')).toBeUndefined();
    const total = old.length + added.length;
    expect(rows()).toHaveLength(total);
    expect(tasks()).toEqual(
      [...added, ...old]
        .map((r) => r.task)
        .sort((a, b) => Number(b!.slice(2)) - Number(a!.slice(2))),
    );
  });

  it('starts over at one page when the filter changes', async () => {
    setRuns(Array.from({ length: PAGE * 2 }, (_, i) => rec(i + 1, i % 2 === 0 ? { exit: 1 } : {})));
    mount();
    await click(button('Show more'));
    expect(rows()).toHaveLength(PAGE * 2);

    await click(buttons().find((b) => b.textContent?.startsWith('Errors')));
    expect(rows()).toHaveLength(PAGE);
    expect(net.asked.at(-1)).not.toContain('from=');
    expect(button('Show more')).toBeUndefined();
  });
});

/** Sets a date input the way a person does: through React's value setter, then `input`. */
async function typeDate(label: string, value: string): Promise<void> {
  const input = box.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(input).not.toBeNull();
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Runs view: date range (AO-0404)', () => {
  const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();

  it('shows today by default, and a longer range with a preset', async () => {
    setRuns([
      rec(1, { started_at: hoursAgo(24 * 10), ended_at: hoursAgo(24 * 10 - 1) }),
      rec(2, { started_at: hoursAgo(24 * 3), ended_at: hoursAgo(24 * 3 - 1) }),
      // Started yesterday and still running: it shows in today's range.
      rec(3, { started_at: hoursAgo(20), ended_at: undefined, status: 'running' }),
      rec(4),
    ]);
    mount();
    expect(net.asked.at(-1)).toContain(
      `start=${encodeURIComponent(new Date(2026, 10, 21).toISOString())}`,
    );
    expect(tasks()).toEqual(['T-4', 'T-3']);
    expect(box.textContent).toContain('Runs today');

    await click(button('Week'));
    expect(button('Week')?.getAttribute('aria-pressed')).toBe('true');
    expect(net.asked.at(-1)).toContain(
      `start=${encodeURIComponent(new Date(2026, 10, 15).toISOString())}`,
    );
    expect(tasks()).toEqual(['T-4', 'T-3', 'T-2']);
    expect(box.textContent).toContain('Runs · 7 days');

    await click(button('30 days'));
    expect(tasks()).toEqual(['T-4', 'T-3', 'T-2', 'T-1']);
  });

  it('shows the runs between two dates with Custom', async () => {
    setRuns([
      rec(1, { started_at: hoursAgo(24 * 10), ended_at: hoursAgo(24 * 10 - 1) }),
      rec(2, { started_at: hoursAgo(24 * 3), ended_at: hoursAgo(24 * 3 - 1) }),
      rec(3),
    ]);
    mount();
    await click(button('Custom'));
    // No From date yet: nothing new is asked, and a line says what to pick.
    expect(box.textContent).toContain('Pick a From date');
    await typeDate('From', '2026-11-01');
    await typeDate('To', '2026-11-18');
    const path = net.asked.at(-1)!;
    expect(path).toContain(`start=${encodeURIComponent(new Date(2026, 10, 1).toISOString())}`);
    // The end of the To day.
    expect(path).toContain(`end=${encodeURIComponent(new Date(2026, 10, 19).toISOString())}`);
    expect(tasks()).toEqual(['T-2', 'T-1']);
    expect(box.textContent).toContain('Runs · range');
  });

  it('pages on within the range', async () => {
    setRuns([
      rec(1, { started_at: hoursAgo(24 * 3), ended_at: hoursAgo(24 * 3 - 1) }),
      ...Array.from({ length: PAGE + 2 }, (_, i) => rec(i + 2)),
    ]);
    mount();
    await click(button('Show more'));
    expect(net.asked.find((p) => p.includes('before='))).toContain('start=');
    // Run 1 is from three days ago, outside Day.
    expect(rows()).toHaveLength(PAGE + 2);
    expect(tasks()).not.toContain('T-1');
  });
});
