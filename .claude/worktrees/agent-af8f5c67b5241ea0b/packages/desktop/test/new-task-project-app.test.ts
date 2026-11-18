// @vitest-environment happy-dom
// The whole app, rendered (AO-0323): New task has a project dropdown with search, keyboard choice
// and Add project as its last row; it opens with the project the Board or List is filtered to;
// and it sends the chosen project's root, so the task lands in that project's store.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../ui/src/App';
import { setViewProject } from '../ui/src/lib/filters';
import type { ProjectProposal, Task } from '../ui/src/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const PROPOSAL: ProjectProposal = {
  kind: 'proposal',
  dir: 'C:\\dev\\shop',
  branch: 'main',
  survey: {
    dir: 'C:\\dev\\shop',
    name: 'shop',
    stacks: ['node'],
    frameworks: [],
    tests: { runner: 'vitest', command: 'npm test', files: 1 },
    build: null,
    lint: null,
    docs: [],
    ci: [],
    agentDocs: [],
  },
  plan: {
    name: 'shop',
    prefix: 'SHO',
    agents: [],
    tasks: [{ title: 'Record the baseline', body: '', priority: 'p2' }],
  },
};

const task = (id: string, root: string, project: string): Task => ({
  id,
  root,
  project,
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

// The tasks of the root `web-store` carry the project name `swarmup-web`, not the root's name.
const TASKS = [
  task('AO-0001', 'agent-ops', 'agent-ops'),
  task('WEB-0001', 'web-store', 'swarmup-web'),
  task('WEB-0002', 'web-store', 'swarmup-web'),
];

let root: Root | undefined;
let box: HTMLDivElement;
let roots: Array<{ name: string; dir: string; isMaster?: boolean }>;
/** The bodies of POST /api/tasks. */
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
    projectPick: async () => ({ ok: true, data: PROPOSAL }),
    projectPlan: async () => ({ ok: true, data: PROPOSAL.plan }),
    projectCreate: async (input: { name: string }) => {
      roots.push({ name: input.name, dir: 'C:\\dev\\shop' });
      return {
        ok: true,
        data: {
          name: input.name,
          dir: 'C:\\dev\\shop\\.swarmup',
          store: null,
          base: null,
          tasks: [{ id: 'SHO-0001', title: 't' }],
          reloaded: true,
        },
      };
    },
    call: async (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => {
      if (method === 'POST' && path === '/api/tasks') {
        posted.push(body ?? {});
        return { ok: true, data: { root: body?.root ?? 'agent-ops', id: 'X-0001' } };
      }
      if (path === '/api/settings') return { ok: true, data: { rootList: roots } };
      if (path === '/api/tasks' || path === '/api/tasks?all') return { ok: true, data: TASKS };
      if (path.startsWith('/api/tasks/')) return { ok: false, error: 'not in this test' };
      return { ok: true, data: [] };
    },
  } as unknown as NonNullable<Window['swarmup']>;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  roots = [
    { name: 'agent-ops', dir: 'C:\\dev\\swarmup-store' },
    { name: 'web-store', dir: 'C:\\dev\\web-store' },
    { name: 'hub', dir: 'C:\\dev\\hub', isMaster: true },
    { name: 'docs-site', dir: 'C:\\dev\\docs' },
  ];
  posted = [];
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
});

/** Lets bridge promises and the 250 ms shared refresh run. */
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

function type(el: HTMLInputElement, text: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function key(el: EventTarget, k: string, init: KeyboardEventInit = {}): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));
  });
}

