// @vitest-environment happy-dom
// The Human loop replay scene and its stat card (AO-0083): beams between the agent and human
// bands, waits that glow until answered, counters that end on the card's figures, the card's
// figures from the report when the timeline carries it, and the card as the Swimlanes outro.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Scene, Stage } from '../ui/src/replay/scene';
import { renderFrame, sceneDuration } from '../ui/src/replay/scene';
import { sceneById } from '../ui/src/replay/scenes';
import {
  BEAM_MS,
  agentsAt,
  beamProgress,
  countersAt,
  humanSessions,
  loopScene,
  prepareLoop,
  shareBefore,
} from '../ui/src/replay/scenes/loop';
import {
  CARD_FADE_MS,
  CARD_MS,
  COUNT_MS,
  countUp,
  loopCard,
  minutesPerHumanMinute,
} from '../ui/src/replay/scenes/loop-card';
import { swimlanesScene } from '../ui/src/replay/scenes/swimlanes';
import type { Timeline } from '../ui/src/types';
import { demoTimeline } from './fixtures/replay-demo';
import { T0, fixture, iso } from './replay-fixture';

const MIN = 60_000;
const STAGES: Array<[string, Stage]> = [
  ['16:9', { width: 1920, height: 1080 }],
  ['1:1', { width: 1080, height: 1080 }],
  ['9:16', { width: 1080, height: 1920 }],
];
const STAGE = STAGES[0]![1];

function markup(
  tl: Timeline,
  t: number,
  stage: Stage = STAGE,
  scene: Scene<unknown> = loopScene,
): string {
  const data = scene.prepare(tl, stage);
  const duration = sceneDuration(scene, tl);
  return renderToStaticMarkup(renderFrame(scene, data, { ...stage, t, duration }));
}

/** The fixture with a person reviewing: the review round has no reviewer agent. */
function humanReview(): Timeline {
  const tl = fixture();
  tl.reviews = [{ ...tl.reviews[0]!, reviewer: null, decidedBy: 'human:dawid' }];
  return tl;
}

describe('Human loop card', () => {
  it('takes agent hours and tasks closed from the report when the timeline carries it', () => {
    // The fixture's report says 60 run minutes; the timeline's own total says 0.9 h.
    const card = loopCard(fixture());
    expect(card).toEqual({
      agentHours: 1,
      humanMinutes: 4,
      asksAnswered: 1,
      reviewRounds: 1,
      tasksClosed: 1,
      footer: 'All projects · 2026-11-02 to 2026-11-02',
      fromReport: true,
    });
  });

  it('falls back to the timeline totals without the report', () => {
    const tl = fixture();
    delete tl.wrapped;
    tl.totals = { ...tl.totals, tasksClosed: 3 };
    expect(loopCard(tl)).toMatchObject({
      agentHours: 0.9,
      tasksClosed: 3,
      footer: '2026-11-02 to 2026-11-02',
      fromReport: false,
    });
  });

  it('names the project in the footer', () => {
    const tl = fixture();
    tl.wrapped = { ...tl.wrapped!, project: 'swarmup' };
    expect(loopCard(tl).footer).toBe('swarmup · 2026-11-02 to 2026-11-02');
  });

  it('works out agent minutes per human minute', () => {
    const card = loopCard(fixture());
    expect(minutesPerHumanMinute(card)).toBe(15);
    expect(minutesPerHumanMinute({ ...card, agentHours: 0.1, humanMinutes: 4 })).toBe(1.5);
    expect(minutesPerHumanMinute({ ...card, humanMinutes: 0 })).toBeNull();
    expect(minutesPerHumanMinute({ ...card, agentHours: 0 })).toBeNull();
  });

  it('counts up to the exact figure', () => {
    expect(countUp(12.4, 0, 1)).toBe('0.0');
    expect(countUp(12.4, 1, 1)).toBe('12.4');
    expect(countUp(37, 2)).toBe('37');
    expect(Number(countUp(37, 0.5))).toBeGreaterThan(18);
  });

  it('shows the full figures once counted, after the timeline ends', () => {
    const tl = fixture();
    const end = sceneDuration(loopScene, tl);
    expect(end).toBe(30_000 + CARD_MS);
    expect(markup(tl, 30_000)).not.toContain('data-card="loop"');
    const card = markup(tl, 30_000 + CARD_FADE_MS + COUNT_MS + 10);
    expect(card).toContain('data-card="loop"');
    expect(card).toContain('HUMAN IN THE LOOP');
    for (const text of [
      '>1.0<',
      'agent hour<',
      '>4<',
      'human minutes',
      'ask answered',
      'review round<',
      'task closed',
      '15 agent minutes for every human minute',
    ]) {
      expect(card, text).toContain(text);
    }
    // While it fades in, the numbers have not started.
    expect(markup(tl, 30_000 + 100)).toContain('>0.0<');
  });
});

