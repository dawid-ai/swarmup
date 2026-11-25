// @vitest-environment happy-dom
// Settings dialogs sit above the page (AO-0338): the edit-agent dialog renders in a portal on
// document.body, outside every Settings section, so no section's toggle or field draws over it
// or takes its clicks. Focus moves into the dialog, Tab stays inside it, and focus goes back to
// the Edit button on close.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Nav } from '../ui/src/App';
import { Settings } from '../ui/src/views/Settings';

const ROLE = 'claude:writer';

const SETTINGS = {
  opsd: {
    runtimes: { claude: { command: 'claude' }, codex: { command: 'codex' } },
    roles: {},
    agents: {},
  },
  set: [],
  kept: [],
  rootList: [{ name: 'acme', dir: 'C:\\dev\\swarmup-store' }],
};

const DATA: Record<string, unknown> = {
  '/api/settings': SETTINGS,
  '/api/agents': [],
  '/api/doctor': [],
  '/api/kb': [],
  '/api/directory': [{ id: ROLE, source: 'role', name: 'Writer', status: 'active' }],
  [`/api/roles/${encodeURIComponent(ROLE)}`]: {
    id: ROLE,
    name: 'Writer',
    status: 'active',
    instructions: 'Write release notes.',
  },
};

vi.mock(import('../ui/src/api'), async (original) => ({
  ...(await original()),
  useData: <T>(path: string | null) => ({
    data: (path === null ? undefined : DATA[path]) as T | undefined,
    error: null,
    reload: vi.fn(),
    set: vi.fn() as (data: T) => void,
  }),
  useUpdate: () => ({ status: 'none', mode: 'manual', current: '0.3.0' }),
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

/** The Edit button of the role file's row in the Role files card (providers have one too). */
function editButton(): HTMLButtonElement {
  const found = [...box.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === 'Edit' && b.parentElement?.textContent?.includes('Writer'),
  );
  if (!found) throw new Error('no Edit button for the role file');
  return found;
}

function tab(shift = false): void {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true }),
    );
  });
}

describe('Settings: edit-agent dialog', () => {
  it('renders above the page in a portal, keeps focus inside and gives it back on close', () => {
    act(() =>
      root!.render(
        createElement(Settings, {
          nav: nav(),
          info: null,
          onRestarted: vi.fn(),
          section: 'agents',
        }),
      ),
    );
    // The Agents category has the page's own switches and fields under the dialog.
    expect(box.querySelectorAll('button[role="switch"], input').length).toBeGreaterThan(0);
    const edit = editButton();
    edit.focus();
    act(() => edit.click());

    const dialog = document.body.querySelector<HTMLElement>(
      `[role="dialog"][aria-label="Edit ${ROLE}"]`,
    );
    expect(dialog).not.toBeNull();
    // A child of body, not of the Settings page: no section's stacking context can hold it.
    expect(dialog!.parentElement).toBe(document.body);
    expect(box.contains(dialog)).toBe(false);
    expect(dialog!.closest('.animate-rise, .panel, section')).toBeNull();

    // Focus moved into the dialog, and Tab wraps at both ends instead of reaching the page.
    expect(dialog!.contains(document.activeElement)).toBe(true);
    const items = [
      ...dialog!.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])',
      ),
    ];
    const first = items[0]!;
    const last = items[items.length - 1]!;
    last.focus();
    tab();
    expect(document.activeElement).toBe(first);
    tab(true);
    expect(document.activeElement).toBe(last);
    // Focus on the page (a stray click left it there) comes back in on the next Tab.
    editButton().focus();
    tab();
    expect(document.activeElement).toBe(first);

    act(() => dialog!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(edit);
  });
});
