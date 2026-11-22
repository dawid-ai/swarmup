// The rubric judge at merge (W7): with `swarmupd.judge.at_merge` on, swarmupd judges a task's
// rubric criteria after its command and check criteria pass; a low score sends it back.
import { describe, expect, it } from 'vitest';
import type { JudgeRunner } from '../src/index.js';
import { MERGE_ACTOR } from '../src/index.js';
import { claudeResult, fakeRunner, RUBRIC_TEXT } from './judge-fake.js';
import { git, mergeSetup } from './merge-setup.js';

/** Task 1 with a rubric criterion on `rubric.md`, committed on main, and a check criterion. */
function withRubric(s: ReturnType<typeof mergeSetup>): void {
  s.onMain('rubric.md', RUBRIC_TEXT);
  s.as('human:dawid').setCriteria('1', [
    { id: 'code', kind: 'check', check: 'regex', args: { path: 'code.txt', pattern: '^two' } },
    { id: 'q', kind: 'rubric', rubric: 'rubric.md', pass: 0.6 },
  ]);
}

const scores = (readability: number, tests: number) =>
  fakeRunner(() => claudeResult({ scores: { readability, tests }, reasons: 'Seen.' }, 0.01));

describe('rubric judge at merge', () => {
  it('judges the rubric criteria after the checks and records them on the merge', async () => {
    const { runner, calls } = scores(4, 3);
    const s = mergeSetup({ judge: { at_merge: true }, judgeRunner: runner });
    withRubric(s);
    s.approve(s.branch('two\n'));
    const lines: string[] = [];
    s.sup.on('merge', (l: string) => lines.push(l));
    await s.merged();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toContain('+two');
    expect(calls[0]!.input).toContain('# Change the code');
    const e = s.last();
    expect(e).toMatchObject({ type: 'merge', actor: MERGE_ACTOR });
    expect(e.criteria).toMatchObject({
      code: { result: 'pass' },
      q: { result: 'pass', score: 0.875, note: 'Seen.' },
    });
    expect(e.body).toContain('Criteria: code pass, q pass.');
    expect(lines.some((l) => l.includes('judges its rubric criteria with claude: q'))).toBe(true);
    expect(lines.some((l) => l.includes('judged: q pass 0.875; cost $0.0100'))).toBe(true);
  });

  it('sends the task back when a rubric criterion scores below its pass mark', async () => {
    const { runner } = scores(1, 1);
    const s = mergeSetup({ judge: { at_merge: true }, judgeRunner: runner });
    withRubric(s);
    const before = git(s.repo, 'rev-parse', 'main');
    s.approve(s.branch('two\n'));
    await s.merged();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    const e = s.last();
    expect(e).toMatchObject({
      type: 'verdict',
      verdict: 'changes',
      actor: MERGE_ACTOR,
      to: 'fake:engineer',
    });
    expect(e.body).toContain('its rubric criteria q scored below their pass mark');
    expect(e.body).toContain('score 0.25');
    expect(e.criteria).toMatchObject({
      code: { result: 'pass' },
      q: { result: 'fail', score: 0.25 },
    });
  });

  it('merges without a judgment when the judge gives no score', async () => {
    const broken: JudgeRunner = async () => ({
      exitCode: null,
      timedOut: true,
      stdout: '',
      stderr: '',
    });
    const s = mergeSetup({ judge: { at_merge: true }, judgeRunner: broken });
    withRubric(s);
    s.approve(s.branch('two\n'));
    await s.merged();
    const e = s.last();
    expect(e.type).toBe('merge');
    expect(e.criteria?.q).toMatchObject({
      result: 'na',
      note: 'the judge failed: timed out after 5 min',
    });
  });

  it('judges nothing while at_merge is off', async () => {
    const { runner, calls } = scores(4, 4);
    const s = mergeSetup({ judgeRunner: runner });
    withRubric(s);
    s.approve(s.branch('two\n'));
    await s.merged();
    expect(calls).toHaveLength(0);
    const e = s.last();
    expect(e.type).toBe('merge');
    expect(e.criteria).toMatchObject({ code: { result: 'pass' } });
    expect(e.criteria).not.toHaveProperty('q');
  });
});
