// @vitest-environment happy-dom
// Settings > Definitions, rendered: each project's swarm.yaml state, effective values with their
// source, problems by file:line:col with their lines marked in the YAML view, Validate, Import
// from my settings (preview, then write), Create swarm.yaml, and in-app edits checked as you type.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DefsImportPlan, DefsView } from '../ui/src/types';
import { DefinitionsPanel, defsValueText, problemWhere } from '../ui/src/ui/defs';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let box: HTMLDivElement;
let calls: Array<{ method: string; path: string; body?: Record<string, unknown> }>;
let view: DefsView;

const DIR = 'C:\\work\\site\\.swarmup';
const TEXT = 'swarmup_defs: 1\nruntimes:\n  claude: { model: opus }\nroles:\n  qa: { burst: x }\n';

const IMPORT: DefsImportPlan = {
  file: `${DIR}\\swarm.yaml`,
  exists: true,
  before: TEXT,
  after: `${TEXT}  engineer: { per_project: 2 }\n`,
  diff: ['+  engineer: { per_project: 2 }'],
  keys: ['roles.engineer.per_project'],
  empty: false,
  problems: [],
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  calls = [];
  view = {
    roots: [
      {
        root: 'site',
        dir: DIR,
        present: true,
        hash: `d:${'a'.repeat(64)}`,
        short: 'd:aaaaaaaaaaaa',
        dirty: true,
        ok: false,
        stale: true,
        agents: 2,
        text: TEXT,
        problems: [
          {
            file: `${DIR}\\swarm.yaml`,
            path: 'roles.qa.burst',
            line: 5,
            col: 15,
            severity: 'error',
            message: 'expected a whole number',
          },
          {
            file: `${DIR}\\agents\\claude-qa.md`,
            path: 'role',
            line: 3,
            col: 1,
            severity: 'warning',
            message: 'not active yet',
          },
        ],
      },
      {
        root: 'docs',
        dir: 'C:\\work\\docs\\.swarmup',
        present: false,
        hash: 'd:b',
        short: 'd:b',
        ok: true,
        stale: false,
        agents: 0,
        problems: [],
      },
    ],
    applied: [{ key: 'runtimes.codex.effort', root: 'site' }],
    overrides: [{ key: 'runtimes.claude.model', machine: 'sonnet', git: 'opus', root: 'site' }],
    conflicts: [],
    values: [
      {
        key: 'runtimes.claude.model',
        value: 'sonnet',
        source: 'machine',
        git: 'opus',
        root: 'site',
      },
      { key: 'runtimes.codex.effort', value: 'low', source: 'git', git: 'low', root: 'site' },
      {
        key: 'roles.qa.providers',
        value: ['claude', 'codex'],
        source: 'git',
        git: [],
        root: 'site',
      },
    ],
  };
  window.swarmup = {
    call: (method: string, path: string, body?: Record<string, unknown>) => {
      calls.push({ method, path, body });
      if (path === '/api/defs') return Promise.resolve({ ok: true, data: view });
      if (path === '/api/defs/import') {
        return Promise.resolve({
          ok: true,
          data: body?.write ? { ...IMPORT, written: true } : IMPORT,
        });
      }
      if (path === '/api/defs/validate') {
        return Promise.resolve({
          ok: true,
          data: body?.root
            ? { ok: true, present: true, hash: 'd:a', problems: [] }
            : { ok: true, problems: [] },
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
});

async function render(): Promise<void> {
  root = createRoot(box);
  await act(async () => {
    root!.render(createElement(DefinitionsPanel));
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

function button(label: string, within: ParentNode = document.body): HTMLButtonElement {
  const b = [...within.querySelectorAll('button')].find((x) => x.textContent?.trim() === label);
  if (!b) throw new Error(`no button ${label}`);
  return b as HTMLButtonElement;
}

describe('Definitions helpers', () => {
  it('writes values as YAML does and problems relative to the store', () => {
    expect(defsValueText(['claude', 'codex'])).toBe('[claude, codex]');
    expect(defsValueText(2)).toBe('2');
    expect(defsValueText(true)).toBe('true');
    expect(problemWhere(view.roots[0]!.problems[1]!, DIR)).toBe('agents/claude-qa.md:3:1');
  });
});

describe('Settings > Definitions', () => {
  it('shows the hash, dirty state, effective values with their source, and problems by line', async () => {
    await render();
    const site = box.querySelector('[data-testid="defs-root-site"]')!;
    expect(site.textContent).toContain('d:aaaaaaaaaaaa');
    expect(site.textContent).toContain('uncommitted changes');
    expect(site.textContent).toContain('last good version in use');
    expect(site.textContent).toContain('1 error');
    const rows = [...site.querySelectorAll('[data-testid="defs-values"] tbody tr')].map((r) =>
      [...r.querySelectorAll('td')].map((td) => td.textContent),
    );
    expect(rows).toEqual([
      ['runtimes.claude.model', 'sonnet', 'this machine', 'opus'],
      ['runtimes.codex.effort', 'low', 'git', ''],
      ['roles.qa.providers', '[claude, codex]', 'git', ''],
    ]);
    const problems = site.querySelector('[data-testid="defs-problems"]')!.textContent;
    expect(problems).toContain('swarm.yaml:5:15 expected a whole number');
    expect(problems).toContain('agents/claude-qa.md:3:1 not active yet');
    // Only swarm.yaml's own problems mark its lines.
    const marked = [...site.querySelectorAll('[data-testid="defs-yaml"] [data-problem]')];
    expect(
      marked.map((l) => [l.getAttribute('data-line'), l.getAttribute('data-problem')]),
    ).toEqual([['5', 'error']]);
    expect(marked[0]!.textContent).toContain('col 15: expected a whole number');
    // A project without swarm.yaml offers to create one.
    const docs = box.querySelector('[data-testid="defs-root-docs"]')!;
    expect(docs.textContent).toContain('No swarm.yaml');
    await click(button('Create swarm.yaml', docs));
    expect(calls.find((c) => c.path === '/api/defs/create')?.body).toEqual({ root: 'docs' });
  });

  it('validates a project and shows what the check found', async () => {
    await render();
    const site = box.querySelector('[data-testid="defs-root-site"]')!;
    await click(button('Validate', site));
    expect(calls.find((c) => c.path === '/api/defs/validate')?.body).toEqual({ root: 'site' });
    expect(site.querySelector('[data-testid="defs-no-problems"]')).not.toBeNull();
  });

  it('previews Import from my settings and writes swarm.yaml only on confirm', async () => {
    await render();
    const site = box.querySelector('[data-testid="defs-root-site"]')!;
    await click(button('Import from my settings', site));
    expect(calls.filter((c) => c.path === '/api/defs/import')).toEqual([
      { method: 'POST', path: '/api/defs/import', body: { root: 'site' } },
    ]);
    expect(document.querySelector('[data-testid="defs-import-diff"]')?.textContent).toContain(
      '+  engineer: { per_project: 2 }',
    );
    await click(button('Update swarm.yaml'));
    expect(calls.filter((c) => c.path === '/api/defs/import')[1]!.body).toEqual({
      root: 'site',
      write: true,
      expect: IMPORT.after,
    });
  });

  it('checks edits as you type and saves with the text it started from', async () => {
    await render();
    const site = box.querySelector('[data-testid="defs-root-site"]')!;
    await click(button('Edit', site));
    const area = site.querySelector<HTMLTextAreaElement>('textarea')!;
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    const next = TEXT.replace('burst: x', 'burst: 2');
    act(() => {
      set.call(area, next);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    expect(calls.filter((c) => c.path === '/api/defs/validate').pop()?.body).toMatchObject({
      text: next,
    });
    await click(button('Save', site));
    expect(calls.find((c) => c.path === '/api/defs/save')?.body).toEqual({
      root: 'site',
      text: next,
      expect: TEXT,
    });
  });
});
