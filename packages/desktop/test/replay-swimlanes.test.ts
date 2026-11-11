// @vitest-environment happy-dom
// The Swimlanes replay scene (AO-0077): lanes per actor, bars by state, review arcs, glowing waits
// on a person, and a layout that stays inside the stage at 16:9, 1:1 and 9:16.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Stage } from '../ui/src/replay/scene';
import { renderFrame } from '../ui/src/replay/scene';
import { sceneById } from '../ui/src/replay/scenes';
import {
  ARC_MS,
  ARC_TRACE_LIMIT,
  MAX_LANES,
  MAX_TRACKS,
  barStateAt,
  glowsAt,
  laneLimits,
  prepareSwimlanes,
  swimlanesScene,
} from '../ui/src/replay/scenes/swimlanes';
import type { Timeline, TimelineLane } from '../ui/src/types';
import { demoTimeline } from './fixtures/replay-demo';

const H = 3_600_000;
const T0 = Date.parse('2026-11-02T09:00:00.000Z');
const iso = (h: number): string => new Date(T0 + h * H).toISOString();
/** Real hour h plays at h * 10 s: three hours in a 30 s clip. */
const sec = (h: number): number => h * 10_000;

const STAGES: Array<[string, Stage]> = [
  ['16:9', { width: 1920, height: 1080 }],
  ['1:1', { width: 1080, height: 1080 }],
  ['9:16', { width: 1080, height: 1920 }],
];

function lane(agent: string, kind: TimelineLane['kind'] = 'agent'): TimelineLane {
  return {
    agent,
    kind,
    first: iso(0),
    workMs: 0,
    runMs: 0,
    tokens: 0,
    tasks: 0,
    reviews: 0,
  };
}

const span = (task: string, agent: string, a: number, b: number | null, endedBy: string) => ({
  root: 'r',
  task,
  title: task,
  agent,
  start: iso(a),
  end: b === null ? null : iso(b),
  endedBy,
});

/**
 * AO-1 goes to review twice (changes, then approve) and ends blocked on AO-2 at the end of the
 * window; AO-2 overlaps it on the same lane, asks the person once and closes.
 */
function fixture(): Timeline {
  return {
    from: iso(0),
    to: iso(3),
    lanes: [
      lane('opsd:merge', 'system'),
      lane('human:dawid', 'human'),
      lane('claude:engineer'),
      lane('codex:reviewer'),
    ],
    spans: [
      span('AO-1', 'claude:engineer', 0.1, 1, 'review'),
      span('AO-2', 'claude:engineer', 0.5, 2.5, 'done'),
      span('AO-1', 'claude:engineer', 1.5, 2, 'review'),
    ],
    reviews: [
      {
        root: 'r',
        task: 'AO-1',
        title: 'AO-1',
        round: 1,
        author: 'claude:engineer',
        reviewer: 'codex:reviewer',
        start: iso(1),
        end: iso(1.5),
        decidedBy: 'codex:reviewer',
        verdict: 'changes',
        endedBy: 'verdict',
      },
      {
        root: 'r',
        task: 'AO-1',
        title: 'AO-1',
        round: 2,
        author: 'claude:engineer',
        reviewer: 'codex:reviewer',
        start: iso(2),
        end: iso(2.6),
        decidedBy: 'codex:reviewer',
        verdict: 'approve',
        endedBy: 'verdict',
      },
    ],
    waits: [
      {
        root: 'r',
        task: 'AO-2',
        title: 'AO-2',
        kind: 'ask',
        actor: 'claude:engineer',
        waitingOn: 'human:dawid',
        on: [],
        human: true,
        start: iso(0.8),
        end: iso(1.2),
        answered: true,
        endedBy: 'answer',
      },
      {
        root: 'r',
        task: 'AO-1',
        title: 'AO-1',
        kind: 'block',
        actor: 'claude:engineer',
        waitingOn: null,
        on: ['AO-2'],
        human: false,
        start: iso(2.65),
        end: null,
        answered: false,
        endedBy: 'open',
      },
    ],
    runs: [],
    decisions: [],
    notes: [],
    created: [],
    closes: [
      { root: 'r', task: 'AO-2', title: 'AO-2', at: iso(2.5), by: 'claude:engineer', via: 'done' },
      { root: 'r', task: 'AO-1', title: 'AO-1', at: iso(2.7), by: 'opsd:merge', via: 'merge' },
    ],
    totals: {
      agentHours: 0,
      workHours: 0,
      humanMinutes: 0,
      humanWaitMinutes: 0,
      asksAnswered: 0,
      reviewRounds: 0,
      tasksClosed: 0,
      runs: 0,
      tokens: 0,
    },
    time: {
      segments: [{ start: T0, end: T0 + 3 * H, playStart: 0, playEnd: 30_000, idle: false }],
      playbackMs: 30_000,
      maxGapMs: 1_800_000,
    },
  };
}

