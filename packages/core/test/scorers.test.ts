import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkDefinitionText,
  checkScorerText,
  clearDefinitionsCache,
  effectiveSample,
  formatProblem,
  loadDefinitions,
} from '../src/index.js';
import { tempDir } from './helpers.js';

const check = (id: string, text: string) =>
  checkScorerText(id, text, { file: `scorers/${id}.yaml` });
const lines = (id: string, text: string) => check(id, text).problems.map(formatProblem);

describe('scorer files', () => {
  it('reads a built-in scorer, named by its file or by scorer', () => {
    expect(check('review-rounds', 'kind: builtin\npass: 0\n').def).toEqual({
      id: 'review-rounds',
      kind: 'builtin',
      scorer: 'review-rounds',
      pass: 0,
      enabled: true,
    });
    expect(
      check(
        'strict-bugs',
        'kind: builtin\nscorer: merge-failures\napplies_to: {types: [bug], roles: [engineer]}\n',
      ).def,
    ).toMatchObject({
      scorer: 'merge-failures',
      applies_to: { types: ['bug'], roles: ['engineer'] },
    });
  });

  it('refuses a built-in that does not exist, and warns about keys of the other kind', () => {
    expect(lines('nope', 'kind: builtin\n')).toEqual([
      expect.stringContaining('error: kind: nope is no built-in scorer; set scorer to one of'),
    ]);
    expect(lines('x', 'kind: builtin\nscorer: speed\n')[0]).toContain(
      'error: scorer: use one of criteria-pass-rate',
    );
    expect(lines('review-rounds', 'kind: builtin\nsample: 0.5\n')).toEqual([
      'scorers/review-rounds.yaml:2:1: warning: sample: sample is for kind rubric; not read',
    ]);
  });

  it('reads a rubric scorer, blind by default, and checks its pass and sample', () => {
    expect(check('copy', 'kind: rubric\nrubric: copy\nsample: 0.25\npass: 0.8\n').def).toEqual({
      id: 'copy',
      kind: 'rubric',
      rubric: 'copy',
      sample: 0.25,
      pass: 0.8,
      blind: true,
      enabled: true,
    });
    expect(lines('copy', 'kind: rubric\n')).toEqual([
      'scorers/copy.yaml:1:1: error: kind: kind rubric needs rubric',
    ]);
    expect(lines('copy', 'kind: rubric\nrubric: copy\npass: 4\n')).toEqual([
      'scorers/copy.yaml:3:1: error: pass: a rubric scorer passes at a share from 0 to 1; got 4',
    ]);
    expect(lines('copy', 'kind: rubric\nrubric: copy\nsample: 1.5\n')[0]).toContain(
      'error: sample: at most 1; got 1.5',
    );
  });

  it('is checked as a scorer by its path', () => {
    expect(checkDefinitionText('store/scorers/x.yaml', 'kind: other\n')[0]?.message).toContain(
      'use one of builtin, rubric',
    );
  });

  it('lets a machine only lower the sample', () => {
    expect(effectiveSample(undefined, undefined)).toBe(1);
    expect(effectiveSample(0.5, 0.2)).toBe(0.2);
    expect(effectiveSample(0.2, 0.9)).toBe(0.2);
  });
});

describe('scorers in a store', () => {
  it('are hashed and checked across files: rubrics exist, one file per built-in', () => {
    const dir = join(tempDir(), '.swarmup');
    mkdirSync(join(dir, 'scorers'), { recursive: true });
    mkdirSync(join(dir, 'rubrics'), { recursive: true });
    writeFileSync(join(dir, 'swarm.yaml'), 'swarmup_defs: 1\n');
    const before = loadDefinitions(dir).hash;
    writeFileSync(
      join(dir, 'rubrics', 'copy.md'),
      '---\nid: copy\nscale: {min: 1, max: 5}\ncriteria:\n  - {id: clear, describe: Reads clearly}\n---\nJudge.\n',
    );
    writeFileSync(join(dir, 'scorers', 'copy.yaml'), 'kind: rubric\nrubric: copy\n');
    writeFileSync(join(dir, 'scorers', 'lost.yaml'), 'kind: rubric\nrubric: lost\n');
    writeFileSync(join(dir, 'scorers', 'review-rounds.yaml'), 'kind: builtin\n');
    writeFileSync(
      join(dir, 'scorers', 'rounds.yaml'),
      'kind: builtin\nscorer: review-rounds\napplies_to: {workflows: [nope]}\n',
    );
    clearDefinitionsCache();
    const set = loadDefinitions(dir);
    expect(set.hash).not.toBe(before);
    expect(Object.fromEntries(set.scorers.map((s) => [s.id, s.def !== null]))).toEqual({
      copy: true,
      lost: false,
      'review-rounds': false,
      rounds: false,
    });
    // Each problem across files points at the key (or list item) that names the target.
    expect(
      set.problems.map(
        (p) => `${basename(p.file)}:${p.line}:${p.col}: ${p.severity}: ${p.path}: ${p.message}`,
      ),
    ).toEqual(
      expect.arrayContaining([
        'lost.yaml:2:1: error: rubric: no rubrics/lost.md in this store',
        'rounds.yaml:2:1: error: scorer: 2 files set the built-in scorer review-rounds (review-rounds, rounds); keep one',
        'rounds.yaml:3:26: warning: applies_to.workflows: no workflows/nope.yaml in this store',
      ]),
    );
    // A rubric scorer has no tree for the judge to read: repo and files stay empty.
    writeFileSync(
      join(dir, 'rubrics', 'copy.md'),
      '---\nid: copy\nscale: {min: 1, max: 5}\ninputs: [diff, repo]\ncriteria:\n  - {id: clear, describe: Reads clearly}\n---\nJudge.\n',
    );
    clearDefinitionsCache();
    expect(
      loadDefinitions(dir).problems.map((p) => `${p.severity}: ${p.path}: ${p.message}`),
    ).toContain(
      'warning: rubric: rubric scorers give the judge only the task and the diff; rubrics/copy.md asks for repo, which stay empty',
    );
  });
});
