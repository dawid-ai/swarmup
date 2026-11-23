// @vitest-environment happy-dom
// The Knowledge view's learn-note promotion (W6): **Promote candidates** lists the notes that keep
// mattering, **Fold into role** files the improver's task, and **Archive** moves a note with why.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Nav } from '../ui/src/App';
import type { KbCandidate, KbNote } from '../ui/src/types';
import { Knowledge } from '../ui/src/views/Knowledge';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const note = (topic: string, slug: string, title: string): KbNote => ({
  root: 'r',
  topic,
  slug,
  ref: `${topic}/${slug}`,
  title,
  author: 'claude:engineer',
  created_at: '2026-11-03T12:00:00Z',
  body: 'Body.',
  score: 0,
});

const candidate = (n: KbNote): KbCandidate => {
  const meta = { root: n.root, topic: n.topic, slug: n.slug, ref: n.ref, title: n.title };
  return {
    ref: n.ref,
    note: { ...meta, author: n.author, created_at: n.created_at },
    shown: 6,
    reads: 0,
    relearned: [],
    why: ['shown in 6 run prompts in 30 days'],
    agents: [{ agent: 'claude:engineer', shown: 6, reads: 0 }],
    for: ['claude:engineer'],
  };
};

let root: Root | undefined;
let box: HTMLDivElement;
const posts: Array<{ path: string; body: unknown }> = [];

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  posts.length = 0;
  const rebase = note('git', 'rebase', 'Rebase onto main');
  const answers = new Map<string, unknown>([
    ['/api/kb', [rebase, note('ui', 'grid', 'Grid gaps')]],
    ['/api/kb/promote', { days: 30, candidates: [candidate(rebase)] }],
  ]);
  window.swarmup = {
    call: (method: string, path: string, body?: unknown) => {
      if (method === 'POST') {
        posts.push({ path, body });
        return Promise.resolve({ ok: true, data: { id: 'T-0009' } });
      }
      return Promise.resolve({ ok: true, data: answers.get(path.split('?')[0]!) ?? [] });
    },
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

const button = (text: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(text),
  );
  if (!found) throw new Error(`no button '${text}'`);
  return found;
};

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
}

it('lists promote candidates and files the improver task for the agent', async () => {
  root = createRoot(box);
  await act(async () => root!.render(createElement(Knowledge, { nav: nav() })));
  await click(button('Promote candidates'));
  const rows = [...document.body.querySelectorAll('.row-link')].map((r) => r.textContent);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toContain('Rebase onto main');
  expect(rows[0]).toContain('shown in 6 run prompts in 30 days');
  expect(document.body.textContent).toContain('Keeps mattering');
  await click(button('Fold into role: claude:engineer'));
  expect(posts).toEqual([
    { path: '/api/improve', body: { agent: 'claude:engineer', kind: 'notes' } },
  ]);
});

it('archives a note with why', async () => {
  root = createRoot(box);
  await act(async () => root!.render(createElement(Knowledge, { nav: nav() })));
  await click(button('Archive'));
  const input = document.body.querySelector<HTMLInputElement>('input[placeholder^="Why archive"]')!;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, 'Folded into the engineer role');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const archive = [...document.body.querySelectorAll('button')].filter(
    (b) => b.textContent === 'Archive',
  );
  await click(archive[0]!);
  expect(posts).toEqual([
    {
      path: '/api/kb/archive',
      body: { refs: ['r/git/rebase'], message: 'Folded into the engineer role' },
    },
  ]);
});
