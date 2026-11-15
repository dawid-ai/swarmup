// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appMenuTemplate, devShortcut } from '../src/menu';
import { resetIn, usageItems } from '../ui/src/lib/usage';
import type { ProviderUsage } from '../ui/src/types';
import { ProviderStatusBar } from '../ui/src/ui/provider-status';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const NOW = Date.parse('2026-11-15T12:00:00Z');
const HOUR = 3_600_000;

function provider(windows: ProviderUsage['windows'], extra: Partial<ProviderUsage> = {}) {
  return { windows, paused: null, live: 0, ...extra } satisfies ProviderUsage;
}

const usage: Record<string, ProviderUsage> = {
  codex: provider({
    five_hour: { utilization: 0.05, resets_at: NOW + 2 * HOUR },
    seven_day: { utilization: 0.12, resets_at: NOW + 75 * HOUR },
  }),
  claude: provider({ five_hour: { utilization: 0.92, resets_at: NOW + HOUR } }),
};

describe('usageItems', () => {
  it('shows the fullest window and its reset, in provider order', () => {
    const items = usageItems(usage, { usage_pause_at: 0.9 }, NOW);
    expect(items.map((i) => [i.provider, i.state, i.pct, i.reset])).toEqual([
      ['claude', 'warning', 92, '1h'],
      ['codex', 'normal', 12, '3d 3h'],
    ]);
  });

  it('warns at the provider pause threshold, which wins over the global one', () => {
    const near = {
      claude: provider({ five_hour: { utilization: 0.85, resets_at: NOW + HOUR } }),
    };
    expect(usageItems(near, { usage_pause_at: 0.9 }, NOW)[0]!.state).toBe('normal');
    expect(
      usageItems(near, { usage_pause_at: 0.9, runtimes: { claude: { pause_at: 0.8 } } }, NOW)[0]!
        .state,
    ).toBe('warning');
    // Without settings yet, swarmupd's default of 90% applies.
    expect(usageItems(usage, undefined, NOW)[0]!.state).toBe('warning');
  });

  it('ignores cached windows at or past their reset boundary', () => {
    const stale = {
      claude: provider({
        five_hour: { utilization: 0.92, resets_at: NOW },
        seven_day: { utilization: 0.12, resets_at: NOW + 75 * HOUR },
      }),
      codex: provider({ five_hour: { utilization: 0.95, resets_at: NOW - 1 } }),
    };

    const items = usageItems(stale, { usage_pause_at: 0.9 }, NOW);
    expect(items.map((i) => [i.provider, i.state, i.pct, i.reset])).toEqual([
      ['claude', 'normal', 12, '3d 3h'],
      ['codex', 'empty', undefined, undefined],
    ]);
    expect(items[1]!.title).toBe('Codex: no current usage window');
  });

  it('tells a signed-out provider from an expired sign-in and drops stale usage', () => {
    const out = {
      codex: provider(
        { five_hour: { utilization: 0.4, resets_at: NOW + HOUR } },
        {
          signed_out: { since: '', steps: 'run `codex login`', check: true, next: '' },
        },
      ),
      claude: provider(
        {},
        {
          signed_out: { since: '', run: 'R1', steps: 'run `claude`', check: true, next: '' },
        },
      ),
      gemini: provider({}),
    };
    expect(usageItems(out, undefined, NOW).map((i) => [i.provider, i.state, i.pct])).toEqual([
      ['claude', 'expired', undefined],
      ['codex', 'signed-out', undefined],
      ['gemini', 'empty', undefined],
    ]);
  });

  it('formats the time to the reset', () => {
    expect(resetIn(30_000)).toBe('<1m');
    expect(resetIn(42 * 60_000)).toBe('42m');
    expect(resetIn(5 * HOUR + 12 * 60_000)).toBe('5h 12m');
    expect(resetIn(2 * HOUR)).toBe('2h');
    expect(resetIn(75 * HOUR)).toBe('3d 3h');
    expect(resetIn(48 * HOUR)).toBe('2d');
  });
});

describe('ProviderStatusBar', () => {
  let root: Root | undefined;
  let box: HTMLDivElement;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    box = document.createElement('div');
    document.body.append(box);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    box.remove();
    vi.useRealTimers();
  });

  function render(props: Parameters<typeof ProviderStatusBar>[0]): void {
    root ??= createRoot(box);
    act(() => root!.render(createElement(ProviderStatusBar, props)));
  }

  const item = (p: string) => box.querySelector<HTMLButtonElement>(`[data-provider="${p}"]`)!;
  /** The visible text, without the provider tiles' SVG titles. */
  const text = (el: Element): string =>
    Array.from(el.querySelectorAll('span'), (s) => s.textContent).join(' ');

  it('shows each provider with its figure, warning near the threshold', () => {
    render({ usage, pause: { usage_pause_at: 0.9 }, onOpen: () => {} });
    expect(text(box.querySelector('footer')!)).toBe('Used Claude 92% · 1h Codex 12% · 3d 3h');
    expect(item('claude').dataset.state).toBe('warning');
    expect(item('claude').className).toContain('text-warn');
    expect(item('codex').dataset.state).toBe('normal');
    expect(item('codex').className).not.toContain('text-warn');
    expect(item('codex').querySelector('svg[aria-label="Codex"]')).not.toBeNull();
  });

  it('shows signed out and an expired sign-in in the warning color', () => {
    render({
      usage: {
        claude: provider(
          {},
          { signed_out: { since: '', run: 'R1', steps: '', check: true, next: '' } },
        ),
        codex: provider({}, { signed_out: { since: '', steps: '', check: true, next: '' } }),
      },
      pause: undefined,
      onOpen: () => {},
    });
    expect(text(item('claude'))).toBe('Claude Sign-in expired');
    expect(text(item('codex'))).toBe('Codex Signed out');
    expect(item('codex').className).toContain('text-warn');
  });

  it('opens the provider on click and says when there is no reading', () => {
    const onOpen = vi.fn();
    render({ usage, pause: undefined, onOpen });
    act(() => item('codex').click());
    expect(onOpen).toHaveBeenCalledWith('codex');
    render({ usage: null, pause: undefined, onOpen });
    expect(text(box)).toBe('Used No usage reading yet');
  });
});

describe('window menu', () => {
  it('has no application menu on Windows and Linux, a minimal one on macOS', () => {
    expect(appMenuTemplate('win32')).toBeNull();
    expect(appMenuTemplate('linux')).toBeNull();
    expect(appMenuTemplate('darwin')!.map((m) => m.role)).toEqual([
      'appMenu',
      'editMenu',
      'windowMenu',
    ]);
  });

  it('keeps reload and DevTools as development shortcuts', () => {
    const key = (
      k: string,
      mods: Partial<Record<'control' | 'meta' | 'shift' | 'alt', boolean>> = {},
    ) =>
      devShortcut({
        type: 'keyDown',
        key: k,
        control: false,
        meta: false,
        shift: false,
        alt: false,
        ...mods,
      });
    expect(key('r', { control: true })).toBe('reload');
    expect(key('R', { meta: true })).toBe('reload');
    expect(key('F5')).toBe('reload');
    expect(key('I', { control: true, shift: true })).toBe('devtools');
    expect(key('F12')).toBe('devtools');
    // Copy, paste and plain typing pass through to the page.
    expect(key('c', { control: true })).toBeNull();
    expect(key('v', { control: true })).toBeNull();
    expect(key('r')).toBeNull();
    expect(
      devShortcut({
        type: 'keyUp',
        key: 'F5',
        control: false,
        meta: false,
        shift: false,
        alt: false,
      }),
    ).toBeNull();
  });
});
