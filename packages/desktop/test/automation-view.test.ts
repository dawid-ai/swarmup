// @vitest-environment happy-dom
// The Automation view: each root's triggers with the machine's consent and trust, Turn on here,
// Review and trust (the exact trigger fields and merge-check commands, then a confirm), Revoke,
// the listener toggle with its restart, and Direct action behind a warning. Every write names
// the person (`as`), and the allow list lets exactly these calls through.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowedCall } from '../src/allow';
import type { AutomationRoot, AutomationView } from '../ui/src/types';
import { Automation, rootStatus } from '../ui/src/views/Automation';

const calls = vi.hoisted(() => [] as Array<{ method: string; path: string; body: unknown }>);
const state = vi.hoisted(() => ({ view: undefined as unknown }));

vi.mock(import('../ui/src/api'), async (original) => ({
  ...(await original()),
  useData: <T>(path: string | null) => ({
    data: (path === '/api/automation' ? state.view : undefined) as T,
    error: null,
    reload: () => {},
    set: () => {},
  }),
  api: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    calls.push({ method, path, body });
    return {} as T;
  },
  refreshSoon: () => {},
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const T_HASH = `t:${'a'.repeat(64)}`;
const C_HASH = `c:${'b'.repeat(64)}`;

const ROOT: AutomationRoot = {
  root: 'site',
  on: false,
  status: 'off',
  trust: 'untrusted',
  hash: T_HASH,
  broken: 1,
  triggers: [
    {
      root: 'site',
      name: 'digest',
      file: 'digest.yaml',
      when: 'every 24h',
      target: 'run claude:pm',
      enabled: true,
      consent: false,
      trust: 'untrusted',
      here: false,
      why: 'off here (swarmupd.triggers.site is not true)',
      last_fire: null,
      next_fire: null,
      fields: [
        ['every', '24h'],
        ['action', 'run'],
        ['agent', 'claude:pm'],
        ['prompt', 'Write the digest.'],
        ['enabled', 'true'],
      ],
      errors: [],
    },
    {
      root: 'site',
      name: 'issue',
      file: 'issue.yaml',
      when: 'webhook hmac',
      target: 'run claude:engineer',
      enabled: true,
      runs_on: ['desk'],
      consent: false,
      trust: 'untrusted',
      here: false,
      why: 'off here (swarmupd.triggers.site is not true)',
      last_fire: null,
      next_fire: null,
      fields: [
        ['action', 'run'],
        ['agent', 'claude:engineer'],
        ['runs_on', '["desk"]'],
        ['enabled', 'true'],
        ['webhook.verify', 'hmac'],
        ['webhook.secret', 'HOOK_KEY'],
      ],
      errors: [],
      webhook: { verify: 'hmac', secret: 'HOOK_KEY', secret_ok: true, direct: false },
    },
    {
      root: 'site',
      name: 'broken',
      file: 'broken.yaml',
      when: '',
      target: '',
      enabled: false,
      consent: false,
      trust: 'untrusted',
      here: false,
      why: 'has errors (swarmup validate)',
      last_fire: null,
      next_fire: null,
      fields: [],
      errors: ['1:1 unknown key'],
    },
  ],
  checks: {
    trust: 'untrusted',
    hash: C_HASH,
    checks: [{ name: 'test', run: 'pnpm test', paths: ['src/**'] }],
  },
};

const VIEW: AutomationView = {
  machine: 'desk',
  roots: [ROOT],
  hooks: {
    enabled: false,
    host: '127.0.0.1',
    port: 8787,
    listener: 'off',
    restart: false,
    log: [
      {
        at: '2026-11-23T10:00:00.000Z',
        via: 'listener',
        root: 'site',
        trigger: 'issue',
        status: 'refused',
        code: 401,
        reason: 'bad signature',
      },
    ],
  },
};

let root: Root | undefined;
let box: HTMLDivElement;
const service = vi.fn(async () => ({ ok: true, data: { note: 'swarmupd restarted (pid 9)' } }));

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  calls.length = 0;
  service.mockClear();
  state.view = structuredClone(VIEW);
  (window as unknown as { swarmup: unknown }).swarmup = { service };
  box = document.createElement('div');
  document.body.append(box);
  root = createRoot(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
  delete (window as unknown as { swarmup?: unknown }).swarmup;
});

const nav = { me: 'human:dawid', go: vi.fn(), openTask: vi.fn() } as never;

function render(): void {
  act(() => root!.render(createElement(Automation, { nav })));
}

function button(text: string): HTMLButtonElement {
  const b = [...document.body.querySelectorAll('button')].find(
    (x) => x.textContent?.trim() === text,
  );
  if (!b) throw new Error(`no ${text} button`);
  return b;
}

function toggle(label: string, within: ParentNode = document.body): HTMLButtonElement {
  const b = [...within.querySelectorAll<HTMLButtonElement>('button[role="switch"]')].find(
    (x) => x.textContent?.trim() === label,
  );
  if (!b) throw new Error(`no ${label} switch`);
  return b;
}

async function click(b: Element): Promise<void> {
  await act(async () => {
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('Automation view', () => {
  it('shows each trigger, its state here and the merge checks', () => {
    render();
    expect(box.querySelector('[data-testid="root-status"]')!.textContent).toBe(
      'Off on this machine: none of its triggers fires here',
    );
    expect(box.textContent).toContain('every 24h');
    expect(box.textContent).toContain('run claude:pm');
    expect(box.textContent).toContain('off here (swarmupd.triggers.site is not true)');
    expect(box.textContent).toContain('1 trigger file(s) have errors');
    expect(box.querySelector('[data-testid="checks-line"]')!.textContent).toContain(
      '1 merge check(s) in swarm.yaml: not trusted',
    );
    expect(box.querySelector('[data-testid="listener-status"]')!.textContent).toBe('Off');
    const hook = box.querySelector('[data-hook="site/issue"]')!;
    expect(hook.textContent).toContain('HOOK_KEY');
    expect(hook.textContent).toContain('present');
    expect(box.textContent).toContain('401 site/issue refused: bad signature');
    // No Revoke while nothing is trusted.
    expect(() => button('Revoke trust')).toThrow();
  });

  it('names each status of a root', () => {
    const status = (s: AutomationRoot['status']) => rootStatus({ ...ROOT, status: s }).text;
    expect(status('untrusted')).toBe('On but not trusted: nothing fires until you trust it');
    expect(status('changed')).toBe(
      'Changed since you trusted it: nothing fires until you review it again',
    );
    expect(status('trusted')).toBe('Trusted: fires as listed');
  });

  it('turns triggers on, and trusts only after the review is confirmed', async () => {
    render();
    await click(button('Turn on here'));
    await click(button('Review and trust'));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    const review = dialog.querySelector('[data-testid="review-triggers"]')!.textContent!;
    expect(review).toContain('prompt: Write the digest.');
    expect(review).toContain('webhook.secret: HOOK_KEY');
    expect(review).toContain('runs_on: ["desk"]');
    expect(dialog.textContent).toContain('Not trusted, with errors: broken');
    expect(dialog.querySelector('[data-testid="review-checks"]')!.textContent).toContain(
      'pnpm test (when it changes src/**)',
    );
    // Nothing is trusted until the person confirms.
    expect(calls.map((c) => c.path)).toEqual(['/api/automation/triggers']);
    await click(button('Trust these on this machine'));
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/automation/triggers',
        body: { as: 'human:dawid', root: 'site', on: true },
      },
      {
        method: 'POST',
        path: '/api/automation/trust',
        body: { as: 'human:dawid', root: 'site', triggers: T_HASH, checks: C_HASH },
      },
    ]);
    for (const c of calls) expect(allowedCall('POST', c.path)).toBe(true);
    expect(allowedCall('GET', '/api/automation')).toBe(true);
  });

  it('turns triggers off and revokes trust', async () => {
    state.view = {
      ...VIEW,
      roots: [{ ...ROOT, on: true, status: 'changed', trust: 'changed' }],
    };
    render();
    expect(box.querySelector('[data-testid="root-status"]')!.textContent).toContain(
      'Changed since you trusted it',
    );
    await click(button('Turn off'));
    await click(button('Revoke trust'));
    expect(calls.map((c) => [c.path, c.body])).toEqual([
      ['/api/automation/triggers', { as: 'human:dawid', root: 'site', on: false }],
      ['/api/automation/revoke', { as: 'human:dawid', root: 'site' }],
    ]);
  });

  it('approves a direct action only after the warning, and takes it back at once', async () => {
    render();
    const hook = box.querySelector('[data-hook="site/issue"]')!;
    await click(toggle('Direct action', hook));
    expect(calls).toEqual([]);
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Each verified delivery runs run claude:engineer');
    expect(dialog.textContent).toContain('Anyone who holds the secret HOOK_KEY can start it');
    await click(button('Approve direct actions'));
    expect(calls.map((c) => [c.path, c.body])).toEqual([
      ['/api/automation/direct', { as: 'human:dawid', root: 'site', trigger: 'issue', on: true }],
    ]);

    calls.length = 0;
    const on = structuredClone(VIEW);
    on.roots[0]!.triggers[1]!.webhook!.direct = true;
    state.view = on;
    render();
    await click(toggle('Direct action', box.querySelector('[data-hook="site/issue"]')!));
    expect(calls.map((c) => [c.path, c.body])).toEqual([
      ['/api/automation/direct', { as: 'human:dawid', root: 'site', trigger: 'issue', on: false }],
    ]);
    for (const c of calls) expect(allowedCall('POST', c.path)).toBe(true);
  });

  it('turns the listener on, and offers the restart that applies it', async () => {
    render();
    await click(toggle('Listener'));
    expect(calls.map((c) => [c.path, c.body])).toEqual([
      ['/api/automation/hooks', { as: 'human:dawid', enabled: true }],
    ]);
    expect(allowedCall('POST', '/api/automation/hooks')).toBe(true);
    expect(() => button('Restart swarmupd')).toThrow();

    state.view = { ...VIEW, hooks: { ...VIEW.hooks, enabled: true, restart: true } };
    render();
    expect(box.textContent).toContain('swarmupd started without it');
    await click(button('Restart swarmupd'));
    expect(service).toHaveBeenCalledWith('restart');
    expect(box.textContent).toContain('swarmupd restarted (pid 9)');
  });

  it('shows a failed listener', () => {
    state.view = {
      ...VIEW,
      hooks: { ...VIEW.hooks, enabled: true, listener: 'failed', error: 'EADDRINUSE' },
    };
    render();
    expect(box.querySelector('[data-testid="listener-status"]')!.textContent).toBe(
      'Could not listen on 127.0.0.1:8787: EADDRINUSE',
    );
  });
});
