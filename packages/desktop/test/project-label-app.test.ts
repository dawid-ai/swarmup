// @vitest-environment happy-dom
// AO-0353: a project renamed with Edit name shows its label in every view, not only the sidebar.
// Filters, New task and the API keep the root's own name.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../ui/src/App';
import { setViewProject } from '../ui/src/lib/filters';
import type { ListedProject, Task } from '../ui/src/types';
import { setProjectLabels } from '../ui/src/ui/project-label';
import { fixture } from './replay-fixture';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const task = (id: string, root: string): Task => ({
  id,
  root,
  project: root,
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
  updatedAt: '2026-11-01T00:00:00Z',
});

const TASKS = [task('AO-0001', 'acme'), task('SHO-0001', 'shop')];

let root: Root | undefined;
let box: HTMLDivElement;
let projects: ListedProject[];
let paths: string[];
let posted: Array<Record<string, unknown>>;

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
    call: async (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => {
      paths.push(path);
      if (path === '/api/settings') {
        return {
          ok: true,
          data: {
            roots: projects.map((p) => p.root),
            rootList: projects.map((p) => ({
              name: p.name,
              label: p.label,
              dir: p.root,
              mirror: false,
              isMirror: false,
              isMaster: false,
            })),
            opsd: { agents: {}, runtimes: {} },
          },
        };
      }
      if (path === '/api/projects') return { ok: true, data: projects };
      if (method === 'POST' && path === '/api/projects/label') {
        const project = projects.find((p) => p.root === body?.root)!;
        project.label = String(body?.label ?? '') || project.name;
        return { ok: true, data: projects.map((p) => ({ ...p })) };
      }
      if (method === 'POST' && path === '/api/tasks') {
        posted.push(body ?? {});
        return { ok: true, data: { root: body?.root, id: 'AO-0002' } };
      }
      if (path === '/api/tasks' || path === '/api/tasks?all') return { ok: true, data: TASKS };
      if (path.startsWith('/api/tasks/')) {
        return { ok: true, data: { task: TASKS[0], body: '', events: [] } };
      }
      if (path.startsWith('/api/timeline')) return { ok: true, data: fixture() };
      if (path === '/api/waits') return { ok: true, data: { providers: {}, waits: [] } };
      return { ok: true, data: [] };
    },
  } as unknown as NonNullable<Window['swarmup']>;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  projects = [
    {
      root: 'C:\\dev\\acme',
      name: 'acme',
      label: 'acme',
      archived: false,
      found: true,
    },
    { root: 'C:\\dev\\shop', name: 'shop', label: 'shop', archived: false, found: true },
  ];
  paths = [];
  posted = [];
  setViewProject(undefined);
  setProjectLabels(new Map());
  stubBridge();
  box = document.createElement('div');
  document.body.append(box);
  root = createRoot(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
  document.body.querySelectorAll('[data-project-menu], [data-modal]').forEach((el) => el.remove());
  window.localStorage.clear();
  setProjectLabels(new Map());
  delete window.swarmup;
});

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function button(text: string, within: ParentNode = document.body): HTMLButtonElement {
  const found = [...within.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!found) throw new Error(`no ${text} button`);
  return found;
}

function click(element: Element): void {
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
}

function type(input: HTMLInputElement, value: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function rename(from: string, to: string): Promise<void> {
  act(() =>
    button(from).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 90 }),
    ),
  );
  const menu = document.body.querySelector<HTMLElement>('[role="menu"][data-project-menu]')!;
  click(button('Edit name', menu));
  const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
  type(dialog.querySelector('input')!, to);
  click(button('Save name', dialog));
  await settle();
}

describe('a renamed project', () => {
  it('shows its label in the list, its filter, the task panel and New task', async () => {
    act(() => root!.render(createElement(App)));
    await settle();
    await rename('acme', 'Control Plane');

    // The sidebar opens the list filtered by the root's name; the chip and the row show the label.
    click(button('Control Plane', document.body.querySelector('[data-projects]')!));
    await settle();
    const main = document.body.querySelector('main')!;
    const chip = main.querySelector('[aria-label="Clear Project"]')!.closest('button')!;
    expect(chip.textContent).toContain('Control Plane');
    const row = [...main.querySelectorAll('tr')].find((r) => r.textContent?.includes('AO-0001'))!;
    expect(row.textContent).toContain('Control Plane');
    expect(row.textContent).not.toContain('acme');
    expect(main.textContent).not.toContain('SHO-0001');

    click(row);
    await settle();
    const panel = document.body.querySelector('[aria-label="Close"]')!.closest('div.fixed')!;
    expect(panel.textContent).toContain('Control Plane');
    click(panel.querySelector('[aria-label="Close"]')!);

    // New task opens with the filtered project, by label, and still sends the root's name.
    click(button('New task'));
    await settle();
    const form = document.body.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="New task"]',
    )!;
    const combo = form.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    expect(combo.value).toBe('Control Plane');
    act(() => combo.focus());
    click(combo);
    const options = [
      ...document.body.querySelectorAll('[role="listbox"][aria-label="Projects"] [role="option"]'),
    ].map((o) => o.textContent?.trim());
    expect(options).toEqual(['Control Plane', 'shop', 'Add project']);
    type(form.querySelector<HTMLInputElement>('input[placeholder="Task title"]')!, 'Ship it');
    click(button('Create task', form));
    await settle();
    expect(posted.at(-1)).toMatchObject({ root: 'acme' });
  });

  it('shows its label in the board filter and in Replay', async () => {
    act(() => root!.render(createElement(App)));
    await settle();
    await rename('acme', 'Control Plane');

    click(button('Board'));
    await settle();
    const main = document.body.querySelector('main')!;
    click(button('Project', main));
    const rows = [...document.body.querySelectorAll('button')]
      .map((b) => b.textContent?.trim())
      .filter((text) => text === 'Control Plane' || text === 'acme');
    // The sidebar row and the filter option; no row shows the root's name.
    expect(rows).toEqual(['Control Plane', 'Control Plane']);

    click(button('Replay'));
    await settle();
    const select = [...main.querySelectorAll('select')].find(
      (s) => s.options[0]?.textContent === 'All projects',
    )!;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'All projects',
      'Control Plane',
      'shop',
    ]);
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    act(() => {
      set.call(select, 'acme');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(paths.some((p) => p.startsWith('/api/timeline') && p.includes('root=acme'))).toBe(true);
    expect(main.querySelector('[data-project-name="true"]')?.textContent).toBe('Control Plane');

    // A second rename reaches the open view without a restart.
    await rename('Control Plane', 'Ops HQ');
    expect(main.querySelector('[data-project-name="true"]')?.textContent).toBe('Ops HQ');
  });
});
