// @vitest-environment happy-dom
// Project sidebar actions (AO-0335): a right click opens the project-local menu, Add new selects
// the project, Edit saves its settings, and Archive/restore and Remove update the sidebar.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../ui/src/App';
import type { RootInfo } from '../ui/src/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let app: Root | undefined;
let box: HTMLDivElement;
let roots: RootInfo[];
let writes: Array<{ path: string; body: unknown }>;

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
    call: async (method: 'GET' | 'POST', path: string, body?: unknown) => {
      if (method === 'GET' && path === '/api/settings') {
        return { ok: true, data: { rootList: roots } };
      }
      if (method === 'POST') {
        writes.push({ path, body });
        const name = decodeURIComponent(path.split('/')[3] ?? '');
        if (path.endsWith('/archive')) {
          roots = roots.map((r) =>
            r.name === name ? { ...r, archived: Boolean((body as { on?: boolean }).on) } : r,
          );
        } else if (path.endsWith('/edit')) {
          const input = body as {
            name: string;
            root: string;
            code: string | null;
            base: string | null;
          };
          roots = roots.map((r) =>
            r.name === name
              ? {
                  ...r,
                  name: input.name,
                  listed: input.root,
                  code: input.code ?? undefined,
                  base: input.base ?? undefined,
                }
              : r,
          );
        } else if (path.endsWith('/remove')) roots = roots.filter((r) => r.name !== name);
        return { ok: true, data: roots };
      }
      return { ok: true, data: [] };
    },
  } as unknown as NonNullable<Window['swarmup']>;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  roots = [
    {
      name: 'agent-ops',
      dir: 'C:\\dev\\swarmup\\.swarmup',
      listed: 'C:\\dev\\swarmup',
      code: 'C:\\dev\\swarmup',
      base: 'main',
      mirror: false,
      isMirror: false,
      isMaster: false,
    },
  ];
  writes = [];
  stubBridge();
  box = document.createElement('div');
  document.body.append(box);
  app = createRoot(box);
});

afterEach(() => {
  act(() => app?.unmount());
  app = undefined;
  box.remove();
  delete window.swarmup;
});

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function button(text: string, within: ParentNode = document.body): HTMLButtonElement {
  const found = [...within.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no ${text} button`);
  return found;
}

function click(el: Element): void {
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
}

function context(el: Element): void {
  act(() =>
    el.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 80 }),
    ),
  );
}

function type(el: HTMLInputElement, value: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function start(): Promise<void> {
  act(() => app!.render(createElement(App)));
  await settle();
}

function project(): HTMLButtonElement {
  return button('agent-ops', document.querySelector('[data-projects]')!);
}

describe('project sidebar menu', () => {
  it('opens New task with its project and edits the project settings', async () => {
    await start();
    context(project());
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(
      [...menu.querySelectorAll('[role="menuitem"]')].map((x) => x.textContent?.trim()),
    ).toEqual(['Add new', 'Edit', 'Archive', 'Remove']);
    click(button('Add new', menu));
    await settle();
    const fresh = document.querySelector<HTMLElement>('[role="dialog"][aria-label="New task"]')!;
    expect(fresh.querySelector<HTMLInputElement>('[aria-label="Project"]')!.value).toBe(
      'agent-ops',
    );
    click(fresh.querySelector('[aria-label="Close"]')!);

    context(project());
    click(button('Edit', document.querySelector('[role="menu"]')!));
    const edit = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Edit agent-ops"]',
    )!;
    const inputs = [...edit.querySelectorAll<HTMLInputElement>('input')];
    expect(inputs.map((i) => i.value)).toEqual([
      'agent-ops',
      'C:\\dev\\swarmup',
      'C:\\dev\\swarmup',
      'main',
    ]);
    type(inputs[0]!, 'swarmup');
    click(button('Save project', edit));
    await settle(300);
    expect(writes.at(-1)).toEqual({
      path: '/api/roots/agent-ops/edit',
      body: {
        name: 'swarmup',
        root: 'C:\\dev\\swarmup',
        code: 'C:\\dev\\swarmup',
        base: 'main',
      },
    });
    expect(document.querySelector('[data-projects]')!.textContent).toContain('swarmup');
  });

  it('archives and restores under the folded group, then confirms non-destructive removal', async () => {
    await start();
    context(project());
    click(button('Archive', document.querySelector('[role="menu"]')!));
    await settle(300);
    const archived = document.querySelector<HTMLElement>('[data-archived-projects]')!;
    expect(archived).not.toBeNull();
    expect(archived.getAttribute('aria-expanded')).toBeNull();
    click(archived.querySelector('button')!);
    context(button('agent-ops', archived));
    click(button('Restore', document.querySelector('[role="menu"]')!));
    await settle(300);
    expect(document.querySelector('[data-archived-projects]')).toBeNull();

    context(project());
    click(button('Remove', document.querySelector('[role="menu"]')!));
    const confirm = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Remove agent-ops?"]',
    )!;
    expect(confirm.textContent).toContain('no files or folders are deleted');
    expect(writes.some((w) => w.path.endsWith('/remove'))).toBe(false);
    click(button('Remove from SwarmUp', confirm));
    await settle(300);
    expect(writes.at(-1)?.path).toBe('/api/roots/agent-ops/remove');
    expect(document.querySelector('[data-projects]')!.textContent).not.toContain('agent-ops');
  });
});
