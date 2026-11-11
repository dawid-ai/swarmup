// @vitest-environment happy-dom
// The whole app, rendered (AO-0161): a window already open on the Board reads `/api/waits` again
// when swarmupd sends a `merge` event, so the merge shows as it starts and as it moves on to the next
// step, without waiting for another kind of change.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../ui/src/App';
import type { MergeStatus } from '../ui/src/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

type Handler = (m: unknown) => void;

let root: Root | undefined;
let box: HTMLDivElement;
let data: Record<string, unknown>;
let handlers: Record<'event' | 'navigate', Handler[]>;

const MERGE: MergeStatus = {
  task: 'swarmup/AO-0157',
  what: '0b55674 on branch claude/ao-0157-x',
  base: 'v2',
  top: 'C:/dev/agent-ops',
  step: 'checks',
  holds: false,
  started_at: new Date(Date.now() - 60_000).toISOString(),
  command: {
    text: 'npm test',
    index: 0,
    count: 1,
    started_at: new Date(Date.now() - 30_000).toISOString(),
  },
  timeout_minutes: 30,
};

/** A stand-in for the preload bridge: swarmupd answers from `data`; the app's listeners are kept. */
function stubBridge(): void {
  const off = (): (() => void) => () => {};
  const keep =
    (kind: 'event' | 'navigate') =>
    (fn: Handler): (() => void) => {
      handlers[kind].push(fn);
      return () => {
        handlers[kind] = handlers[kind].filter((h) => h !== fn);
      };
    };
  window.swarmup = {
    info: async () => ({ pid: 1, port: 1, version: 'test', me: 'human:dawid' }),
    setupStatus: async () => ({ needed: false }),
    desktop: async () => ({ ok: false }),
    update: async () => ({ ok: false }),
    onService: off,
    onUpdate: off,
    onEvent: keep('event'),
    onStatus: off,
    onNavigate: keep('navigate'),
    call: async (_method: 'GET' | 'POST', path: string) => ({
      ok: true,
      data: data[path.split('?')[0]!] ?? [],
    }),
  } as unknown as NonNullable<Window['swarmup']>;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  handlers = { event: [], navigate: [] };
  data = {
    '/api/waits': { providers: {}, waits: [], merge: null },
    '/api/settings': { opsd: { agents: {}, runtimes: {} } },
  };
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

async function send(kind: 'event' | 'navigate', m: unknown): Promise<void> {
  act(() => handlers[kind].forEach((h) => h(m)));
  await settle(400);
}

const panel = (): string | null =>
  box.querySelector('[data-testid="merge-under-way"]')?.textContent?.replace(/\s+/g, ' ') ?? null;

describe('App: a merge event reads the merge again (AO-0161)', () => {
  it('shows the merge in an open Board when it starts and when it changes steps', async () => {
    act(() => root!.render(createElement(App)));
    await settle();
    await send('navigate', { view: 'board' });
    expect(panel()).toBeNull();

    data['/api/waits'] = { providers: {}, waits: [], merge: MERGE };
    await send('event', { event: 'merge', data: MERGE });
    expect(panel()).toContain('npm test');

    const build: MergeStatus = {
      ...MERGE,
      step: 'build',
      holds: true,
      command: { ...MERGE.command!, text: 'npm run build' },
    };
    data['/api/waits'] = { providers: {}, waits: [], merge: build };
    await send('event', { event: 'merge', data: build });
    expect(panel()).toContain('npm run build');

    data['/api/waits'] = { providers: {}, waits: [], merge: null };
    await send('event', { event: 'merge', data: null });
    expect(panel()).toBeNull();
  });
});
