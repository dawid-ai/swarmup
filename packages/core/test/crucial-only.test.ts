// AO-0173: the person sees only crucial decisions. The PM triages findings and answers agents'
// asks; a review without --to goes to a reviewer of another provider. Reviews of releases, money,
// accounts, credentials, client output or data deletion, and asks the PM forwards, still reach
// the person.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UserConfig } from '../src/index.js';
import { setup } from './helpers.js';

function roleFile(rootDir: string, slug: string, status = 'active'): void {
  mkdirSync(join(rootDir, 'agents'), { recursive: true });
  writeFileSync(join(rootDir, 'agents', `${slug}.md`), `---\nstatus: ${status}\n---\n`);
}

const TEAM = [
  'claude-engineer',
  'codex-engineer',
  'claude-pm',
  'codex-pm',
  'claude-reviewer',
  'codex-reviewer',
];

function team(roles = TEAM) {
  const s = setup();
  for (const slug of roles) roleFile(s.rootDir, slug);
  return s;
}

describe('findings go to the PM', () => {
  it('accepts and routes an agent finding for a bug without the person', () => {
    const { as } = team();
    const eng = as('claude:engineer');
    const { meta, proposed } = eng.addTask({
      title: 'Login retries forever on 401',
      body: 'Bug in `core/auth.ts`.',
    });
    expect(proposed).toMatch(/PM or a person/);
    expect(meta.type).toBe('finding');

    // The PM triages it; the person's inbox stays empty.
    expect(
      as('human:dawid')
        .inbox()
        .filter((i) => i.kind === 'triage'),
    ).toEqual([]);
    expect(
      as('codex:pm')
        .inbox()
        .filter((i) => i.kind === 'triage'),
    ).toEqual([]);
    const triage = as('claude:pm')
      .inbox()
      .filter((i) => i.kind === 'triage');
    expect(triage.map((i) => i.task)).toEqual([meta.id]);

    // An engineer cannot accept it; the PM accepts it as a bug with an owner and priority.
    expect(() => eng.retype(meta.id, 'bug')).toThrow(/the PM/);
    const res = as('claude:pm').retype(meta.id, 'bug', 'accepted: bug in an existing project', {
      to: 'codex:engineer',
      priority: 'p1',
    });
    expect(res.events.map((e) => e.type)).toEqual(['retype', 'priority', 'assign']);
    expect(res.view).toMatchObject({ owner: 'codex:engineer', meta: { type: 'bug' } });
    expect(
      as('claude:pm')
        .inbox()
        .filter((i) => i.kind === 'triage'),
    ).toEqual([]);
    expect(as('codex:engineer').next()?.meta.id).toBe(meta.id);

    // The PM's acceptance approves the work: a breakdown under it is a task, not a finding.
    const sub = as('codex:engineer').addTask({ title: 'add a retry cap', parent: meta.id });
    expect(sub.proposed).toBeUndefined();
    expect(sub.meta.type).toBe('task');
  });

  it('lets the PM park a duplicate and escalate a new direction to the person', () => {
    const { as } = team();
    const eng = as('claude:engineer');
    const dup = eng.addTask({ title: 'Login retries again' }).meta;
    const big = eng.addTask({ title: 'New project: mobile app' }).meta;
    const pm = as('claude:pm');
    expect(pm.park(dup.id, 'duplicate of an accepted bug').view.status).toBe('parked');
    expect(() => eng.park(big.id, 'no')).toThrow(/the PM/);

    pm.assign(big.id, 'human:dawid', `${big.id}: a new project; accept or set aside.`);
    const human = as('human:dawid').inbox();
    expect(human.filter((i) => i.kind === 'triage').map((i) => i.task)).toEqual([big.id]);
    expect(pm.inbox().filter((i) => i.kind === 'triage')).toEqual([]);
  });

  it('lets the PM set priority and owner on unheld work, not on held work', () => {
    const { as } = team();
    const h = as('human:dawid');
    const t = h.newTask({ title: 'route me', owner: 'claude:engineer' });
    const pm = as('claude:pm');
    expect(pm.setPriority(t.id, 'p1').view.meta.priority).toBe('p1');
    as('claude:engineer').start(t.id);
    expect(() => pm.assign(t.id, 'codex:engineer')).toThrow(/held by claude:engineer/);
  });

  it('refuses a PM retype or park of held work; the person may still do both', () => {
    const { as } = team();
    const h = as('human:dawid');
    const a = h.newTask({ title: 'held a', owner: 'claude:engineer' });
    const b = h.newTask({ title: 'held b', owner: 'claude:engineer' });
    const eng = as('claude:engineer');
    eng.start(a.id);
    eng.start(b.id);
    const pm = as('claude:pm');
    expect(() => pm.retype(a.id, 'bug')).toThrow(/held by claude:engineer/);
    expect(() => pm.park(a.id, 'not now')).toThrow(/held by claude:engineer/);
    expect(h.retype(a.id, 'bug').view.meta.type).toBe('bug');
    expect(h.park(b.id, 'not now').view.status).toBe('parked');
  });

  it('lets a PM retype a task it holds itself', () => {
    const { as } = team();
    const t = as('human:dawid').newTask({ title: 'pm work', owner: 'claude:pm' });
    const pm = as('claude:pm');
    pm.start(t.id);
    expect(pm.retype(t.id, 'docs').view.meta.type).toBe('docs');
  });

  it('sends findings to the person when no PM is configured', () => {
    const { as } = team(['claude-engineer', 'codex-reviewer']);
    const f = as('claude:engineer').addTask({ title: 'Login retries' }).meta;
    expect(
      as('human:dawid')
        .inbox()
        .filter((i) => i.kind === 'triage')
        .map((i) => i.task),
    ).toEqual([f.id]);
  });
});

