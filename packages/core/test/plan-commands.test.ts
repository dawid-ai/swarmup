import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpsError } from '../src/index.js';
import type { OpsEvent, PlanResult, Root, TaskView } from '../src/index.js';
import { setup } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A plan file with one-line items: `key owner [after|-] [review]`; `after` is comma-separated. */
function yaml(...rows: string[]): string {
  const items = rows.map((row) => {
    const [key, owner, after, review, estimate] = row.split(' ');
    return [
      `  - key: ${key}`,
      `    title: Item ${key}`,
      `    owner: '${owner}'`,
      `    estimate: ${estimate ?? '1h'}`,
      ...(after && after !== '-' ? [`    after: [${after}]`] : []),
      ...(review && review !== '-' ? [`    review: ${review}`] : []),
    ].join('\n');
  });
  return `items:\n${items.join('\n')}\n`;
}

/** Runs `fn` and returns the refusal it throws. */
function refusal(fn: () => unknown): OpsError {
  try {
    fn();
  } catch (err) {
    if (err instanceof OpsError) return err;
    throw err;
  }
  throw new Error('expected a refusal, but the call passed');
}

function world() {
  const { as } = setup();
  const h = as('human:dawid');
  const root = h.defaultRoot();
  const pm = as('claude:pm');
  const view = (id: string): TaskView => h.view(id);
  const events = (id: string): OpsEvent[] => h.showEvents(id).events;
  /** An event written straight to a task: a write from another machine, or under `--force`. */
  const raw = (id: string, actor: string, type: string, extra: Partial<OpsEvent> = {}) =>
    root.appendEvent(h.resolve(id).id, {
      type,
      actor,
      at: new Date().toISOString(),
      body: '',
      ...extra,
    });
  return { as, h, pm, root, view, events, raw };
}

/** Milestone T-0001, claimed by claude:pm, with `rows` proposed as its plan. */
function proposed(...rows: string[]) {
  const w = world();
  w.h.newTask({
    title: 'Desktop app ships on macOS',
    type: 'milestone',
    owner: 'claude:pm',
    priority: 'p1',
    doneWhen: ['A signed .dmg from CI installs on a clean Mac'],
  });
  w.pm.start('1', 'read the goal, write the plan');
  const proposal = w.pm.planPropose('1', yaml(...rows));
  return { ...w, proposal };
}

/** The same milestone with the plan approved: its tasks are T-0002 and up, in `after` order. */
function approved(...rows: string[]) {
  const w = proposed(...rows);
  const approval = w.h.planApprove('1');
  const task = (key: string): string => approval.created.find((c) => c.key === key)!.id;
  return { ...w, approval, task };
}

/** Items a, b (after a), c and e of claude:engineer: T-0002 to T-0005. */
const BASE = ['a claude:engineer', 'b claude:engineer a', 'c claude:engineer', 'e claude:engineer'];
/** A change of BASE: b waits for nothing, c goes to codex:engineer after a, e is removed, d is new. */
const CHANGE = [
  'a claude:engineer',
  'b claude:engineer',
  'c codex:engineer a',
  'd claude:engineer b',
];

/** BASE approved, with CHANGE proposed by the planner and waiting for approval. */
function changing() {
  const w = approved(...BASE);
  w.pm.planAmend('1', 'change', yaml(...CHANGE));
  return w;
}

/** Makes the `n`th call of `root[method]` that `when` matches throw, as a crash would. */
function crashOn<K extends 'createTask' | 'appendEvent'>(
  root: Root,
  method: K,
  n: number,
  when: (...args: Parameters<Root[K]>) => boolean = () => true,
): void {
  const real = root[method].bind(root) as (...args: Parameters<Root[K]>) => ReturnType<Root[K]>;
  let seen = 0;
  vi.spyOn(root, method).mockImplementation(((...args: Parameters<Root[K]>) => {
    if (when(...args) && ++seen === n) throw new Error('crash');
    return real(...args);
  }) as never);
}

const wrote = (r: PlanResult): number =>
  r.events.length + r.created.length + r.applied.length + r.skipped.length;

