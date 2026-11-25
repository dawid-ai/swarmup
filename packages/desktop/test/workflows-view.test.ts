// @vitest-environment happy-dom
// The Workflows view (W5): each project's workflows with their stages and gates, New workflow
// from a template, the editor's form writing the YAML in place (comments kept), the live check,
// Save and Delete, and the routes the page may call for them.
import { act, createElement } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowedCall } from '../src/allow';
import type { Nav } from '../ui/src/App';
import {
  linesText,
  newStageKey,
  readWorkflowYaml,
  setYaml,
  textLines,
  textList,
} from '../ui/src/lib/workflow-yaml';
import type { WorkflowCheck, WorkflowInfo, WorkflowTemplate } from '../ui/src/types';
import { StartWorkflow } from '../ui/src/ui/workflow';
import { Workflows } from '../ui/src/views/Workflows';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const TEXT = `# Bug fix
title: Bug fix
params:
  bug:
    description: The bug
    required: true
milestone:
  title: 'Fix: {{bug}}'
  done_when: '{{bug}} is gone'
approval: starter
stages:
  - key: fix
    title: 'Fix {{bug}}'
    owner: '*:engineer'
    estimate: 2h
  - key: ok
    gate:
      ask: Ship it?
    after: [fix]
`;

const WORKFLOW: WorkflowInfo = {
  root: 'r',
  id: 'bugfix',
  title: 'Bug fix',
  approval: 'starter',
  params: { bug: { description: 'The bug', required: true } },
  stages: 2,
  ok: true,
  problems: [],
  text: TEXT,
  def: {
    id: 'bugfix',
    title: 'Bug fix',
    params: { bug: { description: 'The bug', required: true } },
    milestone: { title: 'Fix: {{bug}}', done_when: '{{bug}} is gone' },
    approval: 'starter',
    stages: [
      { key: 'fix', title: 'Fix {{bug}}', owner: '*:engineer', estimate: '2h' },
      { key: 'ok', gate: { ask: 'Ship it?' }, after: ['fix'] },
    ],
  },
};

const TEMPLATES: WorkflowTemplate[] = [
  { id: 'feature', title: 'Feature', description: 'A feature.', text: 'title: Feature\n' },
  { id: 'blank', title: 'Blank', text: 'title: New workflow\n' },
];

const CHECK: WorkflowCheck = {
  ok: true,
  problems: [],
  def: WORKFLOW.def!,
  params: { bug: 'example' },
  plan: {
    milestone: { title: 'Fix: example', done_when: 'example is gone' },
    approval: 'starter',
    dropped: [],
    items: [
      { key: 'fix', title: 'Fix example', owner: '*:engineer', estimate: '2h' },
      {
        key: 'ok',
        title: 'Ship it?',
        owner: 'human:dawid',
        estimate: '15m',
        after: ['fix'],
        gate: { ask: 'Ship it?' },
      },
    ],
  },
};

let root: Root | undefined;
let box: HTMLDivElement;
let calls: Array<{ method: string; path: string; body?: Record<string, unknown> }>;
let list: WorkflowInfo[];
let check: WorkflowCheck;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  calls = [];
  list = [WORKFLOW];
  check = CHECK;
  window.swarmup = {
    call: (method: string, path: string, body?: Record<string, unknown>) => {
      calls.push({ method, path, body });
      if (path === '/api/workflows') return Promise.resolve({ ok: true, data: list });
      if (path === '/api/workflows/templates')
        return Promise.resolve({ ok: true, data: TEMPLATES });
      if (path === '/api/workflows/check') return Promise.resolve({ ok: true, data: check });
      if (path === '/api/settings') {
        return Promise.resolve({
          ok: true,
          data: { rootList: [{ name: 'r', dir: 'C:/r', mirror: false, isMirror: false }] },
        });
      }
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
  vi.useRealTimers();
});

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount(el: ReactElement): Promise<void> {
  root = createRoot(box);
  await act(async () => root!.render(el));
  await settle();
}

const nav = (): Nav => ({ me: 'human:dawid', openTask: vi.fn(), go: vi.fn() });

