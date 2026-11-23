import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OpsEvent, SwarmExperiment } from '../src/index.js';
import {
  experimentActive,
  experimentFraction,
  experimentTakes,
  initRoot,
  loadDefinitions,
  pickExperiment,
} from '../src/index.js';
import { tempDir } from './helpers.js';

function put(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

const NOW = new Date('2026-11-23T12:00:00.000Z');

const start = (fields: Partial<OpsEvent>): OpsEvent =>
  ({
    id: 'E1',
    at: NOW.toISOString(),
    actor: 'claude:engineer',
    type: 'run-start',
    ...fields,
  }) as OpsEvent;

describe('experiment assignment', () => {
  const exp: SwarmExperiment = { id: 'trial', variant: 'tests-first', share: 0.5 };

  it('deals tasks by sha256(id + ref), the same every time', () => {
    const f = experimentFraction('trial', 'site/T-0001');
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThan(1);
    expect(experimentFraction('trial', 'site/T-0001')).toBe(f);
    expect(experimentFraction('other', 'site/T-0001')).not.toBe(f);
    // About half of many tasks land on the variant side at share 0.5.
    const refs = Array.from({ length: 400 }, (_, i) => `site/T-${String(i).padStart(4, '0')}`);
    const variant = refs.filter(
      (ref) => pickExperiment([exp], { agent: 'claude:engineer', ref }, { now: NOW })?.variant,
    ).length;
    expect(variant).toBeGreaterThan(150);
    expect(variant).toBeLessThan(250);
  });

  it('takes runs by scope and until day, and the first experiment that takes a run wins', () => {
    const s = { agent: 'claude:engineer', ref: 'site/T-0001', type: 'bug', labels: ['ui'] };
    expect(experimentTakes({ scope: { roles: ['engineer'], types: ['bug'] } }, s)).toBe(true);
    expect(experimentTakes({ scope: { agents: ['codex:engineer'] } }, s)).toBe(false);
    expect(experimentTakes({ scope: { labels: ['api'] } }, s)).toBe(false);
    expect(experimentTakes({ scope: { types: ['task'] } }, { ...s, type: undefined })).toBe(false);
    expect(experimentActive({ until: '2026-11-23' }, NOW)).toBe(true);
    expect(experimentActive({ until: '2026-11-22' }, NOW)).toBe(false);
    const all = { id: 'all', variant: 'v2', share: 1 };
    const none = { id: 'none', variant: 'v3', share: 0 };
    expect(pickExperiment([none, all], s, { now: NOW })).toEqual({ experiment: 'none' });
    expect(pickExperiment([{ ...none, until: '2026-01-01' }, all], s, { now: NOW })).toEqual({
      experiment: 'all',
      variant: 'v2',
    });
    expect(pickExperiment([{ ...all, scope: { roles: ['qa'] } }], s, { now: NOW })).toBeNull();
  });

  it("keeps the side of the task's earlier run under the experiment", () => {
    const s = { agent: 'claude:engineer', ref: 'site/T-0001' };
    const all = { id: 'all', variant: 'v2', share: 1 };
    expect(pickExperiment([all], s, { now: NOW, events: [start({ experiment: 'all' })] })).toEqual({
      experiment: 'all',
      sticky: true,
    });
    const none = { id: 'none', variant: 'v3', share: 0 };
    expect(
      pickExperiment([none], s, {
        now: NOW,
        events: [start({ experiment: 'none', variant: 'v3' })],
      }),
    ).toEqual({ experiment: 'none', variant: 'v3', sticky: true });
    // A run of the variant from before experiments were recorded keeps it too.
    expect(pickExperiment([none], s, { now: NOW, events: [start({ variant: 'v3' })] })).toEqual({
      experiment: 'none',
      variant: 'v3',
      sticky: true,
    });
  });
});

describe('experiments in swarm.yaml', () => {
  it('reads them, and checks their variants, ids and days', () => {
    const root = initRoot(tempDir(), { name: 't' });
    put(root, 'agents/claude-engineer.md', '---\nid: claude:engineer\n---\n\nCode.\n');
    put(root, 'variants/tests-first/agents/claude-engineer.md', '---\n---\n\nTests first.\n');
    put(
      root,
      'swarm.yaml',
      [
        'swarmup_defs: 1',
        'experiments:',
        '  - id: trial',
        '    variant: tests-first',
        '    share: 0.25',
        '    scope: {roles: [engineer], labels: [ui]}',
        '    until: 2026-12-31',
        '',
      ].join('\n'),
    );
    const set = loadDefinitions(root);
    expect(set.problems).toEqual([]);
    expect(set.swarm?.experiments).toEqual([
      {
        id: 'trial',
        variant: 'tests-first',
        share: 0.25,
        scope: { roles: ['engineer'], labels: ['ui'] },
        until: '2026-12-31',
      },
    ]);
    put(
      root,
      'swarm.yaml',
      [
        'swarmup_defs: 1',
        'experiments:',
        '  - {id: trial, variant: missing, share: 0.5, until: 2026-02-31}',
        '  - {id: trial, variant: tests-first, share: 1.5}',
        '',
      ].join('\n'),
    );
    const bad = loadDefinitions(root).problems.map((p) => `${p.path}: ${p.message}`);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatch(/^experiments\[1\]\.share: at most 1/);
    put(
      root,
      'swarm.yaml',
      [
        'swarmup_defs: 1',
        'experiments:',
        '  - {id: trial, variant: missing, share: 0.5, until: 2026-02-31}',
        '  - {id: trial, variant: tests-first, share: 1}',
        '',
      ].join('\n'),
    );
    expect(loadDefinitions(root).problems.map((p) => `${p.path}: ${p.message}`)).toEqual([
      'experiments.0.variant: no variants/missing/ in this store and no variants.missing.from_ref',
      'experiments.0.until: 2026-02-31 is no day',
      'experiments.1.id: experiment trial is named twice',
    ]);
  });
});