describe('swarmup plan propose and approve (AO-0110)', () => {
  it('creates the tasks with parent and dependencies in one approval, and a second run writes nothing', () => {
    const { h, pm, view, proposal } = proposed(
      'apple human:dawid',
      'ci *:engineer apple codex:qa 4h',
      'smoke *:qa ci',
    );
    expect(proposal.view).toMatchObject({ status: 'needs-review', reviewer: 'human:dawid' });
    expect(proposal.events.map((e) => e.type)).toEqual(['plan', 'review']);
    expect(proposal.events[1]!.body).toMatch(/Plan for T-0001: 3 items, 6 h/);
    expect(pm.planShow('1')).toMatchObject({ approval: null, pending: { minutes: 360 } });

    const res = h.planApprove('1');
    expect(res.events.map((e) => e.type)).toEqual(['plan-approve']);
    expect(res.created).toEqual([
      { key: 'apple', id: 'T-0002' },
      { key: 'ci', id: 'T-0003' },
      { key: 'smoke', id: 'T-0004' },
    ]);
    expect(res.view).toMatchObject({ status: 'blocked', owner: '*:qa', waitsOnPlan: true });
    expect(res.view.planMissing).toBeUndefined();
    expect(view('3').meta).toMatchObject({
      title: 'Item ci',
      parent: 'T-0001',
      blocked_by: ['T-0002'],
      labels: ['milestone:T-0001'],
      plan_item: 'T-0001#ci',
      review: 'codex:qa',
      done_when: ['Item ci'],
      priority: 'p1',
      owner: '*:engineer',
      created_by: 'human:dawid',
    });
    expect(view('3')).toMatchObject({ status: 'blocked', blockedOn: ['T-0002'] });
    expect(view('4').meta.blocked_by).toEqual(['T-0003']);
    expect(view('2')).toMatchObject({ status: 'todo', owner: 'human:dawid' });

    const again = pm.planApply('1');
    expect(wrote(again)).toBe(0);
    expect(h.views()).toHaveLength(4);
    const report = h.planShow('1');
    expect(report).toMatchObject({ minutes: 360, incomplete: null, pending: null });
    expect(report.items.map((r) => [r.key, r.task, r.status])).toEqual([
      ['apple', 'T-0002', 'todo'],
      ['ci', 'T-0003', 'blocked'],
      ['smoke', 'T-0004', 'blocked'],
    ]);
  });

  it('lets only the holder propose and only a person approve or reject', () => {
    const w = world();
    w.h.newTask({ title: 'Ship', type: 'milestone', owner: 'claude:pm', doneWhen: ['It ships'] });
    const plan = yaml('a claude:engineer');
    expect(refusal(() => w.pm.planPropose('1', plan))).toMatchObject({ code: 1 });
    w.pm.start('1', 'plan');
    expect(refusal(() => w.as('codex:pm').planPropose('1', plan)).message).toMatch(/held by/);
    expect(refusal(() => w.pm.planPropose('1', yaml('a claude:engineer - claude:qa'))).code).toBe(
      2,
    );
    w.pm.planPropose('1', plan);
    expect(refusal(() => w.pm.planApprove('1')).message).toMatch(/only a person approves/);
    expect(refusal(() => w.pm.planReject('1', 'no')).message).toMatch(/only a person sends/);
    expect(refusal(() => w.h.verdict('1', 'approve', 'ok')).message).toMatch(/plan approve/);

    const back = w.h.planReject('1', 'T-0001: split item a');
    expect(back.view).toMatchObject({ status: 'todo', owner: 'claude:pm' });
    expect(back.view.plan!.pending).toBeNull();
    expect(refusal(() => w.h.planApprove('1')).message).toMatch(/no plan that waits/);

    // The planner proposes again with the keys of the plan sent back; a forced approval is recorded.
    w.pm.start('1', 'revise');
    w.pm.planPropose('1', yaml('a claude:engineer', 'a2 claude:engineer a'));
    const forced = w.as('claude:pm', { force: true }).planApprove('1');
    expect(forced.events[0]).toMatchObject({ type: 'plan-approve', forced: true });
    expect(forced.created.map((c) => c.key)).toEqual(['a', 'a2']);
    expect(refusal(() => w.pm.planPropose('1', plan)).message).toMatch(/approved plan/);
  });

  it('approves an edited plan and records what was edited', () => {
    const { h, events } = proposed('a claude:engineer', 'b claude:engineer a');
    const res = h.planApprove('1', { source: yaml('a codex:engineer') });
    expect(res.created).toEqual([{ key: 'a', id: 'T-0002' }]);
    expect(events('1').at(-1)!.body).toMatch(/Edited before approval: removed: b; owner of a/);
    expect(h.view('2').owner).toBe('codex:engineer');
  });
});

