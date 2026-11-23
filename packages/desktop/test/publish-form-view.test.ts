// @vitest-environment happy-dom
// W8 phase 2 in the task panel and the criteria builder: Mark published on a publish task a
// person owns, which records the URL through the person-only endpoint, and the builder entries
// of image-alt, image-size and char-count's urls_as; phase 3's readability and page-contains.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Nav } from '../ui/src/App';
import type { Task, TaskDetail } from '../ui/src/types';
import { draftOf, draftProblem, entryOf } from '../ui/src/ui/criteria';
import { TaskPanel } from '../ui/src/views/TaskPanel';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const TASK_PATH = `/api/tasks/${encodeURIComponent('launch/LC-0010')}`;
let detail: TaskDetail;
const posts: Array<{ path: string; body: unknown }> = [];
let root: Root | undefined;
let box: HTMLDivElement;

const task = (over: Partial<Task> = {}): Task => ({
  id: 'LC-0010',
  root: 'launch',
  title: 'Publish the X thread',
  type: 'publish',
  priority: 'p1',
  status: 'todo',
  owner: 'human:dawid',
  claimedBy: null,
  leaseUntil: null,
  reviewer: null,
  waitingOn: null,
  checkpoint: null,
  updatedAt: '2026-11-22T10:00:00Z',
  ...over,
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  posts.length = 0;
  detail = { task: task(), body: 'Post the approved thread.', events: [] };
  const off = (): (() => void) => () => {};
  window.swarmup = {
    call: (method: string, path: string, body?: unknown) => {
      if (method === 'POST') {
        posts.push({ path, body });
        return Promise.resolve({ ok: true, data: { tag: 'published/LC-0010' } });
      }
      return Promise.resolve({ ok: true, data: path === TASK_PATH ? detail : [] });
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

async function mount(): Promise<void> {
  const nav: Nav = { me: 'human:dawid', openTask: vi.fn(), go: vi.fn() };
  root = createRoot(box);
  await act(async () =>
    root!.render(createElement(TaskPanel, { id: 'launch/LC-0010', nav, onClose: vi.fn() })),
  );
  await settle();
  await settle();
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
}

function type(el: HTMLInputElement, text: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function button(label: string): HTMLButtonElement | undefined {
  return [...box.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
}

describe('Mark published', () => {
  it('records the URL and the file through the published endpoint', async () => {
    await mount();
    await click(button('Mark published')!);
    const form = box.querySelector('[data-publish-form]')!;
    const [url, artifact] = [...form.querySelectorAll('input')];
    const record = button('Record publish')!;
    expect(record.disabled).toBe(true);
    type(url!, 'not a url');
    expect(form.textContent).toContain('An http or https URL');
    expect(button('Record publish')!.disabled).toBe(true);
    type(url!, 'https://x.com/dawid/status/1');
    type(artifact!, 'posts/x-thread.md');
    await click(button('Record publish')!);
    expect(posts).toEqual([
      {
        path: `${TASK_PATH}/published`,
        body: {
          as: 'human:dawid',
          url: 'https://x.com/dawid/status/1',
          artifact: 'posts/x-thread.md',
        },
      },
    ]);
    expect(box.querySelector('[data-publish-form]')).toBeNull();
  });

  it('leaves out the file when none is given', async () => {
    await mount();
    await click(button('Mark published')!);
    type(box.querySelector<HTMLInputElement>('[data-publish-form] input')!, 'https://hn.example/1');
    await click(button('Record publish')!);
    expect(posts[0]!.body).toEqual({ as: 'human:dawid', url: 'https://hn.example/1' });
  });

  it('is not offered on other tasks, on a publish task an agent holds, or once done', async () => {
    detail = { ...detail, task: task({ type: 'content', owner: 'human:dawid' }) };
    await mount();
    expect(button('Mark published')).toBeUndefined();
    act(() => root?.unmount());
    detail = { ...detail, task: task({ owner: 'claude:writer' }) };
    await mount();
    expect(button('Mark published')).toBeUndefined();
    act(() => root?.unmount());
    detail = { ...detail, task: task({ status: 'done' }) };
    await mount();
    expect(button('Mark published')).toBeUndefined();
  });
});

describe('Publish with an adapter', () => {
  it('runs the adapter the publish:<name> label names, once more only with Again', async () => {
    detail = { ...detail, task: task({ labels: ['publish:blog'] }) };
    await mount();
    expect(button('Mark published')).toBeDefined();
    await click(button('Publish')!);
    const form = box.querySelector('[data-publish-adapter]')!;
    expect(form.textContent).toContain('blog');
    await click(button('Publish now')!);
    expect(posts).toEqual([{ path: `${TASK_PATH}/publish`, body: { as: 'human:dawid' } }]);
    expect(box.querySelector('[data-publish-adapter]')).toBeNull();
    await click(button('Publish')!);
    const again = box.querySelector<HTMLInputElement>('[data-publish-adapter] input')!;
    await click(again);
    await click(button('Publish now')!);
    expect(posts[1]!.body).toEqual({ as: 'human:dawid', again: true });
  });

  it('is not offered without the label', async () => {
    await mount();
    expect(button('Publish')).toBeUndefined();
  });
});

describe('Preview', () => {
  it('renders the approved files the preview route returns', async () => {
    const call = window.swarmup!.call;
    window.swarmup!.call = (method: 'GET' | 'POST', path: string, body?: unknown) =>
      path === `${TASK_PATH}/preview`
        ? Promise.resolve({
            ok: true,
            data: {
              commit: 'abcdef1234567890',
              files: [
                {
                  path: 'posts/x.md',
                  kind: 'markdown',
                  text: '# Launch\n\nThe **approved** words.',
                },
              ],
            },
          })
        : call(method, path, body);
    await mount();
    await click(button('Preview')!);
    await settle();
    const panel = box.querySelector('[data-publish-preview]')!;
    expect(panel.textContent).toContain('at abcdef1234');
    expect(panel.querySelector('[data-preview-file="posts/x.md"] strong')?.textContent).toBe(
      'approved',
    );
  });
});

describe('the builders of the phase 2 checks', () => {
  it('round-trips image-alt and image-size, and needs a width and a height', () => {
    const alt = {
      id: 'alt',
      kind: 'check' as const,
      check: 'image-alt',
      args: { path: 'posts/*.md' },
    };
    expect(entryOf(draftOf(alt, 0))).toEqual(alt);
    const size = {
      id: 'og',
      kind: 'check' as const,
      check: 'image-size',
      args: { path: 'assets/og/*.png', width: 1200, height: 630, max_kb: 500 },
    };
    const d = draftOf(size, 0);
    expect(d.args).toEqual({
      path: 'assets/og/*.png',
      width: '1200',
      height: '630',
      max_kb: '500',
    });
    expect(entryOf(d)).toEqual(size);
    expect(draftProblem({ ...d, args: { ...d.args, height: '' } })).toBe('Height is required');
  });

  it('round-trips readability, and needs a grade bound', () => {
    const spec = {
      id: 'grade',
      kind: 'check' as const,
      check: 'readability',
      args: { path: 'posts/*.md', max_grade: 9, min_grade: 6 },
    };
    const d = draftOf(spec, 0);
    expect(d.args).toEqual({ path: 'posts/*.md', max_grade: '9', min_grade: '6' });
    expect(entryOf(d)).toEqual(spec);
    expect(draftProblem({ ...d, args: { path: 'posts/*.md' } })).toBe('Set Max grade or Min grade');
    expect(draftProblem({ ...d, args: { ...d.args, min_grade: '10' } })).toBe(
      'Min grade is above Max grade',
    );
  });

  it('round-trips page-contains, after publish only', () => {
    const spec = {
      id: 'live',
      kind: 'check' as const,
      check: 'page-contains',
      args: { from: 'published', contains: ['github.com/you/repo', 'Launch'], absent: 'TODO' },
      when: 'publish' as const,
    };
    const d = draftOf(spec, 0);
    expect(d.args).toEqual({
      from: 'published',
      contains: 'github.com/you/repo, Launch',
      absent: 'TODO',
    });
    expect(entryOf(d)).toEqual(spec);
    expect(draftProblem(d)).toBeNull();
    expect(draftProblem({ ...d, when: '' })).toMatch(/check it after publish/);
    expect(draftProblem({ ...d, args: { from: '', contains: 'x' } })).toBe(
      'Set URL, or check the published URL',
    );
    expect(draftProblem({ ...d, args: { from: 'published' } })).toBe('Set Contains or Absent');
  });

  it('round-trips char-count urls_as', () => {
    const spec = {
      id: 'x',
      kind: 'check' as const,
      check: 'char-count',
      args: { path: 'posts/x.md', max: 280, per: 'block', urls_as: 23 },
    };
    const d = draftOf(spec, 0);
    expect(d.args.urls_as).toBe('23');
    expect(entryOf(d)).toEqual(spec);
  });
});