describe('reviews go to an agent of another provider', () => {
  it('picks codex:reviewer for Claude work and claude:reviewer for Codex work', () => {
    const { as } = team();
    const h = as('human:dawid');
    const a = h.newTask({ title: 'claude work', owner: 'claude:engineer' });
    const b = h.newTask({ title: 'codex work', owner: 'codex:engineer' });
    as('claude:engineer').start(a.id);
    as('codex:engineer').start(b.id);

    const ra = as('claude:engineer').review(a.id, `${a.id}: abc1234 on branch \`x\`.`);
    expect(ra.view.reviewer).toBe('codex:reviewer');
    expect(ra.notes?.join('\n')).toMatch(/codex:reviewer, a reviewer of another provider/);
    const rb = as('codex:engineer').review(b.id, `${b.id}: def5678 on branch \`y\`.`);
    expect(rb.view.reviewer).toBe('claude:reviewer');

    expect(
      as('codex:reviewer')
        .inbox()
        .map((i) => [i.kind, i.task]),
    ).toEqual([['review', a.id]]);
    expect(
      as('human:dawid')
        .inbox()
        .filter((i) => i.kind === 'review'),
    ).toEqual([]);
  });

  it('sends a review touching a release, or one sent with --human, to the person', () => {
    const { as } = team();
    const h = as('human:dawid');
    const rel = h.newTask({ title: 'Cut 0.2.0', owner: 'claude:engineer', labels: ['release'] });
    const money = h.newTask({ title: 'Pricing page', owner: 'claude:engineer' });
    const eng = as('claude:engineer');
    eng.start(rel.id);
    const r = eng.review(rel.id, `${rel.id}: abc1234 on branch \`release\`.`);
    expect(r.view.reviewer).toBe('human:dawid');
    expect(r.notes?.join('\n')).toMatch(/only the person reviews/);

    eng.start(money.id);
    expect(
      eng.review(money.id, `${money.id}: def5678 on branch \`p\`.`, undefined, undefined, {
        human: true,
      }).view.reviewer,
    ).toBe('human:dawid');

    const kinds = as('human:dawid')
      .inbox()
      .map((i) => [i.kind, i.task]);
    expect(kinds).toEqual([
      ['review', rel.id],
      ['review', money.id],
    ]);
  });

  it('keeps an explicit --to and falls back to the person without a reviewer agent', () => {
    const { as } = team(['claude-engineer']);
    const h = as('human:dawid');
    const t = h.newTask({ title: 'x', owner: 'claude:engineer' });
    as('claude:engineer').start(t.id);
    expect(as('claude:engineer').review(t.id, 'done').view.reviewer).toBe('human:dawid');
  });
});

