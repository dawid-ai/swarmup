// W5 phase 4: built-in scorer settings kept in a store's `scorers/*.yaml`: a store's threshold
// and filters for its own work, under the machine's `swarmupd.scorers`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OpsEvent } from '@swarmup/core';
import { BUILTIN_SCORER_IDS, clearDefinitionsCache, initRoot, Workspace } from '@swarmup/core';
import type { GitScorer, ScoreResult, ScoreTask } from '../src/index.js';
import { computeScores, gitScorers, SCORER_IDS, scorerSettings } from '../src/index.js';
import { temp } from './supervisor-setup.js';

const T0 = Date.parse('2026-11-01T00:00:00Z');
let seq = 0;
const ev = (minute: number, type: string, actor: string, extra: Partial<OpsEvent> = {}) =>
  ({
    id: `E${String(++seq).padStart(4, '0')}`,
    type,
    actor,
    at: new Date(T0 + minute * 60_000).toISOString(),
    body: '',
    ...extra,
  }) as OpsEvent;

/** A task approved after one round of changes, by `author`. */
function reviewed(
  root: string,
  id: string,
  meta: Partial<ScoreTask['meta']> = {},
  author = 'claude:engineer',
): ScoreTask {
  return {
    root,
    id,
    title: id,
    meta: { type: 'task', ...meta },
    status: 'done',
    events: [
      ev(0, 'claim', author),
      ev(1, 'review', author),
      ev(2, 'verdict', 'codex:reviewer', { verdict: 'changes' }),
      ev(3, 'review', author),
      ev(4, 'verdict', 'codex:reviewer', { verdict: 'approve' }),
    ],
  };
}

const rounds = (results: ScoreResult[]) =>
  Object.fromEntries(
    results.filter((r) => r.scorer === 'review-rounds').map((r) => [r.subject, r.pass]),
  );

describe('built-in scorers set in git', () => {
  it('keep the same ids as the engine', () => {
    expect(BUILTIN_SCORER_IDS).toEqual(SCORER_IDS);
  });

  it("score a store's work with its threshold, and other stores with the default", () => {
    // One round of changes passes the default threshold (1) and fails a store's 0.
    const tasks = [reviewed('a', 'T-1'), reviewed('b', 'T-1')];
    const strict: GitScorer = { root: 'a', id: 'rounds', scorer: 'review-rounds', pass: 0 };
    expect(rounds(computeScores({ tasks, runs: [] }, { stores: [strict] }))).toEqual({
      'a/T-1': false,
      'b/T-1': true,
    });
    // The machine's pass wins over the store's.
    expect(
      rounds(
        computeScores(
          { tasks, runs: [] },
          { stores: [strict], settings: { 'review-rounds': { pass: 1 } } },
        ),
      ),
    ).toEqual({ 'a/T-1': true, 'b/T-1': true });
  });

  it('score only the work applies_to takes: types, labels, roles and workflows', () => {
    const tasks = [
      reviewed('a', 'M-1', { type: 'milestone', workflow: 'bugfix' }),
      reviewed('a', 'T-1', { type: 'bug', parent: 'M-1' }),
      reviewed('a', 'T-2', { type: 'bug', labels: ['ui'] }),
      reviewed('a', 'T-3', { type: 'task', labels: ['ui'] }),
      reviewed('a', 'T-4', { type: 'bug', labels: ['ui'] }, 'claude:writer'),
    ];
    const scored = (applies_to: GitScorer['applies_to']) =>
      Object.keys(
        rounds(
          computeScores(
            { tasks, runs: [] },
            { stores: [{ root: 'a', id: 'r', scorer: 'review-rounds', applies_to }] },
          ),
        ),
      ).sort();
    expect(scored({ types: ['bug'] })).toEqual(['a/T-1', 'a/T-2', 'a/T-4']);
    expect(scored({ labels: ['ui'], roles: ['engineer'] })).toEqual(['a/T-2', 'a/T-3']);
    // The milestone a workflow started, and the tasks under it.
    expect(scored({ workflows: ['bugfix'] })).toEqual(['a/M-1', 'a/T-1']);
  });

  it('turn a scorer off for one store with enabled: false', () => {
    const tasks = [reviewed('a', 'T-1'), reviewed('b', 'T-1')];
    const off: GitScorer = { root: 'a', id: 'r', scorer: 'review-rounds', enabled: false };
    expect(rounds(computeScores({ tasks, runs: [] }, { stores: [off] }))).toEqual({
      'b/T-1': true,
    });
  });

  it('are read from each root, with a rubric scorer listed but not scored', () => {
    const repo = temp();
    initRoot(repo, { name: 'demo', human: 'human:dawid' });
    const store = join(repo, '.swarmup');
    mkdirSync(join(store, 'scorers'), { recursive: true });
    mkdirSync(join(store, 'rubrics'), { recursive: true });
    writeFileSync(
      join(store, 'rubrics', 'copy.md'),
      '---\nid: copy\nscale: {min: 1, max: 5}\ncriteria:\n  - {id: clear, describe: Reads clearly}\n---\nJudge the copy.\n',
    );
    writeFileSync(
      join(store, 'scorers', 'review-rounds.yaml'),
      'kind: builtin\npass: 0\napplies_to: {types: [bug]}\n',
    );
    writeFileSync(
      join(store, 'scorers', 'copy.yaml'),
      'kind: rubric\nrubric: copy\nsample: 0.5\njudge: {runtime: claude, model: sonnet}\n',
    );
    clearDefinitionsCache();
    const ws = new Workspace({
      cwd: repo,
      env: { SWARMUP_CONFIG: join(repo, 'none.yml') },
      user: {},
    });
    expect(gitScorers(ws)).toEqual([
      {
        root: 'demo',
        id: 'review-rounds',
        scorer: 'review-rounds',
        pass: 0,
        applies_to: { types: ['bug'] },
      },
    ]);
  });

  it('let a machine set the sample of a rubric scorer, and nothing else of it', () => {
    const user = (scorers: unknown) => ({ swarmupd: { scorers } }) as never;
    expect(scorerSettings(user({ copy: { sample: 0.2 } }))).toEqual({ copy: { sample: 0.2 } });
    expect(() => scorerSettings(user({ copy: { pass: 1 } }))).toThrow(/no such scorer/);
    expect(() => scorerSettings(user({ copy: { sample: 2 } }))).toThrow(/share from 0 to 1/);
  });
});
