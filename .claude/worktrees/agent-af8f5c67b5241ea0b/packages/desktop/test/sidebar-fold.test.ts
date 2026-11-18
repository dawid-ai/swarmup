// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../ui/src/App';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let box: HTMLDivElement;
let navigate: ((message: unknown) => void) | undefined;

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
    onNavigate: (listener: (message: unknown) => void) => {
      navigate = listener;
      return () => {};
    },
    call: async (_method: 'GET' | 'POST', path: string) => {
      if (path === '/api/settings') {
        return {
          ok: true,
          data: {
            rootList: [{ name: 'agent-ops', dir: 'C:\\dev\\swarmup-store' }],
            opsd: { agents: {}, runtimes: {} },
          },
        };
      }
      if (path === '/api/waits') return { ok: true, data: { providers: {}, waits: [] } };
      return { ok: true, data: [] };
    },
  } as unknown as NonNullable<Window['swarmup']>;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  navigate = undefined;
  stubBridge();
  box = document.createElement('div');
  document.body.append(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
  window.localStorage.clear();
  delete window.swarmup;
});

async function mount(): Promise<void> {
  root = createRoot(box);
  act(() => root!.render(createElement(App)));
  await act(async () => {
    await Promise.resolve();
  });
}

function section(name: string): HTMLButtonElement {
  const header = document.body.querySelector<HTMLButtonElement>(
    `[aria-controls="sidebar-section-${name}"]`,
  );
  if (!header) throw new Error(`no ${name} section header`);
  return header;
}

function navItem(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>('nav button')].find(
    (button) => !button.hasAttribute('aria-controls') && button.textContent?.trim() === label,
  );
}

function click(element: Element): void {
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
}

async function sendNavigation(message: unknown): Promise<void> {
  await act(async () => {
    navigate?.(message);
    await Promise.resolve();
  });
}

describe('sidebar sections', () => {
  it('folds, unfolds and restores each section while keeping the active item visible', async () => {
    await mount();
    expect(section('work').getAttribute('aria-expanded')).toBe('true');
    expect(navItem('Board')).toBeDefined();

    click(section('work'));
    expect(section('work').getAttribute('aria-expanded')).toBe('false');
    expect(navItem('Inbox')).toBeDefined();
    expect(navItem('Board')).toBeUndefined();

    click(section('agents'));
    expect(navItem('Agents')).toBeUndefined();
    click(section('work'));
    expect(navItem('Board')).toBeDefined();
    expect(navItem('Agents')).toBeUndefined();

    click(section('work'));
    act(() => root!.unmount());
    root = undefined;
    box.replaceChildren();
    await mount();

    expect(section('work').getAttribute('aria-expanded')).toBe('false');
    expect(section('agents').getAttribute('aria-expanded')).toBe('false');
    expect(navItem('Inbox')).toBeDefined();
    expect(navItem('Board')).toBeUndefined();
    expect(navItem('Agents')).toBeUndefined();
  });

  it('shows the active item when the smoke command folds its section', async () => {
    await mount();
    await sendNavigation({ view: 'agents' });
    expect(navItem('Agents')).toBeDefined();
    expect(navItem('Runs')).toBeDefined();

    await sendNavigation({ view: 'sidebar-fold', id: 'agents' });
    expect(section('agents').getAttribute('aria-expanded')).toBe('false');
    expect(navItem('Agents')).toBeDefined();
    expect(navItem('Runs')).toBeUndefined();
  });
});