describe('plan task rules between plan changes (AO-0110)', () => {
  it('keeps an extra wait through a handoff, and adds the planned waits to block --on', () => {
    const { as, view, task } = approved('a *:engineer', 'b *:engineer a', 'c *:engineer');
    const eng = as('claude:engineer');
    eng.block(task('b'), 'T-0003 also needs c', { on: [task('c')] });
    expect(view(task('b')).blockedOn.sort()).toEqual(['T-0002', 'T-0004']);
    const res = eng.handoff(task('b'), 'codex:engineer', 'T-0003: yours');
    expect(res.events[0]!.on!.sort()).toEqual(['T-0002', 'T-0004']);
    expect(res.view).toMatchObject({ status: 'blocked', owner: 'codex:engineer' });
    expect(res.view.blockedOn.sort()).toEqual(['T-0002', 'T-0004']);
    // delegate and assign carry the same waits.
    const sent = as('codex:engineer').delegate(task('b'), 'claude:engineer', { budget: '2h' });
    expect(sent.view.blockedOn.sort()).toEqual(['T-0002', 'T-0004']);
    const given = as('human:dawid').assign(task('b'), 'codex:engineer');
    expect(given.view).toMatchObject({ status: 'blocked', owner: 'codex:engineer' });
    expect(given.view.blockedOn.sort()).toEqual(['T-0002', 'T-0004']);
  });

  it('refuses a handoff and a claim by the reviewer check, and an owner outside the plan', () => {
    const { as, h, view, task } = approved('ci *:engineer - codex:qa', 'doc claude:engineer');
    const claude = as('claude:engineer');
    const why = refusal(() => claude.handoff(task('ci'), 'codex:engineer', 'yours'));
    expect(why).toMatchObject({ code: 1 });
    expect(why.message).toMatch(/names codex:qa as reviewer, so codex:engineer/);
    expect(refusal(() => as('codex:engineer').claim(task('ci'))).message).toMatch(
      /names codex:qa as reviewer/,
    );
    expect(refusal(() => claude.handoff(task('ci'), '*:writer', 'x')).message).toMatch(
      /plan gives it to \*:engineer, not \*:writer; use swarmup plan amend T-0001 --kind change/,
    );
    expect(refusal(() => claude.handoff(task('doc'), 'codex:engineer', 'x')).message).toMatch(
      /plan gives it to claude:engineer/,
    );
    // A person passes; anyone else with --force, recorded.
    const forced = as('claude:engineer', { force: true }).handoff(
      task('doc'),
      'codex:engineer',
      'x',
    );
    expect(forced.events[0]).toMatchObject({ forced: true });
    expect(h.handoff(task('doc'), 'claude:engineer', 'back').view.owner).toBe('claude:engineer');
    claude.claim(task('ci'));
    expect(view(task('ci')).claimedBy).toBe('claude:engineer');
  });

  it('refuses a delegate --review that differs from the plan', () => {
    const { as, task } = approved('ci *:engineer - codex:qa');
    const eng = as('claude:engineer');
    expect(
      refusal(() => eng.delegate(task('ci'), 'claude:engineer', { review: 'codex:reviewer' }))
        .message,
    ).toMatch(/plan names codex:qa as reviewer; drop --review or pass --review codex:qa/);
    const ok = eng.delegate(task('ci'), 'claude:engineer', { review: 'codex:qa' });
    expect(ok.view.delegation).toMatchObject({ review: 'codex:qa' });
  });

  it('refuses review --to another agent than the plan names, and sends an equal --to', () => {
    const { as, h, events, task } = approved(
      'ci *:engineer - codex:qa',
      'ui *:engineer - codex:qa',
    );
    const eng = as('claude:engineer');
    eng.start(task('ci'), 'plan');
    const why = refusal(() => eng.review(task('ci'), 'T-0002: abc1234 done', 'codex:reviewer'));
    expect(why).toMatchObject({ code: 1 });
    expect(why.message).toMatch(
      /T-0002's plan names codex:qa as reviewer; drop --to, pass --to codex:qa, or pass --human/,
    );
    // A person's id in --to is no human route: only --human, the labels and a repeated request.
    const person = refusal(() => eng.review(task('ci'), 'T-0002: abc1234 done', 'human:dawid'));
    expect(person).toMatchObject({ code: 1 });
    expect(person.message).toMatch(/plan names codex:qa as reviewer.*or pass --human/);
    const forced = as('claude:engineer', { force: true });
    expect(forced.review(task('ci'), 'T-0002: done', 'codex:reviewer').events[0]).toMatchObject({
      to: 'codex:reviewer',
      forced: true,
    });
    // A person passes without --force.
    eng.start(task('ui'), 'plan');
    h.review(task('ui'), 'T-0003: done', 'codex:reviewer');
    expect(events(task('ui')).at(-1)).toMatchObject({ to: 'codex:reviewer' });
    expect(events(task('ui')).at(-1)!.forced).toBeUndefined();

    const w = approved('ci *:engineer - codex:qa');
    w.as('claude:engineer').start('2', 'plan');
    const sent = w.as('claude:engineer').review('2', 'T-0002: done', 'codex:qa');
    expect(sent.view).toMatchObject({ status: 'needs-review', reviewer: 'codex:qa' });
    // Without --to, the plan's reviewer gets it.
    w.as('codex:qa').verdict('2', 'changes', 'T-0002: fix the test');
    w.as('claude:engineer').start('2', 'fix');
    expect(w.as('claude:engineer').review('2', 'T-0002: fixed').view.reviewer).toBe('codex:qa');
  });

  it('sends a plan task with a reviewer to the person on each human route, who closes it', () => {
    const { as, h, view, task } = approved(
      'r1 *:engineer - codex:qa',
      'r2 *:engineer - codex:qa',
      'r3 *:engineer - codex:qa',
    );
    const eng = as('claude:engineer');
    // --human.
    eng.start(task('r1'), 'plan');
    const flagged = eng.review(task('r1'), 'T-0002: done', undefined, undefined, { human: true });
    expect(flagged.view.reviewer).toBe('human:dawid');
    expect(h.done(task('r1'), 'checked').view.status).toBe('done');
    // A type or label only the person reviews.
    h.retype(task('r2'), 'release');
    eng.start(task('r2'), 'plan');
    expect(eng.review(task('r2'), 'T-0003: done').view.reviewer).toBe('human:dawid');
    expect(h.verdict(task('r2'), 'approve', 'ok').view.status).toBe('done');
    // A request that repeats the commit of a `changes` verdict.
    eng.start(task('r3'), 'plan');
    const first = eng.review(task('r3'), 'T-0004: abc1234 on branch feat: the work');
    expect(first.view.reviewer).toBe('codex:qa');
    as('codex:qa').verdict(task('r3'), 'changes', 'T-0004: the test fails');
    eng.start(task('r3'), 'again');
    const repeat = eng.review(task('r3'), 'T-0004: abc1234 on branch feat: the work');
    expect(repeat.view.reviewer).toBe('human:dawid');
    expect(h.done(task('r3'), 'made the commit myself').view.status).toBe('done');
    expect(view('1')).toMatchObject({ status: 'blocked', unblocked: true });
  });

  it('closes a plan task with a reviewer only through the reviewer its review named', () => {
    const { as, h, task } = approved(
      'x *:engineer - codex:qa',
      'y *:engineer - codex:qa',
      'z *:engineer - codex:qa',
      'plain *:engineer',
    );
    const eng = as('claude:engineer');
    eng.start(task('x'), 'plan');
    const early = refusal(() => eng.done(task('x'), 'done'));
    expect(early).toMatchObject({ code: 1 });
    expect(early.message).toMatch(
      /T-0002's plan names codex:qa as reviewer; send it with swarmup review/,
    );
    eng.review(task('x'), 'T-0002: done');
    expect(refusal(() => eng.done(task('x'), 'done')).message).toMatch(
      /send it with swarmup review/,
    );
    expect(as('codex:qa').done(task('x'), 'checked').view.status).toBe('done');

    eng.start(task('y'), 'plan');
    eng.review(task('y'), 'T-0003: done');
    expect(as('codex:qa').verdict(task('y'), 'approve', 'ok').view.status).toBe('done');

    // A person passes, and anyone else with --force, recorded.
    eng.start(task('z'), 'plan');
    const forced = as('claude:engineer', { force: true }).done(task('z'), 'done');
    expect(forced.events[0]).toMatchObject({ type: 'done', forced: true });
    h.reopen(task('z'), 'again');
    expect(h.done(task('z'), 'closed by hand').view.status).toBe('done');

    // Without `review` in the plan, the holder closes as today.
    eng.start(task('plain'), 'plan');
    expect(eng.done(task('plain'), 'done').view.status).toBe('done');
  });

  it('refuses park, an early unblock and an owner change on a question', () => {
    const { as, h, pm, task } = approved('a claude:engineer', 'b claude:engineer a');
    const eng = as('claude:engineer');
    expect(refusal(() => pm.park(task('a'), 'not needed')).message).toMatch(
      /item 'a' of T-0001's plan, and dropping an item changes approved scope; use swarmup plan amend T-0001 --kind change/,
    );
    expect(refusal(() => eng.unblock(task('b'), 'go')).message).toMatch(
      /T-0003 waits for T-0002 under T-0001's plan/,
    );
    eng.start(task('a'), 'plan');
    eng.ask(task('a'), 'T-0002: which signing key?', 'human:dawid', 'the CI key');
    expect(refusal(() => eng.handoff(task('a'), 'claude:engineer', 'x')).message).toMatch(
      /T-0002 waits on a question; answer it first/,
    );
    h.answer(task('a'), 'the CI key');
    eng.start(task('a'), 'go on');
    eng.done(task('a'), 'done');
    expect(eng.unblock(task('b'), 'a is done').view.status).toBe('todo');
    expect(h.park(task('b'), 'dropped by hand').view.status).toBe('parked');
  });
});

