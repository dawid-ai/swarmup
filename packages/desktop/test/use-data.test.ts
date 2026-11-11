// @vitest-environment happy-dom
// AO-0164: refresh signals while swarmupd is slow. A view keeps at most one request per path in
// flight and asks once more when it is back, and views that read the same path share a request,
// so a busy swarmupd does not get a new round of requests for every event it sends.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { refreshSoon, useData } from '../ui/src/api';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let box: HTMLDivElement;
/** Every GET the bridge got, and the answers still owed, in order. */
let calls: string[];
let owed: (() => void)[];

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  calls = [];
  owed = [];
  window.swarmup = {
    call: (_method: 'GET' | 'POST', path: string) => {
      calls.push(path);
      const n = calls.length;
      return new Promise((res) => owed.push(() => res({ ok: true, data: `answer ${n}` })));
    },
  } as unknown as NonNullable<Window['swarmup']>;
  box = document.createElement('div');
  document.body.append(box);
  root = createRoot(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
  delete window.swarmup;
});

function Show({ path, id }: { path: string; id: string }) {
  const { data } = useData<string>(path);
  return createElement('span', { 'data-id': id }, data ?? 'loading');
}

const text = (id: string): string | null =>
  box.querySelector(`[data-id="${id}"]`)?.textContent ?? null;

/** Lets bridge promises and the 250 ms shared refresh run. */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

/** Answers every request still owed. */
async function answerAll(): Promise<void> {
  const now = owed.splice(0);
  await act(async () => {
    for (const f of now) f();
  });
  await settle();
}

describe('useData while swarmupd is slow (AO-0164)', () => {
  it('sends no new request for a path while one is out, and one more when it is back', async () => {
    act(() => root!.render(createElement(Show, { path: '/api/tasks', id: 'a' })));
    await settle();
    expect(calls).toEqual(['/api/tasks']);

    // Three refresh signals while the first request is still out.
    for (let i = 0; i < 3; i++) {
      act(() => refreshSoon());
      await settle(300);
    }
    expect(calls).toEqual(['/api/tasks']);

    await answerAll();
    expect(text('a')).toBe('answer 1');
    // The refreshes that came in meanwhile cost one request, not three.
    expect(calls).toEqual(['/api/tasks', '/api/tasks']);
    await answerAll();
    expect(text('a')).toBe('answer 2');
    expect(calls).toHaveLength(2);
  });

  it('shares one request among views that read the same path', async () => {
    act(() =>
      root!.render(
        createElement('div', null, [
          createElement(Show, { key: 'a', path: '/api/runs?live', id: 'a' }),
          createElement(Show, { key: 'b', path: '/api/runs?live', id: 'b' }),
          createElement(Show, { key: 'c', path: '/api/waits', id: 'c' }),
        ]),
      ),
    );
    await settle();
    expect(calls.sort()).toEqual(['/api/runs?live', '/api/waits']);
    await answerAll();
    expect(text('a')).toMatch(/^answer /);
    expect(text('b')).toBe(text('a'));

    act(() => refreshSoon());
    await settle(300);
    expect(calls).toHaveLength(4);
    await answerAll();
  });

  it('reload during a request sends a new one at once and drops the old answer', async () => {
    let reload: () => void = () => {};
    function WithReload() {
      const r = useData<string>('/api/tasks/T-1');
      reload = r.reload;
      return createElement('span', { 'data-id': 'a' }, r.data ?? 'loading');
    }
    act(() => root!.render(createElement(WithReload)));
    await settle();
    expect(calls).toEqual(['/api/tasks/T-1']);

    // A write ends, and the view reloads while the GET from before the write is still out.
    act(() => reload());
    await settle();
    expect(calls).toEqual(['/api/tasks/T-1', '/api/tasks/T-1']);

    // The pre-write answer comes back first: it must not show.
    const [before, after] = owed.splice(0);
    await act(async () => before!());
    await settle();
    expect(text('a')).toBe('loading');

    await act(async () => after!());
    await settle();
    expect(text('a')).toBe('answer 2');

    // Refreshes during the reload still cost one follow-up, not one each.
    act(() => reload());
    await settle();
    act(() => refreshSoon());
    await settle(300);
    act(() => refreshSoon());
    await settle(300);
    expect(calls).toHaveLength(3);
    await answerAll();
    expect(text('a')).toBe('answer 3');
    expect(calls).toHaveLength(4);
    await answerAll();
    expect(text('a')).toBe('answer 4');
    expect(calls).toHaveLength(4);
  });
});
