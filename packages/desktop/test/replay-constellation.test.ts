// The knowledge constellation scene (AO-0080): the graph it builds from a timeline, labels that
// never overlap, and frames that depend only on t.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Stage } from '../ui/src/replay/scene';
import { STAGE_16_9, renderFrame } from '../ui/src/replay/scene';
import { sceneById } from '../ui/src/replay/scenes';
import {
  MAX_FILES,
  constellationScene,
  overlap,
  prepareConstellation,
} from '../ui/src/replay/scenes/constellation';
import type { ConstellationData } from '../ui/src/replay/scenes/constellation';
import { busyFixture, fixture, iso } from './replay-fixture';

const frame = (stage: Stage, t: number) => ({ ...stage, t, duration: 60_000 });

function expectReadable(d: ConstellationData, stage: Stage): void {
  for (const [i, a] of d.labels.entries()) {
    expect(a.x).toBeGreaterThanOrEqual(0);
    expect(a.y).toBeGreaterThanOrEqual(0);
    expect(a.x + a.w).toBeLessThanOrEqual(stage.width);
    expect(a.y + a.h).toBeLessThanOrEqual(stage.height);
    for (const r of d.reserved) {
      expect(overlap(a, r), `${a.text} over the header or legend`).toBe(false);
    }
    for (const b of d.labels.slice(i + 1)) {
      expect(overlap(a, b), `${a.text} over ${b.text}`).toBe(false);
    }
    // Plain labels keep clear of every node; agent badges, drawn on top, only of agents.
    for (const [j, n] of d.nodes.entries()) {
      if (j === a.node || (a.badge && n.kind !== 'agent')) continue;
      const box = { x: n.x - n.r, y: n.y - n.r, w: 2 * n.r, h: 2 * n.r };
      expect(overlap(a, box), `${a.text} over node ${n.label}`).toBe(false);
    }
    expect(a.badge).toBe(d.nodes[a.node]!.kind === 'agent');
  }
  for (const n of d.nodes) {
    expect(n.x - n.r).toBeGreaterThanOrEqual(0);
    expect(n.x + n.r).toBeLessThanOrEqual(stage.width);
    expect(n.y + n.r).toBeLessThanOrEqual(stage.height);
  }
}