describe('plan amendments (AO-0110)', () => {
  it('applies subtask items at once, up to 25 % of the approved estimate', () => {
    const { h, pm, as, events, view } = approved(...BASE);
    const sub = (key: string, estimate: string, serves = 'a'): string =>
      `${yaml(`${key} claude:engineer - - ${estimate}`)}    for: ${serves}\n`;
    const res = pm.planAmend('1', 'subtask', sub('a1', '30m'));
    expect(res.events.map((e) => e.type)).toEqual(['plan-amend']);
    expect(res.created).toEqual([{ key: 'a1', id: 'T-0006' }]);
    expect(view('6').meta).toMatchObject({ plan_item: 'T-0001#a1', created_by: 'claude:pm' });
    expect(h.showEvents('6').body).toMatch(/Serves: a \(T-0002\)/);
    pm.planAmend('1', 'subtask', sub('a2', '30m'));
    // 4 h approved: 1 h of subtasks is the limit, however many amendments add up to it.
    const over = refusal(() => pm.planAmend('1', 'subtask', sub('a3', '30m')));
    expect(over).toMatchObject({ code: 1 });
    expect(over.message).toMatch(
      /1 h 30 min, more than 25 % of the approved 4 h: use --kind change/,
    );
    expect(events('1').filter((e) => e.type === 'plan-amend')).toHaveLength(2);

    // Each refusal of an amendment that only an approval may make.
    expect(refusal(() => pm.planAmend('1', 'subtask', sub('a', '10m'))).message).toMatch(
      /already used.*use --kind change/,
    );
    const noFor = refusal(() => pm.planAmend('1', 'subtask', yaml('a4 claude:engineer - - 10m')));
    expect(noFor.message).toMatch(/names no `for`.*use --kind change/);
    expect(refusal(() => pm.planAmend('1', 'subtask', sub('a5', '10m', 'a1'))).code).toBe(2);
    expect(
      refusal(() => as('claude:engineer').planAmend('1', 'subtask', sub('a6', '10m'))).message,
    ).toMatch(/only claude:pm or a person amends/);
    expect(refusal(() => pm.planAmend('1', 'fix', yaml('f1 claude:engineer'))).message).toMatch(
      /only the checker that holds T-0001 adds fix tasks/,
    );
    // Fix tasks do not count against the limit.
    expect(h.planAmend('1', 'fix', yaml('f1 claude:engineer - - 2h')).created).toHaveLength(1);
    expect(h.planShow('1').items.find((r) => r.key === 'f1')).toMatchObject({ origin: 'fix' });
  });

  it('holds the effective plan to 25 items across amendments', () => {
    const rows = Array.from({ length: 24 }, (_, i) => `k${i} claude:engineer`);
    const { h, events } = approved(...rows);
    // The 25th item fits.
    expect(h.planAmend('1', 'fix', yaml('f1 claude:engineer')).created).toHaveLength(1);
    expect(h.planShow('1').items).toHaveLength(25);
    for (const kind of ['fix', 'subtask'] as const) {
      const file = `${yaml('x1 claude:engineer - - 10m')}    for: k0\n`;
      const over = refusal(() => h.planAmend('1', kind, file));
      expect(over).toMatchObject({ code: 2 });
      expect(over.message).toMatch(/25 items in the plan and 1 new: a plan holds 25 at most/);
    }
    // Two new items on 24 are refused as a whole.
    const w = approved(...rows);
    const two = refusal(() =>
      w.h.planAmend('1', 'fix', yaml('f1 claude:engineer', 'f2 claude:engineer')),
    );
    expect(two.message).toMatch(/24 items in the plan and 2 new/);
    expect(w.events('1').filter((e) => e.type === 'plan-amend')).toHaveLength(0);
    expect(events('1').filter((e) => e.type === 'plan-amend')).toHaveLength(1);
  });

  it('finishes an amendment a crash stopped, and refuses its file on the rerun', () => {
    const { h, pm, root, events, view } = approved(...BASE);
    const file = `${yaml('a1 claude:engineer - - 30m')}    for: a\n`;
    // The person amends here: the crash is set on the root of the person's workspace.
    crashOn(root, 'createTask', 1);
    expect(() => h.planAmend('1', 'subtask', file)).toThrow('crash');
    vi.restoreAllMocks();
    expect(view('1')).toMatchObject({ status: 'blocked', planMissing: ['a1'] });
    expect(pm.planIncomplete()).toEqual(['test/T-0001']);
    const again = refusal(() => pm.planAmend('1', 'subtask', file));
    expect(again.message).toMatch(/already used.*use --kind change/);
    expect(events('1').filter((e) => e.type === 'plan-amend')).toHaveLength(1);
    expect(view('6').meta.plan_item).toBe('T-0001#a1');
    expect(view('1').planMissing).toBeUndefined();
    expect(pm.planIncomplete()).toEqual([]);
  });

  it('refuses in-place edits, a second pending change and a stale base', () => {
    const { h, pm, as } = approved(...BASE);
    const edited = yaml(...BASE).replace('Item a', 'Item a, renamed');
    const title = refusal(() => pm.planAmend('1', 'change', edited));
    expect(title).toMatchObject({ code: 1 });
    expect(title.message).toMatch(/item 'a': title differs.*add it under a new key/);
    const prio = `${yaml(...BASE)}    priority: p0\n`;
    expect(refusal(() => pm.planAmend('1', 'change', prio)).message).toMatch(
      /item 'e': priority differs.*swarmup priority/,
    );
    expect(refusal(() => pm.planAmend('1', 'change', yaml(...BASE))).message).toMatch(
      /changes nothing/,
    );
    expect(refusal(() => as('codex:pm').planAmend('1', 'change', yaml(...CHANGE))).message).toMatch(
      /only claude:pm or a person/,
    );

    const change = pm.planAmend('1', 'change', yaml(...CHANGE));
    expect(change.events[0]).toMatchObject({ type: 'plan', to: 'human:dawid' });
    expect(change.events[0]!.base).toBe(change.view.plan!.head);
    expect(change.view).toMatchObject({ status: 'blocked', waitsOnPlan: true });
    expect(h.planShow('1').pending!.changes).toEqual([
      'removed: e',
      'after of b: [a] -> []',
      'owner of c: claude:engineer -> codex:engineer',
      'after of c: [] -> [a]',
      'added: d',
    ]);
    expect(refusal(() => pm.planAmend('1', 'change', yaml(...CHANGE))).message).toMatch(
      /already has a plan change that waits/,
    );
    // An amendment applied in between moves the plan past the proposal's base.
    pm.planAmend('1', 'subtask', `${yaml('a1 claude:engineer - - 30m')}    for: a\n`);
    const stale = refusal(() => h.planApprove('1'));
    expect(stale).toMatchObject({ code: 1 });
    expect(stale.message).toMatch(/plan changed since proposal/);
    h.planReject('1', 'T-0001: propose it again from the plan with a1');
    // The effective plan as YAML is the starting point of the revision, so it passes the checks.
    const next = pm.planShow('1').yaml.replace(/ {2}- key: e[\s\S]*?(?= {2}- key:|$)/, '');
    expect(pm.planAmend('1', 'change', next).view.plan!.pending).toMatchObject({ stale: false });
    expect(h.planApprove('1').applied).toEqual([{ key: 'e', id: 'T-0005', change: 'park' }]);
  });
});

