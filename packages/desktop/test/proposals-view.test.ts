// @vitest-environment happy-dom
// Proposals in the Agents view (W6): each variant with its agents, scorers, diff and benchmark,
// Promote and Reject (with a note), and the routes the page may call for them.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowedCall } from '../src/allow';
import type { Nav } from '../ui/src/App';
import type { ImproveStatus, ProposalView } from '../ui/src/types';
import { benchmarkText, Proposals, requiresText } from '../ui/src/ui/proposals';

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

const ROLE_TEXT = '---\nid: claude:engineer\n---\n\nWrite the code.\n';

const STATUS: ImproveStatus = {
  enabled: false,
  notes: false,
  agent: 'claude:improver',
  threshold: 10,
  max_age_days: 7,
  check_hours: 3,
  benchmark: null,
  roots: [
    {
      root: 'tally',
      open: 1,
      policy: {
        agent: 'claude:improver',
        max_open_proposals: 2,
        requires: { benchmark: true, min_delta: 0.1 },
      },
    },
  ],
};

let went: Array<[string, string | undefined]>;

const nav: Nav = {
  me: 'human:dawid',
  openTask: (r) => opened.push(r),
  go: (v, a) => went.push([v, a]),
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  calls = [];
  opened = [];
  went = [];
  list = [PROPOSAL];
  window.swarmup = {
    call: (method: string, path: string, body?: Record<string, unknown>) => {
      calls.push({ method, path, body });
      if (path === '/api/defs/variants') return Promise.resolve({ ok: true, data: list });
      if (path === '/api/improve' && method === 'GET') {
        return Promise.resolve({ ok: true, data: STATUS });
      }
      if (path === '/api/agents') {
        return Promise.resolve({
          ok: true,
          data: [
            {
              id: 'claude:engineer',
              status: 'active',
              live: null,
              file: 'C:/s/agents/claude-engineer.md',
            },
            { id: 'codex:qa', status: 'active', live: null },
          ],
        });
      }
      if (path === '/api/roles/claude%3Aengineer') {
        return Promise.resolve({
          ok: true,
          data: {
            id: 'claude:engineer',
            status: 'active',
            instructions: 'Write the code.',
            path: 'agents/claude-engineer.md',
            text: ROLE_TEXT,
          },
        });
      }
      if (path === '/api/improve/settings') return Promise.resolve({ ok: true, data: STATUS });
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

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

function button(label: string, within: ParentNode = document): HTMLButtonElement {
  const b = [...within.querySelectorAll('button')].find((x) => x.textContent?.trim() === label);
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

  it('shows a variant from a git ref with its ref and commit, and offers no promote', async () => {
    list = [
      {
        ...PROPOSAL,
        name: 'last-week',
        status: 'draft',
        proposal: undefined,
        benchmark: undefined,
        description: 'The engineer as it was before the tests-first rule.',
        from_ref: 'HEAD~20',
        commit: 'abcdef1234567890',
      },
    ];
    await render();
    const card = document.querySelector('[data-testid="proposal-last-week"]')!;
    expect(card.textContent).toContain('from a git ref');
    expect(card.textContent).toContain('The engineer as it was before the tests-first rule.');
    expect(card.querySelector('[data-testid="variant-from-ref"]')!.textContent).toContain(
      'HEAD~20 (abcdef1234)',
    );
    expect([...card.querySelectorAll('button')].map((b) => b.textContent?.trim())).not.toContain(
      'Promote',
    );
  });

  it('stays visible while no variant waits, and says what a proposal is', async () => {
    list = [];
    await render();
    const empty = document.querySelector('[data-testid="proposals-empty"]')!;
    expect(empty.textContent).toContain("a reviewed change to an agent's definition");
    expect(empty.textContent).toContain('Propose a change');
    expect(button('Propose a change')).toBeTruthy();
  });

  it("shows the improver's switches, the benchmark gate and each store's policy", async () => {
    await render();
    const status = document.querySelector('[data-testid="improver-status"]')!;
    expect(status.textContent).toContain('claude:improver');
    expect(status.querySelector('[data-testid="benchmark-gate"]')!.textContent).toContain(
      'Benchmark gate: off',
    );
    expect(status.querySelector('[data-improve-root="tally"]')!.textContent).toContain(
      'a promote needs a benchmark at +10 pts or better; 1 of 2 proposals open',
    );
    await click(status.querySelector('[data-improve-switch="enabled"] button')!);
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      method: 'POST',
      path: '/api/improve/settings',
      body: { as: 'human:dawid', enabled: true },
    });
    await click(button('Set in swarm.yaml (improvement)'));
    expect(went).toEqual([['settings', 'definitions']]);
  });

  it('shows what improvement.requires still needs on a proposal', async () => {
    list = [
      {
        ...PROPOSAL,
        requires: {
          benchmark: true,
          min_delta: 0.1,
          problems: ['improvement.requires a benchmark, and this proposal has none yet'],
        },
      },
    ];
    await render();
    expect(document.querySelector('[data-testid="proposal-requires"]')!.textContent).toBe(
      'improvement.requires: a benchmark at +10 pts or better; not met: improvement.requires a benchmark, and this proposal has none yet',
    );
    expect(requiresText({ benchmark: false, min_delta: 0, problems: [] }).text).toContain(
      'no benchmark',
    );
  });

  it('proposes a change to a role file with a reason, prefilled from the file', async () => {
    list = [];
    await render();
    await click(button('Propose a change'));
    const dialog = document.querySelector('[data-propose-change]')!;
    const file = dialog.querySelector('textarea[aria-label="Role file"]') as HTMLTextAreaElement;
    expect(file.value).toBe(ROLE_TEXT);
    expect(dialog.textContent).toContain('agents/claude-engineer.md');
    expect(button('Propose', dialog).disabled).toBe(true);
    await type(file, `${ROLE_TEXT}Run the tests first.\n`);
    const why = dialog.querySelectorAll('textarea')[1] as HTMLTextAreaElement;
    await type(why, 'Reviews send back untested work.');
    await type(dialog.querySelector('input') as HTMLInputElement, 'T-0009');
    expect(button('Propose', dialog).disabled).toBe(false);
    await click(button('Propose', dialog));
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      method: 'POST',
      path: '/api/defs/propose',
      body: {
        as: 'human:dawid',
        agent: 'claude:engineer',
        text: `${ROLE_TEXT}Run the tests first.\n`,
        message: 'Reviews send back untested work.',
        task: 'T-0009',
      },
    });
  });

  it('describes a benchmark under way, failed or missing', () => {
    expect(benchmarkText(undefined)).toBe('no benchmark');
    expect(benchmarkText({ state: 'running' })).toBe('benchmark running');
    expect(benchmarkText({ state: 'failed', error: 'no set' })).toBe('benchmark failed: no set');
  });
});

describe('proposal routes in the allowlist', () => {
  it('lets the page list, promote, reject, propose and file an improvement task, and nothing else', () => {
    expect(allowedCall('POST', '/api/defs/propose')).toBe(true);
    expect(allowedCall('GET', '/api/improve')).toBe(true);
    expect(allowedCall('POST', '/api/improve/settings')).toBe(true);
    expect(allowedCall('GET', '/api/defs/variants')).toBe(true);
    expect(allowedCall('POST', '/api/defs/variants/engineer-tests-first/promote')).toBe(true);
    expect(allowedCall('POST', '/api/defs/variants/engineer-tests-first/reject')).toBe(true);
    expect(allowedCall('POST', '/api/improve')).toBe(true);
    expect(allowedCall('POST', '/api/defs/variants/x/delete')).toBe(false);
    expect(allowedCall('POST', '/api/defs/variants')).toBe(false);
  });
});
