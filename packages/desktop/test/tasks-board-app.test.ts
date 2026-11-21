// @vitest-environment happy-dom
// The whole app, rendered: the Tasks status filter shows done and parked tasks without the
// Include closed and archived toggle, a sidebar project shows its root's tasks, and the Board's
// Done column shows 20, 100, 250 or all done tasks with the total in its header.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../ui/src/App';
import { setViewProject } from '../ui/src/lib/filters';
import type { Status, Task } from '../ui/src/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const task = (id: string, status: Status, n = 0): Task => ({
  id,
  root: 'web-store',
  // The root's tasks carry the project name `swarmup-web`, not the root's name.
  project: 'swarmup-web',
  title: `task ${id}`,
  type: 'task',
  priority: 'p2',
  status,
  owner: null,
  claimedBy: null,
  leaseUntil: null,
  reviewer: null,
  waitingOn: null,
  checkpoint: null,
  updatedAt: new Date(Date.UTC(2026, 10, 1) + n * 60_000).toISOString(),
});

const OPEN = [task('WEB-0001', 'todo'), task('WEB-0002', 'in-progress')];
const DONE = Array.from({ length: 300 }, (_, i) =>
  task(`WEB-${String(i + 100).padStart(4, '0')}`, 'done', i),
);
const PARKED = [task('WEB-0050', 'parked')];
const ALL = [...OPEN, ...DONE, ...PARKED];

let root: Root | undefined;
let box: HTMLDivElement;

function stubBridge(): void {
  const off = (): (() => void) => () => {};
  window.swarmup = {
    info: async () => ({ pid: 1, port: 1, version: 'test', me: 'human:dawid' }),
    setupStatus: async () => ({ needed: false }),
    desktop: async () => ({ ok: false }),
    update: async () => ({ ok: false }),
    onService: off,
    onUpdate: off,
    onEvent: off,
    onStatus: off,
    onNavigate: off,
    call: async (_method: 'GET' | 'POST', path: string) => {
      if (path === '/api/settings') {
        return { ok: true, data: { rootList: [{ name: 'web-store', dir: 'C:\\dev\\web' }] } };
      }
      // As swarmupd answers: open tasks only, unless `all` asks for the closed ones too.
      if (path === '/api/tasks') return { ok: true, data: OPEN };
      if (path === '/api/tasks?all') return { ok: true, data: ALL };
      if (path.startsWith('/api/tasks/')) return { ok: false, error: 'not in this test' };
      return { ok: true, data: [] };
    },
  } as unknown as NonNullable<Window['swarmup']>;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  setViewProject(undefined);
  stubBridge();
  box = document.createElement('div');
  document.body.append(box);
  root = createRoot(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
  delete window.swarmup;
  window.localStorage.clear();
});

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

function button(text: string, within: ParentNode = document.body): HTMLButtonElement {
  const all = [...within.querySelectorAll('button')];
  const b =
    all.find((x) => x.textContent?.trim() === text) ??
    all.find((x) => x.textContent?.trim().startsWith(text));
  if (!b) throw new Error(`no ${text} button`);
  return b;
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function main(): HTMLElement {
  return document.querySelector('main')!;
}

async function start(view: 'Tasks' | 'Board'): Promise<void> {
  act(() => root!.render(createElement(App)));
  await settle();
  click(button(view));
  await settle();
}

/** Picks a status in the Tasks view's Status chip. */
async function pickStatus(label: string): Promise<void> {
  // The Status chip comes right after the search box; once set, it reads as the status.
  const search = main().querySelector('input[placeholder^="Search id"]')!;
  click(search.parentElement!.nextElementSibling!);
  const options = [...document.body.querySelectorAll('button')].filter(
    (b) => b.textContent?.trim() === label,
  );
  click(options.at(-1)!);
  await settle();
}

function listRows(): number {
  return main().querySelectorAll('tbody tr').length;
}

function closedToggle(): HTMLButtonElement {
  return button('Include closed and archived', main());
}

describe('Tasks view: status filter', () => {
  it('shows done and parked tasks with Include closed and archived off', async () => {
    await start('Tasks');
    expect(closedToggle().getAttribute('aria-checked')).toBe('false');
    expect(listRows()).toBe(2);

    await pickStatus('Done');
    expect(listRows()).toBe(300);
    // The toggle says closed tasks are in, as they are.
    expect(closedToggle().getAttribute('aria-checked')).toBe('true');

    await pickStatus('Parked');
    expect(listRows()).toBe(1);

    await pickStatus('Open (not done or parked)');
    expect(listRows()).toBe(2);
    expect(closedToggle().getAttribute('aria-checked')).toBe('false');
  });

  it('clears a done filter when you turn closed tasks off, so the list never goes empty', async () => {
    await start('Tasks');
    await pickStatus('Done');
    click(closedToggle());
    await settle();
    expect(closedToggle().getAttribute('aria-checked')).toBe('false');
    expect(listRows()).toBe(2);
  });

  it('shows the tasks of a sidebar project whose tasks carry another project name', async () => {
    act(() => root!.render(createElement(App)));
    await settle();
    click(button('web-store', document.querySelector('[data-projects]')!));
    await settle();
    expect(listRows()).toBe(2);
  });
});

/** The Done column's limit dropdown, its header count and its cards, in the board without lanes. */
function doneColumn(): { select: HTMLSelectElement; count: string; cards: number } {
  const select = main().querySelector<HTMLSelectElement>('select[aria-label="Done tasks shown"]')!;
  const header = select.parentElement!;
  return {
    select,
    count: header.querySelector('.ml-auto')!.textContent!.trim(),
    cards: header.parentElement!.querySelectorAll('[draggable="true"]').length,
  };
}

function choose(select: HTMLSelectElement, value: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  act(() => {
    set.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('Board: Done column limit', () => {
  it('shows 20 done cards by default and the total of done tasks in the header', async () => {
    await start('Board');
    const done = doneColumn();
    expect(done.select.value).toBe('20');
    expect([...done.select.options].map((o) => o.textContent)).toEqual(['20', '100', '250', 'All']);
    expect(done.cards).toBe(20);
    // Done and parked tasks share the column.
    expect(done.count).toBe('20 of 301');
  });

  it('shows 100 or all done cards when you pick them, and remembers the choice', async () => {
    await start('Board');
    choose(doneColumn().select, '100');
    expect(doneColumn().cards).toBe(100);
    expect(doneColumn().count).toBe('100 of 301');

    choose(doneColumn().select, 'all');
    expect(doneColumn().cards).toBe(301);
    expect(doneColumn().count).toBe('301');

    choose(doneColumn().select, '100');
    act(() => root!.unmount());
    root = createRoot(box);
    await start('Board');
    expect(doneColumn().select.value).toBe('100');
    expect(doneColumn().cards).toBe(100);
  });

  it('applies the limit to the Done column of each lane', async () => {
    await start('Board');
    choose(doneColumn().select, '100');
    const lanes = main().querySelector<HTMLSelectElement>('select:not([aria-label])')!;
    choose(lanes, 'project');
    await settle();
    const lane = main().querySelector('.mt-3.rounded-2xl')!;
    const columns = lane.querySelectorAll(':scope > div > div');
    // The fifth column is Done.
    expect(columns[4]!.querySelectorAll('[draggable="true"]').length).toBe(100);
    expect(doneColumn().count).toBe('100 of 301');
  });
});
