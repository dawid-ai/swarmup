// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderUsage } from '../ui/src/types';
import { ProviderStatusBar, resetIn } from '../ui/src/ui/provider-status';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const NOW = Date.parse('2026-11-15T10:00:00Z');
let root: Root | undefined;
let box: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  box = document.createElement('div');
  document.body.append(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
});

function usage(patch: Partial<ProviderUsage> = {}): ProviderUsage {
  return { windows: {}, paused: null, live: 0, ...patch };
}

function mount(providers: Record<string, ProviderUsage>, onOpen = vi.fn()): typeof onOpen {
  root = createRoot(box);
  act(() =>
    root!.render(createElement(ProviderStatusBar, { providers, pauseAt: 0.9, now: NOW, onOpen })),
  );
  return onOpen;
}

describe('provider status bar', () => {
  it('shows normal usage, its reset, and opens provider details', () => {
    const open = mount({
      codex: usage({
        windows: {
          seven_day: { utilization: 0.12, resets_at: NOW + 3 * 86_400_000 + 3 * 3_600_000 },
        },
      }),
    });
    const item = box.querySelector<HTMLButtonElement>('[data-provider="codex"]')!;
    expect(item.textContent).toContain('Codex');
    expect(item.textContent).toContain('12% · 3d 3h');
    expect(item.dataset.state).toBe('normal');
    act(() => item.click());
    expect(open).toHaveBeenCalledWith('codex');
  });

  it('uses warning color at the configured pause threshold', () => {
    mount({
      claude: usage({
        windows: {
          five_hour: { utilization: 0.4, resets_at: NOW + 60_000 },
          seven_day: { utilization: 0.92, resets_at: NOW + 3_600_000 },
        },
      }),
    });
    const item = box.querySelector<HTMLElement>('[data-provider="claude"]')!;
    expect(item.textContent).toContain('Claude');
    expect(item.textContent).toContain('92%');
    expect(item.dataset.state).toBe('warning');
    expect(item.className).toContain('text-warn');
  });

  it('shows signed-out and expired sign-in states instead of stale usage', () => {
    mount({
      codex: usage({
        windows: { seven_day: { utilization: 0.12, resets_at: NOW + 60_000 } },
        signed_out: {
          since: '2026-11-15T09:00:00Z',
          steps: 'run `codex login`',
          check: true,
          next: '2026-11-15T10:05:00Z',
        },
      }),
      claude: usage({
        signed_out: {
          since: '2026-11-15T09:00:00Z',
          run: 'R-1',
          steps: 'run `claude login`',
          check: true,
          next: '2026-11-15T10:05:00Z',
        },
      }),
    });
    expect(box.querySelector('[data-provider="codex"]')?.textContent).toContain('Signed out');
    expect(box.querySelector('[data-provider="claude"]')?.textContent).toContain('Sign-in expired');
    expect(box.querySelectorAll('[data-state="signed-out"]')).toHaveLength(2);
  });

  it('formats reset countdowns without noisy zero units', () => {
    expect(resetIn(NOW + 42 * 60_000, NOW)).toBe('42m');
    expect(resetIn(NOW + (8 * 60 + 12) * 60_000, NOW)).toBe('8h 12m');
    expect(resetIn(NOW, NOW)).toBeNull();
  });
});