describe('constellation scene', () => {
  it('asks swarmupd for the graph', () => {
    expect(sceneById('constellation')).toBe(constellationScene);
    expect(constellationScene.query).toBe('graph=1');
  });

  it('builds nodes and edges from ownership, links, notes and files', () => {
    const d = prepareConstellation(fixture(), STAGE_16_9);
    const key = (i: number): string => d.nodes[i]!.key;
    expect(d.nodes.map((n) => n.key).sort()).toEqual([
      'agent:claude:engineer',
      'agent:codex:reviewer',
      'agent:human:dawid',
      'file:r/packages/core/src/a.ts',
      'note:r/AO-1/A note',
      'task:r/AO-1',
    ]);
    expect(d.edges.map((e) => `${e.kind} ${key(e.a)} ${key(e.b)}`).sort()).toEqual([
      'file task:r/AO-1 file:r/packages/core/src/a.ts',
      'learn agent:claude:engineer note:r/AO-1/A note',
      'learn task:r/AO-1 note:r/AO-1/A note',
      'owns task:r/AO-1 agent:claude:engineer',
    ]);
    // Real hour h plays at h * 10 s: the note was written at 0.9 h, the task closed at 2 h.
    const note = d.nodes.find((n) => n.kind === 'note')!;
    expect(note.appear).toBe(9_000);
    expect(d.nodes.find((n) => n.kind === 'task')!.closeAt).toBe(20_000);
  });

  it('lights a note up at each read and links it to the reader and its task (AO-0186)', () => {
    const tl = fixture();
    tl.notes = [{ ...tl.notes[0]!, ref: 'ui/a-note' }];
    tl.noteReads = [
      // A note written in the window, read later by another agent on its task.
      {
        root: 'r',
        ref: 'ui/a-note',
        agent: 'codex:reviewer',
        at: iso(1.5),
        task: 'AO-1',
        taskRoot: 'r',
      },
      // A note from before the window, read with no task known: it appears at its first read.
      { root: 'r', ref: 'git/old-lesson', agent: 'claude:engineer', at: iso(1.2) },
    ];
    const d = prepareConstellation(tl, STAGE_16_9);
    const key = (i: number): string => d.nodes[i]!.key;
    const written = d.nodes.find((n) => n.key === 'note:r/ui/a-note')!;
    expect(written.appear).toBe(9_000);
    expect(written.touches).toEqual([9_000, 15_000]);
    const old = d.nodes.find((n) => n.key === 'note:r/git/old-lesson')!;
    expect(old.label).toBe('old-lesson');
    expect([old.appear, old.touches]).toEqual([12_000, [12_000]]);
    expect(
      d.edges
        .filter((e) => e.kind === 'read')
        .map((e) => `${key(e.a)} ${key(e.b)} ${e.at}`)
        .sort(),
    ).toEqual([
      'agent:claude:engineer note:r/git/old-lesson 12000',
      'agent:codex:reviewer note:r/ui/a-note 15000',
      'task:r/AO-1 note:r/ui/a-note 15000',
    ]);
    // The read pulses the note in the frame.
    const at = (t: number) =>
      renderToStaticMarkup(renderFrame(constellationScene, d, frame(STAGE_16_9, t)));
    expect(at(15_000)).not.toBe(at(14_000));
  });

  it('lights up every event, file actors and decision participants', () => {
    const tl = fixture();
    tl.graph!.touches = [
      // A progress event touches the task and its actor without changing any span or round.
      { root: 'r', task: 'AO-1', actor: 'claude:engineer', at: iso(0.3), type: 'progress' },
      // An actor who only comments still gets a node.
      { root: 'r', task: 'AO-1', actor: 'cursor:engineer', at: iso(2.5), type: 'comment' },
    ];
    // An actor seen only in a file mention.
    tl.graph!.files.push({
      root: 'r',
      task: 'AO-1',
      actor: 'codex:engineer',
      at: iso(2.6),
      path: 'packages/core/src/a.ts',
    });
    tl.decisions = [
      {
        root: 'r',
        id: 'D-0001',
        question: 'Which?',
        task: 'AO-1',
        proposedBy: 'claude:engineer',
        start: iso(2.7),
        end: iso(2.9),
        choice: 'A',
        decidedBy: 'human:dawid',
        ballots: [{ actor: 'claude:qa', at: iso(2.8), choice: 'A' }],
      },
    ];
    const d = prepareConstellation(tl, STAGE_16_9);
    const byKey = (k: string) => d.nodes.find((n) => n.key === k)!;
    expect(byKey('task:r/AO-1').touches).toEqual(
      expect.arrayContaining([3_000, 25_000, 26_000, 27_000, 28_000, 29_000]),
    );
    expect(byKey('agent:claude:engineer').touches).toContain(3_000);
    expect(byKey('agent:cursor:engineer')).toMatchObject({ appear: 25_000, touches: [25_000] });
    expect(byKey('agent:codex:engineer')).toMatchObject({ appear: 26_000, touches: [26_000] });
    expect(byKey('agent:claude:qa')).toMatchObject({ appear: 28_000, touches: [28_000] });
    expect(byKey('agent:human:dawid').touches).toContain(29_000);
    // The reviewer lights up when the request is sent, and the human when the ask reaches them.
    expect(byKey('agent:codex:reviewer').touches).toEqual([10_000, 20_000]);
    expect(byKey('agent:human:dawid').touches).toContain(5_000);
    // Touches are kept once each, in order.
    for (const n of d.nodes)
      expect(n.touches).toEqual([...new Set(n.touches)].sort((a, b) => a - b));

    // The progress event pulses the task: halo and node right after it, the node alone later.
    const task = byKey('task:r/AO-1');
    const at = (t: number): number =>
      (
        renderToStaticMarkup(
          renderFrame(constellationScene, d, { ...STAGE_16_9, t, duration: 30_000 }),
        ).match(new RegExp(`cx="${task.x}" cy="${task.y}"`, 'g')) ?? []
      ).length;
    expect(at(3_100)).toBe(2);
    expect(at(4_500)).toBe(1);
  });

  it('places no label over another, a node, the header or the legend at 1080p, 1:1 and 9:16', () => {
    const tl = busyFixture();
    // The square frame has the least room, so it names a smaller share of the 300 nodes.
    for (const [stage, named] of [
      [STAGE_16_9, 0.5],
      [{ width: 1080, height: 1080 }, 0.45],
      [{ width: 1080, height: 1920 }, 0.5],
    ] as const) {
      const d = prepareConstellation(tl, stage);
      expect(d.nodes.filter((n) => n.kind === 'file')).toHaveLength(MAX_FILES);
      expectReadable(d, stage);
      // Every agent is named, and most of the graph is.
      for (const [i, n] of d.nodes.entries()) {
        if (n.kind === 'agent')
          expect(
            d.labels.some((l) => l.node === i),
            n.label,
          ).toBe(true);
      }
      expect(d.labels.length / d.nodes.length).toBeGreaterThan(named);
    }
  });

  it('renders the same frame twice for the same t, from separate preparations', () => {
    for (const t of [0, 12_345.6, 30_000, 60_000]) {
      const [a, b] = [busyFixture(), busyFixture()].map((tl) =>
        renderToStaticMarkup(
          renderFrame(
            constellationScene,
            prepareConstellation(tl, STAGE_16_9),
            frame(STAGE_16_9, t),
          ),
        ),
      );
      expect(a).toBe(b);
    }
  });

  it('shows nodes as playback reaches them and pulses them when touched', () => {
    const d = prepareConstellation(fixture(), STAGE_16_9);
    const f = (t: number) => ({ ...STAGE_16_9, t, duration: 30_000 });
    const note = d.nodes.find((n) => n.kind === 'note')!;
    const svg = (t: number): string =>
      renderToStaticMarkup(renderFrame(constellationScene, d, f(t)));
    const at = (t: number): number =>
      (svg(t).match(new RegExp(`cx="${note.x}" cy="${note.y}"`, 'g')) ?? []).length;
    expect(at(8_999)).toBe(0);
    // Right at the write: the halo and the node. Two seconds later: the node alone.
    expect(at(9_000)).toBe(2);
    expect(at(11_000)).toBe(1);
  });
});
