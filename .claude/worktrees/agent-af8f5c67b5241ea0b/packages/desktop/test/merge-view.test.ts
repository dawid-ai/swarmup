// @vitest-environment happy-dom
// The merge swarmupd runs now, in the Agents view (AO-0161): the task, the base, the step and its
// command with the time so far against its timeout, and the work that waits for it. A merge can
// hold every writing run, so without it the queue looks stuck.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Nav } from '../ui/src/App';
import type { MergeStatus, WaitItem } from '../ui/src/types';
import { Agents } from '../ui/src/views/Agents';

const net = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));

vi.mock(import('../ui/src/api'), async (original) => ({
  ...(await original()),
  useData: <T>(path: string | null) => ({
    data: (path === null ? undefined : net.data[path]) as T | undefined,
    error: null,
    reload: () => {},
    set: () => {},
  }),
  api: async <T>(): Promise<T> => ({}) as T,
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let box: HTMLDivElement;
let nav: Nav;

const ago = (min: number): string => new Date(Date.now() - min * 60_000 - 1_000).toISOString();

const MERGE: MergeStatus = {
  task: 'swarmup/AO-0157',
  what: '0b55674 on branch claude/ao-0157-x',
  base: 'v2',
  top: 'C:/dev/agent-ops',
  step: 'build',
  holds: true,
  started_at: ago(12),
  command: { text: 'npm run build', index: 1, count: 2, started_at: ago(4) },
  timeout_minutes: 30,
};

const HELD: WaitItem = {
  kind: 'task',
  task: 'swarmup/AO-0158',
  title: 'Other work',
  project: 'swarmup',
  review: false,
  agents: ['claude:engineer'],
  reason: 'claude:engineer: swarmupd merges swarmup/AO-0157 into v2 in C:/dev/agent-ops',
  merge: true,
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  net.data = {
    '/api/agents': [],
    '/api/runs?live': [],
    '/api/tasks': [],
    '/api/machines': [],
    '/api/waits': { providers: {}, waits: [HELD], merge: MERGE },
    '/api/directory': [],
    '/api/settings': { opsd: { budget_minutes: 90, agents: {}, runtimes: {} } },
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
  nav = { me: null, openTask: vi.fn(), go: vi.fn() } as unknown as Nav;
  root = createRoot(box);
  act(() => root!.render(createElement(Agents, { nav })));
}

describe('Agents view: the merge under way (AO-0161)', () => {
  it('shows the task, base, command, elapsed time, timeout and the held work', () => {
    mount();
    const panel = box.querySelector<HTMLElement>('[data-testid="merge-under-way"]');
    expect(panel).not.toBeNull();
    const text = panel!.textContent!.replace(/\s+/g, ' ');
    // The parts of a row sit apart by layout gaps, not spaces.
    expect(text).toMatch(/swarmupd merges ?AO-0157 ?into v2 ?12m so far/);
    expect(text).toContain('Builds v2: 2/2 npm run build, 4m of its 30m timeout');
    expect(text).toContain('No new writing run starts in C:/dev/agent-ops until the build ends.');
    expect(text).toMatch(/Waiting for it: ?AO-0158/);
    const held = [...panel!.querySelectorAll('button')].find((b) => b.textContent === 'AO-0158');
    act(() => held!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(nav.openTask).toHaveBeenCalledWith('swarmup/AO-0158');
  });

  it('shows no merge when swarmupd runs none, or is older than the merge status', () => {
    net.data['/api/waits'] = { providers: {}, waits: [], merge: null };
    mount();
    expect(box.querySelector('[data-testid="merge-under-way"]')).toBeNull();
    act(() => root?.unmount());
    net.data['/api/waits'] = { providers: {}, waits: [] };
    root = createRoot(box);
    act(() => root!.render(createElement(Agents, { nav })));
    expect(box.querySelector('[data-testid="merge-under-way"]')).toBeNull();
  });
});
