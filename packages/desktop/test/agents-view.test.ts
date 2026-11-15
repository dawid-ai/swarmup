// @vitest-environment happy-dom
// The Agents view, rendered: an agent whose wake is on sits among the agent cards, and its card
// has the Wake switch and budget, so wake turned on anywhere can be turned off there.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Nav } from '../ui/src/App';
import { AddAgentDialog, Agents } from '../ui/src/views/Agents';

const net = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  posts: [] as Array<{ path: string; body: unknown }>,
}));

vi.mock(import('../ui/src/api'), async (original) => ({
  ...(await original()),
  useData: <T>(path: string | null) => ({
    data: (path === null ? undefined : net.data[path]) as T | undefined,
    error: null,
    reload: () => {},
    set: () => {},
  }),
  api: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    if (method === 'POST') net.posts.push({ path, body });
    return {} as T;
  },
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let box: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  net.posts.length = 0;
  net.data = {
    '/api/agents': [
      { id: 'claude:pm', status: 'active', wake: true, live: null },
      { id: 'codex:qa', status: 'active', wake: false, live: null },
    ],
    '/api/runs?live': [],
    '/api/tasks': [],
    '/api/machines': [],
    '/api/waits': { providers: {}, waits: [] },
    '/api/directory': [],
    '/api/settings': {
      opsd: {
        budget_minutes: 90,
        agents: { 'claude:pm': { wake: true }, 'codex:qa': { budget: '30m' } },
        runtimes: {},
      },
    },
  };
  box = document.createElement('div');
  document.body.append(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
});

function mount(): void {
  const nav = { me: null, openTask: vi.fn(), go: vi.fn() } as unknown as Nav;
  root = createRoot(box);
  act(() => root!.render(createElement(Agents, { nav })));
}

/** The agent card that names `id`. */
function card(id: string): HTMLElement {
  const cards = [...box.querySelectorAll<HTMLElement>('.panel')].filter((p) =>
    [...p.querySelectorAll('button')].some((b) => b.textContent === 'Start run'),
  );
  const found = cards.find((c) => c.textContent?.includes(id.split(':')[1]!));
  if (!found) throw new Error(`no card for ${id}`);
  return found;
}

function wakeSwitch(el: HTMLElement): HTMLButtonElement {
  const s = el.querySelector<HTMLButtonElement>('button[role="switch"]');
  if (!s) throw new Error('no Wake switch');
  return s;
}

describe('Agents view: wake on the agent cards', () => {
  it('turns wake off from the card of an agent that wakes', async () => {
    mount();
    const s = wakeSwitch(card('claude:pm'));
    expect(s.getAttribute('aria-checked')).toBe('true');
    await act(async () => {
      s.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(net.posts).toEqual([
      {
        path: '/api/settings',
        body: { patch: { opsd: { agents: { 'claude:pm': { wake: false } } } } },
      },
    ]);
  });

  it('shows the switch, off, and the saved budget on a card whose wake is off', () => {
    mount();
    const c = card('codex:qa');
    expect(wakeSwitch(c).getAttribute('aria-checked')).toBe('false');
    const inputs = [...c.querySelectorAll('input')].map((i) => i.value);
    expect(inputs).toContain('30m');
  });
});

function type(input: HTMLInputElement, text: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(el: HTMLElement, label: string): Promise<void> {
  const b = [...el.querySelectorAll('button')].find((x) => x.textContent?.trim() === label);
  if (!b) throw new Error(`no button '${label}'`);
  await act(async () => {
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('Agents view: adding, editing and removing agents', () => {
  beforeEach(() => {
    (net.data['/api/settings'] as { opsd: { runtimes: unknown } }).opsd.runtimes = {
      claude: { command: 'claude', paused: false },
      codex: { command: 'codex', paused: false, model: 'o3' },
    };
  });

  it("saves a model override from the card, with the provider's model as the hint", async () => {
    mount();
    const c = card('codex:qa');
    const model = c.querySelector<HTMLInputElement>('input[placeholder="o3"]')!;
    type(model, 'gpt-5-codex');
    await click(c, 'Save');
    expect(net.posts).toEqual([
      {
        path: '/api/settings',
        body: { patch: { opsd: { agents: { 'codex:qa': { model: 'gpt-5-codex' } } } } },
      },
    ]);
  });

  it('removes an agent of the swarmupd config after a second click', async () => {
    mount();
    const c = card('codex:qa');
    await click(c, 'Remove');
    expect(net.posts).toEqual([]);
    await click(c, 'Remove');
    expect(net.posts).toEqual([
      { path: '/api/settings', body: { patch: { opsd: { agents: { 'codex:qa': null } } } } },
    ]);
  });

  it('adds an agent on a provider from Settings', async () => {
    mount();
    await click(box, 'Add agent');
    type(box.querySelector<HTMLInputElement>('input[placeholder="writer"]')!, 'writer');
    await click(box, 'Add claude:writer');
    expect(net.posts).toEqual([
      {
        path: '/api/settings',
        body: { patch: { opsd: { agents: { 'claude:writer': { wake: false } } } } },
      },
    ]);
  });

  it('Add agent dialog fills in a not configured id from a picker and reports it (AO-0124)', async () => {
    (net.data['/api/settings'] as { opsd: { runtimes: object } }).opsd.runtimes = {
      claude: { command: 'claude' },
      codex: { command: 'codex' },
    };
    const onAdded = vi.fn();
    const onClose = vi.fn();
    root = createRoot(box);
    act(() =>
      root!.render(createElement(AddAgentDialog, { id: 'codex:orchestrator', onAdded, onClose })),
    );
    expect(box.querySelector<HTMLInputElement>('input[placeholder="writer"]')!.value).toBe(
      'orchestrator',
    );
    expect(box.querySelector('select')!.value).toBe('codex');
    await click(box, 'Add codex:orchestrator');
    expect(net.posts).toEqual([
      {
        path: '/api/settings',
        body: { patch: { opsd: { agents: { 'codex:orchestrator': { wake: false } } } } },
      },
    ]);
    expect(onAdded).toHaveBeenCalledWith('codex:orchestrator');
    expect(onClose).toHaveBeenCalled();
  });

  it('marks an agent whose provider was removed', () => {
    net.data['/api/agents'] = [
      { id: 'grok:qa', status: 'active', wake: false, live: null, provider: false },
    ];
    mount();
    expect(card('grok:qa').textContent).toContain('no provider');
  });
});

describe('Agents view: model suggestions and the unknown-model warning', () => {
  beforeEach(() => {
    (net.data['/api/settings'] as { opsd: { runtimes: unknown } }).opsd.runtimes = {
      claude: { command: 'claude', paused: false },
      codex: { command: 'codex', paused: false, model: 'o3' },
    };
  });

  /** The Model field inside `el` and the suggestions its datalist holds now. */
  function modelField(el: HTMLElement): { input: HTMLInputElement; options: () => string[] } {
    const input = el.querySelector<HTMLInputElement>('input[list]')!;
    const options = (): string[] =>
      [...document.getElementById(input.getAttribute('list')!)!.querySelectorAll('option')].map(
        (o) => o.value,
      );
    return { input, options };
  }

  it("suggests Claude's models as you type on a Claude agent", () => {
    mount();
    const f = modelField(card('claude:pm'));
    expect(f.options()).toContain('opus');
    expect(f.options()).not.toContain('gpt-5');
    type(f.input, 'son');
    expect(f.options()).toEqual(['sonnet', 'claude-sonnet-5-5', 'claude-sonnet-4-5']);
    type(f.input, 'claude-sonnet-5-5');
    expect(card('claude:pm').querySelector('[role="status"]')).toBeNull();
  });

  it("suggests Codex's models as you type on a Codex agent", () => {
    mount();
    const f = modelField(card('codex:qa'));
    expect(f.options()).toContain('gpt-5-codex');
    expect(f.options()).not.toContain('opus');
    type(f.input, '5.1-codex');
    expect(f.options()).toEqual(['gpt-5.1-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini']);
    type(f.input, 'gpt-5.1-codex');
    expect(card('codex:qa').querySelector('[role="status"]')).toBeNull();
  });

  it('warns on a name outside the list and still saves it', async () => {
    mount();
    const c = card('codex:qa');
    type(modelField(c).input, 'gpt-9-preview');
    expect(c.querySelector('[role="status"]')?.getAttribute('title')).toMatch(
      /^Not a known codex model \(list of \d{4}-\d{2}-\d{2}\)/,
    );
    await click(c, 'Save');
    expect(net.posts).toEqual([
      {
        path: '/api/settings',
        body: { patch: { opsd: { agents: { 'codex:qa': { model: 'gpt-9-preview' } } } } },
      },
    ]);
  });

  it('suggests and warns for the provider chosen in Add agent', () => {
    root = createRoot(box);
    act(() =>
      root!.render(createElement(AddAgentDialog, { id: 'claude:writer', onClose: () => {} })),
    );
    const f = modelField(document.body);
    expect(f.options()).toContain('haiku');
    type(f.input, 'gpt-5');
    expect(document.body.textContent).toContain('Not a known claude model');
    type(f.input, 'haiku');
    expect(document.body.textContent).not.toContain('Not a known claude model');
  });
});
