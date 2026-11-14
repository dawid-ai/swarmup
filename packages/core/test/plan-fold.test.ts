import { describe, expect, it } from 'vitest';
import { derive, fold, isClaimable, parsePlan, planBody, planLookup, ulid } from '../src/index.js';
import type { OpsEvent, TaskMeta, TaskState } from '../src/index.js';

const T0 = Date.parse('2026-11-14T10:00:00Z');
const NOW = T0 + 24 * 60 * 60_000;

const milestone: TaskMeta = {
  id: 'T-0001',
  title: 'Desktop app ships on macOS',
  type: 'milestone',
  priority: 'p2',
  owner: 'claude:pm',
  done_when: ['A signed .dmg from CI installs on a clean Mac'],
  created_by: 'human:dawid',
  created_at: new Date(T0).toISOString(),
};

function ev(minute: number, type: string, actor: string, extra: Partial<OpsEvent> = {}): OpsEvent {
  const ms = T0 + minute * 60_000;
  return { id: ulid(ms), type, actor, at: new Date(ms).toISOString(), body: '', ...extra };
}

/** A plan event body with one-line items: `key owner [after,after|-] [for]`. */
function plan(...rows: string[]): string {
  const items = rows.map((row) => {
    const [key, owner, after, serves] = row.split(' ');
    const wait =
      (after && after !== '-' ? `\n    after: [${after}]` : '') +
      (serves ? `\n    for: ${serves}` : '');
    return `  - key: ${key}\n    title: Item ${key}\n    owner: '${owner}'\n    estimate: 1h${wait}`;
  });
  return planBody(parsePlan(`items:\n${items.join('\n')}\n`));
}

/** The milestone claimed by the PM, with a first proposal sent to the person. */
function proposed(...rows: string[]): OpsEvent[] {
  return [
    ev(1, 'claim', 'claude:pm'),
    ev(2, 'start', 'claude:pm'),
    ev(3, 'plan', 'claude:pm', { body: plan(...rows) }),
    ev(4, 'review', 'claude:pm', { to: 'human:dawid', body: 'Plan for T-0001' }),
  ];
}

/** `proposed`, then the person's approval of it. */
function approved(...rows: string[]): OpsEvent[] {
  const events = proposed(...rows);
  return [
    ...events,
    ev(5, 'plan-approve', 'human:dawid', { plan: events[2]!.id, body: plan(...rows) }),
  ];
}

const keys = (s: TaskState): string[] => s.plan!.items.map((i) => i.key);

