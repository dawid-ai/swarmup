import { describe, expect, it } from 'vitest';
import { initRoot, MERGE_ACTOR, searchSources, Workspace } from '../src/index.js';
import type { UserConfig } from '../src/index.js';
import { gitRepo, setup } from './helpers.js';

/** A user config in which swarmupd merges approved work of the root `test`. */
const MERGES = { swarmupd: { merge: { test: { base: 'main' } } } } as UserConfig;

/**
 * Task 1 in review, and task 2 blocked on it. `user` is the machine's user config; `review` is
 * the text of task 1's review request.
 */
function blockedOnReview(user: UserConfig, review = 'abc1234 on branch feature: the fix, tests') {
  const { repo, env } = setup();
  const as = (actor: string) => new Workspace({ cwd: repo, env, actor, user });
  const h = as('human:dawid');
  h.newTask({ title: 'The fix', owner: 'claude:engineer' });
  h.newTask({ title: 'Needs the fix', owner: 'claude:engineer' });
  const eng = as('claude:engineer');
  eng.start('2', 'plan');
  eng.block('2', 'needs the fix of T-0001', { on: ['T-0001'] });
  eng.start('1', 'plan');
  eng.review('1', review, 'human:dawid');
  /** Task 2 as `view`, `views` and the search index see it. */
  const waiter = () => {
    const live = h.views().find((v) => v.meta.id === 'T-0002')!;
    const merges = new Set(user === MERGES ? ['test'] : []);
    const found = searchSources(h.roots, Date.now(), undefined, merges)
      .tasks()
      .find(({ view: v }) => v.meta.id === 'T-0002')!;
    return [h.view('2'), live, found.view];
  };
  return { as, h, eng, waiter, repo, env };
}

