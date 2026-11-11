// @vitest-environment happy-dom
// The Replay view (AO-0076): the playback clock, the controls (play, pause, scrub, speed, loop),
// scene switching, and scenes as a pure function of playback time t.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowedCall } from '../src/allow';
import {
  clock,
  initialPlayback,
  playbackAt,
  realAt,
  seek,
  seeded,
  tick,
  togglePlay,
} from '../ui/src/lib/replay';
import { STAGE_16_9, renderFrame, sceneDuration } from '../ui/src/replay/scene';
import { SCENES, sceneById } from '../ui/src/replay/scenes';
import { valueAt, prepareCounters } from '../ui/src/replay/scenes/counters';
import { Replay, timelinePath } from '../ui/src/views/Replay';
import { H, T0, fixture } from './replay-fixture';

describe('playback clock', () => {
  it('advances by wall time times speed only while playing', () => {
    const p = initialPlayback(10_000);
    expect(tick(p, 500)).toBe(p);
    const playing = togglePlay(p);
    expect(tick(playing, 500).t).toBe(500);
    expect(tick({ ...playing, speed: 2 }, 500).t).toBe(1000);
    expect(tick({ ...playing, speed: 0.25 }, 400).t).toBe(100);
  });

  it('stops and pauses on the last frame, or wraps with loop on', () => {
    const near = { ...togglePlay(initialPlayback(10_000)), t: 9_800 };
    expect(tick(near, 500)).toMatchObject({ t: 10_000, playing: false });
    expect(tick({ ...near, loop: true }, 500)).toMatchObject({ t: 300, playing: true });
  });

  it('play on the last frame starts again; seek clamps to the clip', () => {
    const end = { ...initialPlayback(10_000), t: 10_000 };
    expect(togglePlay(end)).toMatchObject({ playing: true, t: 0 });
    expect(togglePlay(togglePlay(end)).playing).toBe(false);
    expect(seek(end, -5).t).toBe(0);
    expect(seek(end, 99_999).t).toBe(10_000);
    expect(seek(end, Number.NaN).t).toBe(0);
    expect(togglePlay(initialPlayback(0)).playing).toBe(false);
  });

  it('keeps speed and loop across a new clip', () => {
    const old = { ...initialPlayback(5000), speed: 4, loop: true, t: 3000 };
    expect(initialPlayback(8000, old)).toEqual({
      t: 0,
      duration: 8000,
      playing: false,
      speed: 4,
      loop: true,
    });
  });

  it('maps playback time back to real time', () => {
    const map = fixture().time;
    for (const ms of [T0, T0 + 0.25 * H, T0 + 1.5 * H, T0 + 3 * H]) {
      expect(realAt(map, playbackAt(map, ms))).toBeCloseTo(ms, 3);
    }
    expect(realAt(map, -1)).toBe(T0);
    expect(realAt(map, 99_999)).toBe(T0 + 3 * H);
    expect(clock(61_250)).toBe('1:01.2');
  });

  it('gives the same random sequence for the same seed', () => {
    const a = seeded(42);
    const b = seeded(42);
    const seqA = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(seqA);
    expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(seeded(43)()).not.toBe(seqA[0]);
  });
});

