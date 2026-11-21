import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  MERGE_ACTOR,
  MergeRepo,
  mergeSource,
  pickMergeSource,
  reviewCommits,
  reviewSources,
  uncommittedRun,
} from '../src/index.js';
import { until } from './until.js';
import {
  STAGE_MS,
  approveAfterRun,
  git,
  mergeSetup,
  temp,
  text,
  worktreeOf,
} from './merge-setup.js';

describe('merging approved work', () => {
  it('reads the branch and commit a review names', () => {
    expect(mergeSource('3959772 on branch claude/ao-0103-run-commit (pushed; worktree x)')).toEqual(
      { commit: '3959772', branch: 'claude/ao-0103-run-commit' },
    );
    expect(mergeSource('abc1234 on branch `fix/a.b`: done')).toEqual({
      commit: 'abc1234',
      branch: 'fix/a.b',
    });
    expect(mergeSource('Work is on branch feature/x. Tests pass.')).toEqual({
      branch: 'feature/x',
    });
    expect(mergeSource('PR: https://github.com/o/r/pull/1')).toBeNull();
  });

  it('takes a loose branch word only when the repo has that branch, else an earlier review (AO-0153)', () => {
    const branches = new Set(['claude/ao-0148-speed', 'claude/ao-0147-speed']);
    const has = {
      branch: (b: string) => branches.has(b),
      commit: (c: string) => c === 'ca2b7d9b',
    };
    // Prose from the AO-0148 and AO-0147 reviews that named a stray word as the branch.
    const prose148 =
      'AO-0148: the failure came from the PC sleeping, not from the branch, and the same commits ' +
      'rebased onto v2 pass. I did not force-push the rebase: the rebased branch is local.';
    const prose147 =
      'AO-0147: the merge failed on a file this branch does not touch; commit it on ' +
      'claude/ao-0147-speed or directly on v2.';
    expect(reviewSources(prose148)).toEqual({ loose: ['is'] });
    expect(reviewSources(prose147)).toEqual({ loose: ['does'] });
    const older148 = 'AO-0148: ca2b7d9b on branch claude/ao-0148-speed (pushed) moves the tests.';
    const older147 = 'AO-0147: f14a8416 + f441744d on branch claude/ao-0147-speed make it fast.';
    // The branch an earlier review names, at its tip: it holds what the last review describes.
    expect(pickMergeSource([prose148, older148], has)).toEqual({ branch: 'claude/ao-0148-speed' });
    expect(pickMergeSource([prose147, older147], has)).toEqual({ branch: 'claude/ao-0147-speed' });
    // A stray word alone merges nothing.
    expect(pickMergeSource([prose148], has)).toBeNull();
    // A loose name that is a branch still counts, after the stray ones.
    expect(pickMergeSource(['this branch does; see branch claude/ao-0148-speed.'], has)).toEqual({
      branch: 'claude/ao-0148-speed',
    });
    // The newest review's `<commit> on branch <name>` stands as it is, even when the repo lacks
    // it: swarmupd tells the human instead of merging older work.
    expect(pickMergeSource(['abc1234 on branch gone', older148], has)).toEqual({
      commit: 'abc1234',
      branch: 'gone',
    });
    // A commit in code font or bold is named all the same (AO-0325): AO-0290's last review, whose
    // commit the repo lacked, lost to the branch of the review before it.
    const final290 = 'AO-0290: `cc3d803` on branch `codex/ao-0290-final` is rebased onto `main`.';
    const older290 = 'AO-0290: `ee160f1` on branch `codex/ao-0290-rebased` is in the bundle.';
    expect(reviewSources(final290).named).toEqual({
      commit: 'cc3d803',
      branch: 'codex/ao-0290-final',
    });
    expect(reviewSources('**cc3d803** on branch x').named).toEqual({
      commit: 'cc3d803',
      branch: 'x',
    });
    // Bold with underscores too: `_` is a word character, so `\b` found no commit there.
    expect(reviewSources('T-0001: __cc3d803__ on branch x is rebased.').named).toEqual({
      commit: 'cc3d803',
      branch: 'x',
    });
    expect(reviewSources('___cc3d803___ on branch __codex/ao-0290-final__.')).toEqual({
      named: { commit: 'cc3d803', branch: 'codex/ao-0290-final' },
      loose: [],
    });
    expect(reviewSources('_cc3d803_ on branch **x**, then branch _y_').named?.branch).toBe('x');
    expect(reviewSources('_cc3d803_ on branch **x**, then branch _y_').loose).toEqual(['y']);
    // Underscores that are not a pair stay in the name.
    expect(reviewSources('cc3d803 on branch _wip').named?.branch).toBe('_wip');
    // A code span holds its text as written: the underscores there are part of the name.
    expect(reviewSources('cc3d803 on branch `__wip__`.').named).toEqual({
      commit: 'cc3d803',
      branch: '__wip__',
    });
    expect(reviewSources('`cc3d803` on branch **`_wip_`**, not branch `__old__`')).toEqual({
      named: { commit: 'cc3d803', branch: '_wip_' },
      loose: ['__old__'],
    });
    expect(reviewSources('The work is on branch `__wip__`; branch __wip__ is bold.').loose).toEqual(
      ['__wip__', 'wip'],
    );
    expect(reviewSources('see branch __`feature`__, then branch `a+b@c`.').loose).toEqual([
      'feature',
      'a+b@c',
    ]);
    // A code span that a longer word runs on from is no name: `feature` is not the branch here.
    expect(reviewSources('cc3d803 on branch `feature`-old is rebased.')).toEqual({ loose: [] });
    expect(reviewSources('cc3d803 on branch `feature`/next.')).toEqual({ loose: [] });
    expect(
      reviewSources('on branch `feature`-old, branch **`feature`**/next, branch `feature`_old')
        .loose,
    ).toEqual([]);
    expect(reviewSources('branch `feature`.old and branch __`feature`__x').loose).toEqual([]);
    // Closing emphasis and punctuation end the name.
    expect(
      reviewSources(
        'branch **`a`**, branch __`b`__. Then (branch `c`) and branch `d`\'s tip; "branch `e`"? branch `f`',
      ).loose,
    ).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(reviewSources('cc3d803 on branch _`feature`_: rebased').named).toEqual({
      commit: 'cc3d803',
      branch: 'feature',
    });
    // A mark after the span closes emphasis only when the same mark opened it before the span.
    for (const tail of ['_', '__', '___', '*', '_*']) {
      expect(reviewSources(`cc3d803 on branch \`feature\`${tail} is rebased.`)).toEqual({
        loose: [],
      });
      expect(reviewSources(`The fix is on branch \`feature\`${tail}, rebased.`).loose).toEqual([]);
    }
    expect(
      reviewSources('branch _`feature`__ and branch __`feature`_ and branch *`feature`_').loose,
    ).toEqual([]);
    expect(
      reviewSources('branch ***`a`***, branch **_`b`_** and branch _**`c`**_. branch ___`d`___')
        .loose,
    ).toEqual(['a', 'b', 'c', 'd']);
    expect(
      pickMergeSource(['The fix is on branch `feature`_.', 'abc1234 on branch feature_'], {
        branch: (b) => b === 'feature' || b === 'feature_',
        commit: () => false,
      }),
    ).toEqual({ branch: 'feature_' });
    expect(
      pickMergeSource(['The fix is on branch `feature`-old.', 'abc1234 on branch feature-old'], {
        branch: (b) => b === 'feature' || b === 'feature-old',
        commit: () => false,
      }),
    ).toEqual({ branch: 'feature-old' });
    expect(
      pickMergeSource(['The fix is on branch `__wip__`.', 'abc1234 on branch stale'], {
        branch: (b) => b === '__wip__' || b === 'stale',
        commit: () => false,
      }),
    ).toEqual({ branch: '__wip__' });
    expect(reviewCommits('the work is __0456def__, not _2b0ab62_ or x_1234abc')).toEqual([
      '0456def',
      '2b0ab62',
      '1234abc',
    ]);
    expect(
      pickMergeSource(['__cc3d803__ on branch `codex/ao-0290-final`', older290], {
        branch: (b) => b === 'codex/ao-0290-rebased',
        commit: () => false,
      }),
    ).toEqual({ commit: 'cc3d803', branch: 'codex/ao-0290-final' });
    expect(
      pickMergeSource([final290, older290], {
        branch: (b) => b === 'codex/ao-0290-rebased',
        commit: () => false,
      }),
    ).toEqual({ commit: 'cc3d803', branch: 'codex/ao-0290-final' });
    // Words that look like commits: hex with a digit and a letter, not numbers, dates or ids.
    expect(
      reviewCommits('cc3d803 replaces `2b0ab62`; 1572 passed on 20261114, run 01M7C6SD, cc3d803.'),
    ).toEqual(['cc3d803', '2b0ab62']);
    // A commit id of digits only or letters only counts where the text says it is a commit: after
    // a label, in a labeled list, or in code font or bold. Bare, it is a number or a word.
    expect(reviewCommits('commit 1234567 is in the bundle; 7654321 passed, defaced.')).toEqual([
      '1234567',
    ]);
    expect(reviewCommits('the commit abcdefa is in the bundle')).toEqual(['abcdefa']);
    expect(reviewCommits('Commits `1234567`, abcdefa and 7654321; then 1111111')).toEqual([
      '1234567',
      'abcdefa',
      '7654321',
    ]);
    expect(reviewCommits('sha: abcdefa, hash=7654321, rev **1111111**')).toEqual([
      'abcdefa',
      '7654321',
      '1111111',
    ]);
    expect(reviewCommits('the work is `1234567`, **abcdefa**, __7654321__ and _deadbee_')).toEqual([
      '1234567',
      'abcdefa',
      '7654321',
      'deadbee',
    ]);
    expect(reviewCommits('run_1234567_x, x_7654321, recommit 1111111, 20261114')).toEqual([]);
    // Capitals name the same commit: git reads `CC3D803` as `cc3d803`. Both come back in lower case.
    expect(reviewSources('T-0001: `CC3D803` on branch `codex/ao-0290-final`.').named).toEqual({
      commit: 'cc3d803',
      branch: 'codex/ao-0290-final',
    });
    expect(reviewSources('Cc3D803 on branch X').named).toEqual({ commit: 'cc3d803', branch: 'X' });
    expect(reviewCommits('commit ABCDEFA, then 0456DEF, `1234567` and **DEADBEE**')).toEqual([
      'abcdefa',
      '0456def',
      '1234567',
      'deadbee',
    ]);
    expect(reviewCommits('CC3D803 replaces cc3d803 and Cc3d803')).toEqual(['cc3d803']);
    expect(reviewCommits('DEFACED and FEEDBAC stay words; SHA: FEEDBAC')).toEqual(['feedbac']);
    expect(
      pickMergeSource(['`CC3D803` on branch `codex/ao-0290-final`', older290], {
        branch: (b) => b === 'codex/ao-0290-rebased',
        commit: () => false,
      }),
    ).toEqual({ commit: 'cc3d803', branch: 'codex/ao-0290-final' });
    // An earlier review whose branch is gone counts by its commit.
    expect(pickMergeSource([prose148, 'ca2b7d9b on branch deleted-one'], has)).toEqual({
      commit: 'ca2b7d9b',
      branch: 'deleted-one',
    });
  });

  it('commits what a run could not commit in the worktree, then merges it (AO-0300)', async () => {
    const s = mergeSetup();
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    // As the AO-0287 run left it: a staged new file and a changed one on top of its commit.
    writeFileSync(join(wt, 'extra.txt'), 'staged\n');
    git(wt, 'add', 'extra.txt');
    writeFileSync(join(wt, 'code.txt'), 'two\nthree\n');
    approveAfterRun(
      s,
      commit,
      `cannot commit what it left in ${wt}: HEAD moved from 1111111 to ${commit.slice(0, 7)} during the run; the changes stay for a person`,
    );
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'merge', actor: MERGE_ACTOR, branch: 'fake/t-0001-r1-merge' });
    expect(e.body).toContain('2 file(s) run R1 left uncommitted');
    expect(text(join(s.repo, 'extra.txt'))).toBe('staged\n');
    expect(text(join(s.repo, 'code.txt'))).toBe('two\nthree\n');
    expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('two\nthree\n');
    // The commit holds the reviewed one, and the worktree is back on it with nothing left.
    expect(git(s.repo, 'rev-parse', 'main^')).toBe(commit);
    expect(git(wt, 'status', '--porcelain')).toBe('');
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(commit);
  });

  it('commits staged work before recording that the reviewed branch is already in main (AO-0330)', async () => {
    const s = mergeSetup();
    const commit = git(s.repo, 'rev-parse', 'main');
    const wt = join(temp(), 'wt');
    git(s.repo, 'worktree', 'add', '-q', '-b', 'feature', wt, commit);
    writeFileSync(join(wt, 'extra.txt'), 'staged\n');
    git(wt, 'add', 'extra.txt');
    approveAfterRun(
      s,
      commit,
      `cannot commit what it left in ${wt}: HEAD moved during the run; the changes stay for a person`,
    );

    await s.merged();

    const e = s.last();
    expect(e).toMatchObject({ type: 'merge', actor: MERGE_ACTOR, branch: 'fake/t-0001-r1-merge' });
    expect(e.body).not.toContain('already in main; nothing to merge');
    expect(e.body).toContain('1 file(s) run R1 left uncommitted');
    expect(text(join(s.repo, 'extra.txt'))).toBe('staged\n');
    expect(git(wt, 'status', '--porcelain')).toBe('');
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(commit);
  });

  it('looks again before recording no merge when staged work appears during the merge (AO-0330)', async () => {
    const s = mergeSetup();
    const commit = git(s.repo, 'rev-parse', 'main');
    const wt = join(temp(), 'wt');
    git(s.repo, 'worktree', 'add', '-q', '-b', 'feature', wt, commit);
    approveAfterRun(
      s,
      commit,
      `cannot commit what it left in ${wt}: HEAD moved during the run; the changes stay for a person`,
    );
    const original = MergeRepo.prototype.rebase;
    const rebase = vi.spyOn(MergeRepo.prototype, 'rebase').mockImplementationOnce(async function (
      this: MergeRepo,
      source,
      onto,
    ) {
      const result = await original.call(this, source, onto);
      writeFileSync(join(wt, 'extra.txt'), 'staged late\n');
      git(wt, 'add', 'extra.txt');
      return result;
    });
    try {
      await s.merged();
      expect(s.last()).toMatchObject({ type: 'verdict', verdict: 'approve' });
      expect(git(wt, 'status', '--porcelain')).toBe('');
      expect(git(s.repo, 'branch', '--list', 'fake/t-0001-r1-merge')).toContain(
        'fake/t-0001-r1-merge',
      );

      await s.merged();

      const e = s.last();
      expect(e).toMatchObject({
        type: 'merge',
        actor: MERGE_ACTOR,
        branch: 'fake/t-0001-r1-merge',
      });
      expect(e.body).not.toContain('already in main; nothing to merge');
      expect(text(join(s.repo, 'extra.txt'))).toBe('staged late\n');
    } finally {
      rebase.mockRestore();
    }
  });

  it('merges the commit of what a run left when the merge starts again after it (AO-0300)', async () => {
    let slept = 0;
    const s = mergeSetup({ now: () => Date.now() + slept });
    const commit = s.branch('nap\n');
    const wt = worktreeOf(s.repo, 'feature');
    writeFileSync(join(wt, 'extra.txt'), 'staged\n');
    git(wt, 'add', 'extra.txt');
    approveAfterRun(s, commit, `cannot commit what it left in ${wt}: HEAD moved during the run`);
    await s.sup.tick();
    await until(() => existsSync(join(s.state, 'napped.txt')), STAGE_MS);
    // The PC sleeps during the check: the merge ends with the worktree clean and starts again.
    slept = 60 * 60_000;
    writeFileSync(join(s.state, 'go.txt'), 'go\n');
    await s.sup.mergeSettled();
    expect(s.last()).toMatchObject({ type: 'verdict', verdict: 'approve' });
    expect(git(wt, 'status', '--porcelain')).toBe('');
    const left = git(s.repo, 'rev-parse', 'fake/t-0001-r1-merge');
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'merge', actor: MERGE_ACTOR, branch: 'fake/t-0001-r1-merge' });
    expect(e.body).toContain('what run R1 left uncommitted');
    expect(git(s.repo, 'rev-parse', 'main')).toBe(left);
    expect(git(s.repo, 'rev-parse', 'main^')).toBe(commit);
    expect(text(join(s.repo, 'extra.txt'))).toBe('staged\n');
  });

  it('sends the task back when its worktree has changes no run-end accounts for (AO-0300)', async () => {
    const s = mergeSetup();
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    writeFileSync(join(wt, 'stray.txt'), 'whose?\n');
    s.approve(commit);
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({
      type: 'verdict',
      verdict: 'changes',
      actor: MERGE_ACTOR,
      to: 'fake:engineer',
    });
    expect(e.body).toContain('1 uncommitted change(s) (`stray.txt`)');
    expect(e.body).toContain('no run-end');
    expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
    expect(text(join(wt, 'stray.txt'))).toBe('whose?\n');
    expect(git(s.repo, 'branch', '--list', 'fake/*')).toBe('');
  });

  /** Run R1 asks for review and ends with changes swarmupd could not commit; the review gets `changes`. */
  const olderUncommittedRun = (s: ReturnType<typeof mergeSetup>, commit: string, wt: string) => {
    const eng = s.as('fake:engineer', 'R1');
    eng.start('1', 'plan');
    eng.review('1', `${commit.slice(0, 7)} on branch feature: changes the code`, 'human:dawid');
    eng.recordRun(
      '1',
      'run-end',
      { run: 'R1', exit: 0, reason: 'exit', minutes: 1 },
      `cannot commit what it left in ${wt}: HEAD moved during the run`,
    );
    s.as('human:dawid').verdict('1', 'changes', 'not yet');
    return s.as('fake:engineer');
  };

  it('commits nothing for a later review when only an older run ended with changes uncommitted (AO-0300)', async () => {
    const s = mergeSetup();
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    const eng = olderUncommittedRun(s, commit, wt);
    // A later review, made outside that run: it does not cover the files now in the worktree.
    writeFileSync(join(wt, 'extra.txt'), 'staged\n');
    git(wt, 'add', 'extra.txt');
    eng.start('1', 'fix');
    eng.review('1', `${commit.slice(0, 7)} on branch feature: ready`, 'human:dawid');
    s.as('human:dawid').verdict('1', 'approve', 'looks right');
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({
      type: 'verdict',
      verdict: 'changes',
      actor: MERGE_ACTOR,
      to: 'fake:engineer',
    });
    expect(e.body).toContain('1 uncommitted change(s) (`extra.txt`)');
    expect(e.body).toContain('no run-end of the run that asked for this review');
    expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
    expect(git(wt, 'status', '--porcelain')).toBe('A  extra.txt');
    expect(git(s.repo, 'branch', '--list', 'fake/*')).toBe('');
  });

  it('leaves the leftover branch of an older run out of the merge of a later review (AO-0300)', async () => {
    const s = mergeSetup();
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    const eng = olderUncommittedRun(s, commit, wt);
    // What an earlier start of a merge would have committed for run R1, on the reviewed commit.
    git(wt, 'checkout', '-q', '-b', 'fake/t-0001-r1-merge');
    writeFileSync(join(wt, 'extra.txt'), 'stale\n');
    git(wt, 'add', 'extra.txt');
    git(wt, 'commit', '-qm', 'What run R1 left');
    git(wt, 'checkout', '-q', 'feature');
    eng.start('1', 'fix');
    eng.review('1', `${commit.slice(0, 7)} on branch feature: ready`, 'human:dawid');
    s.as('human:dawid').verdict('1', 'approve', 'looks right');
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'merge', actor: MERGE_ACTOR, branch: 'feature' });
    expect(git(s.repo, 'rev-parse', 'main')).toBe(commit);
    expect(existsSync(join(s.repo, 'extra.txt'))).toBe(false);
  });

  it('commits nothing for the review of run R2 when the run-end of run R1 comes after it (AO-0300)', async () => {
    const s = mergeSetup();
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    // Run R1 asks for review and gets `changes` before swarmupd records its end.
    const r1 = s.as('fake:engineer', 'R1');
    r1.recordRun('1', 'run-start', { run: 'R1' }, 'fake run');
    r1.start('1', 'plan');
    r1.review('1', `${commit.slice(0, 7)} on branch feature: changes the code`, 'human:dawid');
    s.as('human:dawid').verdict('1', 'changes', 'not yet');
    // Run R2 leaves a file of its own and asks for review; only then does the end of R1 arrive.
    const r2 = s.as('fake:engineer', 'R2');
    r2.recordRun('1', 'run-start', { run: 'R2' }, 'fake run');
    r2.start('1', 'fix');
    writeFileSync(join(wt, 'extra.txt'), 'not reviewed\n');
    git(wt, 'add', 'extra.txt');
    r2.review('1', `${commit.slice(0, 7)} on branch feature: ready`, 'human:dawid');
    r1.recordRun(
      '1',
      'run-end',
      { run: 'R1', exit: 0, reason: 'exit', minutes: 1 },
      `cannot commit what it left in ${wt}: HEAD moved during the run`,
    );
    r2.recordRun('1', 'run-end', { run: 'R2', exit: 0, reason: 'exit', minutes: 1 }, '');
    s.as('human:dawid').verdict('1', 'approve', 'looks right');
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({
      type: 'verdict',
      verdict: 'changes',
      actor: MERGE_ACTOR,
      to: 'fake:engineer',
    });
    expect(e.body).toContain('1 uncommitted change(s) (`extra.txt`)');
    expect(e.body).toContain('no run-end of the run that asked for this review');
    expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
    expect(git(wt, 'status', '--porcelain')).toBe('A  extra.txt');
    expect(git(s.repo, 'branch', '--list', 'fake/*')).toBe('');
  });

  it('leaves the leftover branch of run R1 out when its run-end comes after the review of run R2 (AO-0300)', async () => {
    const s = mergeSetup();
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    const r1 = s.as('fake:engineer', 'R1');
    r1.start('1', 'plan');
    r1.review('1', `${commit.slice(0, 7)} on branch feature: changes the code`, 'human:dawid');
    s.as('human:dawid').verdict('1', 'changes', 'not yet');
    // What an earlier start of a merge would have committed for run R1, on the reviewed commit.
    git(wt, 'checkout', '-q', '-b', 'fake/t-0001-r1-merge');
    writeFileSync(join(wt, 'extra.txt'), 'stale\n');
    git(wt, 'add', 'extra.txt');
    git(wt, 'commit', '-qm', 'What run R1 left');
    git(wt, 'checkout', '-q', 'feature');
    const r2 = s.as('fake:engineer', 'R2');
    r2.start('1', 'fix');
    r2.review('1', `${commit.slice(0, 7)} on branch feature: ready`, 'human:dawid');
    r1.recordRun(
      '1',
      'run-end',
      { run: 'R1', exit: 0, reason: 'exit', minutes: 1 },
      `cannot commit what it left in ${wt}: HEAD moved during the run`,
    );
    s.as('human:dawid').verdict('1', 'approve', 'looks right');
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'merge', actor: MERGE_ACTOR, branch: 'feature' });
    expect(git(s.repo, 'rev-parse', 'main')).toBe(commit);
    expect(existsSync(join(s.repo, 'extra.txt'))).toBe(false);
  });

  it('records the run that asks on the review event (AO-0300)', () => {
    const s = mergeSetup();
    const commit = s.branch('two\n');
    const r1 = s.as('fake:engineer', 'R1');
    r1.start('1', 'plan');
    r1.review('1', `${commit.slice(0, 7)} on branch feature: changes the code`, 'human:dawid');
    expect(s.last()).toMatchObject({ type: 'review', run: 'R1' });
    s.as('human:dawid').verdict('1', 'changes', 'not yet');
    const byHand = s.as('fake:engineer');
    byHand.start('1', 'fix');
    byHand.review('1', `${commit.slice(0, 7)} on branch feature: ready`, 'human:dawid');
    expect(s.last().type).toBe('review');
    expect(s.last().run).toBeUndefined();
  });

  it('takes a run-end for the approved review only from the run the review names (AO-0300)', () => {
    const ev = (type: string, actor: string, more: object = {}) =>
      ({ type, actor, ...more }) as unknown as Parameters<typeof uncommittedRun>[0][number];
    const end = (run: string, body = 'cannot commit what it left in /wt: HEAD moved') =>
      ev('run-end', 'a:eng', { run, body });
    const review = (run?: string) => ev('review', 'a:eng', run ? { run } : {});
    const start = (run: string) => ev('run-start', 'a:eng', { run });
    const approve = ev('verdict', 'h:d', { verdict: 'approve' });
    const got = { id: 'R1', agent: 'a:eng' };
    expect(uncommittedRun([review('R1'), end('R1'), approve])).toEqual(got);
    expect(uncommittedRun([start('R1'), review('R1'), end('R1'), approve])).toEqual(got);
    // The end of another run between the review and the verdict changes nothing.
    expect(uncommittedRun([review('R1'), end('R0', 'ok'), end('R1'), approve])).toEqual(got);
    // A review that names no run (made by hand, or an older event) ties to none.
    expect(uncommittedRun([review(), end('R1'), approve])).toBeNull();
    expect(uncommittedRun([start('R1'), review(), end('R1'), approve])).toBeNull();
    // The run-end comes before the review, or belongs to an earlier review.
    expect(uncommittedRun([end('R1'), review('R1'), approve])).toBeNull();
    expect(
      uncommittedRun([review('R1'), end('R1'), ev('verdict', 'h:d'), review('R2'), approve]),
    ).toBeNull();
    // The run that made the review ended with nothing left; an older one does not count.
    expect(uncommittedRun([end('R1'), review('R2'), end('R2', 'ok'), approve])).toBeNull();
    // Interleaved: the run-end of R1 arrives after the review of R2, before or after R2 ends.
    const twoRuns = [start('R1'), review('R1'), ev('verdict', 'h:d'), start('R2'), review('R2')];
    expect(uncommittedRun([...twoRuns, end('R1'), approve])).toBeNull();
    expect(uncommittedRun([...twoRuns, end('R1'), end('R2', 'ok'), approve])).toBeNull();
    expect(uncommittedRun([...twoRuns, end('R2', 'ok'), end('R1'), approve])).toBeNull();
    expect(uncommittedRun([...twoRuns, end('R1'), end('R2'), approve])).toEqual({
      id: 'R2',
      agent: 'a:eng',
    });
    // Two ends of the named run, or one by another actor, are not a record to act on.
    expect(uncommittedRun([review('R1'), end('R1'), end('R1'), approve])).toBeNull();
    const other = ev('run-end', 'b:eng', { run: 'R1', body: 'left changes uncommitted: x' });
    expect(uncommittedRun([review('R1'), other, approve])).toBeNull();
  });
});
