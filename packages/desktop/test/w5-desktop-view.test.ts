// @vitest-environment happy-dom
// W5 phases 2 and 3 in the app: the Inbox's Gates group with Approve (done) and Reject (park),
// the gate badge in a milestone's plan, the Start a workflow dialog with its parameters, and the
// role editor on a folder agent (agent.md or the runtime addendum, with where each setting comes
// from).
import { act, createElement } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowedCall } from '../src/allow';
import type { Nav } from '../ui/src/App';
import type { InboxItem, PlanReport, RoleFile, WorkflowInfo } from '../ui/src/types';
import { MilestonePlan } from '../ui/src/ui/plan';
import { RoleEditor } from '../ui/src/ui/roles';
import { missingParams, startParams, StartWorkflow } from '../ui/src/ui/workflow';
import { Inbox } from '../ui/src/views/Inbox';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const answers = new Map<string, unknown>();
const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
let written: unknown = {};
let root: Root | undefined;
let box: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  answers.clear();
  writes.length = 0;
  written = {};
  const off = (): (() => void) => () => {};
  window.swarmup = {
    call: (method: string, path: string, body?: Record<string, unknown>) => {
      if (method !== 'GET') {
        writes.push({ path, body: body ?? {} });
        return Promise.resolve({ ok: true, data: written });
      }
      return Promise.resolve({ ok: true, data: answers.get(path.split('?')[0]!) ?? [] });
    },
    info: () => Promise.resolve({ me: 'human:dawid', pid: 1, roots: [] }),
    onService: off,
    onEvent: off,
    onStatus: off,
    onNavigate: off,
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

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount(el: ReactElement): Promise<void> {
  root = createRoot(box);
  await act(async () => root!.render(el));
  await settle();
}

const nav = (): Nav => ({ me: 'human:dawid', openTask: vi.fn(), go: vi.fn() });

function button(text: string, within: ParentNode = document.body): HTMLButtonElement {
  const b = [...within.querySelectorAll('button')].find((x) => x.textContent?.trim() === text);
  if (!b) throw new Error(`no ${text} button`);
  return b;
}

async function click(b: Element): Promise<void> {
  await act(async () => {
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
}

function type(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const set = Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!;
  act(() => {
    set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const GATE: InboxItem = {
  kind: 'gate',
  task: 'T-0003',
  root: 'r',
  title: 'Is the brief for launch post right?',
  type: 'gate',
  summary: 'Is the brief for launch post right?',
  gate: {
    ask: 'Is the brief for launch post right?',
    options: ['yes', 'yes, with notes'],
    on_reject: 'revise',
  },
  milestone: 'T-0001',
};

describe('gates in the Inbox', () => {
  it('shows a Gates group whose Approve posts done with the picked answer', async () => {
    await mount(createElement(Inbox, { nav: nav(), items: [GATE], error: null }));
    expect(box.textContent).toContain('Gates');
    const card = box.querySelector('[data-gate="T-0003"]')!;
    expect(card.querySelector('[data-gate-ask]')!.textContent).toBe(
      'Is the brief for launch post right?',
    );
    await click(button('yes, with notes', card));
    await click(button('Approve', card));
    expect(writes).toEqual([
      { path: '/api/tasks/T-0003/done', body: { as: 'human:dawid', message: 'yes, with notes' } },
    ]);
  });

  it('rejects with park only with a note, and names what the rejection does', async () => {
    await mount(createElement(Inbox, { nav: nav(), items: [GATE], error: null }));
    const card = box.querySelector('[data-gate="T-0003"]')!;
    const back = button('Send back', card);
    expect(back.disabled).toBe(true);
    expect(card.textContent).toContain('sends the work before this gate back for revision');
    type(card.querySelector('textarea')!, 'Tighten the audience');
    await click(button('Send back', card));
    expect(writes).toEqual([
      {
        path: '/api/tasks/T-0003/park',
        body: { as: 'human:dawid', message: 'Tighten the audience' },
      },
    ]);
  });

  it('labels a park gate Reject', async () => {
    const park = { ...GATE, gate: { ask: 'Go?' } };
    await mount(createElement(Inbox, { nav: nav(), items: [park], error: null }));
    expect(button('Reject').title).toBe('Reject parks this gate and every stage after it.');
  });
});

describe('gates in a milestone plan', () => {
  it('marks a gate row with its question and answers', async () => {
    const plan: PlanReport = {
      id: 'T-0001',
      root: 'r',
      title: 'launch post (x)',
      doneWhen: 'live',
      status: 'blocked',
      approval: 'E1',
      planner: 'human:dawid',
      items: [
        { key: 'brief', title: 'Write the brief', owner: '*:writer', after: [], estimate: '30m' },
        {
          key: 'brief-ok',
          title: 'Brief approval',
          owner: 'human:dawid',
          after: ['brief'],
          estimate: '15m',
          type: 'gate',
          gate: { ask: 'Is the brief right?', options: ['yes', 'no'] },
        },
      ],
      minutes: 45,
      spent: 0,
      pending: null,
      incomplete: null,
    } as unknown as PlanReport;
    answers.set('/api/tasks/T-0001/plan', plan);
    await mount(
      createElement(MilestonePlan, {
        id: 'T-0001',
        goal: '',
        events: [],
        nav: nav(),
        onWrote: () => {},
      }),
    );
    const gate = box.querySelector('[data-plan-gate="brief-ok"]')!;
    expect(gate.textContent).toContain('Gate');
    expect(gate.textContent).toContain('Is the brief right?');
    expect(gate.textContent).toContain('answers: yes, no');
    expect(box.querySelector('[data-plan-gate="brief"]')).toBeNull();
  });
});

const WORKFLOWS: WorkflowInfo[] = [
  {
    root: 'r',
    id: 'bugfix',
    title: 'Bug fix',
    description: 'A bug to a tested fix.',
    approval: 'starter',
    params: {
      bug: { description: 'The bug', required: true },
      severity: { default: 'p2', options: ['p0', 'p1', 'p2', 'p3'] },
    },
    stages: 3,
    ok: true,
    problems: [],
  },
  {
    root: 'r',
    id: 'content-piece',
    title: 'Content piece',
    approval: 'proposal',
    params: { piece: { required: true }, channel: { required: true } },
    stages: 4,
    ok: true,
    problems: [],
  },
];

describe('Start a workflow', () => {
  it('fills defaults and names the required parameters left empty', () => {
    expect(startParams(WORKFLOWS[0]!, { bug: ' crash ' })).toEqual({
      bug: 'crash',
      severity: 'p2',
    });
    expect(missingParams(WORKFLOWS[0]!, {})).toEqual(['bug']);
  });

  it('starts the chosen workflow with its parameters', async () => {
    answers.set('/api/workflows', WORKFLOWS);
    written = { milestone: { id: 'T-0007' }, approved: true, created: [{}, {}, {}] };
    const started = vi.fn();
    await mount(
      createElement(StartWorkflow, { me: 'human:dawid', onClose: () => {}, onStarted: started }),
    );
    const dialog = document.body.querySelector('[data-start-workflow]')!;
    expect(dialog.querySelector('[data-approval="starter"]')!.textContent).toContain(
      'Your start approves the plan',
    );
    const start = button('Start', dialog);
    expect(start.disabled).toBe(true);
    expect(dialog.textContent).toContain('Fill in bug');
    type(dialog.querySelector('input')!, 'crash on save');
    await click(button('Start', dialog));
    expect(writes).toEqual([
      {
        path: '/api/workflows/start',
        body: {
          as: 'human:dawid',
          id: 'bugfix',
          root: 'r',
          params: { bug: 'crash on save', severity: 'p2' },
        },
      },
    ]);
    expect(started).toHaveBeenCalledWith('T-0007');
  });

  it('says so when the project has no workflows', async () => {
    answers.set('/api/workflows', []);
    await mount(
      createElement(StartWorkflow, { me: 'human:dawid', onClose: () => {}, onStarted: () => {} }),
    );
    expect(document.body.querySelector('[data-no-workflows]')).not.toBeNull();
  });

  it('is allowed by the desktop’s call list', () => {
    expect(allowedCall('GET', '/api/workflows')).toBe(true);
    expect(allowedCall('POST', '/api/workflows/start')).toBe(true);
    expect(allowedCall('POST', '/api/workflows')).toBe(false);
  });
});

const FOLDER_ROLE: RoleFile = {
  id: 'codex:writer',
  name: 'Writer',
  status: 'active',
  instructions: 'Write the drafts.\n\nKeep it short.',
  kb: ['voice'],
  style: 'Terse.',
  root: 'r',
  providers: ['claude', 'codex'],
  folder: {
    role: 'writer',
    providersFrom: 'agent',
    addendum: 'C:/s/agents/writer/codex.md',
    bodyMode: 'append',
  },
  layers: {
    role: {
      file: 'agent.md',
      data: { name: 'Writer', kb: ['voice'], providers: ['claude', 'codex'] },
      instructions: 'Write the drafts.',
    },
    runtime: { file: 'codex.md', data: { style: 'Terse.' }, instructions: 'Keep it short.' },
  },
  settings: [
    { key: 'model', value: 'o3', from: 'machine', over: 'gpt-5-codex' },
    { key: 'runtimes.codex.effort', value: 'high', from: 'swarm.yaml' },
    { key: 'roles.writer.per_project', value: 2, from: 'swarm.yaml' },
  ],
};

describe('role editor on a folder agent', () => {
  beforeEach(() => {
    answers.set('/api/settings', {
      opsd: { runtimes: { claude: {}, codex: {} }, agents: {}, budget_minutes: 180 },
      rootList: [{ name: 'r', isMirror: false }],
    });
    answers.set('/api/roles/codex%3Awriter', FOLDER_ROLE);
    answers.set('/api/kb', []);
  });

  it('edits agent.md by default and the runtime addendum on Only codex', async () => {
    await mount(
      createElement(RoleEditor, { id: 'codex:writer', onClose: () => {}, me: 'human:dawid' }),
    );
    const text = (): string => document.body.querySelector<HTMLTextAreaElement>('textarea')!.value;
    expect(document.body.textContent).toContain('agents/writer/agent.md');
    expect(text()).toBe('Write the drafts.');
    await click(button('Only codex'));
    expect(document.body.textContent).toContain('agents/writer/codex.md');
    expect(text()).toBe('Keep it short.');
    expect(document.body.textContent).toContain("Empty fields take the role's value");
    await click(button('Save'));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe('/api/roles');
    expect(writes[0]!.body).toMatchObject({
      scope: 'runtime',
      role: { id: 'codex:writer', instructions: 'Keep it short.', style: 'Terse.', name: null },
    });
  });

  it('marks where each run setting comes from', async () => {
    await mount(
      createElement(RoleEditor, { id: 'codex:writer', onClose: () => {}, me: 'human:dawid' }),
    );
    const from = (key: string): string | null =>
      document.body.querySelector(`[data-setting="${key}"] [data-from]`)!.getAttribute('data-from');
    expect(from('model')).toBe('machine');
    expect(from('runtimes.codex.effort')).toBe('swarm.yaml');
    expect(document.body.querySelector('[data-setting="model"]')!.textContent).toContain(
      'over "gpt-5-codex" from git',
    );
  });
});
