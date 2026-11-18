// The Metro map replay scene (AO-0081): task lines branch off the main line at claim, review
// rounds are stations, closing merges back, parked ideas are stubs and human decisions are
// interchanges; the map grows with the playhead and fits 16:9, 1:1 and 9:16.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { renderFrame } from '../ui/src/replay/scene';
import type { Stage } from '../ui/src/replay/scene';
import { sceneById } from '../ui/src/replay/scenes';
import {
  allocateTracks,
  clipPath,
  metroCounts,
  metroScene,
  prepareMetro,
} from '../ui/src/replay/scenes/metro';
import type { MetroData, MetroLine } from '../ui/src/replay/scenes/metro';
import type { Timeline } from '../ui/src/types';
import { demoTimeline } from './fixtures/replay-demo';

const CLIP = 30_000;
const STAGES: Array<[string, Stage]> = [
  ['16:9', { width: 1920, height: 1080 }],
  ['1:1', { width: 1080, height: 1080 }],
  ['9:16', { width: 1080, height: 1920 }],
];
// The demo day is 9 real hours over the clip, so real hour h plays at h / 9 of it.
const at = (h: number): number => (h / 9) * CLIP;
const iso = (h: number): string =>
  new Date(Date.parse('2026-11-02T08:00:00.000Z') + h * 3_600_000).toISOString();

/** The demo day plus a parked idea, an idea that got scheduled, and a decision the person made. */
function timeline(): Timeline {
  const tl = demoTimeline(CLIP);
  tl.created = [
    { root: 'demo', task: 'AO-30', title: 'Sound', at: iso(3), by: 'human:dawid', type: 'idea' },
    { root: 'demo', task: 'AO-20', title: 'Docs', at: iso(2), by: 'human:dawid', type: 'idea' },
    { root: 'demo', task: 'AO-31', title: 'Todo', at: iso(5), by: 'human:dawid', type: 'task' },
  ];
  tl.decisions = [
    {
      root: 'demo',
      id: 'D-0001',
      question: 'Which font?',
      task: 'AO-17',
      proposedBy: 'claude:engineer',
      start: iso(5),
      end: iso(5.5),
      choice: 'plex',
      decidedBy: 'human:dawid',
      ballots: [],
    },
    {
      root: 'demo',
      id: 'D-0002',
      question: 'Ship Friday?',
      proposedBy: 'claude:pm',
      start: iso(6),
      end: iso(6.5),
      choice: 'yes',
      decidedBy: 'human:dawid',
      ballots: [],
    },
  ];
  return tl;
}

const line = (d: MetroData, task: string): MetroLine => d.lines.find((l) => l.task === task)!;
const svg = (d: MetroData, stage: Stage, t: number): string =>
  renderToStaticMarkup(renderFrame(metroScene, d, { ...stage, t, duration: CLIP }));