describe('Human loop scene', () => {
  it('beams an ask up to the person and the answer back down', () => {
    const d = prepareLoop(fixture(), STAGE);
    // The ask runs 0.5 h to 0.8 h: 5 s to 8 s of playback. The review is by an agent: no beam.
    expect(d.beams.map((b) => [b.kind, b.up, b.at])).toEqual([
      ['ask', true, 5000],
      ['answer', false, 8000],
    ]);
    expect(d.waits).toMatchObject([{ start: 5000, end: 8000, open: false, kind: 'ask' }]);
  });

  it('beams a review by a person and its verdict', () => {
    const d = prepareLoop(humanReview(), STAGE);
    expect(d.beams.map((b) => [b.kind, b.up, b.at])).toEqual([
      ['ask', true, 5000],
      ['answer', false, 8000],
      ['review', true, 10_000],
      ['approve', false, 20_000],
    ]);
  });

  it('leaves out a round with no reviewer named that an agent decided', () => {
    const tl = fixture();
    tl.reviews = [{ ...tl.reviews[0]!, reviewer: null, decidedBy: 'codex:reviewer' }];
    expect(prepareLoop(tl, STAGE).beams.map((b) => b.kind)).toEqual(['ask', 'answer']);
    // Still open with no reviewer: it waits on a person.
    tl.reviews = [{ ...tl.reviews[0]!, end: null, endedBy: 'open' }];
    delete tl.reviews[0]!.decidedBy;
    delete tl.reviews[0]!.verdict;
    expect(prepareLoop(tl, STAGE).beams.map((b) => b.kind)).toEqual(['ask', 'answer', 'review']);
  });

  it('keeps an open ask glowing to the end of the clip', () => {
    const tl = fixture();
    tl.waits = [{ ...tl.waits[0]!, end: null, answered: false, endedBy: 'open' }];
    const d = prepareLoop(tl, STAGE);
    expect(d.beams.map((b) => b.kind)).toEqual(['ask']);
    expect(d.waits[0]).toMatchObject({ end: 30_000, open: true });
    expect(markup(tl, 30_000)).toContain('data-live="1"');
  });

  it('steps the agent band with how many agents run at once', () => {
    const d = prepareLoop(fixture(), STAGE);
    expect(d.steps).toEqual([
      [0, 0],
      [1000, 1],
      [10_000, 0],
    ]);
    expect(d.peak).toBe(1);
    expect(agentsAt(d, 999)).toBe(0);
    expect(agentsAt(d, 5000)).toBe(1);
    expect(agentsAt(d, 10_000)).toBe(0);
  });

  it('falls back to held tasks when there are no runs, and leaves people and swarmupd out', () => {
    const tl = fixture();
    tl.runs = [];
    tl.spans = [
      ...tl.spans,
      { ...tl.spans[0]!, agent: 'human:dawid' },
      { ...tl.spans[0]!, agent: 'opsd:merge' },
    ];
    expect(prepareLoop(tl, STAGE).peak).toBe(1);
  });

  it('ticks each human action once', () => {
    const tl = fixture();
    tl.graph!.touches = [
      { root: 'r', task: 'AO-1', actor: 'human:dawid', at: iso(0.8), type: 'answer' },
      { root: 'r', task: 'AO-1', actor: 'human:dawid', at: iso(2.5), type: 'comment' },
      { root: 'r', task: 'AO-1', actor: 'claude:engineer', at: iso(2.6), type: 'progress' },
    ];
    // The create at 0 h, the answer at 0.8 h (named twice) and the comment at 2.5 h.
    expect(prepareLoop(tl, STAGE).human).toEqual([0, 8000, 25_000]);
  });

  it('draws a beam only once it fires, its head moving toward the other band', () => {
    const d = prepareLoop(fixture(), STAGE);
    const ask = d.beams[0]!;
    expect(beamProgress(ask, 4999)).toBeNull();
    expect(beamProgress(ask, 5000 + BEAM_MS / 2)).toBe(0.5);
    expect(beamProgress(ask, 5000 + BEAM_MS * 2)).toBe(1);
    expect(markup(fixture(), 4999)).not.toContain('data-beam');
    expect(markup(fixture(), 5100)).toContain('data-beam="ask"');
    expect(markup(fixture(), 8100)).toContain('data-beam="answer"');
  });

  it('glows a wait from the ask until the answer', () => {
    expect(markup(fixture(), 6000)).toContain('data-live="1"');
    expect(markup(fixture(), 9000)).toContain('data-live="0"');
  });

  it('runs the counters at the real pace and ends them on the card', () => {
    const d = prepareLoop(fixture(), STAGE);
    expect(countersAt(d, 0)).toEqual({ agentHours: 0, humanMinutes: 0 });
    // Half the run (0.1 h to 1 h) is done at 0.55 h, 5.5 s of playback.
    expect(countersAt(d, 5500).agentHours).toBeCloseTo(0.5, 5);
    expect(countersAt(d, 30_000)).toEqual({ agentHours: 1, humanMinutes: 4 });
    let last = { agentHours: 0, humanMinutes: 0 };
    for (let t = 0; t <= 30_000; t += 250) {
      const now = countersAt(d, t);
      expect(now.agentHours).toBeGreaterThanOrEqual(last.agentHours);
      expect(now.humanMinutes).toBeGreaterThanOrEqual(last.humanMinutes);
      last = now;
    }
  });

  it('groups human actions into sessions as the timeline does', () => {
    // Actions at 0, 5 and 30 min: a 0 to 5 min session plus 2 min, and a 2 min one.
    const sessions = humanSessions([T0 + 30 * MIN, T0, T0 + 5 * MIN]);
    expect(sessions).toEqual([
      [T0, T0 + 7 * MIN],
      [T0 + 30 * MIN, T0 + 32 * MIN],
    ]);
    expect(shareBefore(sessions, T0 + 7 * MIN)).toBeCloseTo(7 / 9, 5);
    expect(shareBefore([], T0)).toBe(0);
  });

  it('is in the picker next to Swimlanes, on the same timeline query', () => {
    expect(sceneById('loop')).toBe(loopScene);
    expect(loopScene.query).toBe(swimlanesScene.query);
  });

  it('plays an empty window without beams and with a zero card', () => {
    const tl = demoTimeline(30_000);
    tl.waits = [];
    tl.reviews = [];
    const d = prepareLoop(tl, STAGE);
    expect(d.beams).toEqual([]);
    expect(markup(tl, 30_000 + CARD_MS)).toContain('data-card="loop"');
  });
});