describe('approving a change (AO-0110)', () => {
  it('turns the diff into one event per key and creates the new item', () => {
    const { h, as, view, events } = changing();
    const res = h.planApprove('1');
    const approval = res.events[0]!.id;
    expect(res.created).toEqual([{ key: 'd', id: 'T-0006' }]);
    expect(res.applied).toEqual([
      { key: 'b', id: 'T-0003', change: 'unblock' },
      { key: 'c', id: 'T-0004', change: 'handoff' },
      { key: 'e', id: 'T-0005', change: 'park' },
    ]);
    expect(view('3')).toMatchObject({ status: 'todo', owner: 'claude:engineer' });
    expect(view('4')).toMatchObject({
      status: 'blocked',
      owner: 'codex:engineer',
      blockedOn: ['T-0002'],
    });
    expect(view('5').status).toBe('parked');
    expect(view('6').meta.blocked_by).toEqual(['T-0003']);
    expect(events('4').at(-1)).toMatchObject({
      type: 'handoff',
      to: 'codex:engineer',
      on: ['T-0002'],
      plan_apply: `${approval}#c`,
    });
    expect(view('1')).toMatchObject({ status: 'blocked', waitsOnPlan: true });
    expect(view('1').planUnapplied).toBeUndefined();
    expect(wrote(as('codex:engineer').planApply('1'))).toBe(0);
    // A reorder alone is a `block --on` with the tasks of the new `after` keys.
    as('claude:pm').planAmend(
      '1',
      'change',
      yaml('a claude:engineer', 'b claude:engineer a', 'c codex:engineer a', 'd claude:engineer b'),
    );
    expect(h.planApprove('1').applied).toEqual([{ key: 'b', id: 'T-0003', change: 'block' }]);
    expect(view('3')).toMatchObject({ status: 'blocked', blockedOn: ['T-0002'] });
  });

  it('refuses a diff that touches a task outside the allowed states', () => {
    const { h, as, view, events, raw } = changing();
    const eng = as('claude:engineer');
    const tryIt = (): string => refusal(() => h.planApprove('1')).message;
    // Waiting on a wait the plan did not set.
    eng.block('3', 'T-0003 also needs c', { on: ['4'] });
    expect(tryIt()).toMatch(/T-0003 \(b\) waits on tasks its plan did not set/);
    raw('3', 'human:dawid', 'block', { on: ['T-0002'] });
    // Waiting on a question.
    eng.start('4', 'plan');
    eng.ask('4', 'T-0004: which key?', 'human:dawid', 'the CI key');
    expect(tryIt()).toMatch(/T-0004 \(c\) waits on a question/);
    h.answer('4', 'the CI key');
    // In review.
    eng.start('4', 'go on');
    eng.review('4', 'T-0004: done', 'human:dawid');
    expect(tryIt()).toMatch(/T-0004 \(c\) is needs-review/);
    h.verdict('4', 'changes', 'T-0004: one more test');
    // Closed.
    eng.start('5', 'plan');
    eng.done('5', 'done');
    expect(tryIt()).toMatch(/T-0005 \(e\) is closed/);
    expect(events('1').filter((e) => e.type === 'plan-approve')).toHaveLength(1);
    expect(view('1').plan!.pending).not.toBeNull();
    expect(h.views()).toHaveLength(5);
  });
});