describe('metro map layout', () => {
  const d = prepareMetro(timeline(), STAGES[0]![1]);

  it('opens a line per worked task at its first claim, in order', () => {
    expect(d.lines.filter((l) => !l.stub).map((l) => l.task)).toEqual([
      'AO-12',
      'AO-14',
      'AO-15',
      'AO-17',
      'AO-18',
      'AO-19',
      'AO-20',
    ]);
    expect(line(d, 'AO-12').t0).toBeCloseTo(at(0.2), 6);
    expect(line(d, 'AO-17').t0).toBeCloseTo(at(4.5), 6);
  });

  it('merges closed tasks, runs open ones to the end and stops released ones', () => {
    expect(line(d, 'AO-12')).toMatchObject({ end: 'merge' });
    expect(line(d, 'AO-12').t1).toBeCloseTo(at(4.6), 6);
    // A merged line starts and ends on the main line.
    const pts = line(d, 'AO-12').points;
    expect(pts[0]![1]).toBe(0);
    expect(pts[pts.length - 1]![1]).toBe(0);
    // In review, waiting on an answer or still held at the end: the line runs to the end.
    for (const id of ['AO-18', 'AO-19', 'AO-20']) {
      expect(line(d, id)).toMatchObject({ end: 'open', t1: CLIP });
    }
    // A task let go with nothing open stops in a buffer at its last event.
    const tl = timeline();
    tl.spans.push({
      root: 'demo',
      task: 'AO-40',
      title: 'Dropped',
      agent: 'claude:engineer',
      start: iso(1),
      end: iso(2),
      endedBy: 'release',
    });
    const stopped = line(prepareMetro(tl, STAGES[0]![1]), 'AO-40');
    expect(stopped.end).toBe('stop');
    expect(stopped.t1).toBeCloseTo(at(2), 6);
  });

  it('makes review rounds stations that take their verdict when it lands', () => {
    const rally = line(d, 'AO-12').stations;
    expect(rally.map((s) => [s.kind, s.verdict])).toEqual([
      ['review', 'changes'],
      ['review', 'changes'],
      ['review', 'approve'],
    ]);
    expect(rally[2]!.t).toBeCloseTo(at(4.0), 6);
    expect(rally[2]!.verdictT).toBeCloseTo(at(4.4), 6);
    // Stations sit on the line's own track run, in time order.
    const l = line(d, 'AO-12');
    const us = rally.map((s) => s.u);
    expect([...us].sort((a, b) => a - b)).toEqual(us);
    expect(us[0]!).toBeGreaterThanOrEqual(l.runU);
    // Still in review: no verdict yet.
    expect(line(d, 'AO-19').stations).toEqual([
      expect.objectContaining({ kind: 'review', human: false }),
    ]);
    expect(line(d, 'AO-19').stations[0]!.verdict).toBeUndefined();
  });

  it('makes human decisions interchanges: answers, human verdicts and decisions', () => {
    // AO-14's ask was answered by the person.
    expect(line(d, 'AO-14').stations.map((s) => s.kind)).toEqual(['interchange', 'review']);
    expect(line(d, 'AO-14').stations[0]!.t).toBeCloseTo(at(2.4), 6);
    // The person approved AO-15 themselves.
    expect(line(d, 'AO-15').stations).toEqual([
      expect.objectContaining({ kind: 'review', human: true, verdict: 'approve' }),
    ]);
    // A decision on a task lands on its line; one without a task lands on the main line.
    expect(line(d, 'AO-17').stations).toEqual([expect.objectContaining({ kind: 'interchange' })]);
    expect(d.mainStops).toHaveLength(1);
    expect(d.mainStops[0]!.t).toBeCloseTo(at(6.5), 6);
    // The open ask on AO-18 is not a decision yet.
    expect(line(d, 'AO-18').stations.every((s) => s.kind === 'review')).toBe(true);
  });

  it('opens a line for an ask carried into the window after its claim ended before it', () => {
    // The window and its playback map start at hour 0; these waits began at hour -2.
    const tl = timeline();
    // AO-50: claimed and asked the person before the window; answered inside it.
    // AO-51: same, but the ask is still open at the window's end.
    // AO-52: a block from before the window on a task nobody worked on in it.
    for (const [task, end] of [
      ['AO-50', iso(3)],
      ['AO-51', null],
    ] as const) {
      tl.waits.push({
        root: 'demo',
        task,
        title: 'Carried',
        kind: 'ask',
        actor: 'claude:engineer',
        waitingOn: 'human:dawid',
        on: [],
        human: true,
        start: iso(-2),
        end,
        answered: end !== null,
        endedBy: end ? 'answer' : 'open',
      });
    }
    tl.waits.push({
      root: 'demo',
      task: 'AO-52',
      title: 'Blocked',
      kind: 'block',
      actor: 'claude:pm',
      waitingOn: null,
      on: ['AO-12'],
      human: false,
      start: iso(-2),
      end: null,
      answered: false,
      endedBy: 'open',
    });
    const m = prepareMetro(tl, STAGES[0]![1]);
    const answered = line(m, 'AO-50');
    expect(answered).toMatchObject({ t0: 0, end: 'stop' });
    expect(answered.t1).toBeCloseTo(at(3), 6);
    expect(answered.stations).toEqual([
      expect.objectContaining({ kind: 'interchange', human: true }),
    ]);
    expect(answered.stations[0]!.t).toBeCloseTo(at(3), 6);
    expect(line(m, 'AO-51')).toMatchObject({ t0: 0, t1: CLIP, end: 'open', stations: [] });
    expect(m.lines.some((l) => l.task === 'AO-52')).toBe(false);
  });

  it('keeps work that ends after the window open, with no verdict, answer or decision yet', () => {
    const tl = timeline();
    const later = iso(12);
    // AO-60: held through the window, released after it.
    tl.spans.push({
      root: 'demo',
      task: 'AO-60',
      title: 'Held',
      agent: 'claude:engineer',
      start: iso(1),
      end: later,
      endedBy: 'release',
    });
    // AO-61: in review at the window's end; the person approves and it closes after it.
    tl.spans.push({
      root: 'demo',
      task: 'AO-61',
      title: 'Reviewed',
      agent: 'claude:engineer',
      start: iso(1),
      end: iso(2),
      endedBy: 'review',
    });
    tl.reviews.push({
      root: 'demo',
      task: 'AO-61',
      title: 'Reviewed',
      round: 1,
      author: 'claude:engineer',
      reviewer: null,
      start: iso(2),
      end: later,
      decidedBy: 'human:dawid',
      verdict: 'approve',
      endedBy: 'verdict',
    });
    // AO-62: an ask the person answers after the window.
    tl.spans.push({
      root: 'demo',
      task: 'AO-62',
      title: 'Asked',
      agent: 'claude:engineer',
      start: iso(1),
      end: iso(2),
      endedBy: 'ask',
    });
    tl.waits.push({
      root: 'demo',
      task: 'AO-62',
      title: 'Asked',
      kind: 'ask',
      actor: 'claude:engineer',
      waitingOn: 'human:dawid',
      on: [],
      human: true,
      start: iso(2),
      end: later,
      answered: true,
      endedBy: 'answer',
    });
    // A decision on AO-60 the person makes after the window.
    tl.decisions.push({
      root: 'demo',
      id: 'D-0003',
      question: 'Later?',
      task: 'AO-60',
      proposedBy: 'claude:pm',
      start: iso(3),
      end: later,
      choice: 'yes',
      decidedBy: 'human:dawid',
      ballots: [],
    });
    const m = prepareMetro(tl, STAGES[0]![1]);
    for (const id of ['AO-60', 'AO-61', 'AO-62']) {
      expect(line(m, id), id).toMatchObject({ end: 'open', t1: CLIP });
    }
    expect(line(m, 'AO-60').stations).toEqual([]);
    expect(line(m, 'AO-61').stations).toEqual([
      expect.objectContaining({ kind: 'review', human: false }),
    ]);
    expect(line(m, 'AO-61').stations[0]!.verdict).toBeUndefined();
    expect(line(m, 'AO-62').stations).toEqual([]);
  });

  it('draws parked ideas as stubs, and only ideas nobody worked on', () => {
    const stubs = d.lines.filter((l) => l.stub);
    expect(stubs.map((l) => [l.task, l.end])).toEqual([['AO-30', 'stop']]);
    expect(stubs[0]!.t0).toBeCloseTo(at(3), 6);
    // AO-20 was an idea but has work on it, so it is a line; AO-31 is a plain task nobody took.
    expect(line(d, 'AO-20').stub).toBe(false);
    expect(d.lines.some((l) => l.task === 'AO-31')).toBe(false);
  });

  it('keeps lines that overlap in time on different tracks', () => {
    const real = d.lines;
    for (const a of real) {
      for (const b of real) {
        if (a === b || a.track !== b.track) continue;
        const [first, second] = a.t0 <= b.t0 ? [a, b] : [b, a];
        expect(first.t1, `${a.task} and ${b.task} share track ${a.track}`).toBeLessThan(second.t0);
      }
    }
    // The first lines take the tracks next to the main line, one each side.
    expect(line(d, 'AO-12').track).toBe(1);
    expect(line(d, 'AO-14').track).toBe(-1);
  });

  it('counts what the playhead has passed', () => {
    expect(metroCounts(d, 0)).toEqual({
      lines: 0,
      merged: 0,
      stations: 0,
      interchanges: 0,
      ideas: 0,
    });
    // At 4.5 h: AO-12, AO-14, AO-15 and AO-17 opened, AO-12 has not merged yet (4.6 h), its three
    // rounds are stations, AO-14's answer is an interchange and AO-30 is parked.
    expect(metroCounts(d, at(4.5))).toEqual({
      lines: 4,
      merged: 0,
      stations: 3,
      interchanges: 1,
      ideas: 1,
    });
    expect(metroCounts(d, CLIP)).toEqual({
      lines: 7,
      merged: 4,
      // AO-12 x3, AO-14, AO-18 and AO-19; AO-15's human verdict became an interchange.
      stations: 6,
      // AO-14's answer, AO-15's verdict, the AO-17 decision and the one on the main line.
      interchanges: 4,
      ideas: 1,
    });
  });
});