describe('the fold of a plan (AO-0110, "How the plan folds")', () => {
  it('keeps a task without plan events free of a plan', () => {
    const s = fold(milestone, [ev(1, 'claim', 'claude:pm')]);
    expect(s).toMatchObject({ plan: null, waitsOnPlan: false, planApplied: [] });
  });

  it('holds a first proposal as pending and folds no state from it', () => {
    const events = proposed('apple human:dawid', 'ci *:engineer apple');
    const before = fold(milestone, events.slice(0, 2));
    const s = fold(milestone, events.slice(0, 3));
    expect(s).toMatchObject({ status: before.status, owner: 'claude:pm', waitsOnPlan: false });
    expect(s.plan).toMatchObject({
      items: [],
      approval: null,
      head: null,
      planner: null,
      usedKeys: [],
      pending: { event: events[2]!.id, actor: 'claude:pm', stale: false },
    });
    // The review that `swarmup plan propose` writes with it sends it to the person.
    expect(fold(milestone, events)).toMatchObject({
      status: 'needs-review',
      reviewer: 'human:dawid',
    });
  });

  it('gives the milestone to the checker and blocks it on the first approval', () => {
    const s = fold(milestone, approved('apple human:dawid', 'ci *:engineer apple'));
    expect(s).toMatchObject({
      status: 'blocked',
      owner: '*:qa',
      reviewer: null,
      claimedBy: null,
      waitsOnPlan: true,
      blockedOn: [],
      waitingOn: null,
    });
    expect(s.plan).toMatchObject({
      planner: 'claude:pm',
      pending: null,
      usedKeys: ['apple', 'ci'],
      diff: [],
    });
    expect(s.plan!.approval).toBe(s.plan!.head);
    expect(s.plan!.items).toEqual([
      {
        key: 'apple',
        title: 'Item apple',
        owner: 'human:dawid',
        estimate: '1h',
        origin: 'approve',
      },
      {
        key: 'ci',
        title: 'Item ci',
        owner: '*:engineer',
        estimate: '1h',
        after: ['apple'],
        origin: 'approve',
      },
    ]);
  });

  it('folds a rejection of the first proposal like a changes verdict', () => {
    const events = proposed('ci *:engineer');
    const s = fold(milestone, [
      ...events,
      ev(5, 'plan-reject', 'human:dawid', { plan: events[2]!.id, body: 'split ci' }),
    ]);
    expect(s).toMatchObject({ status: 'todo', owner: 'claude:pm', reviewer: null });
    // Keys of a proposal that was sent back are not used, so the next one can keep them.
    expect(s.plan).toMatchObject({ pending: null, usedKeys: [], approval: null });
  });

  it('adds the items of an amendment to the effective plan and blocks the milestone again', () => {
    const events = [
      ...approved('ci *:engineer'),
      // Every plan task closed, and the checker holds the milestone for the check.
      ev(10, 'unblock', 'codex:qa'),
      ev(11, 'claim', 'codex:qa'),
      ev(12, 'start', 'codex:qa'),
    ];
    const checking = fold(milestone, events);
    expect(checking).toMatchObject({ status: 'in-progress', claimedBy: 'codex:qa' });
    expect(checking.waitsOnPlan).toBe(true);
    const amend = ev(13, 'plan-amend', 'codex:qa', {
      plan_kind: 'fix',
      body: plan('fix1 *:engineer'),
    });
    const s = fold(milestone, [...events, amend]);
    // The amendment ends the checker's claim.
    expect(s).toMatchObject({ status: 'blocked', claimedBy: null, waitsOnPlan: true });
    expect(s.owner).toBe('*:qa');
    expect(keys(s)).toEqual(['ci', 'fix1']);
    expect(s.plan!.items[1]).toMatchObject({ key: 'fix1', origin: 'fix' });
    expect(s.plan).toMatchObject({ head: amend.id, usedKeys: ['ci', 'fix1'] });
    expect(s.plan!.approval).not.toBe(amend.id);
  });

  it('marks the items of a subtask amendment, and skips an amendment before any approval', () => {
    // `ulid` never goes back, so events are made in the order they happened.
    const amend = (): OpsEvent =>
      ev(13, 'plan-amend', 'claude:pm', {
        plan_kind: 'subtask',
        body: plan('lint *:engineer - ci'),
      });
    const s = fold(milestone, [...approved('ci *:engineer'), amend()]);
    expect(s.plan!.items[1]).toMatchObject({ key: 'lint', origin: 'subtask', for: 'ci' });
    const early = fold(milestone, [...proposed('ci *:engineer'), amend()]);
    expect(early).toMatchObject({ status: 'needs-review', waitsOnPlan: false });
    expect(early.plan).toMatchObject({ items: [], usedKeys: [] });
  });

  it('replaces the effective plan on a later approval and names the planner of that plan', () => {
    const first = approved('apple human:dawid', 'ci claude:engineer apple', 'smoke *:qa ci');
    const amend = ev(6, 'plan-amend', 'claude:pm', {
      plan_kind: 'subtask',
      body: plan('lint *:engineer'),
    });
    const change = ev(7, 'plan', 'codex:pm', {
      base: amend.id,
      body: plan('ci codex:engineer', 'smoke *:qa ci', 'lint *:engineer', 'notary *:engineer ci'),
    });
    const before = fold(milestone, [...first, amend, change]);
    // A change proposal leaves the milestone blocked on the plan it has.
    expect(before).toMatchObject({ status: 'blocked', waitsOnPlan: true });
    expect(keys(before)).toEqual(['apple', 'ci', 'smoke', 'lint']);
    expect(before.plan!.pending).toEqual({
      event: change.id,
      actor: 'codex:pm',
      base: amend.id,
      stale: false,
    });

    const approve = ev(8, 'plan-approve', 'human:dawid', { plan: change.id, body: change.body });
    const s = fold(milestone, [...first, amend, change, approve]);
    // Replaced, not merged: `apple` is gone, and the amended `lint` is now an approved item.
    expect(keys(s)).toEqual(['ci', 'smoke', 'lint', 'notary']);
    expect(s.plan!.items.every((i) => i.origin === 'approve')).toBe(true);
    expect(s.plan).toMatchObject({
      approval: approve.id,
      head: approve.id,
      planner: 'codex:pm',
      pending: null,
      usedKeys: ['apple', 'ci', 'smoke', 'lint', 'notary'],
    });
    // `apple` removed; `ci` has another owner and no `after`. `smoke` and `lint` are unchanged,
    // and `notary` is new: its task's creation is its one write.
    expect(s.plan!.diff).toEqual(['apple', 'ci']);
    // The checker keeps the milestone: only the first approval assigns it.
    expect(s).toMatchObject({ status: 'blocked', owner: '*:qa', waitsOnPlan: true });
  });

  it('leaves a key whose estimate alone changed out of the diff', () => {
    const first = approved('ci *:engineer', 'smoke *:qa ci');
    const body = plan('ci *:engineer', 'smoke *:qa ci').replace('estimate: 1h', 'estimate: 3h');
    const change = ev(7, 'plan', 'claude:pm', { base: first[4]!.id, body });
    const approve = ev(8, 'plan-approve', 'human:dawid', { plan: change.id, body });
    const s = fold(milestone, [...first, change, approve]);
    expect(s.plan!.items[0]!.estimate).toBe('3h');
    expect(s.plan!.diff).toEqual([]);
  });

  it('puts a key whose `after` changed in the diff', () => {
    const first = approved('a *:engineer', 'b *:engineer', 'c *:engineer a');
    const body = plan('a *:engineer', 'b *:engineer', 'c *:engineer b');
    const change = ev(7, 'plan', 'claude:pm', { base: first[4]!.id, body });
    const approve = ev(8, 'plan-approve', 'human:dawid', { plan: change.id, body });
    expect(fold(milestone, [...first, change, approve]).plan!.diff).toEqual(['c']);
  });

  it('flags a change proposal whose base the effective plan has moved past', () => {
    const first = approved('ci *:engineer');
    const change = ev(6, 'plan', 'claude:pm', {
      base: first[4]!.id,
      body: plan('ci codex:engineer'),
    });
    expect(fold(milestone, [...first, change]).plan!.pending).toMatchObject({ stale: false });
    // An amendment applied after the proposal was written: approving would drop `fix1`.
    const amend = ev(7, 'plan-amend', 'codex:qa', {
      plan_kind: 'fix',
      body: plan('fix1 *:engineer'),
    });
    const s = fold(milestone, [...first, change, amend]);
    expect(s.plan!.pending).toMatchObject({ event: change.id, base: first[4]!.id, stale: true });
  });

  it('keeps the latest uncited proposal as the pending one', () => {
    const first = approved('ci *:engineer');
    const one = ev(6, 'plan', 'claude:pm', { base: first[4]!.id, body: plan('ci codex:engineer') });
    const two = ev(7, 'plan', 'claude:pm', { base: first[4]!.id, body: plan('ci *:qa') });
    expect(fold(milestone, [...first, one, two]).plan!.pending!.event).toBe(two.id);
    const reject = ev(8, 'plan-reject', 'human:dawid', { plan: two.id, body: 'no' });
    const s = fold(milestone, [...first, one, two, reject]);
    expect(s.plan!.pending!.event).toBe(one.id);
    // A rejected change proposal folds no state: a `todo` milestone would be free while its
    // children are open.
    expect(s).toMatchObject({ status: 'blocked', owner: '*:qa', waitsOnPlan: true });
    expect(keys(s)).toEqual(['ci']);
  });

  it('skips a plan event whose body holds no plan', () => {
    const events = proposed('ci *:engineer');
    const broken = ev(5, 'plan-approve', 'human:dawid', { plan: events[2]!.id, body: 'approved' });
    const s = fold(milestone, [...events, broken]);
    expect(s).toMatchObject({ status: 'needs-review', owner: 'claude:pm', waitsOnPlan: false });
    expect(s.plan).toMatchObject({ approval: null, items: [] });
  });

  it('stops waiting on the plan when the milestone closes, and waits again on a reopen', () => {
    const events = approved('ci *:engineer');
    const done = fold(milestone, [...events, ev(10, 'done', 'codex:qa')]);
    expect(done).toMatchObject({ status: 'done', waitsOnPlan: false });
    const parked = fold(milestone, [...events, ev(10, 'park', 'human:dawid')]);
    expect(parked).toMatchObject({ status: 'parked', waitsOnPlan: false });
    for (const close of ['done', 'park']) {
      const s = fold(milestone, [
        ...events,
        ev(10, close, 'human:dawid'),
        ev(11, 'reopen', 'human:dawid'),
      ]);
      expect(s).toMatchObject({ status: 'blocked', waitsOnPlan: true, owner: '*:qa' });
    }
  });

  it('reopens a milestone without an effective plan as any task', () => {
    const s = fold(milestone, [
      ...proposed('ci *:engineer'),
      ev(10, 'park', 'human:dawid'),
      ev(11, 'reopen', 'human:dawid'),
    ]);
    expect(s).toMatchObject({ status: 'todo', waitsOnPlan: false });
  });

  it('records a skipped key of the effective approval from a comment on the milestone', () => {
    const first = approved('ci claude:engineer', 'smoke *:qa');
    const body = plan('ci codex:engineer');
    const change = ev(7, 'plan', 'claude:pm', { base: first[4]!.id, body });
    const approve = ev(8, 'plan-approve', 'human:dawid', { plan: change.id, body });
    const skip = ev(9, 'comment', 'human:dawid', {
      plan_apply: `${approve.id}#smoke`,
      plan_skip: 'closed',
      body: 'smoke: closed before the change applied',
    });
    const old = ev(9, 'comment', 'human:dawid', {
      plan_apply: `${first[4]!.id}#ci`,
      plan_skip: 'closed',
    });
    const s = fold(milestone, [...first, change, approve, skip, old]);
    expect(s.plan).toMatchObject({ diff: ['ci', 'smoke'], skipped: ['smoke'] });
    // A skip marker is not a change that reached the milestone itself.
    expect(s.planApplied).toEqual([]);
  });
});

