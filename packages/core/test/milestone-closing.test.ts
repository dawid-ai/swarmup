// AO-0110, "Closing": the check that closes a milestone. Its owner is the checker (`*:qa`) from
// the first approved plan on. A pass closes it; a failed check files fix tasks, which block it
// again; the third failed check files none and asks.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MERGE_ACTOR, OpsError, PLAN_FIX_ROUNDS, Workspace } from '../src/index.js';
import type { OpsEvent, UserConfig } from '../src/index.js';
import { setup } from './helpers.js';

/** A user config in which swarmupd merges approved work of the root `test`. */
const MERGES = { swarmupd: { merge: { test: { base: 'main' } } } } as UserConfig;

/** A plan file with one-line items: `key owner [for]`. */
function yaml(...rows: string[]): string {
  const items = rows.map((row) => {
    const [key, owner, serves] = row.split(' ');
    return [
      `  - key: ${key}`,
      `    title: Item ${key}`,
      `    owner: '${owner}'`,
      '    estimate: 1h',
      ...(serves ? [`    for: ${serves}`] : []),
    ].join('\n');
  });
  return `items:\n${items.join('\n')}\n`;
}

function refusal(fn: () => unknown): OpsError {
  try {
    fn();
  } catch (err) {
    if (err instanceof OpsError) return err;
    throw err;
  }
  throw new Error('expected a refusal, but the call passed');
}

/**
 * A fixture store with a PM, an engineer and a checker, and milestone T-0001 whose approved plan
 * is `build` (T-0002) and `sign` (T-0003), both for claude:engineer.
 */
function world() {
  const { repo, rootDir, env } = setup();
  mkdirSync(join(rootDir, 'agents'), { recursive: true });
  const role = (slug: string, extra = ''): void =>
    writeFileSync(join(rootDir, 'agents', `${slug}.md`), `---\nstatus: active\n${extra}---\n`);
  role('claude-pm');
  role('claude-engineer');
  // What step 5 of the design puts in the `qa` role files.
  role('codex-qa', 'can_claim: [question, milestone]\n');
  const as = (actor: string) => new Workspace({ cwd: repo, env, actor, user: MERGES });
  const h = as('human:dawid');
  const pm = as('claude:pm');
  const qa = as('codex:qa');
  const eng = as('claude:engineer');
  h.newTask({
    title: 'Desktop app ships on macOS',
    type: 'milestone',
    owner: 'claude:pm',
    doneWhen: ['A signed .dmg from CI installs on a clean Mac'],
  });
  pm.start('1', 'read the goal, write the plan');
  pm.planPropose('1', yaml('build claude:engineer', 'sign claude:engineer'));
  h.planApprove('1');
  const events = (id: string): OpsEvent[] => h.showEvents(id).events;
  /** The engineer's work on `id`, approved with a branch: its merge is then open. */
  const approveWork = (id: string): void => {
    eng.start(id, 'plan');
    eng.review(id, `abc1234 on branch b-${id}: the work, tests`, 'human:dawid');
    h.verdict(id, 'approve', 'looks right');
  };
  const merge = (id: string): void => {
    const merged = { commit: 'abc1234', into: 'main', branch: `b-${id}` };
    as(MERGE_ACTOR).recordMerge(id, merged, 'Merged');
  };
  /** Closes each task with its work merged. */
  const close = (...ids: string[]): void => {
    for (const id of ids) {
      approveWork(id);
      merge(id);
    }
  };
  /** The checker takes the milestone for a check. */
  const check = (): void => {
    expect(qa.next()?.meta.id).toBe('T-0001');
    qa.start('1', 'run the check');
  };
  /** A failed check: the checker files `keys` as fix tasks, and returns their task ids. */
  const fail = (note: string, ...keys: string[]): string[] => {
    check();
    const res = qa.planAmend('1', 'fix', yaml(...keys.map((k) => `${k} claude:engineer`)), note);
    return res.created.map((c) => c.id);
  };
  return { as, h, pm, qa, eng, events, approveWork, merge, close, check, fail };
}