/** The fixture plus twelve workers, each with ten overlapping tasks and a review round each. */
function dense(): Timeline {
  const tl = fixture();
  for (let i = 0; i < 12; i++) {
    const agent = `codex:worker${i}`;
    tl.lanes.push(lane(agent));
    for (let k = 0; k < 10; k++) {
      const a = 0.05 + k * 0.28 + i * 0.01;
      const task = `AO-${100 + i * 10 + k}`;
      tl.spans.push(span(task, agent, a, a + 0.5, 'review'));
      tl.reviews.push({
        root: 'r',
        task,
        title: 'x',
        round: 1,
        author: agent,
        reviewer: 'codex:reviewer',
        start: iso(a + 0.5),
        end: iso(Math.min(2.99, a + 0.6)),
        decidedBy: 'codex:reviewer',
        verdict: 'approve',
        endedBy: 'verdict',
      });
    }
  }
  return tl;
}

function draw(tl: Timeline, stage: Stage, t: number): Element {
  const data = prepareSwimlanes(tl, stage);
  const html = renderToStaticMarkup(
    renderFrame(swimlanesScene, data, { ...stage, t, duration: tl.time.playbackMs }),
  );
  const box = document.createElement('div');
  box.innerHTML = html;
  return box.firstElementChild!;
}

