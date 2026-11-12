// @vitest-environment happy-dom
// The status loops (AO-0263): which of the four animated states a task, a run and the inbox get,
// which files each state loads, that reduced motion gets the still, and that each view shows at
// most one loop.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act, createElement } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Nav } from '../ui/src/App';
import {
  inboxLoop,
  inboxWaiting,
  LOOP_MIN_PX,
  LOOP_STATES,
  LOOPS,
  runLoop,
  taskLoop,
} from '../ui/src/lib/statusloop';
import type { InboxItem, OpsEvent, RunRecord, Task } from '../ui/src/types';
import { loopImage, StatusLoop } from '../ui/src/ui/statusloop';
import { Inbox } from '../ui/src/views/Inbox';
import { Runs } from '../ui/src/views/Runs';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** A fake swarmupd for the Runs view: one page holding `net.runs`. */
const net = vi.hoisted(() => ({ runs: [] as unknown[] }));

vi.mock(import('../ui/src/api'), async (original) => ({
  ...(await original()),
  useData: <T>(path: string | null) => ({
    data: (path?.startsWith('/api/runs?')
      ? {
          runs: net.runs,
          more: false,
          counts: { all: net.runs.length, live: 0, ended: 0, errors: 0 },
          today: { runs: 0, tokens: 0, errors: 0 },
          pick: null,
        }
      : undefined) as T | undefined,
    error: null,
    reload: () => {},
    set: () => {},
  }),
  api: async <T>(): Promise<T> => '' as T,
}));

// vitest runs from the repo root; under happy-dom, import.meta.url is not a file URL.
const assets = resolve('packages/desktop/ui/src/assets/brand/status');

let root: Root | undefined;
let box: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  net.runs = [];
  box = document.createElement('div');
  document.body.append(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
});

async function mount(el: ReactElement): Promise<void> {
  root = createRoot(box);
  await act(async () => root!.render(el));
}

const loops = (): string[] =>
  [...box.querySelectorAll('[data-loop]')].map((el) => el.getAttribute('data-loop')!);

function task(patch: Partial<Task> = {}): Task {
  return {
    id: 'AO-0001',
    root: 'ops',
    title: 'A task',
    type: 'task',
    priority: 'p2',
    status: 'todo',
    owner: 'claude:engineer',
    claimedBy: null,
    leaseUntil: null,
    reviewer: null,
    waitingOn: null,
    checkpoint: null,
    updatedAt: '2026-11-12T08:00:00Z',
    ...patch,
  };
}

let seq = 0;
function ev(type: string, patch: Partial<OpsEvent> = {}): OpsEvent {
  seq++;
  return {
    id: `E${seq}`,
    type,
    actor: 'claude:engineer',
    at: '2026-11-12T08:00:00Z',
    body: '',
    ...patch,
  };
}

function run(patch: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'R0001',
    agent: 'claude:engineer',
    pid: 1,
    cwd: 'C:/ops',
    started_at: new Date(Date.now() - 60_000).toISOString(),
    ended_at: new Date().toISOString(),
    status: 'ended',
    reason: 'exit',
    exit: 0,
    budget_minutes: 60,
    tokens: 10,
    task: 'AO-0001',
    root: 'ops',
    ...patch,
  };
}

function item(kind: InboxItem['kind']): InboxItem {
  return { kind, task: 'AO-0001', root: 'ops', title: 'A task', summary: 'Pick a region' };
}

function nav(): Nav {
  return { me: 'human:dawid', openTask: vi.fn(), go: vi.fn() };
}

describe('runLoop', () => {
  it('is working while the run is live', () => {
    expect(runLoop({ status: 'running' })).toBe('working');
  });

  it('is done for a run that exited with 0', () => {
    expect(runLoop({ status: 'ended', reason: 'exit', exit: 0 })).toBe('done');
  });

  it('is failed for a non-zero exit, a budget, a token limit and a lost process', () => {
    expect(runLoop({ status: 'ended', reason: 'exit', exit: 1 })).toBe('failed');
    expect(runLoop({ status: 'ended', reason: 'budget', exit: null })).toBe('failed');
    expect(runLoop({ status: 'ended', reason: 'tokens', exit: null })).toBe('failed');
    expect(runLoop({ status: 'ended', reason: 'lost', exit: null })).toBe('failed');
  });

  it('has no loop for a killed run: someone chose to stop it', () => {
    expect(runLoop({ status: 'ended', reason: 'killed', exit: null })).toBeNull();
  });
});

