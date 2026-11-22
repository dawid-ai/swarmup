// @vitest-environment happy-dom
// The task panel's Work section (W8): the artifacts the latest review names, read at the
// reviewed commit. Markdown renders, images show inline, URLs are links, Changes shows a
// word-level diff against the base, and criterion evidence that names a path opens it. Also the
// builders of the new checks.
import { act, createElement } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Nav } from '../ui/src/App';
import type { OpsEvent, Task, TaskArtifact, TaskDetail } from '../ui/src/types';
import { criterionLine, draftOf, draftProblem, entryOf, newDraft } from '../ui/src/ui/criteria';
import { TaskPanel } from '../ui/src/views/TaskPanel';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const answers = new Map<string, unknown>();
const gets: string[] = [];
let root: Root | undefined;
let box: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  answers.clear();
  gets.length = 0;
  const off = (): (() => void) => () => {};
  window.swarmup = {
    call: (method: string, path: string) => {
      if (method === 'GET') {
        gets.push(path);
        return Promise.resolve({ ok: true, data: answers.get(path) ?? [] });
      }
      return Promise.resolve({ ok: true, data: { events: [] } });
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
  await settle();
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
  await settle();
}

const nav = (): Nav => ({ me: 'human:dawid', openTask: vi.fn(), go: vi.fn() });

const COMMIT = 'abc1234def5678abc1234def5678abc1234def56';
const TASK = `/api/tasks/${encodeURIComponent('launch/LC-0004')}`;
const artifactPath = (path: string): string =>
  `${TASK}/artifact?path=${encodeURIComponent(path)}&commit=${COMMIT}`;

const task: Task = {
  id: 'LC-0004',
  root: 'launch',
  title: 'X thread',
  type: 'content',
  priority: 'p1',
  status: 'needs-review',
  owner: 'claude:writer',
  claimedBy: null,
  leaseUntil: null,
  reviewer: 'codex:editor',
  waitingOn: null,
  checkpoint: null,
  updatedAt: '2026-11-22T10:00:00Z',
};

const review: OpsEvent = {
  id: '01REVIEW',
  type: 'review',
  actor: 'claude:writer',
  at: '2026-11-22T09:00:00Z',
  to: 'codex:editor',
  commit: COMMIT,
  artifacts: [
    { kind: 'file', ref: 'posts/x-launch.md' },
    { kind: 'image', ref: 'assets/og/card.png' },
    { kind: 'url', ref: 'https://example.com/preview', label: 'Preview' },
    { kind: 'file', ref: 'notes.txt' },
  ],
  body: 'LC-0004: the thread is ready.',
};

const POST: TaskArtifact = {
  path: 'posts/x-launch.md',
  commit: COMMIT,
  kind: 'text',
  text: '---\nchannel: x\nstatus: draft\n---\n# Launch\n\nSwarmUp ships agents today.\n',
  bytes: 80,
  base: {
    commit: '1111111aaaa',
    text: '---\nchannel: x\n---\n# Launch\n\nSwarmUp ships code today.\n',
  },
};

const CARD: TaskArtifact = {
  path: 'assets/og/card.png',
  commit: COMMIT,
  kind: 'image',
  data: 'data:image/png;base64,iVBORw0KGgo=',
  bytes: 8,
};

function detail(): TaskDetail {
  return {
    task,
    body: 'Write the launch thread.',
    events: [review],
    criteria: [
      {
        id: 'length',
        kind: 'check',
        check: 'char-count',
        args: { path: 'posts/x-*.md', max: 280, per: 'block', separator: '---' },
      },
    ],
    criteriaResults: {
      length: {
        result: 'fail',
        evidence: 'notes.txt: 1 of 3 blocks out of range (block 2 has 301)',
        event: 'E2',
        actor: 'opsd:merge',
        at: '2026-11-22T09:30:00Z',
        type: 'criteria-check',
      },
    },
  };
}

async function openPanel(): Promise<void> {
  answers.set(TASK, detail());
  answers.set(artifactPath('posts/x-launch.md'), POST);
  answers.set(artifactPath('assets/og/card.png'), CARD);
  answers.set(artifactPath('notes.txt'), {
    path: 'notes.txt',
    commit: COMMIT,
    kind: 'text',
    text: 'plain notes',
    bytes: 11,
    base: null,
  } satisfies TaskArtifact);
  await mount(createElement(TaskPanel, { id: 'launch/LC-0004', nav: nav(), onClose: vi.fn() }));
}

const work = (): HTMLElement => box.querySelector<HTMLElement>('[data-work]')!;
const row = (ref: string): HTMLElement =>
  work().querySelector<HTMLElement>(`[data-artifact="${ref}"]`)!;

describe('the Work section', () => {
  it('lists the review artifacts at the reviewed commit', async () => {
    await openPanel();
    expect(work()).toBeTruthy();
    expect(work().textContent).toContain('at abc1234');
    expect(
      [...work().querySelectorAll('[data-artifact]')].map((e) => e.getAttribute('data-artifact')),
    ).toEqual([
      'posts/x-launch.md',
      'assets/og/card.png',
      'https://example.com/preview',
      'notes.txt',
    ]);
  });

  it('renders the first Markdown file without its front matter as a rule', async () => {
    await openPanel();
    const md = row('posts/x-launch.md').querySelector('[data-artifact-markdown]')!;
    // happy-dom's DOMPurify keeps only the first element (see markdown-text.test.ts), so the
    // heading is checked as text; markdown-sanitize.test.ts checks headings under jsdom.
    expect(md.querySelector('.md')?.textContent).toContain('Launch');
    expect(md.querySelector('hr')).toBeNull();
    expect(md.textContent).toContain('SwarmUp ships agents today.');
    expect(md.querySelector('pre')?.textContent).toContain('channel: x');
    // Opened lazily: the closed text file has not been read.
    expect(gets).not.toContain(artifactPath('notes.txt'));
  });

  it('shows an image inline and a URL as a link', async () => {
    await openPanel();
    const img = row('assets/og/card.png').querySelector<HTMLImageElement>('[data-artifact-image]')!;
    expect(img.getAttribute('src')).toBe(CARD.data);
    expect(img.getAttribute('alt')).toBe('assets/og/card.png');
    const a = row('https://example.com/preview').querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://example.com/preview');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.textContent).toBe('Preview');
  });

  it('shows a word-level diff against the base on Changes', async () => {
    await openPanel();
    await click(row('posts/x-launch.md').querySelector('[data-artifact-changes]')!);
    const diff = row('posts/x-launch.md').querySelector('[data-prose-diff]')!;
    const ins = [...diff.querySelectorAll('ins')].map((d) => d.textContent);
    const del = [...diff.querySelectorAll('del')].map((d) => d.textContent);
    expect(ins).toContain('agents');
    expect(ins.some((t) => t?.startsWith('status: draft'))).toBe(true);
    expect(del).toEqual(['code']);
    expect(ins.join('')).not.toContain('Launch');
  });

  it('opens the artifact a criterion names in its evidence', async () => {
    await openPanel();
    expect(row('notes.txt').querySelector('pre')).toBeNull();
    const link = box.querySelector<HTMLButtonElement>(
      '[data-criteria] [data-evidence-artifact="notes.txt"]',
    )!;
    expect(link).toBeTruthy();
    await click(link);
    expect(gets).toContain(artifactPath('notes.txt'));
    expect(row('notes.txt').querySelector('pre')?.textContent).toBe('plain notes');
  });

  it('is not shown when no review names artifacts', async () => {
    answers.set(TASK, { ...detail(), events: [{ ...review, artifacts: undefined }] });
    await mount(createElement(TaskPanel, { id: 'launch/LC-0004', nav: nav(), onClose: vi.fn() }));
    expect(box.querySelector('[data-work]')).toBeNull();
  });
});

describe('the builders of the new checks', () => {
  it('round-trips char-count per block with a separator, and needs Min or Max', () => {
    const spec = {
      id: 'length',
      kind: 'check' as const,
      check: 'char-count',
      args: { path: ['posts/x-*.md', 'posts/hn.md'], max: 280, per: 'block', separator: '---' },
    };
    const d = draftOf(spec, 0);
    expect(d.args).toEqual({
      path: 'posts/x-*.md, posts/hn.md',
      max: '280',
      per: 'block',
      separator: '---',
    });
    expect(entryOf(d)).toEqual(spec);
    expect(draftProblem({ ...d, args: { ...d.args, max: '' } })).toBe('Set Min or Max');
  });

  it('round-trips contains with expect false and front-matter match pairs', () => {
    const banned = {
      id: 'banned',
      kind: 'check' as const,
      check: 'contains',
      args: { path: 'posts/*.md', text: ['leverage', 'game-changer'], expect: false },
    };
    expect(entryOf(draftOf(banned, 0))).toEqual(banned);
    const fm = {
      id: 'fm',
      kind: 'check' as const,
      check: 'front-matter',
      args: {
        path: 'posts/*.md',
        keys: ['channel', 'status'],
        match: { status: '^(draft|approved)$' },
      },
    };
    const d = draftOf(fm, 0);
    expect(d.args.match).toBe('status: ^(draft|approved)$');
    expect(entryOf(d)).toEqual(fm);
    expect(draftProblem({ ...d, args: { ...d.args, match: 'no pair here' } })).toMatch(/Match/);
  });

  it('keeps when: publish, and marks it after publish', () => {
    const live = {
      id: 'live',
      kind: 'check' as const,
      check: 'url-ok',
      args: { url: '{url}' },
      when: 'publish' as const,
    };
    expect(entryOf(draftOf(live, 0))).toEqual(live);
    expect(criterionLine(live)).toBe('url-ok url={url} (after publish)');
    const d = newDraft('check');
    expect(
      entryOf({
        ...d,
        check: 'heading-structure',
        args: { path: 'docs/*.md', headings: '# Title, ## Why' },
      }),
    ).toEqual({
      kind: 'check',
      check: 'heading-structure',
      args: { path: 'docs/*.md', headings: ['# Title', '## Why'] },
    });
  });
});