describe('swimlanes scene', () => {
  it('is in the scene picker', () => {
    expect(sceneById('swimlanes')).toBe(swimlanesScene);
  });

  it('orders lanes agents first, then people, then system actors', () => {
    const d = prepareSwimlanes(fixture(), STAGES[0]![1]);
    expect(d.lanes.map((l) => l.label)).toEqual([
      'claude:engineer',
      'codex:reviewer',
      'human:dawid',
      'opsd:merge',
    ]);
    expect(d.lanes.map((l) => l.kind)).toEqual(['agent', 'agent', 'human', 'system']);
  });

  it('puts each bar on the lane of whoever has to act, stacking overlaps', () => {
    const d = prepareSwimlanes(fixture(), STAGES[0]![1]);
    const bars = d.bars.map((b) => [b.task, d.lanes[b.lane]!.label, b.track, b.state, b.glow]);
    expect(bars).toEqual([
      ['AO-1', 'claude:engineer', 0, 'working', false],
      ['AO-2', 'claude:engineer', 1, 'working', false],
      ['AO-1', 'claude:engineer', 0, 'working', false],
      ['AO-1', 'claude:engineer', 0, 'blocked', false],
      ['AO-1', 'codex:reviewer', 0, 'review', false],
      ['AO-1', 'codex:reviewer', 0, 'review', false],
      ['AO-2', 'human:dawid', 0, 'waiting', true],
    ]);
    expect(d.lanes[0]!.tracks).toBe(2);
    // The open block runs to the end of the clip.
    expect(d.bars[3]!.end).toBe(30_000);
  });

  it('arcs each review round out to the reviewer and back with the verdict', () => {
    const d = prepareSwimlanes(fixture(), STAGES[0]![1]);
    const name = (i: number) => d.lanes[i]!.label.split(':')[0];
    expect(d.arcs.map((a) => [a.kind, name(a.from), name(a.to), Math.round(a.at)])).toEqual([
      ['ask', 'claude', 'human', sec(0.8)],
      ['review', 'claude', 'codex', sec(1)],
      ['answer', 'human', 'claude', sec(1.2)],
      ['changes', 'codex', 'claude', sec(1.5)],
      ['review', 'claude', 'codex', sec(2)],
      ['approve', 'codex', 'claude', sec(2.6)],
    ]);
  });

  it('sends a review with no reviewer to the person', () => {
    const tl = fixture();
    tl.reviews[0]!.reviewer = null;
    tl.reviews[0]!.decidedBy = 'human:dawid';
    const d = prepareSwimlanes(tl, STAGES[0]![1]);
    const reviews = d.bars.filter((b) => b.state === 'review');
    expect(reviews.map((b) => [d.lanes[b.lane]!.label, Math.round(b.start)])).toEqual([
      ['codex:reviewer', sec(2)],
      ['human:dawid', sec(1)],
    ]);
  });

  it('glows a wait on a person from the ask until the answer', () => {
    const stage = STAGES[0]![1];
    const glows = (t: number) =>
      [...draw(fixture(), stage, t).querySelectorAll('[data-glow]')].map((g) =>
        g.getAttribute('data-glow'),
      );
    expect(glows(sec(0.79))).toEqual([]);
    expect(glows(sec(0.8))).toEqual(['AO-2']);
    expect(glows(sec(1.1))).toEqual(['AO-2']);
    expect(glows(sec(1.2))).toEqual([]);
    // An unanswered ask glows to the end of the clip, last frame included.
    const tl = fixture();
    tl.waits[0]!.end = null;
    tl.waits[0]!.answered = false;
    const d = prepareSwimlanes(tl, stage);
    const ask = d.bars.find((b) => b.glow)!;
    expect(glowsAt(ask, 30_000, 30_000)).toBe(true);
  });

  it('grows bars with the playhead and turns a closing bar done when it ends', () => {
    const stage = STAGES[0]![1];
    const bars = (t: number) =>
      [...draw(fixture(), stage, t).querySelectorAll('[data-bar]')].map((g) => [
        g.getAttribute('data-bar'),
        g.getAttribute('data-state'),
        Number(g.querySelector('rect')!.getAttribute('width')),
      ]);
    expect(bars(sec(0.05))).toEqual([]);
    const early = bars(sec(0.3));
    expect(early.map((b) => b[0])).toEqual(['AO-1']);
    const later = bars(sec(0.9));
    expect(later[0]![2]).toBeGreaterThan(early[0]![2] as number);
    const ao2 = (t: number) => bars(t).find((b) => b[0] === 'AO-2' && b[1] !== 'waiting')!;
    expect(ao2(sec(2.4))[1]).toBe('working');
    expect(ao2(sec(2.5))[1]).toBe('done');
    const d = prepareSwimlanes(fixture(), stage);
    expect(barStateAt(d.bars[1]!, sec(2.49))).toBe('working');
  });

  it('draws arcs and close marks only once the playhead reaches them', () => {
    const stage = STAGES[0]![1];
    const count = (t: number, sel: string) =>
      draw(fixture(), stage, t).querySelectorAll(sel).length;
    expect(count(sec(0.5), '[data-arc]')).toBe(0);
    expect(count(sec(1.3), '[data-arc]')).toBe(3);
    expect(count(sec(3), '[data-arc]')).toBe(6);
    expect(count(sec(2.4), '[data-close]')).toBe(0);
    expect(count(sec(3), '[data-close]')).toBe(2);
  });

  const SOURCES: Array<[string, () => Timeline]> = [
    ['fixture', fixture],
    ['demo day', () => demoTimeline(30_000)],
    ['dense week', dense],
  ];
  const CASES = SOURCES.flatMap(([source, make]) =>
    STAGES.map(([aspect, stage]) => [source, aspect, make, stage] as const),
  );

  it.each(CASES)('keeps every lane, bar and label of the %s inside %s', (_s, _a, make, stage) => {
    const d = prepareSwimlanes(make(), stage);
    expect(d.lanes.length).toBeLessThanOrEqual(laneLimits(stage).lanes);
    const s = Math.min(stage.width, stage.height) / 1080;
    // Lanes tile the band between the legend and the bottom margin, in order, without overlap.
    let y = d.layout.top;
    for (const l of d.lanes) {
      expect(l.top).toBeCloseTo(y, 6);
      y += l.height;
    }
    expect(y).toBeCloseTo(d.layout.bottom, 6);
    // Every bar's track sits inside its own lane's band, below the lane's label band.
    for (const b of d.bars) {
      const l = d.lanes[b.lane]!;
      const cy = l.y + b.track * d.layout.trackHeight * 1.25;
      expect(cy - d.layout.trackHeight / 2).toBeGreaterThanOrEqual(
        l.top + d.layout.labelBand - 1e-6,
      );
      expect(cy + d.layout.trackHeight / 2).toBeLessThanOrEqual(l.top + l.height + 1e-6);
    }
    expect(d.layout.trackHeight).toBeGreaterThanOrEqual(18 * s);
    // Text is inside the stage and large enough to read at 1080 px on the short side.
    const svg = draw(make(), stage, sec(2.8));
    for (const text of svg.querySelectorAll('text')) {
      const x = Number(text.getAttribute('x'));
      const ty = Number(text.getAttribute('y'));
      const size = Number(text.getAttribute('font-size'));
      const anchor = text.getAttribute('text-anchor') ?? 'start';
      // Plex Sans averages about 0.55 em per character.
      const width = (text.textContent ?? '').length * size * 0.55;
      const left = anchor === 'end' ? x - width : x;
      expect(size, text.textContent ?? '').toBeGreaterThanOrEqual(18);
      expect(left, text.textContent ?? '').toBeGreaterThanOrEqual(0);
      expect(left + width, text.textContent ?? '').toBeLessThanOrEqual(stage.width);
      expect(ty, text.textContent ?? '').toBeGreaterThan(0);
      expect(ty, text.textContent ?? '').toBeLessThan(stage.height);
    }
    // The first lane starts below the last legend row.
    const legendBottom = d.layout.legendY + (d.layout.legendRows.length - 1) * 44 * s + 11 * s;
    expect(d.layout.top).toBeGreaterThan(legendBottom);
  });

  it('folds lanes past the limit into "others" and keeps people', () => {
    const tl = fixture();
    for (let i = 0; i < 12; i++) {
      const agent = `codex:worker${i}`;
      tl.lanes.push(lane(agent));
      tl.spans.push(span(`AO-${10 + i}`, agent, 0.1, 0.2 + i * 0.1, 'release'));
    }
    const d = prepareSwimlanes(tl, STAGES[0]![1]);
    const labels = d.lanes.map((l) => l.label);
    expect(labels).toHaveLength(MAX_LANES);
    expect(labels[labels.length - 1]).toBe('others');
    expect(labels).toContain('human:dawid');
    // The busiest workers keep their lane; the least busy share "others".
    expect(labels).toContain('codex:worker11');
    expect(labels).not.toContain('codex:worker0');
    for (const b of d.bars) expect(b.lane).toBeLessThan(MAX_LANES);
  });

  it('keeps a trace of few arcs and fades out many', () => {
    const stage = STAGES[0]![1];
    const few = prepareSwimlanes(fixture(), stage);
    expect(few.arcFloor).toBeGreaterThan(0);
    expect(draw(fixture(), stage, 30_000).querySelectorAll('[data-arc]')).toHaveLength(6);
    const many = prepareSwimlanes(dense(), stage);
    expect(many.arcs.length).toBeGreaterThan(ARC_TRACE_LIMIT);
    expect(many.arcFloor).toBe(0);
    // At the end only the arcs of the last few seconds are still visible.
    const shown = draw(dense(), stage, 30_000).querySelectorAll('[data-arc]').length;
    const recent = many.arcs.filter((a) => a.at > 30_000 - ARC_MS * 5).length;
    expect(shown).toBe(recent);
    expect(shown).toBeLessThan(many.arcs.length);
  });

  it('shows fewer lanes and tracks on a square stage', () => {
    expect(laneLimits({ width: 1920, height: 1080 })).toEqual({
      lanes: MAX_LANES,
      tracks: MAX_TRACKS,
    });
    expect(laneLimits({ width: 1080, height: 1920 })).toEqual({
      lanes: MAX_LANES,
      tracks: MAX_TRACKS,
    });
    const square = laneLimits({ width: 1080, height: 1080 });
    expect(square.lanes).toBeLessThan(MAX_LANES);
    expect(square.tracks).toBeLessThan(MAX_TRACKS);
    const d = prepareSwimlanes(dense(), { width: 1080, height: 1080 });
    expect(d.lanes).toHaveLength(square.lanes);
    for (const b of d.bars) expect(b.track).toBeLessThan(square.tracks);
  });

  it('labels an overflow bar only up to the next bar on its track', () => {
    const tl = fixture();
    tl.waits = [];
    tl.reviews = [];
    // Four long tasks at once on a three-track lane: the fourth lands on a used track.
    tl.spans = [
      span('AO-31', 'claude:engineer', 0.1, 2.5, 'release'),
      span('AO-32', 'claude:engineer', 0.12, 2.6, 'release'),
      span('AO-33', 'claude:engineer', 0.14, 2.7, 'release'),
      span('AO-34', 'claude:engineer', 0.2, 2.8, 'release'),
    ];
    const stage = STAGES[0]![1];
    const d = prepareSwimlanes(tl, stage);
    const first = d.bars.find((b) => b.task === 'AO-31')!;
    const fourth = d.bars.find((b) => b.task === 'AO-34')!;
    expect(fourth.track).toBe(first.track);
    expect(first.next).toBe(fourth.start);
    expect(fourth.next).toBe(Infinity);
    const labels = [...draw(tl, stage, 30_000).querySelectorAll('[data-bar] text')].map(
      (e) => e.textContent,
    );
    expect(labels).toEqual(['AO-32', 'AO-33', 'AO-34']);
  });

  it('renders an empty timeline', () => {
    const tl = fixture();
    tl.lanes = [];
    tl.spans = [];
    tl.reviews = [];
    tl.waits = [];
    tl.closes = [];
    tl.time = { segments: [], playbackMs: 0, maxGapMs: 1_800_000 };
    const svg = draw(tl, STAGES[0]![1], 0);
    expect(svg.getAttribute('data-scene')).toBe('swimlanes');
    expect(svg.querySelectorAll('[data-lane]')).toHaveLength(0);
  });
});
