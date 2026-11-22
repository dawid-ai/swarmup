// @vitest-environment happy-dom
// Proposals in the Agents view (W6): each variant with its agents, scorers, diff and benchmark,
// Promote and Reject (with a note), and the routes the page may call for them.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowedCall } from '../src/allow';
import type { Nav } from '../ui/src/App';
import type { ProposalView } from '../ui/src/types';
import { benchmarkText, Proposals } from '../ui/src/ui/proposals';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let box: HTMLDivElement;
let calls: Array<{ method: string; path: string; body?: Record<string, unknown> }>;
let list: ProposalView[];
let opened: string[];

const PROPOSAL: ProposalView = {
  root: 'tally',
  name: 'engineer-tests-first',
  hash: `d:${'c'.repeat(64)}`,
  base: `d:${'b'.repeat(64)}`,
  status: 'proposed',
  stale: false,
  agents: ['claude:engineer'],
  ok: true,
  problems: [],
  proposal: {
    task: 'tally/TL-0009',
    agents: ['claude:engineer'],
    scorers: ['review-rounds', 'merge-failures'],
    message: 'Reviews send back untested work.',
    by: 'claude:improver',
    at: '2026-11-22T10:00:00.000Z',
  },
  diffs: [
    {
      path: 'agents/claude-engineer.md',
      kind: 'changed',
      lines: ['+Run the tests before you ask for review.'],
    },
  ],
  benchmark: {
    state: 'done',
    verdict: 'better',
    delta: { passRate: 0.2, hiddenPassRate: 0, costPerAttempt: 0.1 },
  },
};

const nav: Nav = { me: 'human:dawid', openTask: (r) => opened.push(r), go: () => {} };

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  calls = [];
  opened = [];
  list = [PROPOSAL];
  window.swarmup = {
    call: (method: string, path: string, body?: Record<string, unknown>) => {
      calls.push({ method, path, body });
      if (path === '/api/defs/variants') return Promise.resolve({ ok: true, data: list });
      return Promise.resolve({ ok: true, data: {} });
    },
  } as unknown as NonNullable<Window['swarmup']>;
  box = document.createElement('div');
  document.body.append(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
  document.body.innerHTML = '';
  delete window.swarmup;
});

async function render(): Promise<void> {
  root = createRoot(box);
  await act(async () => {
    root!.render(createElement(Proposals, { nav }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

function button(label: string): HTMLButtonElement {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === label);
  if (!b) throw new Error(`no button ${label}`);
  return b as HTMLButtonElement;
}

describe('Proposals', () => {
  it('shows each variant with its agents, scorers, diff and benchmark', async () => {
    await render();
    const card = document.querySelector('[data-testid="proposal-engineer-tests-first"]')!;
    expect(card.textContent).toContain('tally/engineer-tests-first');
    expect(card.textContent).toContain('claude:engineer');
    expect(card.textContent).toContain('review-rounds, merge-failures');
    expect(card.textContent).toContain('+Run the tests before you ask for review.');
    expect(card.querySelector('[data-testid="proposal-benchmark"]')!.textContent).toBe(
      'benchmark: better (pass rate +20 pts, hidden 0 pts, +$0.10 per attempt)',
    );
    await click(button('tally/TL-0009'));
    expect(opened).toEqual(['tally/TL-0009']);
  });

  it('promotes, and rejects only with a note', async () => {
    await render();
    await click(button('Promote'));
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      method: 'POST',
      path: '/api/defs/variants/engineer-tests-first/promote',
      body: { root: 'tally' },
    });
    calls = [];
    await click(button('Reject'));
    expect(button('Reject').disabled).toBe(true);
    const input = document.querySelector('input')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'Too broad.');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('Reject'));
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      method: 'POST',
      path: '/api/defs/variants/engineer-tests-first/reject',
      body: { root: 'tally', message: 'Too broad.' },
    });
  });

  it('renders nothing while no variant waits', async () => {
    list = [];
    await render();
    expect(document.querySelector('[data-testid="proposals"]')).toBeNull();
  });

  it('describes a benchmark under way, failed or missing', () => {
    expect(benchmarkText(undefined)).toBe('no benchmark');
    expect(benchmarkText({ state: 'running' })).toBe('benchmark running');
    expect(benchmarkText({ state: 'failed', error: 'no set' })).toBe('benchmark failed: no set');
  });
});

describe('proposal routes in the allowlist', () => {
  it('lets the page list, promote, reject and file an improvement task, and nothing else', () => {
    expect(allowedCall('GET', '/api/defs/variants')).toBe(true);
    expect(allowedCall('POST', '/api/defs/variants/engineer-tests-first/promote')).toBe(true);
    expect(allowedCall('POST', '/api/defs/variants/engineer-tests-first/reject')).toBe(true);
    expect(allowedCall('POST', '/api/improve')).toBe(true);
    expect(allowedCall('POST', '/api/defs/variants/x/delete')).toBe(false);
    expect(allowedCall('POST', '/api/defs/variants')).toBe(false);
  });
});
