// Typed criteria at merge (W1), moved here from merge.test.ts after its split (AO-0397).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MERGE_ACTOR } from '../src/index.js';
import { git, mergeSetup, temp } from './merge-setup.js';

describe('typed criteria at merge', () => {
  /** Task 1 with a `command` and a `check` criterion that wants `code.txt` to match `want`. */
  const withCriteria = (s: ReturnType<typeof mergeSetup>, want: string): void => {
    s.as('human:dawid').setCriteria('1', [
      'the code reads well',
      { id: 'cmd', kind: 'command', run: 'node check.mjs' },
      { id: 'code', kind: 'check', check: 'regex', args: { path: 'code.txt', pattern: want } },
    ]);
  };

  it('runs the command and check criteria after the checks and records them on the merge', async () => {
    const s = mergeSetup();
    withCriteria(s, '^two');
    s.approve(s.branch('two\n'));
    const lines: string[] = [];
    s.sup.on('merge', (l: string) => lines.push(l));
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'merge', actor: MERGE_ACTOR });
    expect(e.criteria).toMatchObject({ cmd: { result: 'pass' }, code: { result: 'pass' } });
    // A prose criterion is the reviewer's: the merge leaves it out.
    expect(e.criteria).not.toHaveProperty('c1');
    expect(e.body).toContain('Criteria: cmd pass, code pass.');
    expect(lines.some((l) => l.includes('runs its criteria: cmd, code'))).toBe(true);
    const v = s.as('human:dawid').view('1');
    expect(v.criteriaResults?.code).toMatchObject({ result: 'pass', type: 'merge' });
  });

  it('sends the task back with the failed criteria and leaves the base alone', async () => {
    const s = mergeSetup();
    withCriteria(s, '^three');
    const before = git(s.repo, 'rev-parse', 'main');
    s.approve(s.branch('two\n'));
    await s.merged();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    expect(s.as('human:dawid').view('1').status).toBe('todo');
    const e = s.last();
    expect(e).toMatchObject({
      type: 'verdict',
      verdict: 'changes',
      actor: MERGE_ACTOR,
      to: 'fake:engineer',
    });
    expect(e.body).toContain('its criteria code failed on it rebased onto main');
    expect(e.body).toContain('/^three/ does not match code.txt');
    expect(e.criteria).toMatchObject({ cmd: { result: 'pass' }, code: { result: 'fail' } });
    expect(s.as('human:dawid').view('1').criteriaResults?.code?.result).toBe('fail');
  });

  it('merges a task with criteria to run alone, outside a batch (AO-0381)', async () => {
    const s = mergeSetup({ batch: 5 });
    withCriteria(s, '^two');
    s.approve(s.branch('two\n'));
    const wt = join(temp(), 'wt2');
    git(s.repo, 'worktree', 'add', '-q', '-b', 'feature2', wt, 'main');
    writeFileSync(join(wt, 'two.txt'), 'second\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-qm', 'Other work');
    const commit = git(wt, 'rev-parse', 'HEAD');
    s.as('fake:engineer').start('2', 'plan');
    s.as('fake:engineer').review(
      '2',
      `${commit.slice(0, 7)} on branch feature2: adds two.txt`,
      'human:dawid',
    );
    s.as('human:dawid').verdict('2', 'approve', 'looks right');
    const lines: string[] = [];
    s.sup.on('merge', (l: string) => lines.push(l));
    await s.merged();
    await s.merged();
    const merges = (id: string) =>
      s
        .as('human:dawid')
        .showEvents(id)
        .events.filter((e) => e.type === 'merge');
    expect(merges('1')).toHaveLength(1);
    expect(merges('2')).toHaveLength(1);
    expect(merges('1')[0]!.criteria?.code?.result).toBe('pass');
    expect(lines.some((l) => l.includes('has criteria to run; merges alone after the batch'))).toBe(
      true,
    );
  });
});