describe('asks go to the PM first', () => {
  it('lets the PM answer an ask about a test approach', () => {
    const { as } = team();
    const h = as('human:dawid');
    const t = h.newTask({ title: 'cover login', owner: 'claude:engineer' });
    const eng = as('claude:engineer');
    eng.start(t.id);
    const asked = eng.ask(
      t.id,
      `${t.id}: unit tests or an end-to-end test for the retry cap?`,
      undefined,
      'unit tests',
    );
    expect(asked.view.waitingOn).toBe('claude:pm');
    expect(asked.notes?.join('\n')).toMatch(/sent to claude:pm/);
    expect(
      as('human:dawid')
        .inbox()
        .filter((i) => i.kind === 'ask'),
    ).toEqual([]);
    expect(
      as('claude:pm')
        .inbox()
        .map((i) => [i.kind, i.task]),
    ).toEqual([['ask', t.id]]);

    const ans = as('claude:pm').answer(t.id, 'unit tests: the cap is pure logic');
    expect(ans.view.status).toBe('todo');
    expect(ans.events[0]).toMatchObject({ type: 'answer', to: 'claude:engineer' });
    expect(eng.inbox().some((i) => i.kind === 'message' && i.type === 'answer')).toBe(true);
  });

  it('lets the PM forward a crucial ask; the answer goes back to the agent that asked', () => {
    const { as } = team();
    const h = as('human:dawid');
    const t = h.newTask({ title: 'billing', owner: 'claude:engineer' });
    const eng = as('claude:engineer');
    eng.start(t.id);
    eng.ask(t.id, `${t.id}: which payment provider account do we use?`, undefined, 'Stripe');
    const pm = as('claude:pm');
    expect(() => pm.ask(t.id, 'self', 'claude:pm')).toThrow(/forward it to someone else/);
    const fwd = pm.ask(
      t.id,
      `${t.id}: claude:engineer asks which payment provider account to use; pick one.`,
      undefined,
      'Stripe',
    );
    // The PM's own ask goes to the person, and the original asker stays.
    expect(fwd.view).toMatchObject({ waitingOn: 'human:dawid', askedBy: 'claude:engineer' });
    expect(
      as('human:dawid')
        .inbox()
        .map((i) => [i.kind, i.task]),
    ).toEqual([['ask', t.id]]);
    const ans = h.answer(t.id, 'Stripe');
    expect(ans.events[0]).toMatchObject({ type: 'answer', to: 'claude:engineer' });
  });

  it('sends an ask with --human, or without a PM, to the person', () => {
    const { as } = team();
    const h = as('human:dawid');
    const t = h.newTask({ title: 'x', owner: 'claude:engineer' });
    const eng = as('claude:engineer');
    eng.start(t.id);
    const r = eng.ask(t.id, `${t.id}: delete the old store?`, undefined, 'keep it', {
      human: true,
    });
    expect(r.view.waitingOn).toBe('human:dawid');

    const solo = team(['claude-engineer']);
    const t2 = solo.as('human:dawid').newTask({ title: 'y', owner: 'claude:engineer' });
    solo.as('claude:engineer').start(t2.id);
    expect(solo.as('claude:engineer').ask(t2.id, 'q?').view.waitingOn).toBe('human:dawid');
  });

  it('prefers the chat agent as the PM', () => {
    const { as } = team();
    const user = { opsd: { chat: { agent: 'codex:pm' } } } as UserConfig;
    expect(as('claude:engineer', { user }).triagePm()).toBe('codex:pm');
    expect(as('claude:engineer').triagePm()).toBe('claude:pm');
  });
});