describe('a task blocked on approved work that swarmupd merges (AO-0228)', () => {
  it('stays blocked after the approval and frees when swarmupd records the merge', () => {
    const { as, h, eng, waiter } = blockedOnReview(MERGES);
    h.verdict('1', 'approve', 'looks right');
    expect(h.view('1')).toMatchObject({ status: 'done', awaitsMerge: true });
    for (const v of waiter()) {
      expect(v).toMatchObject({ status: 'blocked', unblocked: false, mergeWait: ['T-0001'] });
    }
    expect(h.mergeWaited()).toEqual(['test/T-0001']);
    expect(eng.next()?.meta.id).not.toBe('T-0002');
    expect(() => eng.claim('2')).toThrow();

    as(MERGE_ACTOR).recordMerge(
      '1',
      { commit: 'abc1234', into: 'main', branch: 'feature' },
      'Merged',
    );
    expect(h.view('1').awaitsMerge).toBe(false);
    for (const v of waiter()) {
      expect(v.unblocked).toBe(true);
      expect(v.mergeWait).toBeUndefined();
    }
    expect(h.mergeWaited()).toEqual([]);
    expect(eng.claim('2').events.map((e) => e.type)).toContain('unblock');
  });

  it('frees on a note from swarmupd that it merges nothing', () => {
    const { as, h } = blockedOnReview(MERGES);
    h.verdict('1', 'approve', 'looks right');
    expect(h.view('2').unblocked).toBe(false);
    as(MERGE_ACTOR).noMerge('1', 'swarmupd merges nothing for T-0001');
    expect(h.view('1').awaitsMerge).toBe(false);
    expect(h.view('2').unblocked).toBe(true);
  });

  it('reads the merge roots from the old `opsd` key when there is no `swarmupd` key', () => {
    const old = { opsd: { merge: { test: { base: 'main' } } } } as UserConfig;
    const { h } = blockedOnReview(old);
    h.verdict('1', 'approve', 'looks right');
    expect(h.view('2')).toMatchObject({ status: 'blocked', mergeWait: ['T-0001'] });
    expect(h.mergeWaited()).toEqual(['test/T-0001']);
  });

  it('stays blocked on a note from swarmupd that the merge failed', () => {
    const { as, h, eng, waiter } = blockedOnReview(MERGES);
    h.verdict('1', 'approve', 'looks right');
    as(MERGE_ACTOR).comment(
      '1',
      'swarmupd could not merge abc1234 on branch feature; main did not move',
      'human:dawid',
    );
    expect(h.view('1')).toMatchObject({ status: 'done', awaitsMerge: true });
    for (const v of waiter()) {
      expect(v).toMatchObject({ status: 'blocked', unblocked: false, mergeWait: ['T-0001'] });
    }
    expect(h.mergeWaited()).toEqual(['test/T-0001']);
    expect(eng.next()?.meta.id).not.toBe('T-0002');
    expect(() => eng.claim('2')).toThrow();
  });

  it('stays blocked on a merge event or a nothing-to-merge note that swarmupd did not write', () => {
    const { h, eng } = blockedOnReview(MERGES);
    h.verdict('1', 'approve', 'looks right');
    eng.noMerge('1', 'nothing to merge');
    eng.recordMerge('1', { commit: 'abc1234', into: 'main', branch: 'feature' }, 'Merged');
    expect(h.view('1').awaitsMerge).toBe(true);
    expect(h.view('2').unblocked).toBe(false);
  });

  it('frees by hand with unblock while the merge is missing', () => {
    const { h, eng } = blockedOnReview(MERGES);
    h.verdict('1', 'approve', 'looks right');
    eng.unblock('2', 'merged by hand');
    expect(h.view('2').status).toBe('todo');
  });

  it('stays blocked when the merge fails and the work goes back', () => {
    const { as, h } = blockedOnReview(MERGES);
    h.verdict('1', 'approve', 'looks right');
    as(MERGE_ACTOR).sendBack('1', 'the checks failed', 'claude:engineer');
    expect(h.view('1').status).toBe('todo');
    expect(h.view('2')).toMatchObject({ status: 'blocked', unblocked: false });
    expect(h.view('2').mergeWait).toBeUndefined();
  });

  it('frees at the approval when swarmupd does not merge the root on this machine', () => {
    const { h, waiter } = blockedOnReview({});
    h.verdict('1', 'approve', 'looks right');
    expect(h.view('1').awaitsMerge).toBe(true);
    expect(waiter().map((v) => v.unblocked)).toEqual([true, true, true]);
  });

  it('frees at the approval when no review names a branch', () => {
    const { h, waiter } = blockedOnReview(MERGES, 'PR: https://example.invalid/pull/1');
    h.verdict('1', 'approve', 'looks right');
    expect(h.view('1').awaitsMerge).toBe(false);
    expect(waiter().map((v) => v.unblocked)).toEqual([true, true, true]);
  });

  /** Task 3 blocked on task 2, and task 4 an open child of task 1, on top of `blockedOnReview`. */
  function withIndirectAndChild(user: UserConfig) {
    const s = blockedOnReview(user);
    s.h.newTask({ title: 'Needs task 2', owner: 'claude:engineer' });
    s.h.newTask({ title: 'Part of the fix', parent: '1' });
    s.eng.start('3', 'plan');
    s.eng.block('3', 'needs T-0002', { on: ['T-0002'] });
    return s;
  }

  it('records the tasks that wait for the merge as freed on the merge, not on the approval', () => {
    const { as, h } = withIndirectAndChild(MERGES);
    const approval = h.verdict('1', 'approve', 'looks right').events[0]!;
    // Only the child moves at the approval; tasks 2 and 3 still wait for the merge.
    expect(approval.freed).toEqual(['T-0004']);
    expect(approval).not.toHaveProperty('freed_indirect');

    const note = as(MERGE_ACTOR).comment('1', 'swarmupd could not merge abc1234', 'human:dawid');
    expect(note.events[0]).not.toHaveProperty('freed');

    const merge = as(MERGE_ACTOR).recordMerge(
      '1',
      { commit: 'abc1234', into: 'main', branch: 'feature' },
      'Merged',
    ).events[0]!;
    expect(merge).toMatchObject({ type: 'merge', freed: ['T-0002'], freed_indirect: ['T-0003'] });
    // A second merge event, with the wait over, releases nothing more.
    const again = as(MERGE_ACTOR).recordMerge(
      '1',
      { commit: 'abc1234', into: 'main', branch: 'feature' },
      'Merged',
    ).events[0]!;
    expect(again).not.toHaveProperty('freed');
  });

  it('records them on a note from swarmupd that it merges nothing', () => {
    const { as, h } = withIndirectAndChild(MERGES);
    expect(h.verdict('1', 'approve', 'looks right').events[0]!.freed).toEqual(['T-0004']);
    const note = as(MERGE_ACTOR).noMerge('1', 'swarmupd merges nothing for T-0001').events[0]!;
    expect(note).toMatchObject({ no_merge: true, freed: ['T-0002'], freed_indirect: ['T-0003'] });
  });

  it('leaves a task freed by hand out of what the merge frees', () => {
    const { as, h, eng } = withIndirectAndChild(MERGES);
    h.verdict('1', 'approve', 'looks right');
    expect(eng.unblock('2', 'merged by hand').events[0]!.freed).toEqual(['T-0002', 'T-0003']);
    const merge = as(MERGE_ACTOR).recordMerge(
      '1',
      { commit: 'abc1234', into: 'main', branch: 'feature' },
      'Merged',
    ).events[0]!;
    expect(merge.freed).toEqual([]);
  });

  it('records every waiter on the approval where nothing waits for a merge', () => {
    const plain = withIndirectAndChild({});
    expect(plain.h.verdict('1', 'approve', 'ok').events[0]).toMatchObject({
      freed: ['T-0002', 'T-0004'],
      freed_indirect: ['T-0003'],
    });
    // The merge of an approval that already recorded its waiters, written on a machine where
    // swarmupd merges, does not count them again.
    const merging = new Workspace({
      cwd: plain.repo,
      env: plain.env,
      actor: MERGE_ACTOR,
      user: MERGES,
    });
    const merge = merging.recordMerge(
      '1',
      { commit: 'abc1234', into: 'main', branch: 'feature' },
      'Merged',
    ).events[0]!;
    expect(merge.freed).toEqual([]);
    expect(merge).not.toHaveProperty('freed_indirect');
  });

  /** A workspace on `s` that also sees a second root, `beta`, so its refs are `root/id`. */
  function withSecondRoot(
    s: ReturnType<typeof withIndirectAndChild>,
    actor: string,
    user: UserConfig,
  ): Workspace {
    const betaDir = gitRepo();
    initRoot(betaDir, { name: 'beta', human: 'human:dawid' });
    const env = { ...s.env, SWARMUP_ROOTS: betaDir } as NodeJS.ProcessEnv;
    const ws = new Workspace({ cwd: s.repo, env, actor, user });
    expect(ws.roots.map((r) => r.name).sort()).toEqual(['beta', 'test']);
    return ws;
  }

  it('does not count them again when the merging machine sees more roots than the reviewer', () => {
    // The reviewer sees one root and no merge setting: the approval holds bare ids.
    const plain = withIndirectAndChild({});
    expect(plain.h.verdict('1', 'approve', 'ok').events[0]).toMatchObject({
      freed: ['T-0002', 'T-0004'],
      freed_indirect: ['T-0003'],
    });
    const merge = withSecondRoot(plain, MERGE_ACTOR, MERGES).recordMerge(
      'test/T-0001',
      { commit: 'abc1234', into: 'main', branch: 'feature' },
      'Merged',
    ).events[0]!;
    expect(merge.freed).toEqual([]);
    expect(merge).not.toHaveProperty('freed_indirect');
  });

  it('does not count them again when the reviewer sees more roots than the merging machine', () => {
    const plain = withIndirectAndChild({});
    const reviewer = withSecondRoot(plain, 'human:dawid', {});
    expect(reviewer.verdict('test/T-0001', 'approve', 'ok').events[0]).toMatchObject({
      freed: ['test/T-0002', 'test/T-0004'],
      freed_indirect: ['test/T-0003'],
    });
    const merging = new Workspace({
      cwd: plain.repo,
      env: plain.env,
      actor: MERGE_ACTOR,
      user: MERGES,
    });
    const merge = merging.recordMerge(
      '1',
      { commit: 'abc1234', into: 'main', branch: 'feature' },
      'Merged',
    ).events[0]!;
    expect(merge.freed).toEqual([]);
    expect(merge).not.toHaveProperty('freed_indirect');
  });

  it('frees when the dependency closes without a review', () => {
    const { repo, env } = setup();
    const as = (actor: string) => new Workspace({ cwd: repo, env, actor, user: MERGES });
    const h = as('human:dawid');
    h.newTask({ title: 'Look it up', owner: 'claude:engineer' });
    h.newTask({ title: 'Needs it', blockedBy: ['1'] });
    const eng = as('claude:engineer');
    eng.start('1', 'plan');
    eng.done('1', 'found it');
    expect(h.view('2').unblocked).toBe(true);
  });
});
