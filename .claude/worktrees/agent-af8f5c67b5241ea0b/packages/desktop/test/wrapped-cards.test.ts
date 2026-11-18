// @vitest-environment happy-dom
// Wrapped cards (AO-0084): the cards built from the Wrapped figures, their timing in the clip,
// PNG file names, and the Replay view asking for `wrapped=1` and offering the card export.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { freeName, imageFiles, writeImages } from '../src/images';
import { frameMarkup, svgDataUrl } from '../ui/src/lib/png';
import { STAGE_16_9, renderFrame } from '../ui/src/replay/scene';
import { sceneById } from '../ui/src/replay/scenes';
import {
  cardAt,
  cardFileName,
  cardTime,
  prepareWrapped,
  wrappedCards,
  wrappedScene,
} from '../ui/src/replay/scenes/wrapped';
import type { Timeline, Wrapped } from '../ui/src/types';
import { frameFileName, timelinePath } from '../ui/src/views/Replay';

const WRAPPED: Wrapped = {
  from: '2026-11-01T00:00:00.000Z',
  to: '2026-11-08T00:00:00.000Z',
  project: 'swarmup',
  closed: 12,
  opened: 9,
  agentMinutes: 870,
  agentHours: 14.5,
  humanMinutes: 38,
  busiest: { agent: 'claude:engineer', runs: 9, minutes: 370, tokens: 1_200_000 },
  rally: {
    task: 'AO-0075',
    title: 'Replay timeline from task events',
    rounds: 3,
    verdict: 'approve',
    players: ['claude:engineer', 'codex:reviewer'],
  },
  fastest: {
    task: 'AO-0060',
    title: 'Pick a db',
    minutes: 2.5,
    asked: 'human:dawid',
    at: '2026-11-03T10:00:00.000Z',
  },
  blocked: { task: 'AO-0051', title: 'Promo umbrella', minutes: 3120, waits: 3 },
};

function timeline(w: Wrapped | undefined, playbackMs = 28_000): Timeline {
  return {
    from: WRAPPED.from,
    to: WRAPPED.to,
    lanes: [],
    spans: [],
    reviews: [],
    waits: [],
    runs: [],
    decisions: [],
    notes: [],
    created: [],
    closes: [],
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
    time: { segments: [], playbackMs, maxGapMs: 1_800_000 },
    ...(w ? { wrapped: w } : {}),
  };
}

