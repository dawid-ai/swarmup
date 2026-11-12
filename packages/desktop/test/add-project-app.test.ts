// @vitest-environment happy-dom
// The whole app, rendered (AO-0274): Add project in the sidebar shows the proposal for the picked
// repo, sends what the person kept on Create, and lists the new project without a restart. A
// pick that fails shows in the dialog; a folder with a data root joins the list with no dialog.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../ui/src/App';
import type { ProjectPlan, ProjectProposal } from '../ui/src/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

function plan(name: string): ProjectPlan {
  return {
    name,
    prefix: name.slice(0, 3).toUpperCase(),
    agents: [{ id: 'claude:qa', why: '1 test files to keep green' }],
    tasks: [
      { title: `Record the baseline: build and test ${name}`, body: '', priority: 'p2' },
      { title: `Write AGENTS.md for ${name}`, body: '', priority: 'p2' },
      { title: 'Run the build and tests in CI', body: '', priority: 'p3' },
    ],
  };
}

const PROPOSAL: ProjectProposal = {
  kind: 'proposal',
  dir: 'C:\\dev\\shop',
  branch: 'main',
  survey: {
    dir: 'C:\\dev\\shop',
    name: 'shop',
    stacks: ['node', 'typescript'],
    frameworks: ['react'],
    tests: { runner: 'vitest', command: 'npm test', files: 1 },
    build: 'npm run build',
    lint: null,
    docs: ['README.md'],
    ci: [],
    agentDocs: [],
  },
  plan: plan('shop'),
};

let root: Root | undefined;
let box: HTMLDivElement;
/** What the next folder pick answers with. */
let pick: unknown;
let created: unknown[];
let roots: Array<{ name: string; dir: string }>;

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
    projectPick: async () => pick,
    projectPlan: async (name: string) => ({ ok: true, data: plan(name) }),
    projectStore: async () => ({ ok: true, data: { dir: 'C:\\dev\\shop-tasks' } }),
    projectCreate: async (input: { name: string; tasks: number[]; where: string }) => {
      created.push(input);
      if (input.name === 'taken')
        return { ok: false, error: "a data root named 'taken' is loaded" };
      roots.push({ name: input.name, dir: 'C:\\dev\\shop' });
      return {
        ok: true,
        data: {
          name: input.name,
          dir: 'C:\\dev\\shop\\.swarmup',
          store: null,
          base: null,
          tasks: input.tasks.map((i) => ({ id: `T-${i}`, title: 't' })),
          reloaded: true,
        },
      };
    },
    call: async (_method: 'GET' | 'POST', path: string) => {
      if (path === '/api/settings') return { ok: true, data: { rootList: roots } };
      return { ok: true, data: [] };
    },
  } as unknown as NonNullable<Window['swarmup']>;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  pick = { ok: true, data: PROPOSAL };
  created = [];
  roots = [{ name: 'agent-ops', dir: 'C:\\dev\\swarmup-store' }];
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

/** Lets bridge promises, the plan's 300 ms wait and the 250 ms shared refresh run. */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

function button(text: string, within: ParentNode = document.body): HTMLButtonElement {
  const b = [...within.querySelectorAll('button')].find((x) => x.textContent?.trim() === text);
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

function dialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="Add project"]');
}

function projects(): string[] {
  const group = document.body.querySelector('[data-projects]')!;
  return [...group.querySelectorAll('button')].map((b) => b.textContent!.trim());
}

async function start(): Promise<void> {
  act(() => root!.render(createElement(App)));
  await settle();
}

describe('Add project', () => {
  it('shows the proposal, creates what was kept, and lists the new project', async () => {
    await start();
    expect(projects()).toEqual(['agent-ops', 'Add project']);
    click(button('Add project'));
    await settle();
    const d = dialog()!;
    expect(d).not.toBeNull();
    for (const text of [
      'C:\\dev\\shop',
      'node, typescript',
      'react',
      '1 files, vitest (npm test)',
      'npm run build',
      'README.md',
      'claude:qa',
      'Write AGENTS.md for shop',
      'Nothing is written until you create it.',
    ]) {
      expect(d.textContent).toContain(text);
    }
    expect(created).toEqual([]);

    // A new name gets its own task titles and prefix; a typed prefix then stays.
    const [name, prefix] = [...d.querySelectorAll<HTMLInputElement>('input[type="text"]')];
    type(name!, 'web store');
    await settle(350);
    expect(d.textContent).toContain('Write AGENTS.md for web store');
    expect(prefix!.value).toBe('WEB');
    type(prefix!, 'ws');
    // Untick the second task.
    click(d.querySelectorAll('input[type="checkbox"]')[1]!);
    click(button('Create', d));
    await settle(300);
    expect(created).toEqual([{ name: 'web store', prefix: 'WS', tasks: [0, 2], where: 'repo' }]);
    expect(dialog()).toBeNull();
    expect(projects()).toEqual(['agent-ops', 'web store', 'Add project']);
    expect(document.body.textContent).toContain('Created web store with 2 tasks');
  });

  it('needs a folder for tasks kept apart, and shows a refused Create in the dialog', async () => {
    await start();
    click(button('Add project'));
    await settle();
    const d = dialog()!;
    type(d.querySelector<HTMLInputElement>('input[type="text"]')!, 'taken');
    click(d.querySelectorAll('input[type="radio"]')[1]!);
    expect(button('Create', d).disabled).toBe(true);
    expect(d.textContent).toContain('approved work merges into main');
    click(button('Pick or create a folder', d));
    await settle(350);
    expect(d.textContent).toContain('C:\\dev\\shop-tasks');
    click(button('Create', d));
    await settle();
    expect(created).toEqual([{ name: 'taken', prefix: 'TAK', tasks: [0, 1, 2], where: 'store' }]);
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain("a data root named 'taken' is loaded");
  });

  it('shows a failed pick in the dialog, and adds a folder that has a root without one', async () => {
    await start();
    pick = { ok: false, error: 'C:\\tmp is not a git repo: run `git init` there first' };
    click(button('Add project'));
    await settle();
    expect(dialog()!.textContent).toContain('C:\\tmp is not a git repo');
    // Picking again from the dialog; a closed folder dialog closes it.
    pick = { ok: false, error: 'cancelled' };
    click(button('Pick another folder', dialog()!));
    await settle();
    expect(dialog()).toBeNull();

    pick = {
      ok: true,
      data: { kind: 'added', dir: 'C:\\dev\\site', name: 'site', added: true, reloaded: true },
    };
    roots.push({ name: 'site', dir: 'C:\\dev\\site' });
    click(button('Add project'));
    await settle(300);
    expect(dialog()).toBeNull();
    expect(projects()).toEqual(['agent-ops', 'site', 'Add project']);
    expect(document.body.textContent).toContain('Added site: it has a data root already');
  });
});
