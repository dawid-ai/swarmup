// @vitest-environment happy-dom
// Settings categories (AO-0337): a deep link picks one category, switching remembers it, and a
// plain Settings open returns to the remembered category.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Nav } from '../ui/src/App';
import { SETTINGS_CATEGORIES, Settings, settingsCategory } from '../ui/src/views/Settings';

vi.mock(import('../ui/src/api'), async (original) => ({
  ...(await original()),
  useData: <T>(path: string | null) => ({
    data: (path === '/api/doctor' || path === '/api/agents' ? [] : undefined) as T | undefined,
    error: null,
    reload: vi.fn(),
    set: vi.fn() as (data: T) => void,
  }),
  useUpdate: () => ({ status: 'none', current: '0.3.0' }),
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let box: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  box = document.createElement('div');
  document.body.append(box);
  root = createRoot(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
});

function nav(): Nav {
  return { me: 'human:dawid', openTask: vi.fn(), go: vi.fn() };
}

function selected(): HTMLElement | null {
  return box.querySelector('[role="tab"][aria-selected="true"]');
}

function tab(name: string): HTMLButtonElement {
  const found = [...box.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (button) => button.textContent?.trim() === name,
  );
  if (!found) throw new Error(`no ${name} settings tab`);
  return found;
}

describe('Settings categories', () => {
  it('resolves category links, older section links and a remembered category', () => {
    expect(settingsCategory('updates', 'health')).toBe('updates');
    expect(settingsCategory('providers', 'health')).toBe('agents');
    expect(settingsCategory(undefined, 'cleanup')).toBe('cleanup');
    expect(settingsCategory('unknown', 'unknown')).toBe('general');
  });

  it('switches from a linked category and remembers the selection', () => {
    const n = nav();
    act(() =>
      root!.render(
        createElement(Settings, {
          nav: n,
          info: null,
          onRestarted: vi.fn(),
          section: 'health',
        }),
      ),
    );

    expect(box.querySelectorAll('[role="tab"]')).toHaveLength(SETTINGS_CATEGORIES.length);
    expect(selected()?.getAttribute('data-settings-category')).toBe('health');
    expect(box.textContent).toContain('Health checks');

    act(() => tab('Updates').click());
    expect(n.go).toHaveBeenCalledWith('settings', 'updates');
    expect(selected()?.getAttribute('data-settings-category')).toBe('updates');
    expect(box.textContent).toContain('You have the newest version.');
    expect(window.localStorage.getItem('swarmup.settings.category')).toBe('updates');

    act(() => root!.unmount());
    root = createRoot(box);
    act(() =>
      root!.render(createElement(Settings, { nav: nav(), info: null, onRestarted: vi.fn() })),
    );
    expect(selected()?.getAttribute('data-settings-category')).toBe('updates');
  });
});