describe('wrapped cards', () => {
  it('make a title card and one card per figure, leaving out empty ones', () => {
    const cards = wrappedCards(WRAPPED);
    expect(cards.map((c) => c.id)).toEqual([
      'title',
      'closed',
      'hours',
      'busiest',
      'rally',
      'fastest',
      'blocked',
    ]);
    expect(cards[1]).toMatchObject({ value: 12, unit: 'tasks closed', subject: '9 opened' });
    expect(cards[2]).toMatchObject({
      value: 14.5,
      decimals: 1,
      subject: 'against 38 human minutes',
    });
    expect(cards[3]).toMatchObject({ value: 9, subject: 'claude:engineer' });
    expect(cards[4]!.detail).toBe('claude:engineer ↔ codex:reviewer, approved');
    expect(cards[5]).toMatchObject({ value: 2.5, decimals: 1, detail: 'asked human:dawid' });
    expect(cards[6]).toMatchObject({ value: 52, decimals: 1, unit: 'hours waiting' });

    const quiet = wrappedCards({
      ...WRAPPED,
      busiest: null,
      rally: null,
      fastest: null,
      blocked: null,
    });
    expect(quiet.map((c) => c.id)).toEqual(['title', 'closed', 'hours']);
  });

  it('split the clip into equal slots and count each number up before it holds', () => {
    expect(cardAt(7, 28_000, 0)).toEqual({ index: 0, u: 0 });
    expect(cardAt(7, 28_000, 4_000)).toEqual({ index: 1, u: 0 });
    expect(cardAt(7, 28_000, 28_000)).toEqual({ index: 6, u: 1 });
    const d = prepareWrapped(timeline(WRAPPED));
    const at = (t: number): string =>
      renderToStaticMarkup(renderFrame(wrappedScene, d, { ...STAGE_16_9, t, duration: 28_000 }));
    // Card 1 (tasks closed) starts at 0 and reaches 12 by its export time.
    expect(at(4_100)).toContain('data-card="closed"');
    expect(at(4_100)).not.toContain('>12<');
    expect(at(cardTime(1, 7, 28_000))).toContain('>12<');
    expect(at(cardTime(2, 7, 28_000))).toContain('>14.5<');
    // Same t, same frame.
    expect(at(13_337)).toBe(at(13_337));
  });

  it('serialize a frame as a standalone SVG for the PNG export', () => {
    const d = prepareWrapped(timeline(WRAPPED));
    const svg = frameMarkup(
      renderFrame(wrappedScene, d, { ...STAGE_16_9, t: cardTime(4, 7, 28_000), duration: 28_000 }),
    );
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 1920 1080"/);
    expect(svg).toContain('>3<');
    expect(svg).toContain('AO-0075 Replay timeline from task events');
    expect(svgDataUrl(svg)).toMatch(/^data:image\/svg\+xml;charset=utf-8,%3Csvg%20/);
  });

  it('wait for the figures before drawing', () => {
    const d = prepareWrapped(timeline(undefined));
    expect(d.cards).toEqual([]);
    const svg = renderToStaticMarkup(
      renderFrame(wrappedScene, d, { ...STAGE_16_9, t: 0, duration: 28_000 }),
    );
    expect(svg).toContain('Loading Wrapped');
  });

  it('lay out on square and portrait stages too', () => {
    const d = prepareWrapped(timeline(WRAPPED));
    for (const stage of [
      { width: 1080, height: 1080 },
      { width: 1080, height: 1920 },
    ]) {
      const svg = renderToStaticMarkup(
        renderFrame(wrappedScene, d, { ...stage, t: cardTime(1, 7, 28_000), duration: 28_000 }),
      );
      expect(svg).toContain(`viewBox="0 0 ${stage.width} ${stage.height}"`);
      expect(svg).toContain('>12<');
    }
  });

  it('name PNG files after the project, the day and the card', () => {
    const cards = wrappedCards(WRAPPED);
    expect(cardFileName(WRAPPED, cards[1]!, 1)).toBe('wrapped-swarmup-2026-11-08-2-closed.png');
    expect(cardFileName({ project: null, to: WRAPPED.to }, cards[0]!, 0)).toBe(
      'wrapped-all-projects-2026-11-08-1-title.png',
    );
    expect(cardFileName({ project: 'Ünïcode / Site', to: WRAPPED.to }, cards[0]!, 0)).toMatch(
      /^wrapped-n-code-site-2026-11-08-1-title\.png$/,
    );
    expect(frameFileName('counters', 'swarm up', 72_500)).toBe(
      'replay-counters-swarm-up-1m12s.png',
    );
    for (const name of [cardFileName(WRAPPED, cards[6]!, 6), frameFileName('wrapped', '', 0)]) {
      expect(() => imageFiles([{ name, data: PNG }])).not.toThrow();
    }
  });

  it('ask the timeline route for wrapped=1 only on the Wrapped scene', () => {
    expect(sceneById('wrapped').query).toBe('wrapped=1');
    expect(sceneById('counters').query).toBeUndefined();
    const base = { project: 'site', days: 7, custom: false, from: '', to: '', clip: 30 };
    expect(timelinePath({ ...base, query: 'wrapped=1' })).toBe(
      '/api/timeline?days=7&clip=30&project=site&wrapped=1',
    );
    expect(timelinePath(base)).toBe('/api/timeline?days=7&clip=30&project=site');
  });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('saving images', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('takes 1 to 20 PNGs with plain names', () => {
    expect(imageFiles([{ name: 'a-1.png', data: PNG }])).toHaveLength(1);
    for (const bad of [
      [],
      'a.png',
      [{ name: '../a.png', data: PNG }],
      [{ name: 'a\\b.png', data: PNG }],
      [{ name: 'A.png', data: PNG }],
      [{ name: 'a.exe', data: PNG }],
      [{ name: 'a.png', data: new Uint8Array([1, 2, 3]) }],
      [{ name: 'a.png', data: 'x' }],
      Array.from({ length: 21 }, (_, i) => ({ name: `a${i}.png`, data: PNG })),
    ]) {
      expect(() => imageFiles(bad), JSON.stringify(bad).slice(0, 40)).toThrow();
    }
  });

  it('never overwrites a file in the folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarmup-images-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'card.png'), 'keep');
    expect(
      writeImages(dir, [
        { name: 'card.png', data: PNG },
        { name: 'card.png', data: PNG },
        { name: 'other.png', data: PNG },
      ]),
    ).toEqual(['card-2.png', 'card-3.png', 'other.png']);
    expect(readFileSync(join(dir, 'card.png'), 'utf8')).toBe('keep');
    expect(readdirSync(dir).sort()).toEqual(['card-2.png', 'card-3.png', 'card.png', 'other.png']);
    expect(freeName('x.png', (n) => n !== 'x-4.png')).toBe('x-4.png');
  });
});
