// @vitest-environment happy-dom
// Review rally (AO-0082): one task's review rounds as a 10 s rally, picked from the Replay view,
// rendered the same for the same t in 16:9, 1:1 and 9:16, and recorded with the picked task.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordOptions } from '../ui/src/lib/record';
import { ASPECTS } from '../ui/src/lib/record';
import { STAGE_16_9, renderFrame } from '../ui/src/replay/scene';
import type { Stage } from '../ui/src/replay/scene';
import { sceneById } from '../ui/src/replay/scenes';
import {
  RALLY_MS,
  chipAt,
  prepareRally,
  rallyAt,
  rallyChoices,
  rallyScene,
  verdictOf,
} from '../ui/src/replay/scenes/rally';
import type { ReviewRound, Timeline } from '../ui/src/types';
import { Replay } from '../ui/src/views/Replay';
import { fixture, iso } from './replay-fixture';

function round(
  task: string,
  n: number,
  start: number,
  end: number | null,
  verdict?: 'approve' | 'changes',
): ReviewRound {
  return {
    root: 'r',
    task,
    title: task === 'AO-7' ? 'Replay timeline from task events' : 'Other task',
    round: n,
    author: 'claude:engineer',
    reviewer: 'codex:reviewer',
    start: iso(start),
    end: end === null ? null : iso(end),
    ...(verdict ? { decidedBy: 'codex:reviewer', verdict } : {}),
    endedBy: verdict ? 'verdict' : end === null ? 'open' : 'release',
  };
}

/** AO-7: three rounds, changes twice, then approved. AO-1 (from the fixture): one round. */
function rallyTimeline(): Timeline {
  const tl = fixture();
  return {
    ...tl,
    reviews: [
      ...tl.reviews,
      round('AO-7', 3, 2.5, 2.9, 'approve'),
      round('AO-7', 1, 0.2, 0.5, 'changes'),
      round('AO-7', 2, 1.2, 1.6, 'changes'),
    ],
  };
}

const markup = (d: unknown, stage: Stage, t: number, duration = RALLY_MS): string =>
  renderToStaticMarkup(renderFrame(rallyScene, d as never, { ...stage, t, duration }));