describe('scenes', () => {
  const frame = (t: number) => ({ ...STAGE_16_9, t, duration: 30_000 });

  it.each(SCENES.map((s) => [s.id, s] as const))(
    '%s renders the same frame twice for the same t',
    (_id, scene) => {
      for (const t of [0, 7_345.5, 15_000, 30_000]) {
        // Prepared twice too, so nothing carries over between preparations.
        const a = renderToStaticMarkup(
          renderFrame(scene, scene.prepare(fixture(), STAGE_16_9), frame(t)),
        );
        const b = renderToStaticMarkup(
          renderFrame(scene, scene.prepare(fixture(), STAGE_16_9), frame(t)),
        );
        expect(a).toBe(b);
        expect(a).toContain(`data-scene="${scene.id}"`);
      }
      // Time moves the picture: the first and last frames differ.
      const data = scene.prepare(fixture(), STAGE_16_9);
      expect(renderToStaticMarkup(renderFrame(scene, data, frame(0)))).not.toBe(
        renderToStaticMarkup(renderFrame(scene, data, frame(30_000))),
      );
    },
  );

  it('reads no wall clock and no unseeded randomness', () => {
    const dir = join(import.meta.dirname, '..', 'ui', 'src', 'replay');
    const files = [
      join(dir, 'scene.tsx'),
      ...readdirSync(join(dir, 'scenes')).map((f) => join(dir, 'scenes', f)),
    ];
    for (const f of files) {
      const src = readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '');
      expect(src, f).not.toMatch(
        /Date\.now|performance\.now|Math\.random|new Date\(\s*\)|toLocale/,
      );
    }
  });

  it('counts each total at the playback time it happened', () => {
    const d = prepareCounters(fixture());
    const by = (label: string) => d.counters.find((c) => c.label === label)!;
    expect(valueAt(by('Tasks closed'), 19_999)).toBe(0);
    expect(valueAt(by('Tasks closed'), 20_000)).toBe(1);
    expect(valueAt(by('Asks answered'), 8_000)).toBe(1);
    expect(valueAt(by('Tokens'), 9_999)).toBe(0);
    expect(valueAt(by('Tokens'), 10_000)).toBe(5000);
  });

  it('falls back to the first scene for an unknown id', () => {
    expect(sceneById('nope')).toBe(SCENES[0]);
    expect(new Set(SCENES.map((s) => s.id)).size).toBe(SCENES.length);
  });
});

describe('timeline path and allow list', () => {
  const base = { project: '', days: 7, custom: false, from: '', to: '', clip: 30 };

  it('builds the swarmupd call for a window, a clip and a project', () => {
    expect(timelinePath(base)).toBe('/api/timeline?days=7&clip=30');
    expect(timelinePath({ ...base, project: 'swarm up', clip: 15 })).toBe(
      '/api/timeline?days=7&clip=15&project=swarm%20up',
    );
    expect(timelinePath({ ...base, custom: true })).toBeNull();
    expect(timelinePath({ ...base, custom: true, from: '2026-11-01', to: '2026-11-03' })).toBe(
      '/api/timeline?from=2026-11-01&to=2026-11-03&clip=30',
    );
  });

  it('lets the page call the timeline route', () => {
    expect(allowedCall('GET', '/api/timeline?days=7&clip=30&project=x')).toBe(true);
    expect(allowedCall('POST', '/api/timeline')).toBe(false);
  });
});

// The view, with swarmupd mocked and requestAnimationFrame driven by hand.
const paths = vi.hoisted(() => [] as string[]);
const served = vi.hoisted(() => ({ timeline: null as unknown }));

vi.mock(import('../ui/src/api'), async (original) => ({
  ...(await original()),
  useData: <T>(path: string | null) => {
    if (path) paths.push(path);
    const data = path?.startsWith('/api/timeline')
      ? served.timeline
      : path === '/api/tasks?all'
        ? [{ id: 'AO-1', project: 'swarmup' }]
        : undefined;
    return { data: data as T, error: null, reload: () => {}, set: () => {} };
  },
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let box: HTMLDivElement;
let frames: Array<(now: number) => void> = [];
let now = 0;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  paths.length = 0;
  served.timeline = fixture();
  frames = [];
  now = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames[id - 1] = () => {};
  });
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

function render(): void {
  act(() => root!.render(createElement(Replay)));
}

function byLabel(label: string): HTMLElement {
  const el = box.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!el) throw new Error(`no ${label}`);
  return el;
}

function button(text: string): HTMLButtonElement {
  const b = [...box.querySelectorAll('button')].find((x) => x.textContent?.trim() === text);
  if (!b) throw new Error(`no ${text} button`);
  return b;
}

const clockText = (): string => box.querySelector('[data-testid="replay-clock"]')!.textContent!;
const scrub = (): HTMLInputElement => byLabel('Scrub') as HTMLInputElement;

/** Runs the pending animation frames `ms` of wall time later. */
function advance(ms: number): void {
  now += ms;
  const pending = frames;
  frames = [];
  act(() => pending.forEach((cb) => cb(now)));
}