describe('Swimlanes outro', () => {
  it('closes the Swimlanes clip on the same card', () => {
    const tl = fixture();
    expect(swimlanesScene.outroMs).toBe(CARD_MS);
    expect(sceneDuration(swimlanesScene, tl)).toBe(30_000 + CARD_MS);
    expect(markup(tl, 30_000, STAGE, swimlanesScene)).not.toContain('data-card');
    const end = markup(tl, 30_000 + CARD_MS, STAGE, swimlanesScene);
    expect(end).toContain('data-card="loop"');
    expect(end).toContain('15 agent minutes for every human minute');
    // The lanes stay under the card at their last frame.
    expect(end).toContain('data-lane="claude:engineer"');
  });
});

describe('layout', () => {
  /** Every text anchor in the markup, as [x, y]. */
  function anchors(svg: string): Array<[number, number]> {
    return [...svg.matchAll(/<text[^>]*?\sx="([-\d.e]+)"[^>]*?\sy="([-\d.e]+)"/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ]);
  }

  it.each(STAGES)('keeps every label inside a %s stage', (_name, stage) => {
    const tl = demoTimeline(30_000);
    tl.wrapped = { ...fixture().wrapped!, project: 'swarmup', agentHours: 123.4, closed: 48 };
    tl.totals = { ...tl.totals, humanMinutes: 186, asksAnswered: 14, reviewRounds: 27 };
    for (const t of [12_000, 30_000, 30_000 + CARD_MS]) {
      const svg = markup(tl, t, stage);
      const points = anchors(svg);
      expect(points.length).toBeGreaterThan(5);
      for (const [x, y] of points) {
        expect(x, `x at ${t}`).toBeGreaterThanOrEqual(0);
        expect(x, `x at ${t}`).toBeLessThanOrEqual(stage.width);
        expect(y, `y at ${t}`).toBeGreaterThan(0);
        expect(y, `y at ${t}`).toBeLessThan(stage.height);
      }
    }
  });

  it.each(STAGES)('keeps the bands apart on a %s stage', (_name, stage) => {
    const d = prepareLoop(demoTimeline(30_000), stage);
    const L = d.layout;
    expect(L.human.top).toBeGreaterThan(L.legendY);
    expect(L.human.bottom).toBeLessThan(L.agents.top);
    expect(L.agents.bottom).toBeLessThanOrEqual(stage.height);
    expect(L.waitTrack).toBeGreaterThan(0);
  });
});
