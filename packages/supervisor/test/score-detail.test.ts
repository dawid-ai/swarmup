// A score's breakdown (W4): every subject of one scorer for an agent or a task, worst first, with
// the criteria of the approving verdict, the runs a token score summed, why stuck runs failed,
// and a rubric judge's scores and reasons.
import { describe, expect, it } from 'vitest';
import type { OpsEvent, TaskMeta, Workspace } from '@swarmup/core';
import type { DetailHost, RunRecord, ScoreResult } from '../src/index.js';
import { scorerCatalog, scoreDetail } from '../src/index.js';

const ENG = 'claude:engineer';
const AT = '2026-11-20T10:00:00.000Z';

const result = (over: Partial<ScoreResult>): ScoreResult => ({
  scorer: 'criteria-pass-rate',
  level: 'task',
  subject: 'r/T-1',
  agent: ENG,
  value: 1,
  unit: 'ratio',
  pass: true,
  n: 2,
  evidence: [],
  at: AT,
  ...over,
});

const run = (id: string, over: Partial<RunRecord> = {}): RunRecord => ({
  id,
  agent: ENG,
  task: 'T-1',
  root: 'r',
  pid: 1,
  image: 'node',
  command: 'x',
  cwd: '.',
  log: 'x',
  started_at: AT,
  status: 'ended',
  budget_minutes: 60,
  tokens: 100,
  ...over,
});

function host(
  tasks: Record<string, { meta: Partial<TaskMeta>; events: OpsEvent[] }>,
  runs: RunRecord[] = [],
): DetailHost {
  const ws = {
    showEvents: (ref: string) => {
      const t = tasks[ref];
      if (!t) throw new Error(`no task ${ref}`);
      return { meta: { id: ref, title: `Title of ${ref}`, ...t.meta }, body: '', events: t.events };
    },
  } as unknown as Workspace;
  return { ws: () => ws, runs: () => runs };
}

const verdict = (id: string, criteria: Record<string, unknown>): OpsEvent =>
  ({
    id,
    type: 'verdict',
    actor: 'codex:reviewer',
    at: AT,
    body: '',
    verdict: 'approve',
    criteria,
  }) as OpsEvent;

describe('scoreDetail', () => {
  it('lists every subject worst first, with the scorer and the pass count', () => {
    const results = [
      result({ scorer: 'review-rounds', unit: 'rounds', subject: 'r/T-1', value: 0, pass: true }),
      result({ scorer: 'review-rounds', unit: 'rounds', subject: 'r/T-2', value: 3, pass: false }),
      result({ scorer: 'review-rounds', unit: 'rounds', subject: 'r/T-3', value: 1, pass: true }),
      result({ scorer: 'review-rounds', unit: 'rounds', subject: 'r/T-4', agent: 'other:x' }),
    ];
    const d = scoreDetail(host({}), results, scorerCatalog(), {
      scorer: 'review-rounds',
      agent: ENG,
    })!;
    expect(d.scorer).toMatchObject({ id: 'review-rounds', pass: 1, better: 'lower' });
    expect(d.rows.map((r) => r.subject)).toEqual(['r/T-2', 'r/T-3', 'r/T-1']);
    expect(d).toMatchObject({ passed: 2, judged: 3, mean: 1.33 });
  });

  it("adds each criterion's result from the approving verdict", () => {
    const tasks = {
      'r/T-1': {
        meta: { done_when: ['The parser handles empty input', 'Docs mention it'] },
        events: [
          verdict('E1', {
            c1: { result: 'pass', evidence: 'test/parse.test.ts' },
            c2: { result: 'fail', note: 'no docs' },
          }),
        ],
      },
    };
    const d = scoreDetail(
      host(tasks),
      [result({ value: 0.5, pass: false, evidence: ['E1'], note: 'failed: c2' })],
      scorerCatalog(),
      { scorer: 'criteria-pass-rate', agent: ENG },
    )!;
    expect(d.rows[0]).toMatchObject({
      title: 'Title of r/T-1',
      criteria: [
        {
          id: 'c1',
          kind: 'prose',
          text: 'The parser handles empty input',
          result: 'pass',
          evidence: 'test/parse.test.ts',
        },
        { id: 'c2', text: 'Docs mention it', result: 'fail', note: 'no docs' },
      ],
    });
  });

  it('adds the runs a token score summed and why stuck runs failed', () => {
    const runs = [run('RUN-A', { tokens: 900 }), run('RUN-B', { tokens: 100, review: true })];
    const cost = scoreDetail(
      host({ 'r/T-1': { meta: {}, events: [] } }, runs),
      [
        result({
          scorer: 'cost-per-merged-task',
          unit: 'tokens',
          value: 1000,
          pass: undefined,
          evidence: ['RUN-A', 'RUN-B'],
        }),
      ],
      scorerCatalog(),
      { scorer: 'cost-per-merged-task' },
    )!;
    expect(cost.rows[0]!.runs).toEqual([
      expect.objectContaining({ id: 'RUN-A', tokens: 900 }),
      expect.objectContaining({ id: 'RUN-B', tokens: 100, review: true }),
    ]);
    const stuck = scoreDetail(
      host({}, [run('RUN-C', { reason: 'budget' })]),
      [
        result({
          scorer: 'stuck-runs',
          level: 'agent',
          subject: ENG,
          value: 0.5,
          pass: false,
          evidence: ['RUN-C'],
        }),
      ],
      scorerCatalog(),
      { scorer: 'stuck-runs', agent: ENG },
    )!;
    expect(stuck.rows[0]!.runs).toEqual([
      expect.objectContaining({ id: 'RUN-C', reason: 'budget' }),
    ]);
  });

  it("describes a rubric scorer from its rows and keeps the judge's scores and reasons", () => {
    const d = scoreDetail(
      host({ 'r/T-1': { meta: {}, events: [] } }),
      [
        result({
          scorer: 'copy-quality',
          value: 0.4,
          pass: false,
          extra: { clarity: 2, voice: 1 },
          note: 'The voice drifts in the second half.',
          rubric: { id: 'copy', pass: 0.7 },
        }),
      ],
      scorerCatalog(),
      { scorer: 'copy-quality' },
    )!;
    expect(d.scorer).toMatchObject({ id: 'copy-quality', pass: 0.7, better: 'higher' });
    expect(d.scorer.description).toContain('rubrics/copy.md');
    expect(d.rows[0]).toMatchObject({
      extra: { clarity: 2, voice: 1 },
      note: 'The voice drifts in the second half.',
    });
  });

  it("narrows to one task's own scores and its runs', and knows no unknown scorer", () => {
    const results = [
      result({ scorer: 'orientation', level: 'run', subject: 'RUN-A', unit: 'calls', value: 40 }),
      result({ scorer: 'orientation', level: 'run', subject: 'RUN-Z', unit: 'calls', value: 5 }),
    ];
    const d = scoreDetail(
      host({}, [run('RUN-A'), run('RUN-Z', { task: 'T-9' })]),
      results,
      scorerCatalog(),
      {
        scorer: 'orientation',
        task: 'r/T-1',
      },
    )!;
    expect(d.rows.map((r) => r.subject)).toEqual(['RUN-A']);
    expect(scoreDetail(host({}), results, scorerCatalog(), { scorer: 'nope' })).toBeNull();
  });
});