describe('locks and the claim guard (AO-0110)', () => {
  it('holds the changed tasks under lock from the approval to their key events', () => {
    const { h, as, root, view } = changing();
    const lock = (id: string): boolean => existsSync(join(root.opsDir, 'locks', `task-${id}.lock`));
    const held: Record<string, boolean[]> = {};
    const real = root.appendEvent.bind(root);
    vi.spyOn(root, 'appendEvent').mockImplementation((id, ev, ...rest) => {
      if (ev.type === 'plan-approve' || ev.plan_apply) {
        held[ev.type] = ['T-0001', 'T-0003', 'T-0004', 'T-0005'].map(lock);
      }
      return real(id, ev, ...rest);
    });
    h.planApprove('1');
    vi.restoreAllMocks();
    // A claim that waits for these locks lands after the key events.
    expect(held).toEqual({
      'plan-approve': [true, true, true, true],
      unblock: [true, true, true, true],
      handoff: [true, true, true, true],
      park: [true, true, true, true],
    });
    expect(lock('T-0004')).toBe(false);
    // It then claims only as the new owner, after the new dependency.
    expect(refusal(() => as('claude:engineer').claim('4')).message).toMatch(/not claimable/);
    expect(refusal(() => as('codex:engineer').claim('4')).message).toMatch(/not claimable/);
    as('claude:engineer').start('2', 'plan');
    as('claude:engineer').done('2', 'done');
    expect(refusal(() => as('claude:engineer').claim('4')).message).toMatch(
      /owned by codex:engineer/,
    );
    as('codex:engineer').claim('4');
    expect(view('4').claimedBy).toBe('codex:engineer');
  });

  it('writes nothing when a claim wins the lock first', () => {
    const { h, as, view, events } = changing();
    as('claude:engineer').claim('4');
    const why = refusal(() => h.planApprove('1'));
    expect(why).toMatchObject({ code: 1 });
    expect(why.message).toMatch(/T-0004 \(c\) is claimed by claude:engineer/);
    expect(events('1').filter((e) => e.type === 'plan-approve')).toHaveLength(1);
    expect(events('3').some((e) => e.plan_apply)).toBe(false);
    expect(h.views()).toHaveLength(5);
    expect(view('1').plan!.pending).not.toBeNull();
    // After the run releases it, the same approval goes through.
    as('claude:engineer').release('4', 'not now');
    expect(h.planApprove('1').applied).toHaveLength(3);
  });

  it('holds the changed tasks after a crash until swarmup plan apply', () => {
    const { h, as, root, view, events } = changing();
    crashOn(root, 'appendEvent', 1, (_id, ev) => ev.plan_apply !== undefined);
    expect(() => h.planApprove('1')).toThrow('crash');
    vi.restoreAllMocks();
    const eng = as('claude:engineer');
    expect(view('1')).toMatchObject({ status: 'blocked', planUnapplied: ['b', 'c', 'e'] });
    expect(view('4').planHold).toBe(view('1').plan!.approval);
    expect(refusal(() => eng.claim('4')).message).toMatch(
      /T-0004 waits for T-0001's plan to apply; run swarmup plan apply T-0001/,
    );
    expect(refusal(() => eng.start('5', 'plan')).message).toMatch(/plan to apply/);
    // T-0006, the new item, waits for T-0003 under the new plan.
    expect(eng.queue().map((v) => v.meta.id)).toEqual(['T-0002']);
    expect(h.planShow('1').incomplete).toEqual({ missing: [], unapplied: ['b', 'c', 'e'] });

    const done = as('codex:engineer').planApply('1');
    expect(done.applied.map((a) => a.change)).toEqual(['unblock', 'handoff', 'park']);
    expect(view('4').planHold).toBeUndefined();
    expect(view('1').planUnapplied).toBeUndefined();
    for (const id of ['3', '4', '5']) {
      expect(events(id).filter((e) => e.plan_apply)).toHaveLength(1);
    }
    expect(wrote(eng.planApply('1'))).toBe(0);
  });
});

