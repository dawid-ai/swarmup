import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { samePath } from '@swarmup/core';
import { Checkout } from '../src/checkout.js';
import { MERGE_ACTOR, MergeRepo, pathGone, staleWorktree } from '../src/index.js';
import { ID, approveAfterRun, git, mergeSetup, temp, text, worktreeOf } from './merge-setup.js';

describe('merging approved work', () => {
  /** A branch `feature` checked out in the repo's own checkout, as a run without a task worktree leaves it. */
  const featureInRepo = (repo: string): string => {
    git(repo, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(repo, 'code.txt'), 'two\n');
    git(repo, 'commit', '-qam', 'Change the code');
    return git(repo, 'rev-parse', 'HEAD');
  };

  it("sends the task back when the repo's own checkout is on the reviewed branch with changes (AO-0300)", async () => {
    const s = mergeSetup();
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = featureInRepo(s.repo);
    writeFileSync(join(s.repo, 'stray.txt'), 'whose?\n');
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
    expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
    expect(text(join(s.repo, 'stray.txt'))).toBe('whose?\n');
  });

  it("looks at the repo's own checkout when another root's base has the reviewed branch's name (AO-0300)", async () => {
    // A second root merges into a branch named `feature` in a repo of its own. That name says
    // nothing about this repo, where `feature` is the reviewed branch.
    const s = mergeSetup({ otherMerge: { other: { base: 'feature' } } });
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = featureInRepo(s.repo);
    writeFileSync(join(s.repo, 'stray.txt'), 'whose?\n');
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
    expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
    expect(text(join(s.repo, 'stray.txt'))).toBe('whose?\n');
  });

  it("takes what a run could not commit in the repo's own checkout on the reviewed branch (AO-0300)", async () => {
    const s = mergeSetup();
    const commit = featureInRepo(s.repo);
    writeFileSync(join(s.repo, 'extra.txt'), 'staged\n');
    git(s.repo, 'add', 'extra.txt');
    approveAfterRun(
      s,
      commit,
      `cannot commit what it left in ${s.repo}: HEAD moved during the run`,
    );
    await s.merged();
    // The run's file is in a commit on top of the reviewed one, and the merge works with that.
    const left = git(s.repo, 'rev-parse', 'fake/t-0001-r1-merge');
    expect(git(s.repo, 'rev-parse', `${left}^`)).toBe(commit);
    expect(git(s.repo, 'show', `${left}:extra.txt`)).toBe('staged');
    expect(s.last()).toMatchObject({ type: 'merge', branch: 'fake/t-0001-r1-merge' });
    expect(git(s.repo, 'rev-parse', 'main')).toBe(left);
    expect(git(s.repo, 'status', '--porcelain', '--', 'extra.txt')).toBe('');
  });

  it('sends the task back when the worktree with the changes is not on the commit to merge (AO-0300)', async () => {
    const s = mergeSetup();
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    writeFileSync(join(wt, 'code.txt'), 'two\nthree\n');
    git(wt, 'commit', '-qam', 'One more line');
    writeFileSync(join(wt, 'code.txt'), 'two\nthree\nfour\n');
    approveAfterRun(s, commit, 'left changes uncommitted: 1 process(es) of the run still alive');
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'verdict', verdict: 'changes', actor: MERGE_ACTOR });
    expect(e.body).toContain('not on the commit to merge');
    expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
    expect(text(join(wt, 'code.txt'))).toBe('two\nthree\nfour\n');
  });

  it('merges nothing when a file changes while swarmupd commits what the run left (AO-0300)', async () => {
    const s = mergeSetup();
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    writeFileSync(join(wt, 'extra.txt'), 'staged\n');
    git(wt, 'add', 'extra.txt');
    writeFileSync(join(wt, 'code.txt'), 'two\nthree\n');
    approveAfterRun(s, commit, `cannot commit what it left in ${wt}: HEAD moved during the run`);
    // `code.txt` changes between the commit and the look that follows it (the `check` index).
    type Stage = (index: string, head: string, excludes: string[]) => Generator;
    const proto = Checkout.prototype as unknown as { stage: Stage };
    const real = proto.stage;
    const stage = vi.spyOn(proto, 'stage').mockImplementation(function (this: Checkout, ...a) {
      if (a[0].endsWith('check')) writeFileSync(join(wt, 'code.txt'), 'two\nthree\nfour\n');
      return real.apply(this, a);
    });
    try {
      await s.merged();
    } finally {
      stage.mockRestore();
    }
    const e = s.last();
    expect(e).toMatchObject({
      type: 'verdict',
      verdict: 'changes',
      actor: MERGE_ACTOR,
      to: 'fake:engineer',
    });
    expect(e.body).toContain('1 file(s) there changed again');
    expect(e.body).toContain('`code.txt`');
    expect(e.body).toContain('on branch `fake/t-0001-r1-merge`');
    // The commit holds the older `code.txt`: the base stays, and the newer content stays in the file.
    expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
    expect(git(s.repo, 'show', 'fake/t-0001-r1-merge:code.txt')).toBe('two\nthree');
    expect(text(join(wt, 'code.txt'))).toBe('two\nthree\nfour\n');
    expect(git(s.repo, 'show', 'fake/t-0001-r1-merge:extra.txt')).toBe('staged');
  });

  it('merges nothing when the worktree stays changed with nothing in it to commit (AO-0300)', async () => {
    const s = mergeSetup();
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    // A staged version of `code.txt`, and the file changed back: the files equal the commit, so
    // the commit of what the run left has nothing to hold, and git still reports the change.
    writeFileSync(join(wt, 'code.txt'), 'two\nthree\n');
    git(wt, 'add', 'code.txt');
    writeFileSync(join(wt, 'code.txt'), 'two\n');
    approveAfterRun(s, commit, `cannot commit what it left in ${wt}: HEAD moved during the run`);
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({
      type: 'verdict',
      verdict: 'changes',
      actor: MERGE_ACTOR,
      to: 'fake:engineer',
    });
    expect(e.body).toContain('1 uncommitted change(s) (`code.txt`)');
    expect(e.body).toContain('found nothing in them to commit');
    // The base stays, no branch is made, and the staged version stays in the index.
    expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
    expect(git(s.repo, 'branch', '--list', 'fake/*')).toBe('');
    expect(git(wt, 'show', ':code.txt')).toBe('two\nthree');
  });

  it('merges nothing when the worktree is still changed after the commit of what the run left (AO-0300)', async () => {
    const s = mergeSetup();
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    writeFileSync(join(wt, 'extra.txt'), 'staged\n');
    git(wt, 'add', 'extra.txt');
    approveAfterRun(s, commit, `cannot commit what it left in ${wt}: HEAD moved during the run`);
    // A file appears after the commit and its restore, before the worktree is read again.
    const real = Checkout.prototype.commitLeftovers;
    const spy = vi.spyOn(Checkout.prototype, 'commitLeftovers').mockImplementation(async function (
      this: Checkout,
      ...a
    ) {
      const c = await real.apply(this, a);
      writeFileSync(join(wt, 'late.txt'), 'late\n');
      return c;
    });
    try {
      await s.merged();
    } finally {
      spy.mockRestore();
    }
    const e = s.last();
    expect(e).toMatchObject({ type: 'verdict', verdict: 'changes', actor: MERGE_ACTOR });
    expect(e.body).toContain('1 file(s) there still show as changed after the commit (`late.txt`)');
    expect(e.body).toContain('on branch `fake/t-0001-r1-merge`');
    expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
    expect(text(join(wt, 'late.txt'))).toBe('late\n');
  });

  /** Makes git fail in the worktree `wt` (a broken index); the returned function repairs it. */
  const breakIndex = (wt: string): (() => void) => {
    const index = join(git(wt, 'rev-parse', '--absolute-git-dir'), 'index');
    const good = readFileSync(index);
    writeFileSync(index, 'not an index\n');
    return () => writeFileSync(index, good);
  };

  it('merges nothing while git cannot read the task worktree, then what the run left (AO-0300)', async () => {
    const s = mergeSetup();
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    writeFileSync(join(wt, 'extra.txt'), 'staged\n');
    git(wt, 'add', 'extra.txt');
    approveAfterRun(s, commit, `cannot commit what it left in ${wt}: HEAD moved during the run`);
    const warns: string[] = [];
    s.sup.on('warn', (m: string) => warns.push(m));
    const repair = breakIndex(wt);
    await s.merged();
    // The reviewed commit lacks `extra.txt`: with the worktree unread, the base stays.
    expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
    expect(s.last()).toMatchObject({ type: 'verdict', verdict: 'approve' });
    expect(warns.join('\n')).toContain('cannot read the worktree');
    repair();
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'merge', branch: 'fake/t-0001-r1-merge' });
    expect(git(s.repo, 'rev-parse', 'main^')).toBe(commit);
    expect(text(join(s.repo, 'extra.txt'))).toBe('staged\n');
  });

  it('tells the human and merges nothing when the task worktree stays unreadable (AO-0300)', async () => {
    const s = mergeSetup();
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = s.branch('two\n');
    const repair = breakIndex(worktreeOf(s.repo, 'feature'));
    s.approve(commit);
    await s.merged();
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'verdict', verdict: 'approve' });
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'comment', actor: MERGE_ACTOR, to: 'human:dawid' });
    expect(e.body).toContain('cannot read the worktree');
    expect(e.body).toContain('Nothing is merged');
    // Told once: the merge does not start again until the task changes.
    repair();
    await s.merged();
    expect(s.last().id).toBe(e.id);
    expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
  });

  it('merges nothing while git cannot list the worktrees (AO-0300)', async () => {
    const s = mergeSetup();
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = s.branch('two\n');
    writeFileSync(join(worktreeOf(s.repo, 'feature'), 'stray.txt'), 'whose?\n');
    s.approve(commit);
    const list = vi
      .spyOn(MergeRepo.prototype, 'worktreeList')
      .mockRejectedValueOnce(new Error('fatal: cannot list'));
    try {
      await s.merged();
      expect(list).toHaveBeenCalledTimes(1);
      expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
      expect(s.last()).toMatchObject({ type: 'verdict', verdict: 'approve' });
      // The next look reads the list and finds the changes.
      await s.merged();
      expect(s.last()).toMatchObject({ type: 'verdict', verdict: 'changes', actor: MERGE_ACTOR });
      expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
    } finally {
      list.mockRestore();
    }
  });

  it('merges nothing while the folder of the task worktree cannot be looked at (AO-0300)', async () => {
    const s = mergeSetup();
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    writeFileSync(join(wt, 'extra.txt'), 'staged\n');
    git(wt, 'add', 'extra.txt');
    approveAfterRun(s, commit, `cannot commit what it left in ${wt}: HEAD moved during the run`);
    const warns: string[] = [];
    s.sup.on('warn', (m: string) => warns.push(m));
    // What `statSync` throws for a folder on a drive that does not answer: not `ENOENT`.
    const denied = Object.assign(new Error(`EACCES: permission denied, stat '${wt}'`), {
      code: 'EACCES',
    });
    const gone = vi.spyOn(MergeRepo.prototype, 'worktreeGone').mockImplementationOnce(() => {
      throw denied;
    });
    try {
      await s.merged();
      expect(gone).toHaveBeenCalledTimes(1);
      expect(samePath(gone.mock.calls[0]![0], wt)).toBe(true);
      // The reviewed commit lacks `extra.txt`: with the folder unseen, the base stays.
      expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
      expect(s.last()).toMatchObject({ type: 'verdict', verdict: 'approve' });
      expect(warns.join('\n')).toContain('cannot read the worktree');
      await s.merged();
      expect(s.last()).toMatchObject({ type: 'merge', branch: 'fake/t-0001-r1-merge' });
      expect(git(s.repo, 'rev-parse', 'main^')).toBe(commit);
      expect(text(join(s.repo, 'extra.txt'))).toBe('staged\n');
    } finally {
      gone.mockRestore();
    }
  });

  it('merges the reviewed commit when the folder of the task worktree is deleted (AO-0300)', async () => {
    const s = mergeSetup();
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    // Git still lists the worktree (prunable); nothing is left in it to miss.
    rmSync(wt, { recursive: true, force: true });
    s.approve(commit);
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'merge' });
    expect(git(s.repo, 'rev-parse', 'main')).toBe(commit);
  });

  it('pathGone says gone only for a path the file system reports missing (AO-0300)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gone-'));
    try {
      expect(pathGone(dir)).toBe(false);
      expect(pathGone(join(dir, 'none'))).toBe(true);
      writeFileSync(join(dir, 'file'), '');
      expect(pathGone(join(dir, 'file', 'under'))).toBe(true);
      for (const code of ['EACCES', 'EPERM', 'EBUSY', 'EIO']) {
        const err = Object.assign(new Error(code), { code });
        expect(() =>
          pathGone(dir, () => {
            throw err;
          }),
        ).toThrow(err);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges nothing while git cannot read the branch of an earlier start of the merge (AO-0300)', async () => {
    const s = mergeSetup();
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    // As an earlier start of the merge left it: the changes committed on their branch, the
    // worktree clean on the reviewed commit.
    writeFileSync(join(wt, 'extra.txt'), 'staged\n');
    git(wt, 'add', 'extra.txt');
    git(wt, 'commit', '-qm', 'What the run left');
    const left = git(wt, 'rev-parse', 'HEAD');
    git(wt, 'branch', 'fake/t-0001-r1-merge');
    git(wt, 'reset', '-q', '--hard', commit);
    approveAfterRun(s, commit, `cannot commit what it left in ${wt}: HEAD moved during the run`);
    const tip = vi
      .spyOn(MergeRepo.prototype, 'branchOn')
      .mockRejectedValueOnce(new Error('fatal: cannot read refs'));
    try {
      await s.merged();
      expect(tip).toHaveBeenCalledTimes(1);
      expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
      await s.merged();
      expect(git(s.repo, 'rev-parse', 'main')).toBe(left);
    } finally {
      tip.mockRestore();
    }
  });

  it('merges the branch an earlier review names when the approved review names none (AO-0153)', async () => {
    const s = mergeSetup();
    const first = s.branch('two\n');
    const eng = s.as('fake:engineer');
    eng.start('1', 'plan');
    eng.review('1', `${first.slice(0, 7)} on branch feature: changes the code`, 'human:dawid');
    s.as('human:dawid').verdict('1', 'changes', 'one more line');
    // The fix lands on the branch; the next review names no source, only prose.
    const block = git(s.repo, 'worktree', 'list', '--porcelain')
      .split(/\r?\n\r?\n/)
      .find((b) => b.includes('branch refs/heads/feature'))!;
    const wt = /^worktree (.+)$/m.exec(block)![1]!.trim();
    writeFileSync(join(wt, 'code.txt'), 'two\nthree\n');
    git(wt, 'commit', '-qam', 'One more line');
    const tip = git(wt, 'rev-parse', 'HEAD');
    eng.start('1', 'fix');
    eng.review('1', 'Added the line; this branch is ready and the tests pass.', 'human:dawid');
    s.as('human:dawid').verdict('1', 'approve', 'looks right');
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'merge', actor: MERGE_ACTOR, branch: 'feature' });
    expect(git(s.repo, 'rev-parse', 'main')).toBe(tip);
    expect(text(join(s.repo, 'code.txt'))).toBe('two\nthree\n');
  });

  it('makes its worktree again when it is left from another repo (AO-0273)', async () => {
    const s = mergeSetup();
    // swarmupd's worktree as an earlier merge left it, when the code checkout was another repo.
    const old = temp();
    git(old, 'init', '-q', '-b', 'main');
    git(old, 'commit', '-q', '--allow-empty', '-m', 'start');
    const wt = join(s.state, 'merge', 'test');
    mkdirSync(dirname(wt), { recursive: true });
    git(old, 'worktree', 'add', '-q', '--detach', wt);
    writeFileSync(join(wt, 'left.txt'), 'from an earlier merge\n');
    const commit = s.branch('two\n');
    s.approve(commit);
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'merge', actor: MERGE_ACTOR, branch: 'feature' });
    expect(git(s.repo, 'rev-parse', 'main')).toBe(commit);
    // The folder is a worktree of the checkout now, and the old repo lists it no more.
    const listed = (repo: string): string[] =>
      git(repo, 'worktree', 'list', '--porcelain')
        .split(/\r?\n/)
        .filter((l) => l.startsWith('worktree '))
        .map((l) => l.slice('worktree '.length).trim());
    expect(listed(s.repo).some((p) => samePath(p, wt))).toBe(true);
    expect(listed(old)).toHaveLength(1);
    const entries = join(old, '.git', 'worktrees');
    expect(existsSync(entries) ? readdirSync(entries) : []).toEqual([]);
    expect(existsSync(join(wt, 'left.txt'))).toBe(false);
  });

  it('leaves a folder inside another checkout alone and names its repo (AO-0273)', async () => {
    const s = mergeSetup();
    const other = temp();
    git(other, 'init', '-q', '-b', 'main');
    git(other, 'commit', '-q', '--allow-empty', '-m', 'start');
    const inside = join(other, 'merge');
    mkdirSync(inside);
    writeFileSync(join(inside, 'notes.txt'), 'someone else\n');
    const repo = new MergeRepo(s.repo, inside, [], { ...process.env, ...ID });
    await expect(repo.ensureWorktree(git(s.repo, 'rev-parse', 'main'))).rejects.toThrow(
      /belongs to the repo at .* remove it/,
    );
    expect(text(join(inside, 'notes.txt'))).toBe('someone else\n');
  });

  it('makes its worktree again when its old repo was deleted (AO-0275)', async () => {
    const s = mergeSetup();
    const old = temp();
    git(old, 'init', '-q', '-b', 'main');
    git(old, 'commit', '-q', '--allow-empty', '-m', 'start');
    const wt = join(s.state, 'merge', 'test');
    mkdirSync(dirname(wt), { recursive: true });
    git(old, 'worktree', 'add', '-q', '--detach', wt);
    writeFileSync(join(wt, 'left.txt'), 'from an earlier merge\n');
    rmSync(old, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    const commit = s.branch('two\n');
    s.approve(commit);
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'merge', actor: MERGE_ACTOR, branch: 'feature' });
    expect(git(s.repo, 'rev-parse', 'main')).toBe(commit);
    expect(
      samePath(
        git(wt, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
        join(s.repo, '.git'),
      ),
    ).toBe(true);
    expect(existsSync(join(wt, 'left.txt'))).toBe(false);
  });

  it('keeps a folder whose .git names no missing worktree entry (AO-0275)', async () => {
    const s = mergeSetup();
    const at = git(s.repo, 'rev-parse', 'main');
    const cases: [string, (dir: string) => void][] = [
      ['no .git', () => undefined],
      ['a .git folder', (dir) => mkdirSync(join(dir, '.git'))],
      ['other text', (dir) => writeFileSync(join(dir, '.git'), 'notes\n')],
      // A submodule of a checkout that is gone: not a worktree swarmupd made.
      [
        'a submodule',
        (dir) =>
          writeFileSync(join(dir, '.git'), `gitdir: ${join(temp(), 'gone', 'modules', 'x')}\n`),
      ],
    ];
    for (const [name, make] of cases) {
      const dir = join(temp(), 'merge');
      mkdirSync(dir);
      make(dir);
      writeFileSync(join(dir, 'notes.txt'), 'someone else\n');
      expect(staleWorktree(dir), name).toBe(false);
      const repo = new MergeRepo(s.repo, dir, [], { ...process.env, ...ID });
      await expect(repo.ensureWorktree(at), name).rejects.toThrow(/is no git worktree; remove it/);
      expect(text(join(dir, 'notes.txt')), name).toBe('someone else\n');
    }
  });

  it('keeps a task blocked on approved work until the merge is recorded (AO-0228)', async () => {
    const s = mergeSetup({ userMerge: true });
    const commit = s.branch('slow\n');
    const eng = s.as('fake:engineer');
    eng.start('2', 'plan');
    eng.block('2', 'needs the change of T-0001', { on: ['T-0001'] });
    s.approve(commit);
    const waiter = () => s.as('human:dawid').view('2');
    expect(waiter()).toMatchObject({ unblocked: false, mergeWait: ['T-0001'] });
    // The merge is under way: its check waits for go.txt, and the base has not moved.
    await s.sup.tick();
    expect(s.sup.merge?.ref).toBe('test/T-0001');
    expect(waiter().unblocked).toBe(false);
    expect(s.as('fake:engineer').next()).toBeUndefined();
    writeFileSync(join(s.state, 'go.txt'), '');
    await s.sup.mergeSettled();
    expect(s.last()).toMatchObject({ type: 'merge', actor: MERGE_ACTOR });
    expect(text(join(s.repo, 'code.txt'))).toBe('slow\n');
    expect(waiter().unblocked).toBe(true);
  });

  it('frees a task blocked on approved work that has nothing to merge (AO-0228)', async () => {
    const s = mergeSetup({ userMerge: true });
    const eng = s.as('fake:engineer');
    eng.start('2', 'plan');
    eng.block('2', 'needs T-0001', { on: ['T-0001'] });
    eng.start('1', 'plan');
    // Prose that names no branch the repo has.
    eng.review('1', 'This branch is ready and the tests pass.', 'human:dawid');
    s.as('human:dawid').verdict('1', 'approve', 'looks right');
    const waiter = () => s.as('human:dawid').view('2');
    expect(waiter()).toMatchObject({ unblocked: false, mergeWait: ['T-0001'] });
    // The first tick finds nothing to merge; the next one notes it.
    await s.merged();
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'comment', actor: MERGE_ACTOR, no_merge: true });
    expect(e.body).toContain('swarmupd merges nothing for T-0001: no review request names');
    expect(waiter().unblocked).toBe(true);
    // Once only.
    await s.merged();
    await s.merged();
    expect(s.last().id).toBe(e.id);
  });

  it('keeps a task blocked on approved work whose merge failed (AO-0228)', async () => {
    const s = mergeSetup({ userMerge: true });
    const eng = s.as('fake:engineer');
    eng.start('2', 'plan');
    eng.block('2', 'needs T-0001', { on: ['T-0001'] });
    // The review names a commit and a branch the repo lacks, so the merge fails.
    s.approve('0123abc');
    const waiter = () => s.as('human:dawid').view('2');
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'comment', actor: MERGE_ACTOR, to: 'human:dawid' });
    expect(e).not.toHaveProperty('no_merge');
    expect(e.body).toContain('swarmupd cannot merge 0123abc on branch feature');
    expect(s.as('human:dawid').view('1')).toMatchObject({ status: 'done', awaitsMerge: true });
    expect(waiter()).toMatchObject({ status: 'blocked', unblocked: false, mergeWait: ['T-0001'] });
    expect(s.as('fake:engineer').next()).toBeUndefined();
    // Later ticks add no note that would free it.
    await s.merged();
    await s.merged();
    expect(s.last().id).toBe(e.id);
    expect(waiter().unblocked).toBe(false);
  });

  it('keeps the worktree of approved work whose merge failed (AO-0228)', async () => {
    let now = Date.now();
    const s = mergeSetup({ userMerge: true, now: () => now });
    const wt = join(s.repo, 'out', 'wt-T-0001');
    git(s.repo, 'worktree', 'add', '-q', '-b', 'fake/t-0001', wt, 'main');
    // The review names a commit the repo lacks, so the merge fails with a note.
    s.approve('0123abc');
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'comment', actor: MERGE_ACTOR });
    expect(e.body).toContain('swarmupd cannot merge 0123abc on branch feature');
    // Closed for longer than `reclaim_after_minutes`, but its work is still not in the base.
    now += 61 * 60_000;
    await s.sup.housekeep();
    expect(existsSync(wt)).toBe(true);
    expect(s.last().id).toBe(e.id);
    // A note that nothing is left to merge settles it, and the worktree goes.
    s.as(MERGE_ACTOR).noMerge('1', 'swarmupd merges nothing for T-0001.');
    now += 61 * 60_000;
    await s.sup.housekeep();
    expect(existsSync(wt)).toBe(false);
  });

  it('keeps a task blocked on approved work that the repo lacks, and tells the human (AO-0228)', async () => {
    const s = mergeSetup({ userMerge: true });
    const eng = s.as('fake:engineer');
    eng.start('2', 'plan');
    eng.block('2', 'needs T-0001', { on: ['T-0001'] });
    eng.start('1', 'plan');
    eng.review('1', '0123abc on branch gone: the change', 'human:dawid');
    s.as('human:dawid').verdict('1', 'changes', 'one more test');
    eng.start('1', 'plan');
    // The newest review names nothing; the earlier one names work the repo does not have.
    eng.review('1', 'Added the test.', 'human:dawid');
    s.as('human:dawid').verdict('1', 'approve', 'looks right');
    const waiter = () => s.as('human:dawid').view('2');
    await s.merged();
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'comment', actor: MERGE_ACTOR, to: 'human:dawid' });
    expect(e).not.toHaveProperty('no_merge');
    expect(e.body).toContain('swarmupd cannot merge T-0001');
    expect(e.body).toContain('stay blocked');
    expect(waiter()).toMatchObject({ status: 'blocked', unblocked: false, mergeWait: ['T-0001'] });
    // Once only.
    await s.merged();
    await s.merged();
    expect(s.last().id).toBe(e.id);
    expect(waiter().unblocked).toBe(false);
  });

  it('frees a task blocked on work approved before the merge setting (AO-0228)', async () => {
    const s = mergeSetup({ userMerge: true, since: '2999-01-01T00:00:00.000Z' });
    const commit = s.branch('two\n');
    const eng = s.as('fake:engineer');
    eng.start('2', 'plan');
    eng.block('2', 'needs T-0001', { on: ['T-0001'] });
    s.approve(commit);
    expect(s.as('human:dawid').view('2').unblocked).toBe(false);
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'comment', actor: MERGE_ACTOR });
    expect(e.body).toContain('it was approved before swarmupd merged approved work of test');
    expect(s.as('human:dawid').view('2').unblocked).toBe(true);
    expect(text(join(s.repo, 'code.txt'))).toBe('one\n');
  });

  it('frees a task blocked on work approved before the merge setting and commented on after it (AO-0228)', async () => {
    const s = mergeSetup({ userMerge: true });
    const commit = s.branch('two\n');
    const eng = s.as('fake:engineer');
    eng.start('2', 'plan');
    eng.block('2', 'needs T-0001', { on: ['T-0001'] });
    s.approve(commit);
    // swarmupd first sees the merge setting after the approval, and a comment comes later still.
    const since = new Date(Date.parse(s.last().at) + 1).toISOString();
    while (new Date().toISOString() <= since) await new Promise((r) => setTimeout(r, 2));
    writeFileSync(join(s.state, 'merge.json'), JSON.stringify({ test: since }));
    s.as('human:dawid').comment('1', 'Thanks, this reads well.');
    expect(s.last().at > since).toBe(true);
    expect(s.as('human:dawid').view('2').unblocked).toBe(false);
    // The first tick finds nothing to merge; no later one may take the named work for missing.
    await s.merged();
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'comment', actor: MERGE_ACTOR, no_merge: true });
    expect(e.body).toContain('it was approved before swarmupd merged approved work of test');
    expect(s.as('human:dawid').view('2').unblocked).toBe(true);
    expect(text(join(s.repo, 'code.txt'))).toBe('one\n');
    // Once only.
    await s.merged();
    await s.merged();
    expect(s.last().id).toBe(e.id);
  });
});
