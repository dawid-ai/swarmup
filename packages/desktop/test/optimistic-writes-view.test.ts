// @vitest-environment happy-dom
// Writes show before opsd answers (AO-0171): a task comment and a chat message appear at once,
// marked as sending, and New conversation clears the chat at once. When opsd answers, its copy
// replaces the pending one; when the write fails, the pending one goes, the text returns to the
// box and the error shows.
import { act, createElement } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Nav } from '../ui/src/App';
import type { ChatMessage, ChatView, OpsEvent, Task, TaskDetail } from '../ui/src/types';
import { Chat } from '../ui/src/views/Chat';
import { TaskPanel } from '../ui/src/views/TaskPanel';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

type Answer = { ok: boolean; data?: unknown; error?: string };

/** What each GET path answers; anything else gets an empty list. */
const answers = new Map<string, unknown>();
/** Writes the UI sent and opsd has not answered yet; the test answers each. */
const held: Array<{ path: string; body: Record<string, unknown>; answer: (a: Answer) => void }> =
  [];

let root: Root | undefined;
let box: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  answers.clear();
  held.length = 0;
  const off = (): (() => void) => () => {};
  window.swarmup = {
    call: (method: string, path: string, body?: Record<string, unknown>) => {
      if (method !== 'GET') {
        return new Promise<Answer>((answer) => held.push({ path, body: body ?? {}, answer }));
      }
      return Promise.resolve({ ok: true, data: answers.get(path.split('?')[0]!) ?? [] });
    },
    info: () => Promise.resolve({ me: 'human:dawid', pid: 1, roots: [] }),
    setupStatus: () => Promise.resolve({ needed: false }),
    desktop: () => Promise.resolve({ ok: false }),
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

async function mount(el: ReactElement): Promise<void> {
  root = createRoot(box);
  await act(async () => root!.render(el));
  await settle();
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const nav = (): Nav => ({ me: 'human:dawid', openTask: vi.fn(), go: vi.fn() });

function button(text: string): HTMLButtonElement {
  const b = [...document.body.querySelectorAll('button')].find((x) =>
    x.textContent?.trim().startsWith(text),
  );
  if (!b) throw new Error(`no ${text} button`);
  return b;
}

async function click(b: Element): Promise<void> {
  await act(async () => {
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function type(el: HTMLTextAreaElement, text: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Answers the oldest held write. */
async function answer(a: Answer): Promise<void> {
  const w = held.shift();
  if (!w) throw new Error('no write is out');
  await act(async () => w.answer(a));
  await settle();
}

const event = (id: string, body: string): OpsEvent => ({
  id,
  type: 'comment',
  actor: 'human:dawid',
  at: new Date().toISOString(),
  body,
});

describe('a task comment', () => {
  const t = {
    id: 'AO-0001',
    root: 'r',
    title: 'Slow clicks',
    type: 'task',
    priority: 'p2',
    status: 'todo',
    owner: 'claude:engineer',
    claimedBy: null,
    leaseUntil: null,
    reviewer: null,
    waitingOn: null,
    updatedAt: '2026-11-09T00:00:00Z',
  } as unknown as Task;
  const path = `/api/tasks/${encodeURIComponent('r/AO-0001')}`;

  async function open(): Promise<HTMLTextAreaElement> {
    answers.set(path, { task: t, body: '', events: [] } satisfies TaskDetail);
    await mount(createElement(TaskPanel, { id: 'r/AO-0001', nav: nav(), onClose: vi.fn() }));
    return box.querySelector('textarea')!;
  }

  it('shows at once, marked as sending, and takes the stored copy when opsd answers', async () => {
    const area = await open();
    type(area, 'Measured: 34 ms');
    await click(button('Comment'));
    // opsd has not answered: the comment is in the thread and the box is empty.
    expect(held.map((w) => w.path)).toEqual([`${path}/comment`]);
    expect(box.querySelector('ol')?.textContent).toContain('Measured: 34 ms');
    expect(box.querySelector('ol [data-pending]')?.textContent).toBe('sending…');
    expect(area.value).toBe('');
    const stored = event('01M7000000000000000000000A', 'Measured: 34 ms');
    answers.set(path, { task: t, body: '', events: [stored] } satisfies TaskDetail);
    await answer({ ok: true, data: { events: [stored] } });
    expect(box.querySelector('ol [data-pending]')).toBeNull();
    expect(box.querySelector(`#ev-${stored.id}`)?.textContent).toContain('Measured: 34 ms');
    expect(box.querySelector('ol')?.textContent?.match(/Measured: 34 ms/g)).toHaveLength(1);
  });

  it('goes again when opsd refuses it, with the text back in the box and the reason', async () => {
    const area = await open();
    type(area, 'Measured: 34 ms');
    await click(button('Comment'));
    expect(box.querySelector('ol')?.textContent).toContain('Measured: 34 ms');
    await answer({ ok: false, error: 'task store is locked' });
    expect(box.querySelector('ol')?.textContent ?? '').not.toContain('Measured: 34 ms');
    expect(area.value).toBe('Measured: 34 ms');
    expect(box.textContent).toContain('task store is locked');
  });
});

describe('the PM chat', () => {
  const view = (messages: ChatMessage[]): ChatView => ({
    agent: 'claude:pm',
    mentions: false,
    messages,
    live: null,
    streaming: null,
    busy: null,
    waiting: null,
  });
  const msg = (id: string, text: string, role: ChatMessage['role'] = 'user'): ChatMessage => ({
    id,
    role,
    at: new Date().toISOString(),
    text,
    from: role === 'user' ? 'human:dawid' : undefined,
    status: role === 'user' ? 'sent' : undefined,
  });

  it('shows a message at once and swaps in what opsd answers', async () => {
    answers.set('/api/chat', view([]));
    await mount(createElement(Chat, { nav: nav() }));
    const area = box.querySelector('textarea')!;
    type(area, 'What is left on AO-0171?');
    await click(button('Send'));
    expect(held.map((w) => w.path)).toEqual(['/api/chat']);
    expect(box.textContent).toContain('What is left on AO-0171?');
    expect(box.querySelector('[data-pending]')?.textContent).toBe('sending…');
    expect(area.value).toBe('');
    const after = view([{ ...msg('m1', 'What is left on AO-0171?'), status: 'queued' }]);
    // What opsd stored, for any read from here on.
    answers.set('/api/chat', after);
    await answer({ ok: true, data: after });
    expect(box.querySelector('[data-pending]')).toBeNull();
    expect(box.textContent?.match(/What is left on AO-0171\?/g)).toHaveLength(1);
    expect(box.textContent).toContain('queued');
  });

  it('takes a failed message back into the box and says why', async () => {
    answers.set('/api/chat', view([]));
    await mount(createElement(Chat, { nav: nav() }));
    const area = box.querySelector('textarea')!;
    type(area, 'hello');
    await click(button('Send'));
    await answer({ ok: false, error: 'opsd is not running' });
    expect(box.querySelector('[data-pending]')).toBeNull();
    expect(area.value).toBe('hello');
    expect(box.textContent).toContain('opsd is not running');
  });

  it('clears for a new conversation at once, and brings the old one back when opsd refuses', async () => {
    answers.set(
      '/api/chat',
      view([msg('m1', 'first question'), msg('m2', 'an answer', 'assistant')]),
    );
    await mount(createElement(Chat, { nav: nav() }));
    expect(box.textContent).toContain('first question');
    await click(button('New conversation'));
    expect(held.map((w) => w.path)).toEqual(['/api/chat/reset']);
    expect(box.textContent).not.toContain('first question');
    expect(box.textContent).toContain('No conversation yet');
    await answer({ ok: false, error: 'a turn is still running' });
    expect(box.textContent).toContain('first question');
    expect(box.textContent).toContain('a turn is still running');
    // Asked again, opsd starts the new conversation.
    await click(button('New conversation'));
    answers.set('/api/chat', view([]));
    await answer({ ok: true, data: view([]) });
    expect(box.textContent).not.toContain('first question');
  });
});