describe('crashes during an application (AO-0110)', () => {
  it('creates the remaining tasks after a crash between created tasks, each once', () => {
    const { h, as, root, view } = proposed(
      'a claude:engineer',
      'b claude:engineer a',
      'c claude:engineer',
    );
    crashOn(root, 'createTask', 2);
    expect(() => h.planApprove('1')).toThrow('crash');
    vi.restoreAllMocks();
    expect(h.views().map((v) => v.meta.id)).toEqual(['T-0001', 'T-0002']);
    expect(view('1')).toMatchObject({ status: 'blocked', owner: '*:qa', planMissing: ['b', 'c'] });
    const rest = as('codex:engineer').planApply('1');
    expect(rest.created).toEqual([
      { key: 'b', id: 'T-0003' },
      { key: 'c', id: 'T-0004' },
    ]);
    expect(view('3').meta).toMatchObject({ blocked_by: ['T-0002'], created_by: 'human:dawid' });
    expect(wrote(h.planApply('1'))).toBe(0);
    expect(h.views()).toHaveLength(4);
  });

  it('writes only the missing key events after a crash between item events', () => {
    const { h, root, view, events } = changing();
    crashOn(root, 'appendEvent', 2, (_id, ev) => ev.plan_apply !== undefined);
    expect(() => h.planApprove('1')).toThrow('crash');
    vi.restoreAllMocks();
    expect(view('3')).toMatchObject({ status: 'todo' });
    expect(view('3').planHold).toBeUndefined();
    expect(view('1').planUnapplied).toEqual(['c', 'e']);
    // The next plan write finishes it first.
    const res = h.planApply('1');
    expect(res.applied).toEqual([
      { key: 'c', id: 'T-0004', change: 'handoff' },
      { key: 'e', id: 'T-0005', change: 'park' },
    ]);
    expect(res.created).toEqual([]);
    for (const id of ['3', '4', '5']) {
      expect(events(id).filter((e) => e.plan_apply)).toHaveLength(1);
    }
    expect(h.views()).toHaveLength(6);
  });

  it('stops at a task claimed or sent for review before the rerun, and skips a closed one', () => {
    const { h, root, view, events, raw } = changing();
    crashOn(root, 'appendEvent', 1, (_id, ev) => ev.plan_apply !== undefined);
    expect(() => h.planApprove('1')).toThrow('crash');
    vi.restoreAllMocks();
    // As a claim from another machine, or a forced write, would land them.
    raw('3', 'claude:engineer', 'review', { to: 'human:dawid', body: 'T-0003: done' });
    raw('4', 'claude:engineer', 'claim', { token: 'abc123' });
    raw('5', 'claude:engineer', 'done');
    const stop = refusal(() => h.planApply('1'));
    expect(stop).toMatchObject({ code: 1 });
    expect(stop.message).toMatch(/T-0003 \(b\) is needs-review/);
    expect(stop.message).toMatch(/T-0004 \(c\) is claimed by claude:engineer/);
    expect(stop.message).not.toMatch(/T-0005/);
    // The closed task got its skip marker on the milestone; the others still hold the plan.
    const skip = events('1').at(-1)!;
    expect(skip).toMatchObject({ type: 'comment', plan_skip: 'closed' });
    expect(skip.plan_apply).toBe(`${view('1').plan!.approval}#e`);
    expect(skip.body.trim()).toBe('e: closed before the change applied');
    expect(view('1')).toMatchObject({ status: 'blocked', planUnapplied: ['b', 'c'] });
    expect(view('5').status).toBe('done');

    raw('3', 'human:dawid', 'verdict', { verdict: 'changes' });
    raw('4', 'claude:engineer', 'release');
    const res = h.planApply('1');
    expect(res.applied.map((a) => a.key)).toEqual(['b', 'c']);
    expect(res.skipped).toEqual([]);
    expect(view('1').planUnapplied).toBeUndefined();
    expect(view('4')).toMatchObject({ owner: 'codex:engineer', blockedOn: ['T-0002'] });
  });
});