describe('closing a milestone (AO-0110, "Closing")', () => {
  it('closes after its tasks are done, their merge waits settle and the check passes', () => {
    const { h, qa, approveWork, merge, close } = world();
    expect(h.view('1')).toMatchObject({ status: 'blocked', owner: '*:qa', unblocked: false });
    close('2');
    approveWork('3');
    // Every task is done, and the last one's work is not in the base yet: no check.
    expect(h.view('1')).toMatchObject({ unblocked: false, mergeWait: ['T-0003'] });
    expect(qa.next()).toBeUndefined();
    expect(() => qa.claim('1')).toThrow(/not claimable/);
    merge('3');
    expect(h.view('1')).toMatchObject({ status: 'blocked', unblocked: true });

    expect(qa.next()?.meta.id).toBe('T-0001');
    qa.start('1', 'run the check');
    qa.checkpoint('1', '`spctl -a app.dmg`: accepted', 'close it');
    const done = qa.done('1', 'check passed: `spctl -a app.dmg` accepted the CI build');
    expect(done.view).toMatchObject({ status: 'done', waitsOnPlan: false, claimedBy: null });
    expect(h.planShow('1').failedChecks).toEqual([]);
  });

  it('adds fix tasks on a failed check and stays blocked until they close and merge', () => {
    const { h, pm, qa, events, approveWork, merge, close, check } = world();
    close('2', '3');
    check();
    // Only the checker that holds the milestone files fixes.
    expect(refusal(() => pm.planAmend('1', 'fix', yaml('f0 claude:engineer'))).message).toMatch(
      /only the checker that holds T-0001 adds fix tasks/,
    );
    const failed = qa.planAmend(
      '1',
      'fix',
      yaml('fix-notarize claude:engineer sign', 'fix-icon claude:engineer'),
      'check failed: `spctl -a app.dmg` rejected the build, and the icon is missing',
    );
    // One fix task per gap; the amendment blocks the milestone and ends the checker's claim.
    expect(failed.created.map((c) => [c.key, c.id])).toEqual([
      ['fix-notarize', 'T-0004'],
      ['fix-icon', 'T-0005'],
    ]);
    expect(failed.view).toMatchObject({
      status: 'blocked',
      owner: '*:qa',
      claimedBy: null,
      waitsOnPlan: true,
      unblocked: false,
      planOpen: ['T-0004', 'T-0005'],
    });
    expect(h.view('4').meta).toMatchObject({ parent: 'T-0001', plan_item: 'T-0001#fix-notarize' });
    expect(qa.next()).toBeUndefined();
    // The checker owns the milestone, and still cannot close it past its open fix tasks.
    expect(refusal(() => qa.done('1', 'check passed')).message).toMatch(
      /T-0001 waits for its plan: T-0004, T-0005; its check runs when they are closed and merged/,
    );
    const report = h.planShow('1');
    expect(report.failedChecks).toMatchObject([
      {
        event: events('1').find((e) => e.type === 'plan-amend')!.id,
        actor: 'codex:qa',
        keys: ['fix-notarize', 'fix-icon'],
        note: 'check failed: `spctl -a app.dmg` rejected the build, and the icon is missing',
      },
    ]);
    expect(report.fixRounds).toBe(PLAN_FIX_ROUNDS);

    // Closed is not enough: the last fix waits for its merge.
    close('4');
    expect(h.view('1')).toMatchObject({ unblocked: false, planOpen: ['T-0005'] });
    approveWork('5');
    expect(h.view('1')).toMatchObject({ unblocked: false, mergeWait: ['T-0005'] });
    expect(qa.next()).toBeUndefined();
    expect(() => qa.done('1', 'check passed')).toThrow(/waits for its plan: T-0005 \(merge\)/);
    merge('5');
    expect(h.view('1')).toMatchObject({ status: 'blocked', unblocked: true });

    check();
    expect(qa.done('1', 'check passed: the notarized .dmg installs').view.status).toBe('done');
  });

  it('writes an ask and no fix tasks on the third failed check', () => {
    const { h, pm, qa, events, close, check, fail } = world();
    close('2', '3');
    close(...fail('check failed: the build is unsigned', 'fix-a'));
    close(...fail('check failed: the signature is ad hoc', 'fix-b'));
    expect(h.view('1').plan?.failedChecks).toHaveLength(2);

    check();
    const tasks = h.views().length;
    const third = refusal(() => qa.planAmend('1', 'fix', yaml('fix-c claude:engineer'), 'again'));
    expect(third.code).toBe(1);
    expect(third.message).toMatch(/has failed 2 times.*adds none: ask with swarmup ask T-0001/);
    expect(events('1').filter((e) => e.type === 'plan-amend')).toHaveLength(2);
    expect(h.views()).toHaveLength(tasks);
    expect(qa.view('1')).toMatchObject({ status: 'in-progress', claimedBy: 'codex:qa' });

    // A plain ask, without --to: it reaches the PM, which forwards it to the person.
    const asked = qa.ask(
      '1',
      'T-0001: the check failed three times: unsigned build, ad hoc signature, now an expired ' +
        'certificate. Options: change done_when, add work, or park.',
      undefined,
      'add work: renew the certificate',
    );
    expect(asked.view).toMatchObject({ status: 'blocked', waitingOn: 'claude:pm' });
    expect(asked.events.map((e) => e.type)).toEqual(['ask']);
    expect(h.views()).toHaveLength(tasks);
    const forwarded = pm.ask(
      '1',
      'T-0001: its check failed three times (unsigned build, ad hoc signature, expired ' +
        'certificate). Change done_when, add work, or park?',
      undefined,
      'add work: renew the certificate',
    );
    expect(forwarded.view).toMatchObject({ waitingOn: 'human:dawid', askedBy: 'codex:qa' });

    // The answer frees the milestone for the checker, and a failed check still adds no fixes.
    h.answer('1', 'add work: claude:pm proposes the change');
    check();
    expect(() => qa.planAmend('1', 'fix', yaml('fix-c claude:engineer'))).toThrow(/adds none/);
    // A person may still add a fix.
    expect(h.planAmend('1', 'fix', yaml('fix-d claude:engineer')).created).toHaveLength(1);
  });

  it('starts a new count of failed checks at an approved plan change and at a reopen', () => {
    const { h, pm, qa, close, check, fail } = world();
    close('2', '3');
    close(...fail('check failed: unsigned', 'fix-a'));
    close(...fail('check failed: ad hoc signature', 'fix-b'));
    // The person approves more work: the check then runs against another plan.
    const revised = `${h.planShow('1').yaml}${yaml('cert claude:engineer').slice('items:\n'.length)}`;
    pm.planAmend('1', 'change', revised, 'T-0001: add the certificate renewal');
    const approval = h.planApprove('1');
    expect(approval.view.plan?.failedChecks).toEqual([]);
    close(approval.created[0]!.id);
    const fixes = fail('check failed: the certificate is for another team', 'fix-c');
    expect(fixes).toHaveLength(1);
    expect(h.view('1').plan?.failedChecks).toHaveLength(1);

    close(...fixes);
    check();
    qa.done('1', 'check passed: the .dmg installs');
    h.reopen('1', 'T-0001: the installer fails on macOS 15');
    expect(h.view('1').plan?.failedChecks).toEqual([]);
  });

  it('shows parked items to the check by key', () => {
    const { h, close } = world();
    close('2');
    h.park('3', 'dropped: signing moves to the next milestone');
    expect(h.view('1')).toMatchObject({ status: 'blocked', unblocked: true });
    const parked = h.planShow('1').items.filter((r) => r.status === 'parked');
    expect(parked.map((r) => [r.key, r.task])).toEqual([['sign', 'T-0003']]);
  });
});