function setRange(input: HTMLInputElement, value: number): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Replay view', () => {
  // The default scene's clip: the 30 s timeline plus its outro card, if it has one.
  const END = clock(sceneDuration(SCENES[0]!, fixture()));
  const query = (scene = SCENES[0]!): string => (scene.query ? `&${scene.query}` : '');

  it('plays, pauses and stops at the end', () => {
    render();
    expect(clockText()).toBe(`0:00.0 / ${END}`);
    act(() => byLabel('Play').click());
    expect(byLabel('Pause')).toBeTruthy();
    advance(0); // the first frame only sets the start
    advance(1000);
    expect(clockText()).toBe(`0:01.0 / ${END}`);
    act(() => byLabel('Pause').click());
    advance(1000);
    expect(clockText()).toBe(`0:01.0 / ${END}`);
    act(() => byLabel('Play').click());
    advance(0);
    advance(60_000);
    expect(clockText()).toBe(`${END} / ${END}`);
    expect(byLabel('Play')).toBeTruthy();
  });

  it('plays faster or slower with the speed buttons', () => {
    render();
    act(() => button('2×').click());
    expect(button('2×').getAttribute('aria-pressed')).toBe('true');
    act(() => byLabel('Play').click());
    advance(0);
    advance(1000);
    expect(clockText()).toBe(`0:02.0 / ${END}`);
    act(() => button('0.25×').click());
    advance(1000);
    expect(clockText()).toBe(`0:02.2 / ${END}`);
  });

  it('scrubs to a time, and Back to start returns to 0', () => {
    render();
    setRange(scrub(), 12_500);
    expect(clockText()).toBe(`0:12.5 / ${END}`);
    expect(Number(scrub().value)).toBe(12_500);
    act(() => byLabel('Back to start').click());
    expect(clockText()).toBe(`0:00.0 / ${END}`);
  });

  it('loops back to the start when loop is on', () => {
    render();
    act(() => byLabel('Loop').click());
    expect(byLabel('Loop').getAttribute('aria-pressed')).toBe('true');
    setRange(scrub(), sceneDuration(SCENES[0]!, fixture()) - 500);
    act(() => byLabel('Play').click());
    advance(0);
    advance(1000);
    expect(clockText()).toBe(`0:00.5 / ${END}`);
    expect(byLabel('Pause')).toBeTruthy();
  });

  it('switches scenes and keeps the playhead', () => {
    render();
    setRange(scrub(), 15_000);
    const stage = () => box.querySelector('[data-testid="replay-stage"] svg')!;
    expect(stage().getAttribute('data-scene')).toBe(SCENES[0]!.id);
    const other = SCENES[1]!;
    act(() => button(other.label).click());
    expect(stage().getAttribute('data-scene')).toBe(other.id);
    expect(button(other.label).getAttribute('aria-pressed')).toBe('true');
    expect(clockText()).toBe(`0:15.0 / ${END}`);
    // The stage shows the scene's frame for the current t.
    const expected = renderToStaticMarkup(
      renderFrame(other, other.prepare(fixture(), STAGE_16_9), {
        ...STAGE_16_9,
        t: 15_000,
        duration: sceneDuration(other, fixture()),
      }),
    );
    // Same text and same shapes; the DOM and the server serialize styles differently.
    const parsed = document.createElement('div');
    parsed.innerHTML = expected;
    const want = parsed.firstElementChild!;
    expect(stage().textContent).toBe(want.textContent);
    const widths = (el: Element) =>
      [...el.querySelectorAll('rect')].map((r) => r.getAttribute('width')).join(',');
    expect(widths(stage())).toBe(widths(want));
    expect(stage().textContent).toContain('2026-11-02 10:30 UTC');
  });

  it('asks swarmupd for the picked window and starts the new clip from 0', () => {
    render();
    expect(paths).toContain(`/api/timeline?days=7&clip=30${query()}`);
    setRange(scrub(), 10_000);
    act(() => button('30 days').click());
    expect(paths).toContain(`/api/timeline?days=30&clip=30${query()}`);
    expect(clockText()).toBe(`0:00.0 / ${END}`);
  });

  it('plays and seeks from the keyboard', () => {
    render();
    const stage = box.querySelector('[data-testid="replay-stage"]')!;
    act(() => {
      stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(clockText()).toBe(`0:01.0 / ${END}`);
    act(() => {
      stage.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(byLabel('Pause')).toBeTruthy();
  });

  it('shows an empty state when the window has nothing to play', () => {
    served.timeline = { ...fixture(), time: { segments: [], playbackMs: 0, maxGapMs: 1 } };
    render();
    expect(box.textContent).toContain('Nothing to replay in this window');
    expect(box.querySelector('[aria-label="Play"]')).toBeNull();
  });
});