describe('taskLoop', () => {
  it('is working while someone holds the task', () => {
    expect(taskLoop(task({ status: 'in-progress', claimedBy: 'claude:engineer' }))).toBe('working');
    expect(taskLoop(task({ status: 'claimed', claimedBy: 'claude:engineer' }))).toBe('working');
  });

  it('has no loop in the queue, parked, or on a stale claim', () => {
    expect(taskLoop(task())).toBeNull();
    expect(taskLoop(task({ status: 'parked' }))).toBeNull();
    expect(taskLoop(task({ status: 'in-progress', stale: true }))).toBeNull();
  });

  it('is done when the task closed, whatever its runs did', () => {
    const events = [ev('run-end', { reason: 'exit', exit: 1 })];
    expect(taskLoop(task({ status: 'done' }), events)).toBe('done');
  });

  it('is needs-you for a review that waits for a person, not for an agent reviewer', () => {
    expect(taskLoop(task({ status: 'needs-review', reviewer: 'human:dawid' }))).toBe('needs-you');
    expect(taskLoop(task({ status: 'needs-review', reviewer: 'codex:reviewer' }))).toBeNull();
  });

  it("is needs-you for a review with no named reviewer: it waits in the person's queue", () => {
    expect(taskLoop(task({ status: 'needs-review', reviewer: null }))).toBe('needs-you');
    // A failed run before the request does not hide that the review waits.
    const events = [ev('run-end', { reason: 'exit', exit: 1 })];
    expect(taskLoop(task({ status: 'needs-review', reviewer: null }), events)).toBe('needs-you');
  });

  it('is needs-you for a question to a person, not for a block on an agent or a task', () => {
    expect(taskLoop(task({ status: 'blocked', waitingOn: 'human:dawid' }))).toBe('needs-you');
    expect(taskLoop(task({ status: 'blocked', waitingOn: 'codex:pm' }))).toBeNull();
    expect(taskLoop(task({ status: 'blocked', blockedOn: ['AO-0002'] }))).toBeNull();
    expect(
      taskLoop(task({ status: 'blocked', waitingOn: 'human:dawid', unblocked: true })),
    ).toBeNull();
  });

  it('is failed when the last run failed, even while the claim still stands', () => {
    const events = [ev('claim'), ev('run-start'), ev('run-end', { reason: 'lost', exit: null })];
    expect(taskLoop(task({ status: 'in-progress' }), events)).toBe('failed');
    expect(taskLoop(task({ status: 'todo' }), events)).toBe('failed');
  });

  it('stops being failed when someone takes the task up again', () => {
    const failed = ev('run-end', { reason: 'exit', exit: 2 });
    const held = task({ status: 'in-progress' });
    expect(taskLoop(held, [failed, ev('run-start')])).toBe('working');
    expect(taskLoop(held, [failed, ev('claim')])).toBe('working');
    expect(taskLoop(held, [failed, ev('comment')])).toBe('failed');
  });

  it('does not call a killed run or a clean exit a failure', () => {
    const held = task({ status: 'in-progress' });
    expect(taskLoop(held, [ev('run-end', { reason: 'killed', exit: null })])).toBe('working');
    expect(taskLoop(held, [ev('run-end', { reason: 'exit', exit: 0 })])).toBe('working');
  });

  it('shows the question, not the failure, when the task also waits for a person', () => {
    const events = [ev('run-end', { reason: 'budget', exit: null })];
    expect(taskLoop(task({ status: 'blocked', waitingOn: 'human:dawid' }), events)).toBe(
      'needs-you',
    );
  });
});

describe('inboxLoop', () => {
  it('has no loop before the inbox loaded', () => {
    expect(inboxLoop(undefined)).toBeNull();
  });

  it('is done at inbox zero', () => {
    expect(inboxLoop([])).toBe('done');
  });

  it('is needs-you while something holds work up for the person', () => {
    for (const kind of ['ask', 'review', 'vote', 'decide', 'triage', 'stranded'] as const) {
      expect(inboxLoop([item('message'), item(kind)])).toBe('needs-you');
    }
    expect(inboxWaiting([item('ask'), item('review'), item('mention')])).toBe(2);
  });

  it('has no loop for messages, mentions and assigned tasks alone', () => {
    expect(inboxLoop([item('message'), item('mention'), item('owned')])).toBeNull();
  });
});

