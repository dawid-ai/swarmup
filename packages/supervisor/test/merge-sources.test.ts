import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { reviewSourcesOf, secretKind } from '@swarmup/core';
import {
  type MergeStatus,
  CommandRunner,
  MERGE_ACTOR,
  MergeRepo,
  pickMergeSource,
  reviewSources,
  startApi,
} from '../src/index.js';
import { until } from './until.js';
import {
  STAGE_MS,
  WIN,
  alive,
  blindLister,
  ended,
  git,
  mergeSetup,
  precise,
  refusingLister,
  removed,
  temp,
  text,
} from './merge-setup.js';

describe('merging approved work', () => {
  it('rebases again when the base moves during the checks, and checks again only for code', async () => {
    const s = mergeSetup();
    const count = () =>
      existsSync(join(s.state, 'checks.txt')) ? text(join(s.state, 'checks.txt')).length : 0;
    const commit = s.branch('slow\n');
    s.approve(commit);
    await s.sup.tick();
    await until(() => count() === 1, STAGE_MS);
    // A task store sync lands on main while the check runs: no code changed.
    const synced = s.onMain('.swarmup/sync-note.md', 'note\n');
    writeFileSync(join(s.state, 'go.txt'), 'go\n');
    await s.sup.mergeSettled();
    const tip = git(s.repo, 'rev-parse', 'main');
    expect(git(s.repo, 'rev-parse', `${tip}^`)).toBe(synced);
    expect(count()).toBe(1);
    expect(s.last()).toMatchObject({ type: 'merge', commit: tip });
  });

  it('records work already in the base without moving it', async () => {
    const s = mergeSetup();
    const commit = s.branch('two\n');
    git(s.repo, 'merge', '-q', '--ff-only', 'feature');
    const tip = git(s.repo, 'rev-parse', 'main');
    s.approve(commit);
    await s.merged();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(tip);
    expect(existsSync(join(s.state, 'checks.txt'))).toBe(false);
    expect(s.last()).toMatchObject({ type: 'merge', commit: tip });
    expect(s.last().body).toContain('is already in main; nothing to merge');
  });

  it("merges the run-suffixed branch that holds a reviewed run's leftover files (AO-0356)", async () => {
    const s = mergeSetup();
    const committed = s.branch('two\n');
    const branch = 'fake/t-0001-r1';
    git(s.repo, 'branch', '-m', 'feature', branch);
    // The review was sent before wrap-up. Its task branch has no work, while swarmupd's later
    // run-end records the branch where it committed the files the sandboxed run left.
    git(s.repo, 'branch', 'feature', 'main');
    const reviewed = git(s.repo, 'rev-parse', 'feature');
    const eng = s.as('fake:engineer', 'R1');
    eng.start('1', 'plan');
    eng.review(
      '1',
      `${reviewed.slice(0, 7)} on branch feature: changes the code, tests`,
      'human:dawid',
    );
    eng.recordRun(
      '1',
      'run-end',
      { run: 'R1', exit: 0, reason: 'exit', minutes: 1 },
      `left 1 changed file(s); swarmupd committed them as ${committed.slice(0, 7)} on branch ${branch}`,
    );
    s.as('human:dawid').verdict('1', 'approve', 'looks right');

    await s.merged();

    expect(s.last()).toMatchObject({ type: 'merge', actor: MERGE_ACTOR, branch });
    expect(s.last().body).not.toContain('nothing to merge');
    expect(text(join(s.repo, 'code.txt'))).toBe('two\n');
    expect(git(s.repo, 'rev-parse', 'main')).toBe(committed);
  });

  it('takes the commit the approved review names in code font, not the branch of an earlier review (AO-0325)', async () => {
    const s = mergeSetup({ userMerge: true });
    const commit = s.branch('two\n');
    // The branch of an earlier round: it points at main, as an import that failed left it.
    git(s.repo, 'branch', 'stale', 'main');
    const eng = s.as('fake:engineer');
    eng.start('2', 'plan');
    eng.block('2', 'needs T-0001', { on: ['T-0001'] });
    eng.start('1', 'plan');
    eng.review('1', 'T-0001: `0123abc` on branch `stale` is rebased.', 'human:dawid');
    s.as('human:dawid').verdict('1', 'changes', 'the branch is empty');
    eng.start('1', 'plan');
    eng.review(
      '1',
      `T-0001: \`${commit.slice(0, 7)}\` on branch \`feature\` is rebased onto current \`main\`.`,
      'human:dawid',
    );
    s.as('human:dawid').verdict('1', 'approve', 'looks right');
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'merge', actor: MERGE_ACTOR, branch: 'feature' });
    expect(text(join(s.repo, 'code.txt'))).toBe('two\n');
    expect(s.as('human:dawid').view('2').unblocked).toBe(true);
  });

  it('merges nothing when the commit the approved review names in code font is not in the repo (AO-0325)', async () => {
    const s = mergeSetup({ userMerge: true });
    git(s.repo, 'branch', 'stale', 'main');
    const tip = git(s.repo, 'rev-parse', 'main');
    const eng = s.as('fake:engineer');
    eng.start('2', 'plan');
    eng.block('2', 'needs T-0001', { on: ['T-0001'] });
    eng.start('1', 'plan');
    eng.review('1', 'T-0001: `0123abc` on branch `stale` is rebased.', 'human:dawid');
    s.as('human:dawid').verdict('1', 'changes', 'the branch is empty');
    eng.start('1', 'plan');
    // As AO-0290's last review: the commit is in a bundle, not in the repo.
    eng.review(
      '1',
      'T-0001: `0456def` on branch `final` is rebased onto current `main`; import the bundle.',
      'human:dawid',
    );
    s.as('human:dawid').verdict('1', 'approve', 'looks right');
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'comment', actor: MERGE_ACTOR, to: 'human:dawid' });
    expect(e.body).toContain('swarmupd cannot merge 0456def on branch final');
    expect(git(s.repo, 'rev-parse', 'main')).toBe(tip);
    expect(s.as('human:dawid').view('1')).toMatchObject({ status: 'done', awaitsMerge: true });
    expect(s.as('human:dawid').view('2')).toMatchObject({ status: 'blocked', unblocked: false });
  });

  it('files a finding, not a merge, when a fallback source is in the base and the approved review names a commit that is not (AO-0325)', async () => {
    const s = mergeSetup({ userMerge: true });
    git(s.repo, 'branch', 'stale', 'main');
    const tip = git(s.repo, 'rev-parse', 'main');
    const eng = s.as('fake:engineer');
    eng.start('2', 'plan');
    eng.block('2', 'needs T-0001', { on: ['T-0001'] });
    eng.start('1', 'plan');
    eng.review('1', 'T-0001: 0123abc on branch stale is rebased.', 'human:dawid');
    s.as('human:dawid').verdict('1', 'changes', 'the branch is empty');
    eng.start('1', 'plan');
    // No `<commit> on branch <name>`: the pick falls back to the earlier review's branch.
    eng.review(
      '1',
      `T-0001: the work is commit 0456def in the bundle, rebased onto ${tip.slice(0, 7)}.`,
      'human:dawid',
    );
    s.as('human:dawid').verdict('1', 'approve', 'looks right');
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'finding', actor: MERGE_ACTOR });
    expect(git(s.repo, 'rev-parse', 'main')).toBe(tip);
    const human = s.as('human:dawid');
    expect(human.view('1')).toMatchObject({ status: 'done', awaitsMerge: true });
    expect(human.view('2')).toMatchObject({ status: 'blocked', unblocked: false });
    const finding = human.view(e.ref!);
    expect(finding.meta).toMatchObject({ type: 'finding', priority: 'p1' });
    expect(finding.meta.title).toContain('T-0001 is approved, but its work is not in main');
    const filed = human.showEvents(e.ref!).body;
    expect(filed).toContain('`0456def`');
    // The base's own commit, which the review names too, is not reported.
    expect(filed).not.toContain(`\`${tip.slice(0, 7)}\``);
    // Once only, and no later tick frees the waiter.
    await s.merged();
    await s.merged();
    expect(s.last().id).toBe(e.id);
    expect(human.view('2').unblocked).toBe(false);
  });

  it('takes the commit the approved review names in underscore bold, not the branch of an earlier review (AO-0325)', async () => {
    const s = mergeSetup({ userMerge: true });
    const commit = s.branch('two\n');
    git(s.repo, 'branch', 'stale', 'main');
    const eng = s.as('fake:engineer');
    eng.start('2', 'plan');
    eng.block('2', 'needs T-0001', { on: ['T-0001'] });
    eng.start('1', 'plan');
    eng.review('1', 'T-0001: __0123abc__ on branch __stale__ is rebased.', 'human:dawid');
    s.as('human:dawid').verdict('1', 'changes', 'the branch is empty');
    eng.start('1', 'plan');
    eng.review(
      '1',
      `T-0001: __${commit.slice(0, 7)}__ on branch __feature__ is rebased onto current \`main\`.`,
      'human:dawid',
    );
    s.as('human:dawid').verdict('1', 'approve', 'looks right');
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'merge', actor: MERGE_ACTOR, branch: 'feature' });
    expect(text(join(s.repo, 'code.txt'))).toBe('two\n');
    expect(s.as('human:dawid').view('2').unblocked).toBe(true);
  });

  it.each([
    ['named', (sha: string) => `T-0001: \`${sha}\` on branch \`__wip__\` is rebased.`],
    ['loose', () => 'T-0001: the fix is on branch `__wip__`, rebased onto `main`.'],
  ])(
    'takes a branch whose name has underscores at both ends from code font, not the branch of an earlier review: %s (AO-0325)',
    async (_form, request) => {
      const s = mergeSetup({ userMerge: true });
      const commit = s.branch('two\n');
      git(s.repo, 'branch', '-m', 'feature', '__wip__');
      git(s.repo, 'branch', 'stale', 'main');
      const eng = s.as('fake:engineer');
      eng.start('2', 'plan');
      eng.block('2', 'needs T-0001', { on: ['T-0001'] });
      eng.start('1', 'plan');
      eng.review('1', 'T-0001: 0123abc on branch stale is rebased.', 'human:dawid');
      s.as('human:dawid').verdict('1', 'changes', 'the branch is empty');
      eng.start('1', 'plan');
      eng.review('1', request(commit.slice(0, 7)), 'human:dawid');
      s.as('human:dawid').verdict('1', 'approve', 'looks right');
      await s.merged();
      expect(s.last()).toMatchObject({ type: 'merge', actor: MERGE_ACTOR, branch: '__wip__' });
      expect(s.last().body).not.toContain('nothing to merge');
      expect(text(join(s.repo, 'code.txt'))).toBe('two\n');
      expect(s.as('human:dawid').view('2').unblocked).toBe(true);
    },
  );

  it.each([
    ['named', (sha: string) => `T-0001: \`${sha}\` on branch \`feature\`-old is rebased.`],
    ['loose', () => 'T-0001: the fix is on branch `feature`-old, rebased onto `main`.'],
  ])(
    'does not take the branch a code span names when a longer word runs on from the span: %s (AO-0325)',
    async (_form, request) => {
      const s = mergeSetup({ userMerge: true });
      const commit = s.branch('two\n');
      git(s.repo, 'branch', '-m', 'feature', 'feature-old');
      // The stale branch whose name the code span holds: it is already in `main`.
      git(s.repo, 'branch', 'feature', 'main');
      const eng = s.as('fake:engineer');
      eng.start('2', 'plan');
      eng.block('2', 'needs T-0001', { on: ['T-0001'] });
      eng.start('1', 'plan');
      eng.review('1', 'T-0001: the work is on branch feature-old.', 'human:dawid');
      s.as('human:dawid').verdict('1', 'changes', 'rebase it');
      eng.start('1', 'plan');
      eng.review('1', request(commit.slice(0, 7)), 'human:dawid');
      s.as('human:dawid').verdict('1', 'approve', 'looks right');
      await s.merged();
      expect(s.last()).toMatchObject({ type: 'merge', actor: MERGE_ACTOR, branch: 'feature-old' });
      expect(s.last().body).not.toContain('nothing to merge');
      expect(text(join(s.repo, 'code.txt'))).toBe('two\n');
      expect(s.as('human:dawid').view('2').unblocked).toBe(true);
    },
  );

  it.each(
    ['_', '__', '___'].flatMap((tail) => [
      [
        'named',
        tail,
        (sha: string) => `T-0001: \`${sha}\` on branch \`feature\`${tail} is rebased.`,
      ] as const,
      [
        'loose',
        tail,
        () => `T-0001: the fix is on branch \`feature\`${tail}, rebased onto \`main\`.`,
      ] as const,
    ]),
  )(
    'does not take the branch a code span names when unpaired underscores follow the span: %s, %s (AO-0325)',
    async (_form, tail, request) => {
      const s = mergeSetup({ userMerge: true });
      const commit = s.branch('two\n');
      git(s.repo, 'branch', '-m', 'feature', `feature${tail}`);
      // The stale branch whose name the code span holds: it is already in `main`.
      git(s.repo, 'branch', 'feature', 'main');
      const eng = s.as('fake:engineer');
      eng.start('2', 'plan');
      eng.block('2', 'needs T-0001', { on: ['T-0001'] });
      eng.start('1', 'plan');
      eng.review('1', `T-0001: the work is on branch feature${tail} for now.`, 'human:dawid');
      s.as('human:dawid').verdict('1', 'changes', 'rebase it');
      eng.start('1', 'plan');
      eng.review('1', request(commit.slice(0, 7)), 'human:dawid');
      s.as('human:dawid').verdict('1', 'approve', 'looks right');
      await s.merged();
      expect(s.last()).toMatchObject({
        type: 'merge',
        actor: MERGE_ACTOR,
        branch: `feature${tail}`,
      });
      expect(s.last().body).not.toContain('nothing to merge');
      expect(text(join(s.repo, 'code.txt'))).toBe('two\n');
      expect(s.as('human:dawid').view('2').unblocked).toBe(true);
    },
  );

  it('takes the commit the approved review names in capitals, not the branch of an earlier review (AO-0325)', async () => {
    const s = mergeSetup({ userMerge: true });
    const commit = s.branch('two\n');
    git(s.repo, 'branch', 'stale', 'main');
    const eng = s.as('fake:engineer');
    eng.start('2', 'plan');
    eng.block('2', 'needs T-0001', { on: ['T-0001'] });
    eng.start('1', 'plan');
    eng.review('1', 'T-0001: 0123abc on branch stale is rebased.', 'human:dawid');
    s.as('human:dawid').verdict('1', 'changes', 'the branch is empty');
    eng.start('1', 'plan');
    eng.review(
      '1',
      `T-0001: ${commit.slice(0, 7).toUpperCase()} on branch feature is rebased onto current \`main\`.`,
      'human:dawid',
    );
    s.as('human:dawid').verdict('1', 'approve', 'looks right');
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'merge', actor: MERGE_ACTOR, branch: 'feature' });
    expect(text(join(s.repo, 'code.txt'))).toBe('two\n');
    expect(s.as('human:dawid').view('2').unblocked).toBe(true);
  });

  it('merges nothing when the commit the approved review names in capitals is not in the repo (AO-0325)', async () => {
    const s = mergeSetup({ userMerge: true });
    git(s.repo, 'branch', 'stale', 'main');
    const tip = git(s.repo, 'rev-parse', 'main');
    const eng = s.as('fake:engineer');
    eng.start('2', 'plan');
    eng.block('2', 'needs T-0001', { on: ['T-0001'] });
    eng.start('1', 'plan');
    eng.review('1', 'T-0001: 0123abc on branch stale is rebased.', 'human:dawid');
    s.as('human:dawid').verdict('1', 'changes', 'the branch is empty');
    eng.start('1', 'plan');
    eng.review(
      '1',
      'T-0001: ABCDEFA on branch final is rebased; import the bundle.',
      'human:dawid',
    );
    s.as('human:dawid').verdict('1', 'approve', 'looks right');
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'comment', actor: MERGE_ACTOR, to: 'human:dawid' });
    expect(e.body).toContain('swarmupd cannot merge abcdefa on branch final');
    expect(git(s.repo, 'rev-parse', 'main')).toBe(tip);
    expect(s.as('human:dawid').view('1')).toMatchObject({ status: 'done', awaitsMerge: true });
    expect(s.as('human:dawid').view('2')).toMatchObject({ status: 'blocked', unblocked: false });
  });

  it('merges nothing when the commit the approved review names in underscore bold is not in the repo (AO-0325)', async () => {
    const s = mergeSetup({ userMerge: true });
    git(s.repo, 'branch', 'stale', 'main');
    const tip = git(s.repo, 'rev-parse', 'main');
    const eng = s.as('fake:engineer');
    eng.start('2', 'plan');
    eng.block('2', 'needs T-0001', { on: ['T-0001'] });
    eng.start('1', 'plan');
    eng.review('1', 'T-0001: `0123abc` on branch `stale` is rebased.', 'human:dawid');
    s.as('human:dawid').verdict('1', 'changes', 'the branch is empty');
    eng.start('1', 'plan');
    eng.review(
      '1',
      'T-0001: __0456def__ on branch final is rebased; import the bundle.',
      'human:dawid',
    );
    s.as('human:dawid').verdict('1', 'approve', 'looks right');
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'comment', actor: MERGE_ACTOR, to: 'human:dawid' });
    expect(e.body).toContain('swarmupd cannot merge 0456def on branch final');
    expect(git(s.repo, 'rev-parse', 'main')).toBe(tip);
    expect(s.as('human:dawid').view('1')).toMatchObject({ status: 'done', awaitsMerge: true });
    expect(s.as('human:dawid').view('2')).toMatchObject({ status: 'blocked', unblocked: false });
  });

  it('files a finding when a fallback source is in the base and the approved review names an unmerged commit in underscore bold (AO-0325)', async () => {
    const s = mergeSetup({ userMerge: true });
    git(s.repo, 'branch', 'stale', 'main');
    const tip = git(s.repo, 'rev-parse', 'main');
    const eng = s.as('fake:engineer');
    eng.start('2', 'plan');
    eng.block('2', 'needs T-0001', { on: ['T-0001'] });
    eng.start('1', 'plan');
    eng.review('1', 'T-0001: 0123abc on branch stale is rebased.', 'human:dawid');
    s.as('human:dawid').verdict('1', 'changes', 'the branch is empty');
    eng.start('1', 'plan');
    // No `<commit> on branch <name>`: the pick falls back to the earlier review's branch.
    eng.review('1', 'T-0001: the work is commit __0456def__ in the bundle.', 'human:dawid');
    s.as('human:dawid').verdict('1', 'approve', 'looks right');
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'finding', actor: MERGE_ACTOR });
    expect(git(s.repo, 'rev-parse', 'main')).toBe(tip);
    const human = s.as('human:dawid');
    expect(human.showEvents(e.ref!).body).toContain('`0456def`');
    expect(human.view('1')).toMatchObject({ status: 'done', awaitsMerge: true });
    expect(human.view('2')).toMatchObject({ status: 'blocked', unblocked: false });
  });

  // A commit id may have no letter or no digit; the guard reads it after a label or in Markdown.
  it.each([
    ['all digits after a label', 'the work is commit 1234567 in the bundle', '1234567'],
    ['all letters after a label', 'the work is commit abcdefa in the bundle', 'abcdefa'],
    ['all digits in code font', 'the work is `1234567`, in the bundle', '1234567'],
    ['all letters in bold', 'the work is **abcdefa**, in the bundle', 'abcdefa'],
    ['capital letters after a label', 'the work is commit ABCDEFA in the bundle', 'abcdefa'],
    ['capitals and digits in prose', 'the work is 0456DEF, in the bundle', '0456def'],
    ['capital letters in code font', 'the work is `ABCDEFA`, in the bundle', 'abcdefa'],
  ])(
    'files a finding when a fallback source is in the base and the approved review names an unmerged commit of %s (AO-0325)',
    async (_form, says, sha) => {
      const s = mergeSetup({ userMerge: true });
      git(s.repo, 'branch', 'stale', 'main');
      const tip = git(s.repo, 'rev-parse', 'main');
      const eng = s.as('fake:engineer');
      eng.start('2', 'plan');
      eng.block('2', 'needs T-0001', { on: ['T-0001'] });
      eng.start('1', 'plan');
      eng.review('1', 'T-0001: 0123abc on branch stale is rebased.', 'human:dawid');
      s.as('human:dawid').verdict('1', 'changes', 'the branch is empty');
      eng.start('1', 'plan');
      // No `<commit> on branch <name>`: the pick falls back to the earlier review's branch.
      eng.review('1', `T-0001: ${says}.`, 'human:dawid');
      s.as('human:dawid').verdict('1', 'approve', 'looks right');
      await s.merged();
      const e = s.last();
      expect(e).toMatchObject({ type: 'finding', actor: MERGE_ACTOR });
      expect(git(s.repo, 'rev-parse', 'main')).toBe(tip);
      const human = s.as('human:dawid');
      expect(human.showEvents(e.ref!).body).toContain(`\`${sha}\``);
      expect(human.view('1')).toMatchObject({ status: 'done', awaitsMerge: true });
      expect(human.view('2')).toMatchObject({ status: 'blocked', unblocked: false });
    },
  );

  it('records a fallback source already in the base when the approved review names no commit the base lacks (AO-0325)', async () => {
    const s = mergeSetup();
    const commit = s.branch('two\n');
    git(s.repo, 'merge', '-q', '--ff-only', 'feature');
    const tip = git(s.repo, 'rev-parse', 'main');
    const eng = s.as('fake:engineer');
    eng.start('1', 'plan');
    eng.review('1', `T-0001: ${commit.slice(0, 7)} on branch feature`, 'human:dawid');
    s.as('human:dawid').verdict('1', 'changes', 'say what the tests cover');
    eng.start('1', 'plan');
    eng.review(
      '1',
      `T-0001: ${commit.slice(0, 7)} is unchanged; the tests cover it.`,
      'human:dawid',
    );
    s.as('human:dawid').verdict('1', 'approve', 'looks right');
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'merge', commit: tip });
    expect(s.last().body).toContain('is already in main; nothing to merge');
  });

  it('sends back a branch that changes task store files', async () => {
    const s = mergeSetup();
    const before = git(s.repo, 'rev-parse', 'main');
    const wt = join(temp(), 'wt');
    git(s.repo, 'worktree', 'add', '-q', '-b', 'feature', wt, 'main');
    writeFileSync(join(wt, 'code.txt'), 'two\n');
    writeFileSync(join(wt, '.swarmup', 'stray.md'), 'stray\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-qm', 'Change the code');
    s.approve(git(wt, 'rev-parse', 'HEAD'));
    await s.merged();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    expect(s.last()).toMatchObject({ type: 'verdict', verdict: 'changes', actor: MERGE_ACTOR });
    expect(s.last().body).toContain('changes task store files (.swarmup/stray.md)');
  });

  it('merges nothing approved before swarmupd first saw the merge setting', async () => {
    const s = mergeSetup();
    const before = git(s.repo, 'rev-parse', 'main');
    s.approve(s.branch('two\n'));
    // A verdict in the same millisecond as swarmupd's first look counts as after it; a fast Linux
    // machine got there inside one millisecond and merged (AO-0395).
    const verdictAt = Date.parse(s.last().at);
    await until(() => Date.now() > verdictAt);
    rmSync(join(s.state, 'merge.json'));
    await s.merged();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    expect(s.last().type).toBe('verdict');
  });

  /**
   * Holds the first `MergeRepo` call to `method` until the returned `release` runs, so a test can
   * act while merge planning waits for git; `asked` resolves once planning asks. Counts the
   * calls to `branches` and `hasCommit`.
   */
  function gateGit(method: 'branches' | 'hasCommit') {
    const real = {
      branches: MergeRepo.prototype.branches,
      hasCommit: MergeRepo.prototype.hasCommit,
    };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let asked!: () => void;
    const askedP = new Promise<void>((r) => (asked = r));
    let first = true;
    const hold = async (): Promise<void> => {
      if (!first) return;
      first = false;
      asked();
      await gate;
    };
    const branches = vi.spyOn(MergeRepo.prototype, 'branches').mockImplementation(async function (
      this: MergeRepo,
    ) {
      if (method === 'branches') await hold();
      return real.branches.call(this);
    });
    const hasCommit = vi.spyOn(MergeRepo.prototype, 'hasCommit').mockImplementation(async function (
      this: MergeRepo,
      rev: string,
    ) {
      if (method === 'hasCommit') await hold();
      return real.hasCommit.call(this, rev);
    });
    const restore = (): void => {
      branches.mockRestore();
      hasCommit.mockRestore();
    };
    return { asked: askedP, release, hasCommit, restore };
  }

  it('merges nothing when the task is reopened while git answers the merge plan (AO-0169)', async () => {
    const s = mergeSetup();
    const before = git(s.repo, 'rev-parse', 'main');
    s.approve(s.branch('two\n'));
    const g = gateGit('branches');
    try {
      const tick = s.sup.tick();
      await g.asked;
      s.as('human:dawid').reopen('1', 'one more thing');
      g.release();
      await tick;
      await s.sup.mergeSettled();
    } finally {
      g.restore();
    }
    expect(s.sup.merge).toBeNull();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    const events = s.as('human:dawid').showEvents('1').events;
    expect(events.some((e) => e.actor === MERGE_ACTOR)).toBe(false);
    expect(s.last().type).toBe('reopen');
  });

  it.each([
    ['branches', 0],
    ['hasCommit', 1],
  ] as const)(
    'ends the merge plan at the git answer to %s when swarmupd stops meanwhile (AO-0169)',
    async (method, probes) => {
      const s = mergeSetup();
      const before = git(s.repo, 'rev-parse', 'main');
      const eng = s.as('fake:engineer');
      // Two earlier reviews name commits on branches the repo lacks, so planning asks git about
      // both commits; the approved review names no source.
      for (const [sha, branch] of [
        ['1111111', 'gone-one'],
        ['2222222', 'gone-two'],
      ]) {
        eng.start('1', 'plan');
        eng.review('1', `${sha} on branch ${branch}: changes the code`, 'human:dawid');
        s.as('human:dawid').verdict('1', 'changes', 'not yet');
      }
      eng.start('1', 'fix');
      eng.review('1', 'Ready; the tests pass.', 'human:dawid');
      s.as('human:dawid').verdict('1', 'approve', 'looks right');
      const g = gateGit(method);
      try {
        const tick = s.sup.tick();
        await g.asked;
        s.sup.stop({ killRuns: true });
        g.release();
        await tick;
        await s.sup.mergeSettled();
        // No rev-parse starts after the stop.
        expect(g.hasCommit).toHaveBeenCalledTimes(probes);
      } finally {
        g.restore();
      }
      expect(s.sup.merge).toBeNull();
      expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
      expect(s.last()).toMatchObject({ type: 'verdict', actor: 'human:dawid' });
    },
  );

  it('waits for a writing run in the checkout, lets runs start during the checks, and holds the checkout from the fast-forward (AO-0160)', async () => {
    const s = mergeSetup();
    // The check waits for go.txt; the build waits for build-go.txt, then builds.
    const commit = s.branch('slow hold\n');
    s.approve(commit);
    const before = git(s.repo, 'rev-parse', 'main');
    const runGo = join(s.state, 'run-go.txt');
    const run = s.sup.launch({ agent: 'fake:engineer', task: '2' });
    await s.merged();
    expect(s.sup.merge).toBeNull();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    expect(s.last().type).toBe('verdict');

    // Each run ends by itself: a killed run's process may outlive the kill on Windows, keeping
    // the scratch repo busy past the test.
    let end = ended(s.sup, run.id);
    writeFileSync(runGo, 'go\n');
    await end;
    rmSync(runGo);
    await s.sup.tick();
    await until(() => existsSync(join(s.state, 'checks.txt')), STAGE_MS);
    // The checks run in swarmupd's worktree and hold nothing: a writing run starts meanwhile.
    expect(s.sup.merge).toMatchObject({ base: 'main', holds: false });
    const during = s.sup.launch({ agent: 'fake:engineer', task: '2' });

    // The checks pass; the base does not move while that run is live.
    writeFileSync(join(s.state, 'go.txt'), 'go\n');
    await until(() => s.sup.merge?.holds === true);
    await new Promise((r) => setTimeout(r, 300));
    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    // A task store sync lands on main during the wait: the merge rebases onto it, checks once.
    const synced = s.onMain('.swarmup/sync-note.md', 'note\n');

    end = ended(s.sup, during.id);
    writeFileSync(runGo, 'go\n');
    await end;
    rmSync(runGo);
    await s.sup.tick();
    // The build waits for build-go.txt: the checkout is held until it is over.
    await until(() => existsSync(join(s.state, 'building.txt')), STAGE_MS);
    expect(git(s.repo, 'rev-parse', 'main^')).toBe(synced);
    expect(text(join(s.state, 'checks.txt'))).toHaveLength(1);
    expect(() => s.sup.launch({ agent: 'fake:engineer', task: '2' })).toThrow(
      /^swarmupd merges test\/T-0001 into main in /,
    );
    writeFileSync(join(s.state, 'build-go.txt'), 'go\n');
    await s.sup.mergeSettled();
    expect(s.sup.merge).toBeNull();
    expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('slow hold\n');
    expect(s.last()).toMatchObject({ type: 'merge', commit: git(s.repo, 'rev-parse', 'main') });
  });

  it('shows the merge under way with its step and command, marks the work it holds, and logs each step (AO-0161)', async () => {
    const s = mergeSetup();
    const lines: string[] = [];
    s.sup.on('merge', (m: string) => lines.push(m));
    expect(s.sup.mergeStatus()).toBeNull();
    // The check waits for go.txt; the build waits for build-go.txt.
    s.approve(s.branch('slow hold\n'));
    await s.sup.tick();
    await until(() => existsSync(join(s.state, 'checks.txt')), STAGE_MS);
    const checking = s.sup.mergeStatus()!;
    expect(checking).toMatchObject({
      task: 'test/T-0001',
      base: 'main',
      step: 'checks',
      holds: false,
      command: { text: 'node check.mjs', index: 0, count: 1 },
      timeout_minutes: 30,
    });
    expect(checking.what).toMatch(/^[0-9a-f]{7} on branch feature$/);
    expect(Date.parse(checking.command!.started_at)).toBeGreaterThanOrEqual(
      Date.parse(checking.started_at),
    );
    expect(lines).toEqual([
      expect.stringMatching(
        /^test\/T-0001: starts: [0-9a-f]{7} on branch feature into main, built in /,
      ),
      "test/T-0001: check 1/1 `node check.mjs` starts in swarmupd's worktree, timeout 30 min",
    ]);

    writeFileSync(join(s.state, 'go.txt'), 'go\n');
    await until(() => existsSync(join(s.state, 'building.txt')), STAGE_MS);
    expect(s.sup.mergeStatus()).toMatchObject({
      step: 'build',
      holds: true,
      command: { text: 'node build.mjs', index: 0, count: 1 },
    });
    // Work a waking agent would start in the held checkout waits for the merge, and says so.
    s.sup.config.agents['fake:engineer'] = { ...s.sup.config.agents['fake:engineer'], wake: true };
    const held = s.sup.waits().find((w) => w.task === 'test/T-0002');
    expect(held).toMatchObject({ merge: true });
    expect(held!.reason).toMatch(
      /^fake:engineer: swarmupd merges test\/T-0001 into main in .+; it holds the checkout until its build ends$/,
    );
    expect(lines.slice(2)).toEqual([
      expect.stringMatching(/^test\/T-0001: check 1\/1 `node check\.mjs` passed after \d+s$/),
      expect.stringMatching(/^test\/T-0001: holds .+ from new writing runs until the build ends$/),
      expect.stringMatching(/^test\/T-0001: moved main to [0-9a-f]{7}; builds it in /),
      expect.stringMatching(
        /^test\/T-0001: build 1\/1 `node build\.mjs` starts in .+, timeout 30 min$/,
      ),
    ]);

    writeFileSync(join(s.state, 'build-go.txt'), 'go\n');
    await s.sup.mergeSettled();
    expect(s.sup.mergeStatus()).toBeNull();
    expect(lines.slice(6)).toEqual([
      expect.stringMatching(/^test\/T-0001: build 1\/1 `node build\.mjs` passed after \d+s$/),
      expect.stringMatching(/^test\/T-0001: ends after \d+s$/),
    ]);
    expect(s.sup.waits().some((w) => w.merge)).toBe(false);
  });

  it('sends each change of the merge under way on the event stream, so open app windows read it again (AO-0161)', async () => {
    const s = mergeSetup();
    const api = await startApi(s.sup, { port: 0, token: 'merge-token', version: 't' });
    const merges: Array<MergeStatus | null> = [];
    let hello = false;
    const stream = await fetch(`http://127.0.0.1:${api.port}/api/events?token=merge-token`);
    const reader = stream.body!.getReader();
    const pump = (async () => {
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          if (event === 'hello') hello = true;
          if (event !== 'merge') continue;
          merges.push(JSON.parse(/^data: (.+)$/m.exec(frame)![1]!) as MergeStatus | null);
        }
      }
    })();
    try {
      await until(() => hello);
      // The check waits for go.txt; the build waits for build-go.txt.
      // `slow` and `hold` make them wait; without them both end at once, and on a fast machine
      // the stream had moved past each step before the test read it (AO-0240).
      s.approve(s.branch('slow hold stream\n'));
      await s.sup.tick();
      await until(() => merges.some((m) => m?.command?.text === 'node check.mjs'), STAGE_MS);
      expect(merges[0]).toMatchObject({ task: 'test/T-0001', base: 'main', step: 'rebase' });
      expect(merges.at(-1)).toMatchObject({ step: 'checks', holds: false });

      writeFileSync(join(s.state, 'go.txt'), 'go\n');
      await until(() => merges.some((m) => m?.command?.text === 'node build.mjs'), STAGE_MS);
      expect(merges.at(-1)).toMatchObject({ step: 'build', holds: true });

      writeFileSync(join(s.state, 'build-go.txt'), 'go\n');
      await s.sup.mergeSettled();
      await until(() => merges.at(-1) === null);
      // Every step the app shows arrived as it began.
      const steps = merges.filter((m) => m !== null).map((m) => m.step);
      expect(steps).toEqual(expect.arrayContaining(['rebase', 'checks', 'build']));
    } finally {
      await reader.cancel();
      await pump.catch(() => {});
      await api.close();
    }
  });

  it.runIf(precise)(
    'records the merge when swarmupd stops during the build, ends what the build started, and builds again after a restart',
    async () => {
      const s = mergeSetup();
      const commit = s.branch('hold\n');
      s.approve(commit);
      await s.sup.tick();
      await until(() => existsSync(join(s.state, 'building.txt')), STAGE_MS);
      const build = Number(text(join(s.state, 'building.txt')));
      const tip = git(s.repo, 'rev-parse', 'main');
      expect(text(join(s.repo, 'code.txt'))).toBe('hold\n');
      s.sup.stop();
      await s.sup.close();

      // The stop ended the detached build process too: nothing is left to race the next build.
      expect(alive(build)).toBe(false);
      expect(existsSync(join(s.state, 'merge-procs.json'))).toBe(false);
      // The base moved, so the merge is on record; the build is not done.
      expect(existsSync(join(s.repo, 'dist', 'built.txt'))).toBe(false);
      const e = s.last();
      expect(e).toMatchObject({ type: 'merge', actor: MERGE_ACTOR, commit: tip });
      expect(e.body).toContain('was stopped with swarmupd; the next swarmupd runs the build again');
      expect(s.as('human:dawid').view('1').status).toBe('done');

      writeFileSync(join(s.state, 'build-go.txt'), 'go\n');
      const next = s.opsd();
      await next.tick();
      await next.mergeSettled();
      expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('hold\n');
      expect(git(s.repo, 'rev-parse', 'main')).toBe(tip);
      expect(s.last()).toMatchObject({ type: 'comment', actor: MERGE_ACTOR });
      expect(s.last().body).toContain(
        'Built main with `node build.mjs` after the earlier build did not finish',
      );
      // One merge event, and the build is not run a third time.
      expect(
        s
          .as('human:dawid')
          .showEvents('1')
          .events.filter((x) => x.type === 'merge'),
      ).toHaveLength(1);
      const events = s.as('human:dawid').showEvents('1').events.length;
      await next.tick();
      await next.mergeSettled();
      expect(s.as('human:dawid').showEvents('1').events).toHaveLength(events);
    },
    45_000,
  );

  // On Windows the job object ends the build whatever the lister can do; see the next test.
  it.runIf(precise && !WIN)(
    'waits for a build no kill could end before it builds again',
    async () => {
      const s = mergeSetup({ procs: refusingLister });
      const warns: string[] = [];
      s.approve(s.branch('hold\n'));
      await s.sup.tick();
      await until(() => existsSync(join(s.state, 'building.txt')), STAGE_MS);
      const build = Number(text(join(s.state, 'building.txt')));
      s.sup.stop();
      await s.sup.close();

      // The detached build survived every kill; swarmupd keeps it on record.
      expect(alive(build)).toBe(true);
      const left = JSON.parse(text(join(s.state, 'merge-procs.json'))) as Array<{ pid: number }>;
      expect(left.map((p) => p.pid)).toContain(build);
      expect(s.last().body).toContain('the next swarmupd runs the build again');

      // The next swarmupd neither builds nor merges while it runs.
      const next = s.opsd();
      next.on('warn', (m: string) => warns.push(m));
      await next.tick();
      await next.mergeSettled();
      expect(next.merge).toBeNull();
      expect(existsSync(join(s.repo, 'dist'))).toBe(false);
      expect(warns.join('\n')).toContain('waiting for what an earlier merge left running');

      // Once it ends by itself, the next look clears it and the build runs.
      writeFileSync(join(s.state, 'build-go.txt'), 'go\n');
      const end = Date.now() + 15_000;
      while (s.last().type !== 'comment' && Date.now() < end) {
        await next.tick();
        await next.mergeSettled();
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(alive(build)).toBe(false);
      expect(JSON.parse(text(join(s.state, 'merge-procs.json')))).toEqual([]);
      expect(s.last()).toMatchObject({ type: 'comment', actor: MERGE_ACTOR });
      expect(s.last().body).toContain(
        'Built main with `node build.mjs` after the earlier build did not finish',
      );
    },
    45_000,
  );

  it.runIf(WIN)(
    'ends the whole build on a stop where listing and killing processes are refused, and waits for recorded leftovers',
    async () => {
      // The sandbox case: no process list, no kill by PID. Only the job object can end the build.
      let lister = blindLister();
      const s = mergeSetup({ procs: () => lister });
      s.approve(s.branch('hold\n'));
      await s.sup.tick();
      await until(() => existsSync(join(s.state, 'building.txt')), STAGE_MS);
      const build = Number(text(join(s.state, 'building.txt')));
      const start = Date.now();
      s.sup.stop();
      await s.sup.close();
      expect(Date.now() - start).toBeLessThan(10_000);
      expect(alive(build)).toBe(false);
      expect(existsSync(join(s.state, 'merge-procs.json'))).toBe(false);
      expect(s.last().body).toContain('the next swarmupd runs the build again');

      // A leftover on record, from a swarmupd before this one, holds the build until it is gone.
      const left = { pid: 999_999, start: Date.now() - 60_000, running: true };
      writeFileSync(
        join(s.state, 'merge-procs.json'),
        JSON.stringify([
          { ...left, ppid: 0, name: 'held', cmd: 'held', first_seen: '', last_seen: '' },
        ]),
      );
      writeFileSync(join(s.state, 'build-go.txt'), 'go\n');
      const warns: string[] = [];
      lister = blindLister(left);
      const next = s.opsd();
      next.on('warn', (m: string) => warns.push(m));
      await next.tick();
      await next.mergeSettled();
      expect(existsSync(join(s.repo, 'dist'))).toBe(false);
      expect(warns.join('\n')).toContain('waiting for what an earlier merge left running');

      left.running = false;
      const end = Date.now() + 15_000;
      while (s.last().type !== 'comment' && Date.now() < end) {
        await next.tick();
        await next.mergeSettled();
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(s.last()).toMatchObject({ type: 'comment', actor: MERGE_ACTOR });
      expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('hold\n');
    },
    45_000,
  );

  it.runIf(WIN)('runs each command in a job object that ends everything it started', async () => {
    const dir = temp();
    // tree.mjs starts a detached child, which starts one more; each writes its PID and waits.
    writeFileSync(
      join(dir, 'tree.mjs'),
      `
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
const depth = Number(process.argv[2] ?? 0);
writeFileSync('pid' + depth + '.txt', String(process.pid));
if (depth < 2) spawn(process.execPath, ['tree.mjs', String(depth + 1)], { detached: depth === 0, stdio: 'ignore' });
if (depth === 0 && process.argv[3] === 'exit') {
  while (!existsSync('pid2.txt')) await new Promise((r) => setTimeout(r, 50));
  process.exit(3);
}
setInterval(() => {}, 1000);
`,
    );
    const pids = (): number[] => [0, 1, 2].map((d) => Number(text(join(dir, `pid${d}.txt`))));
    const ready = (): boolean => [0, 1, 2].every((d) => existsSync(join(dir, `pid${d}.txt`)));

    // A stop ends the tree, detached child included.
    const runner = new CommandRunner(process.env, { killTree: () => {} });
    const stopped = runner.runAll(['node tree.mjs 0'], dir, 60_000);
    await until(ready);
    const first = pids();
    runner.stop();
    expect((await stopped)[0]).toMatchObject({ ok: false, why: 'stopped' });
    await until(() => first.every((p) => !alive(p)));

    // A command that exits by itself keeps its exit code and leaves nothing running.
    for (const d of [0, 1, 2]) rmSync(join(dir, `pid${d}.txt`));
    const [r] = await new CommandRunner(process.env).runAll(['node tree.mjs 0 exit'], dir, 60_000);
    expect(r).toMatchObject({ ok: false, why: 'exit 3' });
    await until(() => pids().every((p) => !alive(p)));
    await until(() => removed(dir));
  });

  it('ends a stopped command even when what it started outlives the stop', async () => {
    const dir = temp();
    const pid = join(dir, 'pid.txt');
    const go = join(dir, 'go.txt');
    // Holds the output open until go.txt exists.
    writeFileSync(
      join(dir, 'hold.mjs'),
      `
import { existsSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pid)}, String(process.pid));
while (!existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 50));
`,
    );
    // No job, no watch and no group kill: ending the shell may leave node running.
    const runner = new CommandRunner(process.env, { killTree: () => {}, job: false });
    const result = runner.runAll(['node hold.mjs'], dir, 60_000);
    await until(() => existsSync(pid) && text(pid) !== '');
    const start = Date.now();
    runner.stop();
    const [r] = await result;
    expect(r).toMatchObject({ ok: false, why: 'stopped' });
    expect(Date.now() - start).toBeLessThan(9_000);
    // The leftover ends by itself and lets go of the folder.
    writeFileSync(go, 'go\n');
    await until(() => removed(dir));
  });

  it('keeps secret-looking output out of the send-back and the log', async () => {
    const s = mergeSetup();
    s.approve(s.branch('leak\n'));
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'verdict', verdict: 'changes', actor: MERGE_ACTOR });
    expect(secretKind(e.body)).toBeNull();
    expect(e.body).toContain('[line removed: it looks like a GitHub token]');
    expect(e.body).toContain('after the token');
    const log = /Full output: (\S+)/.exec(e.body)?.[1];
    expect(log).toBeDefined();
    const kept = text(log!);
    expect(secretKind(kept)).toBeNull();
    expect(kept).toContain('after the token');
    // Nothing else swarmupd keeps holds it either.
    for (const f of readdirSync(join(s.state, 'merge', 'logs'))) {
      expect(secretKind(text(join(s.state, 'merge', 'logs', f)))).toBeNull();
    }
  });
});