function button(label: string, within: ParentNode = document.body): HTMLButtonElement {
  const b = [...within.querySelectorAll('button')].find((x) => x.textContent?.trim() === label);
  if (!b) throw new Error(`no button ${label}`);
  return b;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

describe('workflow YAML edits', () => {
  it('sets and removes fields in place, keeping comments and other keys', () => {
    const next = setYaml(TEXT, ['title'], 'Hotfix');
    expect(next).toContain('# Bug fix');
    expect(next).toContain('title: Hotfix');
    expect(next).toContain("title: 'Fix: {{bug}}'");
    const gone = setYaml(next, ['params', 'bug', 'required'], false);
    expect(readWorkflowYaml(gone).value!.params).toEqual({ bug: { description: 'The bug' } });
    const after = setYaml(TEXT, ['stages', 1, 'after'], ['fix', 'other']);
    expect(after).toContain('after: [ fix, other ]');
    const gate = setYaml(TEXT, ['stages', 0, 'gate', 'ask'], 'Go?');
    expect(readWorkflowYaml(gate).value!.stages).toMatchObject([{ gate: { ask: 'Go?' } }, {}]);
  });

  it('reports text that does not parse, and leaves it alone', () => {
    const bad = 'title: [oops\n';
    expect(readWorkflowYaml(bad).value).toBeNull();
    expect(readWorkflowYaml(bad).error).toMatch(/line/);
    expect(setYaml(bad, ['title'], 'x')).toBe(bad);
    expect(textList(' a, ,b ')).toEqual(['a', 'b']);
    expect(newStageKey([{ key: 'stage-2' }, { key: 'x' }])).toBe('stage-3');
  });
});

describe('Workflows view', () => {
  it('lists each workflow with its parameters, stages and gates', async () => {
    await mount(createElement(Workflows, { nav: nav() }));
    const card = document.querySelector('[data-testid="workflow-r-bugfix"]')!;
    expect(card.textContent).toContain('Bug fix');
    expect(card.textContent).toContain('approved by your start');
    expect(card.textContent).toContain('bug *');
    const stages = [...card.querySelectorAll('[data-stage]')];
    expect(stages.map((s) => s.getAttribute('data-stage'))).toEqual(['fix', 'ok']);
    expect(stages[1]!.getAttribute('data-gate')).toBe('true');
    expect(stages[1]!.textContent).toContain('Gate: Ship it?');
  });

  it('explains workflows and offers New workflow when there are none', async () => {
    list = [];
    await mount(createElement(Workflows, { nav: nav() }));
    expect(document.body.textContent).toContain('No workflows yet');
    expect(document.body.textContent).toContain('campaign launch');
  });

  it('creates a workflow from a template and saves it as new', async () => {
    await mount(createElement(Workflows, { nav: nav() }));
    await click(button('New workflow'));
    const dialog = document.querySelector('[data-new-workflow]')!;
    expect(button('Open editor', dialog).disabled).toBe(false);
    expect((dialog.querySelector('input') as HTMLInputElement).value).toBe('feature');
    await click(button('Open editor', dialog));
    expect(document.querySelector('[data-workflow-editor]')).not.toBeNull();
    await settle(400);
    const checked = calls.find((c) => c.path === '/api/workflows/check');
    expect(checked?.body).toMatchObject({ id: 'feature', root: 'r', text: 'title: Feature\n' });
    await click(button('Save'));
    expect(calls.find((c) => c.path === '/api/workflows/save')?.body).toEqual({
      as: 'human:dawid',
      root: 'r',
      id: 'feature',
      text: 'title: Feature\n',
      create: true,
    });
  });

  it('edits a field in the form, writes the YAML, and saves with the text it started from', async () => {
    await mount(createElement(Workflows, { nav: nav() }));
    await click(button('Edit'));
    const form = document.querySelector('[data-testid="workflow-form"]')!;
    const title = form.querySelector('input') as HTMLInputElement;
    expect(title.value).toBe('Bug fix');
    await type(title, 'Hotfix');
    await click(button('YAML'));
    const yaml = document.querySelector(
      'textarea[aria-label="Workflow YAML"]',
    ) as HTMLTextAreaElement;
    expect(yaml.value).toContain('title: Hotfix');
    expect(yaml.value).toContain('# Bug fix');
    await settle(400);
    await click(button('Save'));
    const save = calls.find((c) => c.path === '/api/workflows/save')!;
    expect(save.body).toMatchObject({ id: 'bugfix', root: 'r', expect: TEXT });
    expect(String(save.body!.text)).toContain('title: Hotfix');
  });

  it('edits a gate’s answers one per line and a parameter’s pattern in the form', async () => {
    expect(linesText(['yes', 'yes, with notes'])).toBe('yes\nyes, with notes');
    expect(textLines(' yes \r\n\nyes, with notes\n')).toEqual(['yes', 'yes, with notes']);
    await mount(createElement(Workflows, { nav: nav() }));
    await click(button('Edit'));
    const form = document.querySelector('[data-testid="workflow-form"]')!;
    const gate = form.querySelector('[data-stage-form="ok"]')!;
    const answers = [...gate.querySelectorAll('label')]
      .find((l) => l.textContent?.startsWith('Gate answers'))!
      .querySelector('textarea')!;
    await type(answers, 'yes\nyes, with notes');
    const param = form.querySelector('[data-param="bug"]')!;
    const pattern = [...param.querySelectorAll('label')]
      .find((l) => l.textContent?.startsWith('Pattern'))!
      .querySelector('input')!;
    await type(pattern, '[a-z ]+');
    await click(button('YAML'));
    const yaml = document.querySelector(
      'textarea[aria-label="Workflow YAML"]',
    ) as HTMLTextAreaElement;
    const value = readWorkflowYaml(yaml.value).value!;
    expect((value.stages as Array<Record<string, unknown>>)[1]!.gate).toEqual({
      ask: 'Ship it?',
      options: ['yes', 'yes, with notes'],
    });
    expect((value.params as Record<string, Record<string, unknown>>).bug!.pattern).toBe('[a-z ]+');
  });

  it('shows problems with their lines and keeps Save off while the text has errors', async () => {
    check = {
      ok: false,
      def: null,
      problems: [
        {
          file: 'x',
          path: 'stages.0.estimate',
          line: 15,
          col: 15,
          severity: 'error',
          message: 'use minutes, hours or days',
        },
      ],
    };
    await mount(createElement(Workflows, { nav: nav() }));
    await click(button('Edit'));
    await settle(400);
    const problems = document.querySelector('[data-testid="workflow-problems"]')!;
    expect(problems.textContent).toContain('line 15:15');
    expect(problems.textContent).toContain('use minutes, hours or days');
    expect(button('Save').disabled).toBe(true);
  });

  it('previews the compiled plan with its gate', async () => {
    await mount(createElement(Workflows, { nav: nav() }));
    await click(button('Edit'));
    await settle(400);
    await click(button('Preview'));
    const preview = document.querySelector('[data-testid="workflow-preview"]')!;
    expect(preview.textContent).toContain('Fix: example');
    expect(preview.querySelector('[data-plan-item="ok"]')!.textContent).toContain('Gate');
  });

  it('deletes a workflow after a confirm', async () => {
    await mount(createElement(Workflows, { nav: nav() }));
    await click(button('Delete'));
    const dialog = document.querySelector('[data-delete-workflow]')!;
    expect(calls.some((c) => c.path === '/api/workflows/delete')).toBe(false);
    await click(button('Delete', dialog));
    expect(calls.find((c) => c.path === '/api/workflows/delete')?.body).toEqual({
      as: 'human:dawid',
      root: 'r',
      id: 'bugfix',
      expect: TEXT,
    });
  });

  it('points Start a workflow at Workflows when the project has none', async () => {
    list = [];
    const open = vi.fn();
    await mount(
      createElement(StartWorkflow, {
        me: 'human:dawid',
        onClose: () => {},
        onStarted: () => {},
        onOpenWorkflows: open,
      }),
    );
    const empty = document.querySelector('[data-no-workflows]')!;
    expect(empty.textContent).toContain('Workflows');
    await click(button('Open Workflows'));
    expect(open).toHaveBeenCalled();
  });

  it('is allowed by the desktop’s call list', () => {
    expect(allowedCall('GET', '/api/workflows/templates')).toBe(true);
    for (const w of ['check', 'save', 'delete']) {
      expect(allowedCall('POST', `/api/workflows/${w}`)).toBe(true);
    }
  });
});