const task: TaskMeta = {
  id: 'T-0003',
  title: 'Build and sign the .dmg in CI',
  type: 'task',
  priority: 'p2',
  owner: '*:engineer',
  parent: 'T-0001',
  plan_item: 'T-0001#ci',
  blocked_by: ['T-0002'],
  created_by: 'human:dawid',
  created_at: new Date(T0).toISOString(),
};

describe('handoff, delegate and reopen with `to` and `on` (AO-0110)', () => {
  it('blocks the task on `on` in the same event as the owner change', () => {
    const marker = { plan_apply: 'APPROVAL#ci' };
    for (const type of ['handoff', 'delegate']) {
      const e = ev(1, type, 'human:dawid', { to: 'codex:engineer', on: ['T-0005'], ...marker });
      const s = fold({ ...task, blocked_by: undefined }, [e]);
      expect(s).toMatchObject({
        status: 'blocked',
        owner: 'codex:engineer',
        blockedOn: ['T-0005'],
        waitEvent: e.id,
        waitingOn: null,
        todoSince: null,
        planApplied: ['APPROVAL#ci'],
      });
    }
  });

  it('replaces the old dependencies with `on`', () => {
    const s = fold(task, [
      ev(1, 'handoff', 'human:dawid', { to: 'codex:engineer', on: ['T-0009'] }),
    ]);
    expect(s).toMatchObject({ status: 'blocked', blockedOn: ['T-0009'] });
  });

  it('folds a handoff or delegate without `on`, or with an empty one, as before', () => {
    for (const type of ['handoff', 'delegate']) {
      for (const on of [undefined, []]) {
        const s = fold(task, [ev(1, type, 'human:dawid', { to: 'codex:engineer', on })]);
        expect(s).toMatchObject({ status: 'todo', owner: 'codex:engineer', blockedOn: [] });
      }
    }
  });

  it('ends a claim and keeps a delegation with `on`', () => {
    const s = fold({ ...task, blocked_by: undefined }, [
      ev(1, 'claim', 'claude:engineer'),
      ev(2, 'delegate', 'human:dawid', { to: 'codex:engineer', review: 'claude:qa', on: ['T-2'] }),
    ]);
    expect(s).toMatchObject({ status: 'blocked', claimedBy: null, blockedOn: ['T-2'] });
    expect(s.delegation).toMatchObject({ to: 'codex:engineer', review: 'claude:qa' });
  });

  it('reopens a plan task under its plan owner, blocked on its dependencies', () => {
    const closed = [
      ev(1, 'unblock', 'claude:engineer'),
      ev(2, 'claim', 'claude:engineer'),
      ev(3, 'start', 'claude:engineer'),
      ev(4, 'done', 'claude:engineer'),
    ];
    expect(fold(task, closed)).toMatchObject({ status: 'done', blockedOn: [] });
    const reopen = ev(5, 'reopen', 'human:dawid', { to: 'codex:engineer', on: ['T-0002'] });
    expect(fold(task, [...closed, reopen])).toMatchObject({
      status: 'blocked',
      owner: 'codex:engineer',
      blockedOn: ['T-0002'],
      claimedBy: null,
    });
    // With `to` alone, the owner changes and the task is free.
    const free = ev(5, 'reopen', 'human:dawid', { to: 'codex:engineer' });
    expect(fold(task, [...closed, free])).toMatchObject({
      status: 'todo',
      owner: 'codex:engineer',
    });
  });

  it('reopens without `to` and `on` as before', () => {
    const s = fold(task, [ev(1, 'park', 'human:dawid'), ev(2, 'reopen', 'human:dawid')]);
    expect(s).toMatchObject({ status: 'todo', owner: '*:engineer', blockedOn: [] });
  });

  it('does not block a closed task with `on`', () => {
    const s = fold(task, [
      ev(1, 'park', 'human:dawid'),
      ev(2, 'handoff', 'human:dawid', { to: 'codex:engineer', on: ['T-0002'] }),
    ]);
    expect(s).toMatchObject({ status: 'parked', blockedOn: [] });
  });
});