describe('metro map tracks and paths', () => {
  it('puts each interval on the nearest free track, alternating sides', () => {
    const iv = (a: number, b: number) => ({ a, b });
    expect(allocateTracks([iv(0, 10), iv(1, 5), iv(2, 3), iv(6, 9), iv(11, 12)])).toEqual([
      1, -1, 2, -1, 1,
    ]);
    // With one track a side, the third shares the track that frees up first.
    expect(allocateTracks([iv(0, 10), iv(1, 5), iv(2, 3)], 1)).toEqual([1, -1, -1]);
    expect(allocateTracks([])).toEqual([]);
  });

  it('clips a path at the playhead, cutting the segment it crosses', () => {
    const pts: Array<[number, number]> = [
      [0, 0],
      [0, 20],
      [10, 30],
      [50, 30],
    ];
    expect(clipPath(pts, -1)).toEqual([]);
    expect(clipPath(pts, 0)).toEqual([
      [0, 0],
      [0, 20],
    ]);
    expect(clipPath(pts, 5)).toEqual([
      [0, 0],
      [0, 20],
      [5, 25],
    ]);
    expect(clipPath(pts, 99)).toEqual(pts);
  });
});

describe('metro map frames', () => {
  it('is in the scene picker', () => {
    expect(sceneById('metro')).toBe(metroScene);
  });

  it.each(STAGES)('fits the %s stage and grows with the playhead', (_name, stage) => {
    const d = prepareMetro(timeline(), stage);
    expect(d.portrait).toBe(stage.height > stage.width);
    // Every point of every line lies on the stage.
    for (const l of d.lines) {
      for (const [u, v] of l.points) {
        const [x, y] = d.portrait ? [d.main + v, u] : [u, d.main + v];
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(stage.width);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(stage.height);
      }
    }
    const first = svg(d, stage, 0);
    const mid = svg(d, stage, CLIP / 2);
    const last = svg(d, stage, CLIP);
    expect(first).toContain(`viewBox="0 0 ${stage.width} ${stage.height}"`);
    expect(first).toContain('0 lines');
    expect(mid).not.toBe(last);
    expect(last).toContain('7 lines');
    expect(last).toContain('4 merged');
    // Same t, freshly prepared: the same frame.
    expect(svg(prepareMetro(timeline(), stage), stage, CLIP / 2)).toBe(mid);
  });

  it('labels lines with their task id when the tracks leave room', () => {
    const d = prepareMetro(timeline(), STAGES[0]![1]);
    const out = svg(d, STAGES[0]![1], CLIP);
    expect(out).toContain('>AO-12<');
    expect(out).toContain('>main<');
    // Stubs carry no label.
    expect(out).not.toContain('>AO-30<');
  });

  it('shares tracks instead of shrinking them past reading when a window is crowded', () => {
    const tl = timeline();
    for (let i = 0; i < 300; i++) {
      tl.spans.push({
        root: 'demo',
        task: `AO-${1000 + i}`,
        title: 'Busy',
        agent: 'claude:engineer',
        start: iso(0.01 * i),
        end: iso(0.01 * i + 4),
        endedBy: 'done',
      });
    }
    for (const [, stage] of STAGES) {
      const d = prepareMetro(tl, stage);
      expect(d.pitch).toBeGreaterThanOrEqual(9);
      const maxTrack = Math.max(...d.lines.map((l) => Math.abs(l.track)));
      const across = d.portrait ? stage.width : stage.height;
      expect(maxTrack * d.pitch).toBeLessThan(across / 2);
    }
  });

  it('draws an empty window without lines', () => {
    const tl = demoTimeline(0);
    tl.spans = [];
    tl.reviews = [];
    tl.waits = [];
    tl.closes = [];
    const d = prepareMetro(tl, STAGES[0]![1]);
    expect(d.lines).toEqual([]);
    expect(svg(d, STAGES[0]![1], 0)).toContain('0 lines');
  });
});