describe('the kit files', () => {
  it('has the 64 and 128 px loop and both stills for every state', () => {
    const files = readdirSync(assets).sort();
    const want = LOOP_STATES.flatMap((s) =>
      ['64.webp', '128.webp', 'still-64.png', 'still-256.png'].map(
        (f) => `swarmup-status-${s}-${f}`,
      ),
    ).sort();
    expect(files).toEqual(want);
  });

  /** The loop count in an animated WebP's `ANIM` chunk: 0 is forever. */
  function loopCount(file: string): number {
    const buf = readFileSync(join(assets, file));
    const at = buf.indexOf('ANIM', 12, 'latin1');
    expect(at).toBeGreaterThan(0);
    // Chunk id (4), chunk size (4), background color (4), then the loop count (2).
    return buf.readUInt16LE(at + 12);
  }

  it('encodes done and failed to play once, working and needs-you to loop', () => {
    for (const s of LOOP_STATES) {
      for (const px of [64, 128]) {
        expect(loopCount(`swarmup-status-${s}-${px}.webp`), `${s} ${px}`).toBe(
          LOOPS[s].once ? 1 : 0,
        );
      }
    }
  });
});

describe('StatusLoop', () => {
  it('loads the 64 px loop at 48 px, with the 128 px file for 2x screens', () => {
    const img = loopImage('working', 48);
    expect(img.src).toContain('swarmup-status-working-64.webp');
    expect(img.srcSet).toMatch(/working-64\.webp 1x, .*working-128\.webp 2x$/);
    expect(loopImage('done', 96).src).toContain('swarmup-status-done-128.webp');
  });

  it('draws every state with its name as the image text', async () => {
    for (const s of LOOP_STATES) {
      await mount(createElement(StatusLoop, { state: s }));
      const img = box.querySelector('img')!;
      expect(img.getAttribute('src')).toContain(`swarmup-status-${s}-64.webp`);
      expect(img.getAttribute('alt')).toBe(LOOPS[s].label);
      expect(img.getAttribute('width')).toBe('48');
      act(() => root?.unmount());
    }
  });

  it('offers the still, and only the still, when reduced motion is set', async () => {
    for (const s of LOOP_STATES) {
      await mount(createElement(StatusLoop, { state: s, size: 64 }));
      const source = box.querySelector('picture > source')!;
      // The source comes before the img, so a browser with reduced motion on picks it.
      expect(source.nextElementSibling?.tagName).toBe('IMG');
      expect(source.getAttribute('media')).toBe('(prefers-reduced-motion: reduce)');
      const set = source.getAttribute('srcset')!;
      expect(set).toContain(`swarmup-status-${s}-still-64.png`);
      expect(set).not.toContain('.webp');
      act(() => root?.unmount());
    }
  });

  it('never draws under 48 px, where the 3D mark is unreadable', async () => {
    await mount(createElement(StatusLoop, { state: 'working', size: 14 }));
    expect(box.querySelector('img')!.getAttribute('width')).toBe(String(LOOP_MIN_PX));
  });
});

describe('the views', () => {
  it('shows one needs-you loop in an inbox with several waiting items', async () => {
    await mount(
      createElement(Inbox, {
        nav: nav(),
        items: [item('ask'), item('review'), item('triage'), item('message')],
        error: null,
      }),
    );
    expect(loops()).toEqual(['needs-you']);
    expect(box.textContent).toContain('3 things wait for you');
  });

  it('shows the done loop at inbox zero and none for messages alone', async () => {
    await mount(createElement(Inbox, { nav: nav(), items: [], error: null }));
    expect(loops()).toEqual(['done']);
    act(() => root?.unmount());
    await mount(createElement(Inbox, { nav: nav(), items: [item('message')], error: null }));
    expect(loops()).toEqual([]);
  });

  it('shows one loop in Runs, for the picked run, however many rows the list has', async () => {
    net.runs = [
      run({ id: 'R0003', status: 'running', ended_at: undefined, exit: undefined }),
      run({ id: 'R0002', reason: 'lost', exit: null }),
      run({ id: 'R0001' }),
    ];
    await mount(createElement(Runs, { nav: nav() }));
    expect(loops()).toEqual([]);
    for (const [id, state] of [
      ['R0003', 'working'],
      ['R0002', 'failed'],
      ['R0001', 'done'],
    ] as const) {
      act(() => root?.unmount());
      await mount(createElement(Runs, { nav: nav(), selected: id }));
      expect(loops(), id).toEqual([state]);
    }
  });
});
