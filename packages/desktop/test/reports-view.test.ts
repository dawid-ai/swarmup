// @vitest-environment happy-dom
// Reports, rendered: while swarmupd builds a report the view shows that it is busy, and a window
// picked meanwhile shows its own report, never the late answer for the window before.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Nav } from '../ui/src/App';
import type { Report } from '../ui/src/types';
import { Reports } from '../ui/src/views/Reports';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let box: HTMLDivElement;
/** Report requests that have not been answered yet, by path. */
let pending: Map<string, (data: unknown) => void>;

const BUSY = '[data-testid="report-building"]';

const report = (closed: number): Report => ({
  from: '2026-11-14T00:00:00.000Z',
  to: '2026-11-21T00:00:00.000Z',
  projects: [{ project: 'site', opened: 1, closed, parked: 0, open: 1, blocked: 0 }],
  agents: [],
  providers: [],
  decisions: [],
  channels: [],
  totals: { opened: 1, closed, runs: 0, minutes: 0, tokens: 0 },
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  pending = new Map();
  // The desktop bridge: a report answers only when the test says so.
  window.swarmup = {
    call: (_method: string, path: string) =>
      path.startsWith('/api/report')
        ? new Promise((resolve) => pending.set(path, (data) => resolve({ ok: true, data })))
        : Promise.resolve({ ok: true, data: [] }),
  } as unknown as NonNullable<Window['swarmup']>;
  box = document.createElement('div');
  document.body.append(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
  delete window.swarmup;
});

const nav = (): Nav => ({ me: 'human:dawid', openTask: vi.fn(), go: vi.fn() });
const busy = (): Element | null => box.querySelector(BUSY);
/** The Closed figure of the report on screen, not of the busy state's placeholders. */
const closed = (): string | undefined =>
  [...box.querySelectorAll('.panel')]
    .find((p) => !p.closest(BUSY) && p.querySelector('.label-caps')?.textContent === 'Closed')
    ?.textContent?.replace('Closed', '');

async function answer(path: string, data: unknown): Promise<void> {
  await act(async () => {
    pending.get(path)!(data);
    await new Promise((r) => setTimeout(r, 0));
  });
}

function pick(label: string): void {
  const b = [...box.querySelectorAll('button')].find((x) => x.textContent === label)!;
  act(() => b.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

describe('Reports while the report builds', () => {
  it('shows a busy state until the report comes, and drops the answer for an old window', async () => {
    root = createRoot(box);
    await act(async () => root!.render(createElement(Reports, { nav: nav() })));
    expect(pending.has('/api/report?days=7')).toBe(true);
    expect(busy()?.getAttribute('role')).toBe('status');
    expect(busy()?.textContent).toContain('Building the report…');

    await answer('/api/report?days=7', report(3));
    expect(busy()).toBeNull();
    expect(closed()).toBe('3');

    // Another window: busy again, and the week's late answer does not show under it.
    pick('30 days');
    expect(pending.has('/api/report?days=30')).toBe(true);
    expect(busy()).not.toBeNull();
    pick('Day');
    await answer('/api/report?days=30', report(30));
    expect(busy()).not.toBeNull();
    expect(closed()).toBeUndefined();
    await answer('/api/report?days=1', report(1));
    expect(busy()).toBeNull();
    expect(closed()).toBe('1');
  });
});

describe('Reports scores', () => {
  it('lists each agent with a column per scorer that has a score', async () => {
    root = createRoot(box);
    await act(async () => root!.render(createElement(Reports, { nav: nav() })));
    const line = {
      level: 'task' as const,
      better: 'lower' as const,
      pass: 1,
      n: 4,
      passed: 3,
      judged: 4,
      worst: [{ subject: 'site/T-0002', value: 3, evidence: [] }],
    };
    await answer('/api/report?days=7', {
      ...report(3),
      scores: [
        {
          agent: 'claude:engineer',
          scorers: [
            { ...line, scorer: 'review-rounds', unit: 'rounds', mean: 1.25 },
            { ...line, scorer: 'stuck-runs', level: 'agent', unit: 'ratio', mean: 0.04, n: 50 },
          ],
        },
      ],
    });
    const table = box.querySelector('[data-testid="report-scores"]')!;
    const heads = [...table.querySelectorAll('th')].map((th) => th.textContent);
    expect(heads).toEqual(['Agent', 'Review rounds', 'Stuck runs']);
    const cells = [...table.querySelectorAll('tbody td')].slice(1).map((td) => td.textContent);
    expect(cells).toEqual(['1.254', '4%50']);
    expect(table.querySelector('td[title]')?.getAttribute('title')).toBe(
      'mean over 4 tasks; 3 of 4 pass; worst: site/T-0002 3',
    );
  });
});