/** A child of the milestone for plan key `key`, with `events`. */
function child(n: number, key: string | undefined, events: OpsEvent[] = []): TaskState {
  const meta: TaskMeta = {
    id: `T-000${n}`,
    title: `Item ${key ?? n}`,
    type: 'task',
    priority: 'p2',
    owner: 'claude:engineer',
    parent: 'T-0001',
    ...(key ? { plan_item: `T-0001#${key}` } : {}),
    created_by: 'human:dawid',
    created_at: new Date(T0).toISOString(),
  };
  return fold(meta, events);
}

const closed = (minute = 20): OpsEvent[] => [
  ev(minute, 'claim', 'claude:engineer'),
  ev(minute + 1, 'start', 'claude:engineer'),
  ev(minute + 2, 'done', 'claude:engineer'),
];

/** The view of `state` among `live` tasks, with `archived` ones and `merging` awaiting a merge. */
function view(
  state: TaskState,
  live: TaskState[],
  opts: { archived?: TaskState[]; merging?: string[] } = {},
) {
  const all = [state, ...live.filter((s) => s !== state)];
  const status = new Map(
    [...all, ...(opts.archived ?? [])].map((s) => [s.meta.id, s.status] as const),
  );
  return derive(
    state,
    'test',
    NOW,
    (id) => status.get(id),
    (id) => (opts.merging ?? []).includes(id),
    planLookup(all, () => opts.archived ?? []),
  );
}