describe('review rally', () => {
  it('offers tasks with review rounds, most rounds first', () => {
    expect(rallyChoices(rallyTimeline())).toEqual([
      { id: 'r/AO-7', label: 'AO-7 · 3 rounds · Replay timeline from task events' },
      { id: 'r/AO-1', label: 'AO-1 · 1 round · One' },
    ]);
    expect(rallyChoices({ ...fixture(), reviews: [] })).toEqual([]);
  });

  it('keeps the same task id in two roots apart', () => {
    const other = (r: ReviewRound): ReviewRound => ({ ...r, root: 'q', title: 'Same id, q' });
    const tl: Timeline = {
      ...fixture(),
      reviews: [
        round('AO-7', 1, 0.2, 0.5, 'changes'),
        round('AO-7', 2, 1.2, 1.6, 'approve'),
        other(round('AO-7', 1, 0.3, 0.6, 'approve')),
      ],
    };
    // A shared id gets its root in the label; the picker offers both.
    expect(rallyChoices(tl)).toEqual([
      { id: 'r/AO-7', label: 'r/AO-7 · 2 rounds · Replay timeline from task events' },
      { id: 'q/AO-7', label: 'q/AO-7 · 1 round · Same id, q' },
    ]);
    const r = prepareRally(tl, 'r/AO-7');
    expect([r.root, r.task, r.rounds.length]).toEqual(['r', 'AO-7', 2]);
    const q = prepareRally(tl, 'q/AO-7');
    expect([q.root, q.task, q.title, q.rounds.length]).toEqual(['q', 'AO-7', 'Same id, q', 1]);
    expect(q.rounds[0]).toMatchObject({ round: 1, verdict: 'approved' });
  });

  it('builds the rounds in order, each labeled with its verdict', () => {
    const d = prepareRally(rallyTimeline(), 'r/AO-7');
    expect(d.task).toBe('AO-7');
    expect(d.rounds.map((r) => [r.round, r.verdict])).toEqual([
      [1, 'changes asked'],
      [2, 'changes asked'],
      [3, 'approved'],
    ]);
    expect(d.rounds[0]).toMatchObject({
      author: 'claude:engineer',
      reviewer: 'codex:reviewer',
      asked: '2026-11-02 09:12 UTC',
      returned: true,
    });
    // First request at 09:12 to the approval at 11:54.
    expect(d.span).toBe('2h42m');
    // No choice, or an unknown one, takes the task with the most rounds.
    expect(prepareRally(rallyTimeline()).task).toBe('AO-7');
    expect(prepareRally(rallyTimeline(), 'nope').task).toBe('AO-7');
    expect(prepareRally(rallyTimeline(), 'r/AO-1').rounds).toHaveLength(1);
  });

  it('labels rounds that ended without a verdict', () => {
    expect(verdictOf(round('AO-7', 1, 0, null)).text).toBe('in review');
    expect(verdictOf(round('AO-7', 1, 0, 1)).text).toBe('released');
  });

  it('serves and returns each round in an equal share of the clip', () => {
    expect(rallyAt(3, 0)).toMatchObject({ phase: 'intro' });
    expect(rallyAt(3, 1)).toMatchObject({ phase: 'end', index: 2 });
    // The rally runs from 12 % to 80 % of the clip; each round gets a third of that.
    const slot = 0.68 / 3;
    expect(rallyAt(3, 0.12 + slot * 0.25)).toMatchObject({ index: 0, shot: 'serve' });
    expect(rallyAt(3, 0.12 + slot * 0.25).u).toBeCloseTo(0.5);
    expect(rallyAt(3, 0.12 + slot * 1.75)).toMatchObject({ index: 1, shot: 'return' });
    expect(rallyAt(3, 0.12 + slot * 1.75).u).toBeCloseTo(0.5);
    expect(chipAt(0, 3)).toBeCloseTo(0.12 + slot);
    expect(chipAt(2, 3)).toBeCloseTo(0.8);
  });

  it('renders three rounds ending on approved in 16:9, 1:1 and 9:16', () => {
    const slot = (0.68 / 3) * RALLY_MS;
    for (const { stage } of ASPECTS) {
      const d = rallyScene.prepare(rallyTimeline(), stage, 'r/AO-7');
      const at = (t: number): string => markup(d, stage, t);
      const start = at(0);
      expect(start).toContain(`viewBox="0 0 ${stage.width} ${stage.height}"`);
      expect(start).toContain('REVIEW RALLY · AO-7');
      expect(start.match(/data-chip="pending"/g)).toHaveLength(3);

      // Round 2's return is in flight with its verdict; round 1's chip is on the board.
      const mid = at(0.12 * RALLY_MS + slot * 1.75);
      expect(mid).toContain('data-round="2"');
      expect(mid).toContain('data-ball=""');
      expect(mid).toMatch(/data-label=""[^>]*>changes asked</);
      expect(mid.match(/data-chip="changes asked"/g)).toHaveLength(1);

      const end = at(RALLY_MS);
      expect(end).toContain('data-ending="approved"');
      expect(end).toContain('>APPROVED<');
      expect(end).toContain('>3 rounds · 2h42m<');
      expect(end).not.toContain('data-ball=""');
      expect(end.match(/data-chip="changes asked"/g)).toHaveLength(2);
      expect(end.match(/data-chip="approved"/g)).toHaveLength(1);
      expect(end).toContain('>R3 approved<');

      // Same t, same frame, prepared twice; time moves the picture.
      for (const t of [0, 1234.5, 5000, RALLY_MS]) {
        expect(markup(rallyScene.prepare(rallyTimeline(), stage, 'r/AO-7'), stage, t)).toBe(at(t));
      }
      expect(at(3000)).not.toBe(at(3100));
    }
  });

  it('keeps the ball with the reviewer while the last round waits', () => {
    const tl = {
      ...fixture(),
      reviews: [round('AO-7', 1, 0, 1, 'changes'), round('AO-7', 2, 1.5, null)],
    };
    const d = prepareRally(tl);
    const end = markup(d, STAGE_16_9, RALLY_MS);
    expect(end).toContain('data-ending="in review"');
    expect(end).toContain('>IN REVIEW<');
  });

  it('says so when the window has no review rounds', () => {
    const d = prepareRally({ ...fixture(), reviews: [] });
    expect(markup(d, STAGE_16_9, 0)).toContain('No review rounds in this window');
  });

  it('is a scene with a task picker and a fixed 10 s clip', () => {
    expect(sceneById('rally')).toBe(rallyScene);
    expect(rallyScene.clipMs).toBe(10_000);
    expect(rallyScene.pick?.label).toBe('Task');
  });
});

