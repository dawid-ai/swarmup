// @vitest-environment happy-dom
// AO-0354: the desktop sidebar's project menu, archived group, safe delete copy and refused writes.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../ui/src/App';
import type { ListedProject } from '../ui/src/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const AGENT_OPS: ListedProject = {
  root: 'C:\\dev\\swarmup-store',
  name: 'agent-ops',
  label: 'Agent Ops',
  archived: false,
  found: true,
};
const SHOP: ListedProject = {
  root: 'C:\\dev\\shop',
  name: 'shop',
  label: 'Shop archive',
  archived: true,
  found: true,
};

let root: Root | undefined;
let box: HTMLDivElement;
let projects: ListedProject[];
let calls: Array<{ path: string; body?: Record<string, unknown> }>;
let refuse: string | null;
let relocate: { ok: boolean; data?: ListedProject[]; error?: string };

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
    projectRelocate: async () => relocate,
    call: async (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => {
      if (path === '/api/settings') {
        return {
          ok: true,
          data: {
            roots: ['C:\\dev\\swarmup-store', 'C:\\dev\\shop'],
            rootList: projects
              .filter((project) => !project.archived)
              .map((project) => ({
                name: project.name,
                label: project.label,
                dir: project.root,
                mirror: false,
                isMirror: false,
                isMaster: false,
              })),
            opsd: { agents: {}, runtimes: {} },
          },
        };
      }
      if (path === '/api/projects') return { ok: true, data: projects };
      if (path === '/api/waits') return { ok: true, data: { providers: {}, waits: [] } };
      if (method === 'POST' && path.startsWith('/api/projects/')) {
        calls.push({ path, body });
        if (refuse) return { ok: false, error: refuse };
        const project = projects.find((item) => item.root === body?.root)!;
        if (path.endsWith('/archive')) project.archived = true;
        if (path.endsWith('/unarchive')) project.archived = false;
        if (path.endsWith('/label')) project.label = String(body?.label ?? '') || project.name;
        if (path.endsWith('/remove')) projects = projects.filter((item) => item !== project);
        return { ok: true, data: [...projects] };
      }
      return { ok: true, data: [] };
    },
  } as unknown as NonNullable<Window['swarmup']>;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  projects = [{ ...AGENT_OPS }, { ...SHOP }];
  calls = [];
  refuse = null;
  relocate = { ok: true, data: projects };
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
  delete window.swarmup;
});

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function mount(): Promise<void> {
  act(() => root!.render(createElement(App)));
  await settle();
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

function rightClick(element: Element): void {
  act(() =>
    element.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 90 }),
    ),
  );
}

function type(input: HTMLInputElement, value: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function menu(): HTMLElement {
  const found = document.body.querySelector<HTMLElement>('[role="menu"][data-project-menu]');
  if (!found) throw new Error('no project menu');
  return found;
}

describe('project sidebar actions', () => {
  it('opens the right-click menu and moves projects through the collapsed Archived group', async () => {
    await mount();
    const archived = button('Archived1');
    expect(archived.getAttribute('aria-expanded')).toBe('false');
    expect(document.body.textContent).not.toContain('Shop archive');

    rightClick(button('Agent Ops'));
    expect([...menu().querySelectorAll('button')].map((item) => item.textContent?.trim())).toEqual([
      'Edit name',
      'Edit location',
      'Archive',
      'Delete',
    ]);
    click(button('Archive', menu()));
    await settle();
    expect(calls.at(-1)).toEqual({
      path: '/api/projects/archive',
      body: { root: 'C:\\dev\\swarmup-store' },
    });
    expect(button('Archived2').getAttribute('aria-expanded')).toBe('false');
    expect(document.body.querySelector('[data-projects]')!.textContent).not.toContain('Agent Ops');

    click(button('Archived2'));
    expect(document.body.querySelector('[data-projects]')!.textContent).toContain('Agent Ops');
    rightClick(button('Shop archive'));
    expect(button('Unarchive', menu())).toBeDefined();
    click(button('Unarchive', menu()));
    await settle();
    expect(calls.at(-1)?.path).toBe('/api/projects/unarchive');
    expect(button('Shop archive')).toBeDefined();
  });

  it('shows rename refusals and confirms that Delete leaves every file on disk', async () => {
    await mount();
    rightClick(button('Agent Ops'));
    click(button('Edit name', menu()));
    const rename = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    type(rename.querySelector('input')!, 'Control Plane');
    refuse = 'that project name is already used';
    click(button('Save name', rename));
    await settle();
    expect(rename.textContent).toContain('that project name is already used');

    refuse = null;
    click(button('Save name', rename));
    await settle();
    expect(button('Control Plane')).toBeDefined();

    rightClick(button('Control Plane'));
    click(button('Delete', menu()));
    const confirm = document.body.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Delete Control Plane?"]',
    )!;
    expect(confirm.textContent).toContain("only from SwarmUp's project list");
    expect(confirm.textContent).toContain('No files or folders on disk will be deleted.');
    click(button('Delete project', confirm));
    await settle();
    expect(calls.at(-1)?.path).toBe('/api/projects/remove');
    expect(document.body.querySelector('[data-projects]')!.textContent).not.toContain(
      'Control Plane',
    );
  });

  it('uses the system-folder bridge for Edit location and shows its refusal', async () => {
    await mount();
    relocate = { ok: false, error: 'the selected folder has no data root' };
    rightClick(button('Agent Ops'));
    click(button('Edit location', menu()));
    await settle();
    expect(document.body.textContent).toContain('the selected folder has no data root');

    refuse = 'the project is busy';
    rightClick(button('Agent Ops'));
    click(button('Archive', menu()));
    await settle();
    expect(document.body.textContent).toContain('the project is busy');
  });
});