describe('the view of a milestone that waits on its plan (AO-0110, "The milestone\'s state")', () => {
  const ms = fold(milestone, approved('apple human:dawid', 'ci *:engineer apple'));

  it('stays blocked while a key of the effective plan has no task', () => {
    const v = view(ms, [child(2, 'apple', closed())]);
    expect(v).toMatchObject({ status: 'blocked', unblocked: false, planMissing: ['ci'] });
    expect(isClaimable(v)).toBe(false);
    expect(view(ms, [])).toMatchObject({ planMissing: ['apple', 'ci'], unblocked: false });
  });

  it('stays blocked while a child is open, and frees when every child is done or parked', () => {
    const apple = child(2, 'apple', closed());
    const open = view(ms, [apple, child(3, 'ci')]);
    expect(open).toMatchObject({ status: 'blocked', unblocked: false, planOpen: ['T-0003'] });
    expect(open.planMissing).toBeUndefined();
    const v = view(ms, [apple, child(3, 'ci', [ev(30, 'park', 'human:dawid')])]);
    expect(v).toMatchObject({ status: 'blocked', unblocked: true });
    expect(v.planOpen).toBeUndefined();
    expect(isClaimable(v)).toBe(true);
  });

  it('counts a child that is no plan item: any open task under the milestone blocks it', () => {
    const kids = [child(2, 'apple', closed()), child(3, 'ci', closed())];
    expect(view(ms, [...kids, child(4, undefined)])).toMatchObject({
      unblocked: false,
      planOpen: ['T-0004'],
    });
    expect(view(ms, [...kids, child(4, undefined, closed())]).unblocked).toBe(true);
  });

  it('counts a done child as open until its merge wait settles', () => {
    const kids = [child(2, 'apple', closed()), child(3, 'ci', closed())];
    const v = view(ms, kids, { merging: ['T-0003'] });
    expect(v).toMatchObject({ status: 'blocked', unblocked: false, mergeWait: ['T-0003'] });
    expect(isClaimable(v)).toBe(false);
    const merged = view(ms, kids);
    expect(merged.unblocked).toBe(true);
    expect(merged.mergeWait).toBeUndefined();
  });

  it('never waits for the merge of a parked child', () => {
    const parked = child(3, 'ci', [ev(30, 'park', 'human:dawid')]);
    const v = view(ms, [child(2, 'apple', closed()), parked], { merging: ['T-0003'] });
    expect(v.unblocked).toBe(true);
  });

  it('blocks again when a child is reopened', () => {
    const apple = child(2, 'apple', closed());
    const back = child(3, 'ci', [...closed(), ev(40, 'reopen', 'human:dawid')]);
    expect(view(ms, [apple, back])).toMatchObject({ unblocked: false, planOpen: ['T-0003'] });
    // Also after the checker's claim freed the milestone and then released it.
    const released = fold(milestone, [
      ...approved('apple human:dawid', 'ci *:engineer apple'),
      ev(30, 'unblock', 'codex:qa'),
      ev(31, 'claim', 'codex:qa', { token: 'c' }),
      ev(32, 'release', 'codex:qa', { holder: 'c' }),
    ]);
    expect(released).toMatchObject({ status: 'todo', waitsOnPlan: true });
    const v = view(released, [apple, back]);
    expect(v).toMatchObject({ status: 'blocked', unblocked: false, planOpen: ['T-0003'] });
    expect(isClaimable(v)).toBe(false);
    const free = view(released, [apple, child(3, 'ci', closed())]);
    expect(free.status).toBe('todo');
    expect(isClaimable(free)).toBe(true);
  });

  it('finds the task of a key in the archive: it is closed, not missing', () => {
    const v = view(ms, [child(2, 'apple', closed())], { archived: [child(3, 'ci', closed())] });
    expect(v.unblocked).toBe(true);
    expect(v.planMissing).toBeUndefined();
  });

  it('keeps a question or a block on the milestone: closed children do not free it', () => {
    const asked = fold(milestone, [
      ...approved('ci *:engineer'),
      ev(30, 'unblock', 'codex:qa'),
      ev(31, 'claim', 'codex:qa'),
      ev(32, 'ask', 'codex:qa', { to: 'claude:pm', body: 'third failed check' }),
    ]);
    const v = view(asked, [child(3, 'ci', closed())]);
    expect(v).toMatchObject({ status: 'blocked', unblocked: false, waitingOn: 'claude:pm' });
  });

  it('stays blocked when the dependency of a `block --on` closes while the plan is unsettled', () => {
    const blocked = fold(milestone, [
      ...approved('apple human:dawid', 'ci *:engineer apple'),
      ev(30, 'unblock', 'codex:qa'),
      ev(31, 'claim', 'codex:qa'),
      ev(32, 'block', 'codex:qa', { on: ['T-0009'], body: 'needs the CI runner' }),
    ]);
    expect(blocked).toMatchObject({ status: 'blocked', blockedOn: ['T-0009'], waitsOnPlan: true });
    // The dependency is no child of the milestone.
    const dep = (events: OpsEvent[]): TaskState =>
      fold({ ...child(9, undefined).meta, parent: undefined }, events);
    const apple = child(2, 'apple', closed());
    const ci = child(3, 'ci', closed());
    const back = child(3, 'ci', [...closed(), ev(40, 'reopen', 'human:dawid')]);

    // The block's own wait holds while the dependency is open.
    expect(view(blocked, [apple, ci, dep([])]).unblocked).toBe(false);
    // The dependency closed: an open, a reopened, a missing or a merging child still holds it.
    const done = dep(closed());
    for (const kids of [[apple, child(3, 'ci')], [apple, back], [apple]]) {
      const v = view(blocked, [...kids, done]);
      expect(v).toMatchObject({ status: 'blocked', unblocked: false, blockedOn: ['T-0009'] });
      expect(isClaimable(v)).toBe(false);
    }
    expect(view(blocked, [apple, back, done]).planOpen).toEqual(['T-0003']);
    const merging = view(blocked, [apple, ci, done], { merging: ['T-0003'] });
    expect(merging.unblocked).toBe(false);
    expect(isClaimable(merging)).toBe(false);
    // Dependency closed and plan settled: free.
    const free = view(blocked, [apple, ci, done]);
    expect(free).toMatchObject({ status: 'blocked', unblocked: true });
    expect(isClaimable(free)).toBe(true);
  });

  it('runs neither plan rule without the lookups', () => {
    const v = derive(ms, 'test', NOW, () => undefined);
    expect(v).toMatchObject({ status: 'blocked', unblocked: false });
    expect(v.planMissing).toBeUndefined();
  });
});