function dialog(title: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[role="dialog"][aria-label="${title}"]`);
}

function combo(): HTMLInputElement {
  return dialog('New task')!.querySelector<HTMLInputElement>('input[role="combobox"]')!;
}

/** The rows of the open project list, or null while it is closed. */
function rows(): string[] | null {
  const list = document.body.querySelector('[role="listbox"][aria-label="Projects"]');
  return list
    ? [...list.querySelectorAll('[role="option"]')].map((o) => o.textContent!.trim())
    : null;
}

function active(): string | undefined {
  return document.body
    .querySelector('[role="listbox"][aria-label="Projects"] [aria-selected="true"]')
    ?.textContent?.trim();
}

function title(): HTMLInputElement {
  return dialog('New task')!.querySelector<HTMLInputElement>('input[placeholder="Task title"]')!;
}

async function start(): Promise<void> {
  act(() => root!.render(createElement(App)));
  await settle();
}

async function create(): Promise<Record<string, unknown>> {
  if (!title().value) type(title(), 'Fix the header');
  click(button('Create task', dialog('New task')!));
  await settle();
  return posted.at(-1)!;
}

describe('New task: project dropdown', () => {
  it('lists the sidebar projects, filters as you type and picks with the keyboard', async () => {
    await start();
    click(button('New task'));
    // No filter: the default root's project. The Master Repo is not a project.
    expect(combo().value).toBe('agent-ops');
    expect(rows()).toBeNull();
    click(combo());
    expect(rows()).toEqual(['agent-ops', 'web-store', 'docs-site', 'Add project']);

    // A match anywhere in the name, whatever the case; Add project stays last.
    type(combo(), 'S-S');
    expect(rows()).toEqual(['docs-site', 'Add project']);
    type(combo(), 'nothing');
    expect(rows()).toEqual(['Add project']);
    type(combo(), 'STO');
    expect(rows()).toEqual(['web-store', 'Add project']);
    expect(active()).toBe('web-store');
    key(combo(), 'ArrowDown');
    expect(active()).toBe('Add project');
    key(combo(), 'ArrowDown');
    expect(active()).toBe('Add project');
    key(combo(), 'ArrowUp');
    expect(active()).toBe('web-store');
    key(combo(), 'Enter');
    expect(rows()).toBeNull();
    expect(combo().value).toBe('web-store');
    expect(dialog('New task')).not.toBeNull();

    // Esc closes the list and leaves the form and the choice.
    click(combo());
    type(combo(), 'agent');
    expect(rows()).toEqual(['agent-ops', 'Add project']);
    key(combo(), 'Escape');
    expect(rows()).toBeNull();
    expect(dialog('New task')).not.toBeNull();
    expect(combo().value).toBe('web-store');

    // The task goes to the chosen project's root, under that root's default project name.
    const body = await create();
    expect(body).toMatchObject({ title: 'Fix the header', root: 'web-store' });
    expect(body.project).toBeUndefined();
  });

  it('keeps the draft through Add project and selects the new project', async () => {
    await start();
    click(button('New task'));
    type(title(), 'Set up the shop');
    click(combo());
    const add = [...document.body.querySelectorAll('[role="option"]')].at(-1)!;
    expect(add.textContent).toContain('Add project');
    click(add);
    await settle();
    const d = dialog('Add project')!;
    expect(d).not.toBeNull();
    // The form is still there under the dialog.
    expect(title().value).toBe('Set up the shop');
    click(button('Create', d));
    await settle(300);

    expect(dialog('Add project')).toBeNull();
    expect(dialog('New task')).not.toBeNull();
    expect(title().value).toBe('Set up the shop');
    expect(combo().value).toBe('shop');
    click(combo());
    expect(rows()).toEqual(['agent-ops', 'web-store', 'docs-site', 'shop', 'Add project']);
    key(combo(), 'Escape');
    expect(await create()).toMatchObject({ title: 'Set up the shop', root: 'shop' });
  });

  it('opens with the project the Board is filtered to: button, shortcut and palette', async () => {
    await start();
    click(button('Board'));
    await settle();
    click(button('Project', document.querySelector('main')!));
    // The filter names the project of the tasks, which is not the root's name.
    click(button('swarmup-web'));

    click(button('New task'));
    expect(combo().value).toBe('web-store');
    click(button('Cancel', dialog('New task')!));
    expect(dialog('New task')).toBeNull();

    key(document.body, 'n');
    expect(combo().value).toBe('web-store');
    click(button('Cancel', dialog('New task')!));

    key(document.body, 'k', { ctrlKey: true });
    click(button('New task', dialog('Command palette') ?? document.body.lastElementChild!));
    expect(combo().value).toBe('web-store');
    // The task keeps the filter's project name, so it shows in the filtered board.
    expect(await create()).toMatchObject({ root: 'web-store', project: 'swarmup-web' });
  });

  it('lets you change the preselected project, which then takes its own project name', async () => {
    await start();
    click(button('Board'));
    await settle();
    click(button('Project', document.querySelector('main')!));
    click(button('swarmup-web'));
    click(button('New task'));
    click(combo());
    type(combo(), 'docs');
    key(combo(), 'Enter');
    expect(combo().value).toBe('docs-site');
    const body = await create();
    expect(body).toMatchObject({ root: 'docs-site' });
    expect(body.project).toBeUndefined();
  });

  it('opens with the project of a List filter, and with the default once the filter is gone', async () => {
    await start();
    // A sidebar project opens the list as `project:<name>`.
    click(button('web-store', document.querySelector('[data-projects]')!));
    await settle();
    click(button('New task'));
    expect(combo().value).toBe('web-store');
    click(button('Cancel', dialog('New task')!));

    // The filter bar of the list, set by hand.
    click(button('Tasks'));
    await settle();
    click(button('Project', document.querySelector('main')!));
    click(button('swarmup-web'));
    click(button('New task'));
    expect(combo().value).toBe('web-store');
    click(button('Cancel', dialog('New task')!));

    click(button('Inbox'));
    await settle();
    click(button('New task'));
    expect(combo().value).toBe('agent-ops');
    await settle();
  });
});