describe('reopening a plan task (AO-0110)', () => {
  it('reconciles a skipped task with the effective plan, and refuses a removed item', () => {
    const { h, as, root, view, raw } = changing();
    crashOn(root, 'appendEvent', 1, (_id, ev) => ev.plan_apply !== undefined);
    expect(() => h.planApprove('1')).toThrow('crash');
    vi.restoreAllMocks();
    raw('4', 'claude:engineer', 'done');
    const res = h.planApply('1');
    expect(res.skipped).toEqual([{ key: 'c', id: 'T-0004' }]);
    expect(view('4')).toMatchObject({ status: 'done', owner: 'claude:engineer' });
    const approval = view('1').plan!.approval;

    // The skipped change did not reach the task; a reopen brings the plan's owner and waits.
    const back = h.reopen('4', 'T-0004: the build broke');
    expect(back.events[0]).toMatchObject({ type: 'reopen', to: 'codex:engineer', on: ['T-0002'] });
    expect(back.view).toMatchObject({
      status: 'blocked',
      owner: 'codex:engineer',
      blockedOn: ['T-0002'],
    });
    expect(back.view.planHold).toBeUndefined();
    expect(view('1').planOpen).toContain('T-0004');

    // T-0005 was removed by the approval: bringing it back changes approved scope.
    const gone = refusal(() => h.reopen('5', 'again'));
    expect(gone).toMatchObject({ code: 1 });
    expect(gone.message).toBe(
      `T-0005 was removed from T-0001's plan by ${approval}; propose a change with a new key (use --force to override)`,
    );
    const forced = as('human:dawid', { force: true }).reopen('5', 'again');
    expect(forced.events[0]).toMatchObject({ type: 'reopen', forced: true });
    expect(view('1').planOpen).toContain('T-0005');
  });
});