describe('an incomplete application and `planHold` (AO-0110, "Locks and the claim guard")', () => {
  const first = approved('apple human:dawid', 'ci claude:engineer apple', 'smoke *:qa ci');
  // `apple` is removed, `ci` changes owner and loses its `after`, `smoke` stays.
  const body = plan('ci codex:engineer', 'smoke *:qa ci');
  const change = ev(7, 'plan', 'claude:pm', { base: first[4]!.id, body });
  const approve = ev(8, 'plan-approve', 'human:dawid', { plan: change.id, body });
  const ms = fold(milestone, [...first, change, approve]);
  const mark = (key: string) => ({ plan_apply: `${approve.id}#${key}` });

  it('holds the task of each key in the diff until its marker is written', () => {
    const apple = child(2, 'apple');
    const ci = child(3, 'ci');
    const smoke = child(4, 'smoke');
    const kids = [apple, ci, smoke];
    expect(view(apple, [ms, ...kids])).toMatchObject({ status: 'todo', planHold: approve.id });
    expect(view(ci, [ms, ...kids]).planHold).toBe(approve.id);
    expect(isClaimable(view(ci, [ms, ...kids]))).toBe(false);
    // `smoke` is not in the diff.
    expect(view(smoke, [ms, ...kids]).planHold).toBeUndefined();
    expect(isClaimable(view(smoke, [ms, ...kids]))).toBe(true);
    expect(view(ms, kids)).toMatchObject({
      status: 'blocked',
      unblocked: false,
      planUnapplied: ['apple', 'ci'],
    });
  });

  it('frees a key when its one event carries the marker', () => {
    const apple = child(2, 'apple', [ev(9, 'park', 'human:dawid', mark('apple'))]);
    const ci = child(3, 'ci', [
      ev(9, 'handoff', 'human:dawid', { to: 'codex:engineer', ...mark('ci') }),
    ]);
    const kids = [apple, ci, child(4, 'smoke')];
    const v = view(ci, [ms, ...kids]);
    expect(v.planHold).toBeUndefined();
    expect(v).toMatchObject({ status: 'todo', owner: 'codex:engineer' });
    expect(isClaimable(v)).toBe(true);
    expect(view(ms, kids).planUnapplied).toBeUndefined();
  });

  it('keeps the hold for a marker of another approval', () => {
    const ci = child(3, 'ci', [
      ev(6, 'handoff', 'human:dawid', { to: 'codex:engineer', plan_apply: `${first[4]!.id}#ci` }),
    ]);
    expect(view(ci, [ms, ci]).planHold).toBe(approve.id);
  });

  it('holds a task whose lease ran out, too', () => {
    const ci = child(3, 'ci', [
      ev(1, 'claim', 'claude:engineer', { lease_until: new Date(T0 + 60_000).toISOString() }),
    ]);
    const v = view(ci, [ms, ci]);
    expect(v).toMatchObject({ stale: true, planHold: approve.id });
    expect(isClaimable(v)).toBe(false);
  });

  it('settles a key whose task closed first with a skip marker on the milestone', () => {
    const skip = ev(9, 'comment', 'human:dawid', { ...mark('apple'), plan_skip: 'closed' });
    const skipped = fold(milestone, [...first, change, approve, skip]);
    const apple = child(2, 'apple', closed(6));
    const ci = child(3, 'ci', [
      ev(9, 'handoff', 'human:dawid', { to: 'codex:engineer', ...mark('ci') }),
    ]);
    const kids = [apple, ci, child(4, 'smoke')];
    // Without the skip marker the application is incomplete; with it, complete.
    expect(view(ms, kids).planUnapplied).toEqual(['apple']);
    expect(view(skipped, kids).planUnapplied).toBeUndefined();
    // A closed task is never held: nothing can claim it.
    expect(view(apple, [ms, ...kids]).planHold).toBeUndefined();
    // Reopened before the skip marker, it is held; after it, the reopen reconciles it.
    const back = child(2, 'apple', [...closed(6), ev(10, 'reopen', 'human:dawid')]);
    expect(view(back, [ms, back]).planHold).toBe(approve.id);
    expect(view(back, [skipped, back]).planHold).toBeUndefined();
  });

  it('reads the archived task of a removed key while every effective key has a live task', () => {
    const apple = child(2, 'apple', closed(6));
    const applied = (key: string, n: number): TaskState =>
      child(n, key, [...closed(9), ev(12, 'comment', 'human:dawid', mark(key))]);
    const live = [applied('ci', 3), child(4, 'smoke', closed(9))];
    // `apple` is not in the effective plan, so only the diff makes the view read the archive.
    const v = view(ms, live, { archived: [apple] });
    expect(v).toMatchObject({ status: 'blocked', unblocked: false, planUnapplied: ['apple'] });
    expect(v.planMissing).toBeUndefined();
    expect(isClaimable(v)).toBe(false);
    // The task marker or the milestone's skip marker settles it.
    const marked = view(ms, live, { archived: [applied('apple', 2)] });
    expect(marked.planUnapplied).toBeUndefined();
    expect(marked.unblocked).toBe(true);
    const skip = ev(9, 'comment', 'human:dawid', { ...mark('apple'), plan_skip: 'closed' });
    const skipped = view(fold(milestone, [...first, change, approve, skip]), live, {
      archived: [apple],
    });
    expect(skipped.planUnapplied).toBeUndefined();
    expect(skipped.unblocked).toBe(true);
  });

  it('holds nothing after a first approval or an amendment: they change no existing task', () => {
    const plain = fold(milestone, [
      ...first,
      ev(9, 'plan-amend', 'claude:pm', { plan_kind: 'subtask', body: plan('lint *:engineer') }),
    ]);
    const ci = child(3, 'ci');
    expect(view(ci, [plain, ci]).planHold).toBeUndefined();
    expect(view(plain, [child(2, 'apple'), ci, child(4, 'smoke')])).toMatchObject({
      planMissing: ['lint'],
      planOpen: ['T-0002', 'T-0003', 'T-0004'],
    });
  });

  it('holds no task whose milestone is unknown or has no plan', () => {
    const ci = child(3, 'ci');
    expect(view(ci, [ci]).planHold).toBeUndefined();
    expect(view(ci, [fold(milestone, []), ci]).planHold).toBeUndefined();
  });
});