describe('review source fields (AO-0384)', () => {
  it('reads the fields before the prose, and a store review as naming no code', () => {
    // AO-0328's wording: the extra word "store" misses the prose pattern.
    const body = 'AO-0328: `98be9579` on store branch `main`; also see branch `old/x`.';
    expect(reviewSources(body).named).toBeUndefined();
    expect(reviewSourcesOf({ body, commit: 'ABCDEF1234', branch: 'claude/ao-0328' })).toEqual({
      named: { commit: 'abcdef1234', branch: 'claude/ao-0328' },
      loose: ['main', 'old/x'],
    });
    expect(reviewSourcesOf({ body, commit: '98be9579', branch: 'main', repo: 'store' })).toEqual({
      loose: [],
    });
    // A commit without a branch (a detached HEAD) leaves the prose to name the source.
    expect(reviewSourcesOf({ body: 'cc3d803 on branch x', commit: 'abcdef1' })).toEqual(
      reviewSources('cc3d803 on branch x'),
    );
    const review = { body, commit: 'abcdef1', branch: 'claude/ao-0328', repo: 'code' as const };
    expect(pickMergeSource([review], { branch: () => true, commit: () => true })).toEqual({
      commit: 'abcdef1',
      branch: 'claude/ao-0328',
    });
  });

  it('merges the commit and branch a review recorded as fields when its prose names neither', async () => {
    const s = mergeSetup();
    const commit = s.branch('two\n');
    const eng = s.as('fake:engineer');
    eng.start('1', 'plan');
    const body = `T-0001: \`${commit.slice(0, 8)}\` on store branch \`main\`.`;
    eng.review('1', body, 'human:dawid', undefined, {
      source: { commit, branch: 'feature', repo: 'code' },
    });
    s.as('human:dawid').verdict('1', 'approve', 'looks right');
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'merge', actor: MERGE_ACTOR, branch: 'feature' });
    expect(text(join(s.repo, 'code.txt'))).toBe('two\n');
  });

  it('closes a review of store work with no merge and no finding, and frees its waiters', async () => {
    const s = mergeSetup({ userMerge: true });
    const tip = git(s.repo, 'rev-parse', 'main');
    const eng = s.as('fake:engineer');
    eng.start('2', 'plan');
    eng.block('2', 'needs T-0001', { on: ['T-0001'] });
    eng.start('1', 'plan');
    // AO-0297's case: a store commit the code repo lacks, named as `<commit> on branch <name>`.
    const body = 'T-0001: e4aa1570 on branch main: agent files updated.';
    eng.review('1', body, 'human:dawid', undefined, {
      source: { commit: 'e4aa1570', branch: 'main', repo: 'store' },
    });
    s.as('human:dawid').verdict('1', 'approve', 'looks right');
    const human = s.as('human:dawid');
    // Store work has no code to wait for: the approval frees the waiter on its own.
    expect(human.view('1')).toMatchObject({ status: 'done', awaitsMerge: false });
    expect(human.view('2').unblocked).toBe(true);
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'comment', actor: MERGE_ACTOR, no_merge: true });
    expect(e.body).toContain('nothing to merge: store work, synced');
    expect(git(s.repo, 'rev-parse', 'main')).toBe(tip);
    // Once only, and no finding.
    await s.merged();
    expect(s.last().id).toBe(e.id);
    expect(human.views().filter((v) => v.meta.type === 'finding')).toEqual([]);
  });
});
