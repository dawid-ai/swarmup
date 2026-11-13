// @vitest-environment happy-dom
// The Cleanup section of Settings (AO-0298): the switch for removing closed tasks' worktrees, the
// grace period and scratch days, and the worktrees the last sweep held back.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../ui/src/types';
import { CleanupCard } from '../ui/src/views/Settings';

const net = vi.hoisted(() => ({ posts: [] as Array<{ path: string; body: unknown }> }));

vi.mock(import('../ui/src/api'), async (original) => ({
  ...(await original()),
  api: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    if (method === 'POST') net.posts.push({ path, body });
    return {} as T;
  },
  refreshSoon: () => {},
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let box: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  net.posts.length = 0;
  box = document.createElement('div');
  document.body.append(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
});

function settings(more: {
  opsd?: Partial<Settings['opsd']>;
  set?: string[];
  kept?: Settings['kept'];
}): Settings {
  return {
    opsd: { reclaim_worktrees: true, reclaim_after_minutes: 60, scratch_days: 7, ...more.opsd },
    set: more.set ?? [],
    kept: more.kept ?? [],
  } as Settings;
}

function mount(data: Settings): ReturnType<typeof vi.fn> {
  const onSaved = vi.fn();
  root = createRoot(box);
  act(() => root!.render(createElement(CleanupCard, { data, onSaved })));
  return onSaved;
}

function type(input: HTMLInputElement, text: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const toggle = (): HTMLButtonElement => box.querySelector('button[role="switch"]')!;
const save = (): HTMLButtonElement =>
  [...box.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save')!;
const inputs = (): HTMLInputElement[] => [...box.querySelectorAll('input')];

describe('Settings: cleanup', () => {
  it('shows cleanup on by default, with the defaults as hints and nothing to save', () => {
    mount(settings({}));
    expect(box.textContent).toContain('Remove the worktrees of closed tasks');
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(inputs().map((i) => [i.value, i.placeholder])).toEqual([
      ['', '60'],
      ['', '7'],
    ]);
    expect(save().disabled).toBe(true);
    expect(box.textContent).toContain('Nothing: the sweep left no closed task');
  });

  it('turns the removal off and saves only what changed', async () => {
    const onSaved = mount(settings({}));
    await click(toggle());
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(box.textContent).toContain('every task worktree stays');
    type(inputs()[0]!, '15');
    await click(save());
    expect(net.posts).toEqual([
      {
        path: '/api/settings',
        body: { patch: { opsd: { reclaim_worktrees: false, reclaim_after_minutes: 15 } } },
      },
    ]);
    expect(onSaved).toHaveBeenCalled();
  });

  it('shows a hand-written off and the saved numbers, and turns it on again', async () => {
    mount(
      settings({
        opsd: { reclaim_worktrees: false, reclaim_after_minutes: 5, scratch_days: 2 },
        set: ['reclaim_worktrees', 'reclaim_after_minutes', 'scratch_days'],
      }),
    );
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(inputs().map((i) => i.value)).toEqual(['5', '2']);
    // An emptied field goes back to the default.
    type(inputs()[1]!, '');
    await click(toggle());
    await click(save());
    expect(net.posts).toEqual([
      {
        path: '/api/settings',
        body: { patch: { opsd: { reclaim_worktrees: true, scratch_days: null } } },
      },
    ]);
  });

  it('lists the worktrees the last sweep held back, with the reason', () => {
    mount(
      settings({
        kept: [
          {
            task: 'swarmup/AO-0244',
            path: 'C:/dev/swarmup/out/wt-AO-0244',
            reason: 'uncommitted changes (notes.md and 2 more)',
          },
          {
            task: 'swarmup/AO-0250',
            path: 'C:/dev/swarmup/out/wt-AO-0250',
            reason: 'its merge is pending',
          },
        ],
      }),
    );
    const rows = [...box.querySelectorAll('li')].map((li) => li.textContent);
    expect(rows).toEqual([
      'swarmup/AO-0244: uncommitted changes (notes.md and 2 more)C:/dev/swarmup/out/wt-AO-0244',
      'swarmup/AO-0250: its merge is pending' + 'C:/dev/swarmup/out/wt-AO-0250',
    ]);
    expect(box.textContent).not.toContain('Nothing: the sweep left');
  });
});