// The view, with swarmupd mocked.
const served = vi.hoisted(() => ({ timeline: null as unknown }));

vi.mock(import('../ui/src/api'), async (original) => ({
  ...(await original()),
  useData: <T>(path: string | null) => {
    const data = path?.startsWith('/api/timeline')
      ? served.timeline
      : path === '/api/tasks?all'
        ? [{ id: 'AO-7', project: 'swarmup' }]
        : undefined;
    return { data: data as T | undefined, error: null, reload: () => {}, set: () => {} };
  },
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let box: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  served.timeline = rallyTimeline();
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  box = document.createElement('div');
  document.body.append(box);
  root = createRoot(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
  vi.unstubAllGlobals();
});

function button(text: string): HTMLButtonElement {
  const b = [...box.querySelectorAll('button')].find((x) => x.textContent?.trim() === text);
  if (!b) throw new Error(`no ${text} button`);
  return b;
}

const clockText = (): string => box.querySelector('[data-testid="replay-clock"]')!.textContent!;
const stage = (): Element => box.querySelector('[data-testid="replay-stage"] svg')!;
const taskSelect = (): HTMLSelectElement | undefined =>
  [...box.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'r/AO-7'));

function pick(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('Replay view with the review rally', () => {
  it('picks a task, plays 10 s, and starts again from 0 on another task', () => {
    const record = vi.fn<(opts: RecordOptions) => Promise<Uint8Array>>();
    act(() => root!.render(createElement(Replay, { record })));
    expect(taskSelect()).toBeUndefined();
    act(() => button('Review rally').click());
    expect(stage().getAttribute('data-scene')).toBe('rally');
    expect(clockText()).toBe('0:00.0 / 0:10.0');
    expect(box.textContent).toContain('Clip 10 s');
    const select = taskSelect()!;
    expect(select.value).toBe('r/AO-7');
    expect([...select.options].map((o) => o.value)).toEqual(['r/AO-7', 'r/AO-1']);
    expect(stage().textContent).toContain('REVIEW RALLY · AO-7');

    const scrub = box.querySelector<HTMLInputElement>('[aria-label="Scrub"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(scrub, '6000');
      scrub.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(clockText()).toBe('0:06.0 / 0:10.0');

    pick(select, 'r/AO-1');
    expect(stage().textContent).toContain('REVIEW RALLY · AO-1');
    expect(clockText()).toBe('0:00.0 / 0:10.0');
  });

  it('says there is nothing to pick when no task was reviewed in the window', () => {
    served.timeline = { ...fixture(), reviews: [] };
    act(() => root!.render(createElement(Replay)));
    act(() => button('Review rally').click());
    expect(box.textContent).toContain('No review rounds in this window');
    expect(box.querySelector('[aria-label="Play"]')).toBeNull();
  });
});
