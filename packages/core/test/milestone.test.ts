import { describe, expect, it } from 'vitest';
import {
  MERGE_ACTOR,
  OpsError,
  parsePlan,
  planBody,
  searchSources,
  Workspace,
} from '../src/index.js';
import type { OpsEvent, TaskView, UserConfig } from '../src/index.js';
import { setup } from './helpers.js';

/** A user config in which swarmupd merges approved work of the root `test`. */
const MERGES = { swarmupd: { merge: { test: { base: 'main' } } } } as UserConfig;

/** A plan event body with one-line items: `key owner [after]`. */
function plan(...rows: string[]): string {
  const items = rows.map((row) => {
    const [key, owner, after] = row.split(' ');
    const wait = after ? `\n    after: [${after}]` : '';
    return `  - key: ${key}\n    title: Item ${key}\n    owner: '${owner}'\n    estimate: 1h${wait}`;
  });
  return planBody(parsePlan(`items:\n${items.join('\n')}\n`));
}

function world(user: UserConfig = MERGES) {
  const { repo, env } = setup();
  const as = (actor: string) => new Workspace({ cwd: repo, env, actor, user });
  const h = as('human:dawid');
  const root = h.defaultRoot();
  /** Writes an event as the `swarmup plan` commands of step 2 will: straight to the task. */
  const write = (id: string, actor: string, type: string, extra: Partial<OpsEvent> = {}) =>
    root.appendEvent(id, { type, actor, at: new Date().toISOString(), body: '', ...extra });
  /** A task as `view`, `views` and the search index see it: they must agree. */
  const seen = (id: string): TaskView[] => {
    const merges = new Set(user === MERGES ? ['test'] : []);
    const found = searchSources(h.roots, Date.now(), undefined, merges)
      .tasks()
      .find(({ view: v }) => v.meta.id === id)!;
    return [h.view(id), h.views({ archived: true }).find((v) => v.meta.id === id)!, found.view];
  };
  return { as, h, root, write, seen };
}

/**
 * Milestone T-0001 with an approved plan of `build` (T-0002, claude:engineer) and `smoke`
 * (T-0003, codex:qa, after `build`), and their tasks created.
 */
function approvedMilestone(user: UserConfig = MERGES) {
  const w = world(user);
  const { as, h, write } = w;
  h.newTask({
    title: 'Desktop app ships on macOS',
    type: 'milestone',
    owner: 'claude:pm',
    doneWhen: ['A signed .dmg from CI installs on a clean Mac'],
  });
  const pm = as('claude:pm');
  pm.start('1', 'read the goal, write the plan');
  const body = plan('build claude:engineer', 'smoke codex:qa build');
  const proposal = write('T-0001', 'claude:pm', 'plan', { body });
  pm.review('1', 'T-0001: plan with 2 items, 2 h; approve it or send it back', 'human:dawid');
  const tasks = () => {
    h.newTask({
      title: 'Item build',
      owner: 'claude:engineer',
      parent: '1',
      planItem: 'T-0001#build',
      labels: ['milestone:T-0001'],
    });
    h.newTask({
      title: 'Item smoke',
      owner: 'codex:qa',
      parent: '1',
      planItem: 'T-0001#smoke',
      blockedBy: ['2'],
    });
  };
  const approve = () => write('T-0001', 'human:dawid', 'plan-approve', { plan: proposal.id, body });
  return { ...w, pm, proposal, body, approve, tasks };
}

/** Sends `id` for review naming a branch, and approves it: its merge is then open. */
function approveWork(w: ReturnType<typeof world>, id: string, actor: string, branch: string) {
  const agent = w.as(actor);
  agent.start(id, 'plan');
  agent.review(id, `abc1234 on branch ${branch}: the work, tests`, 'human:dawid');
  w.h.verdict(id, 'approve', 'looks right');
}

const merged = { commit: 'abc1234', into: 'main', branch: 'feature' };

describe('creating a milestone (AO-0110)', () => {
  it('refuses a milestone without a done-when line, and with more than one', () => {
    const { h } = world();
    const base = { title: 'Ship it', type: 'milestone', owner: 'claude:pm' };
    for (const doneWhen of [undefined, [], ['one', 'two']]) {
      let err: unknown;
      try {
        h.newTask({ ...base, doneWhen });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(OpsError);
      expect(err).toMatchObject({ code: 2, message: /done-when line/ });
    }
    expect(h.views()).toHaveLength(0);
    const meta = h.newTask({ ...base, doneWhen: ['CI builds a signed .dmg'] });
    expect(meta).toMatchObject({ type: 'milestone', done_when: ['CI builds a signed .dmg'] });
  });

  it('accepts a finding as a milestone only with one done-when line', () => {
    const { as, h } = world();
    const pm = as('claude:pm');
    const bare = pm.finding({ title: 'Ship on macOS', body: 'goal' }).meta;
    const checked = pm.finding({ title: 'Ship on Linux', doneWhen: ['The .deb installs'] }).meta;
    expect(() => h.retype(bare.id, 'milestone')).toThrow(/done-when line/);
    expect(h.retype(checked.id, 'milestone', '', { to: 'claude:pm' }).view.meta.type).toBe(
      'milestone',
    );
  });

  it('keeps `plan_item` and `review` in task.md', () => {
    const { h, root } = world();
    const meta = h.newTask({ title: 'x', planItem: 'T-0009#ci', review: 'codex:qa' });
    expect(root.readTask(meta.id).meta).toMatchObject({
      plan_item: 'T-0009#ci',
      review: 'codex:qa',
    });
    expect(() => h.newTask({ title: 'y', review: '*:qa' })).toThrow(/bad reviewer/);
  });
});

describe('a milestone and its plan in the workspace (AO-0110)', () => {
  it('refuses a verdict while a plan waits for approval', () => {
    const { h, approve } = approvedMilestone();
    expect(h.view('1')).toMatchObject({ status: 'needs-review', reviewer: 'human:dawid' });
    expect(h.view('1').plan!.pending).toMatchObject({ actor: 'claude:pm' });
    expect(() => h.verdict('1', 'approve', 'ok')).toThrow(/use swarmup plan approve T-0001/);
    expect(() => h.verdict('1', 'changes', 'no')).toThrow(/use swarmup plan reject T-0001/);
    expect(h.view('1').status).toBe('needs-review');
    approve();
    expect(h.view('1')).toMatchObject({ status: 'blocked', owner: '*:qa', reviewer: null });
  });

  it('still takes a verdict on a milestone without a pending plan', () => {
    const { as, h } = world();
    h.newTask({ title: 'Ship', type: 'milestone', owner: 'claude:pm', doneWhen: ['check'] });
    const pm = as('claude:pm');
    pm.start('1', 'plan');
    pm.review('1', 'T-0001: a question about the goal before any plan', 'human:dawid');
    expect(h.verdict('1', 'changes', 'narrow the goal').view.status).toBe('todo');
  });

  it('stays blocked until every key has a task and every child is closed', () => {
    const w = approvedMilestone({});
    const { as, h, seen, approve, tasks } = w;
    approve();
    for (const v of seen('T-0001')) {
      expect(v).toMatchObject({
        status: 'blocked',
        unblocked: false,
        planMissing: ['build', 'smoke'],
      });
    }
    tasks();
    const qa = as('codex:qa');
    for (const v of seen('T-0001')) {
      expect(v.planMissing).toBeUndefined();
      expect(v).toMatchObject({ unblocked: false, planOpen: ['T-0002', 'T-0003'] });
    }
    expect(qa.next()).toBeUndefined();
    expect(() => qa.claim('1')).toThrow(/not claimable/);

    const eng = as('claude:engineer');
    eng.start('2', 'plan');
    eng.done('2', 'built');
    expect(h.view('1')).toMatchObject({ unblocked: false, planOpen: ['T-0003'] });
    expect(qa.next()?.meta.id).toBe('T-0003');
    qa.start('3', 'plan');
    qa.done('3', 'smoke check passed');

    for (const v of seen('T-0001')) {
      expect(v).toMatchObject({ status: 'blocked', unblocked: true });
      expect(v.planOpen).toBeUndefined();
    }
    // The checker's claim frees the milestone for the check.
    expect(qa.next()?.meta.id).toBe('T-0001');
    const claim = qa.claim('1');
    expect(claim.events.map((e) => [e.type, e.body])).toEqual([
      ['unblock', 'Plan tasks closed'],
      ['claim', ''],
    ]);
    expect(claim.view).toMatchObject({ status: 'claimed', claimedBy: 'codex:qa' });
    qa.start('1', 'run the check');
    expect(qa.done('1', 'check passed: the .dmg installs').view).toMatchObject({
      status: 'done',
      waitsOnPlan: false,
    });
  });

  it("stays blocked until its last child's merge event", () => {
    const w = approvedMilestone();
    const { as, h, seen, approve, tasks } = w;
    approve();
    tasks();
    approveWork(w, '2', 'claude:engineer', 'feature');
    as(MERGE_ACTOR).recordMerge('2', merged, 'Merged');
    approveWork(w, '3', 'codex:qa', 'smoke');
    // Every child is done, and the last one's approved work is not in the base yet.
    expect(h.view('3')).toMatchObject({ status: 'done', awaitsMerge: true });
    for (const v of seen('T-0001')) {
      expect(v).toMatchObject({ status: 'blocked', unblocked: false, mergeWait: ['T-0003'] });
      expect(v.planOpen).toBeUndefined();
    }
    expect(h.mergeWaited()).toEqual(['test/T-0003']);
    const qa = as('codex:qa');
    expect(qa.next()).toBeUndefined();
    expect(() => qa.claim('1')).toThrow(/not claimable/);

    as(MERGE_ACTOR).recordMerge('3', { ...merged, branch: 'smoke' }, 'Merged');
    for (const v of seen('T-0001')) {
      expect(v.unblocked).toBe(true);
      expect(v.mergeWait).toBeUndefined();
    }
    expect(h.mergeWaited()).toEqual([]);
    expect(qa.next()?.meta.id).toBe('T-0001');
  });

  it("stays blocked until its last child's no-merge note", () => {
    const w = approvedMilestone();
    const { as, h, approve, tasks } = w;
    approve();
    tasks();
    approveWork(w, '2', 'claude:engineer', 'feature');
    as(MERGE_ACTOR).noMerge('2', 'swarmupd merges nothing for T-0002');
    approveWork(w, '3', 'codex:qa', 'smoke');
    expect(h.view('1')).toMatchObject({ unblocked: false, mergeWait: ['T-0003'] });
    // A note that the merge failed settles nothing.
    as(MERGE_ACTOR).comment('3', 'swarmupd could not merge abc1234 on branch smoke', 'human:dawid');
    expect(h.view('1')).toMatchObject({ unblocked: false, mergeWait: ['T-0003'] });
    as(MERGE_ACTOR).noMerge('3', 'swarmupd merges nothing for T-0003');
    expect(h.view('1').unblocked).toBe(true);
    expect(as('codex:qa').claim('1').view.status).toBe('claimed');
  });

  it('frees at the last approval where swarmupd merges nothing on this machine', () => {
    const w = approvedMilestone({});
    w.approve();
    w.tasks();
    approveWork(w, '2', 'claude:engineer', 'feature');
    approveWork(w, '3', 'codex:qa', 'smoke');
    expect(w.h.view('1').unblocked).toBe(true);
  });

  it('blocks again when a child is reopened', () => {
    const w = approvedMilestone({});
    const { as, h, seen, approve, tasks } = w;
    approve();
    tasks();
    as('claude:engineer').start('2', 'plan');
    as('claude:engineer').done('2', 'built');
    as('codex:qa').start('3', 'plan');
    as('codex:qa').done('3', 'passed');
    expect(h.view('1').unblocked).toBe(true);
    h.reopen('3', 'the smoke check missed the updater');
    for (const v of seen('T-0001')) {
      expect(v).toMatchObject({ status: 'blocked', unblocked: false, planOpen: ['T-0003'] });
    }
    expect(as('codex:qa').next()?.meta.id).toBe('T-0003');
    expect(() => as('codex:qa').claim('1')).toThrow(/not claimable/);
  });

  it('blocks an item again when its dependency is reopened', () => {
    const w = approvedMilestone({});
    const { as, h, write, approve, tasks } = w;
    approve();
    tasks();
    const eng = as('claude:engineer');
    const qa = as('codex:qa');
    eng.start('2', 'plan');
    eng.done('2', 'built');
    expect(h.view('3').unblocked).toBe(true);
    // Created with `blocked_by` every `after` task, so the reopened one blocks it again.
    h.reopen('2', 'the build is unsigned');
    expect(h.view('3')).toMatchObject({ status: 'blocked', unblocked: false });
    expect(qa.next()).toBeUndefined();
    expect(() => qa.claim('3')).toThrow(/not claimable/);
    expect(h.view('1')).toMatchObject({ unblocked: false, planOpen: ['T-0002', 'T-0003'] });
    eng.start('2', 'sign it');
    eng.done('2', 'signed');
    qa.start('3', 'plan');
    qa.done('3', 'passed');
    expect(h.view('1').unblocked).toBe(true);

    // A closed item comes back with `to` and `on`: blocked on its dependency in the same event.
    h.reopen('2', 'still unsigned on arm64');
    write('T-0003', 'human:dawid', 'reopen', { to: 'codex:qa', on: ['T-0002'] });
    expect(h.view('3')).toMatchObject({ status: 'blocked', unblocked: false, owner: 'codex:qa' });
    expect(() => qa.claim('3')).toThrow(/not claimable/);
    eng.start('2', 'sign arm64');
    eng.done('2', 'signed');
    expect(h.view('3').unblocked).toBe(true);
    expect(qa.claim('3').view.status).toBe('claimed');
  });

  it('holds a task until the change of a later approval reaches it', () => {
    const w = approvedMilestone({});
    const { as, h, seen, write, approve, tasks } = w;
    const first = approve();
    tasks();
    const body = plan('build codex:engineer', 'smoke codex:qa build');
    const change = write('T-0001', 'claude:pm', 'plan', { base: first.id, body });
    expect(h.view('1')).toMatchObject({ status: 'blocked', waitsOnPlan: true });
    expect(h.view('2').planHold).toBeUndefined();
    // The process dies after the approval and before the key's event.
    const second = write('T-0001', 'human:dawid', 'plan-approve', { plan: change.id, body });
    for (const v of seen('T-0002')) expect(v.planHold).toBe(second.id);
    for (const v of seen('T-0001')) expect(v.planUnapplied).toEqual(['build']);
    const eng = as('claude:engineer');
    expect(eng.next()).toBeUndefined();
    expect(eng.queue()).toEqual([]);
    expect(() => eng.claim('2')).toThrow(
      "T-0002 waits for T-0001's plan to apply; run swarmup plan apply T-0001",
    );
    expect(() => eng.start('2', 'plan')).toThrow(/waits for T-0001's plan to apply/);
    expect(h.view('2').status).toBe('todo');

    // `swarmup plan apply` writes the key's one event, with its marker.
    write('T-0002', 'human:dawid', 'handoff', {
      to: 'codex:engineer',
      plan_apply: `${second.id}#build`,
      body: 'T-0001: plan change',
    });
    for (const v of seen('T-0002')) expect(v.planHold).toBeUndefined();
    expect(h.view('1').planUnapplied).toBeUndefined();
    expect(() => eng.claim('2')).toThrow(/owned by codex:engineer/);
    expect(as('codex:engineer').claim('2').view.status).toBe('claimed');
  });
});

describe('the reviewer of a plan item as the fallback of `swarmup review` (AO-0110)', () => {
  function task(extra: { labels?: string[]; review?: string } = { review: 'codex:qa' }) {
    const w = world({});
    const meta = w.h.newTask({ title: 'Build it', owner: 'claude:engineer', ...extra });
    const eng = w.as('claude:engineer');
    eng.start(meta.id, 'plan');
    return { ...w, eng, id: meta.id };
  }

  it('sends a review without --to to the reviewer in task.md', () => {
    const { eng, id } = task();
    expect(eng.review(id, 'abc1234 on branch b: done').view.reviewer).toBe('codex:qa');
  });

  it('goes to the person without one, as before', () => {
    const { eng, id } = task({});
    expect(eng.review(id, 'abc1234 on branch b: done').view.reviewer).toBe('human:dawid');
  });

  it("reads a delegation's reviewer first", () => {
    const { h, as, id } = task();
    h.delegate(id, 'claude:engineer', { review: 'other:qa' });
    const eng = as('claude:engineer');
    eng.start(id, 'plan');
    expect(eng.review(id, 'abc1234 on branch b: done').view.reviewer).toBe('other:qa');
  });

  it('keeps --human and the type or label route first', () => {
    const plain = task();
    const sent = plain.eng.review(plain.id, 'abc1234 on branch b: done', undefined, undefined, {
      human: true,
    });
    expect(sent.view.reviewer).toBe('human:dawid');
    const money = task({ review: 'codex:qa', labels: ['billing'] });
    expect(money.eng.review(money.id, 'abc1234 on branch b: done').view.reviewer).toBe(
      'human:dawid',
    );
  });

  it('refuses a reviewer of the same provider as the author', () => {
    const { h, as, id } = task();
    h.handoff(id, 'codex:engineer', 'yours');
    const eng = as('codex:engineer');
    eng.start(id, 'plan');
    expect(() => eng.review(id, 'abc1234 on branch b: done')).toThrow(/another provider/);
  });
});
