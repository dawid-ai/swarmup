// AO-0065: ask and review events carry a structured recommendation. AO-0066: inbox items name
// the open tasks that wait on them, directly and at any depth.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Workspace } from '../src/index.js';
import { fakeToken, setup } from './helpers.js';

describe('recommendations on ask and review', () => {
  it('writes the recommendation on the ask event and shows it in the inbox, also from the index cache', () => {
    const { as, rootDir, repo, env } = setup();
    as('human:dawid').newTask({ title: 'x' });
    as('claude:engineer').start('1');
    const res = as('claude:engineer').ask('1', 'Which database?', undefined, '  Postgres  ');
    expect(res.warnings).toBeUndefined();
    expect(res.events[0]!.recommend).toBe('Postgres');
    const dir = join(rootDir, 'tasks', 'T-0001', 'events');
    const file = readdirSync(dir).find((n) => n.startsWith(res.events[0]!.id))!;
    expect(readFileSync(join(dir, file), 'utf8')).toMatch(/^recommend: Postgres$/m);
    const item = { kind: 'ask', summary: 'Which database?', recommend: 'Postgres' };
    expect(as('human:dawid').inbox()).toEqual([expect.objectContaining(item)]);
    // A second workspace reads the cached index, which must carry the field too.
    const again = new Workspace({ cwd: repo, env, actor: 'human:dawid' });
    expect(again.inbox()).toEqual([expect.objectContaining(item)]);
    expect(again.showEvents('1').events.at(-1)!.recommend).toBe('Postgres');
  });

  it('carries the recommendation on a review request', () => {
    const { as } = setup();
    as('human:dawid').newTask({ title: 'x' });
    as('claude:engineer').start('1');
    as('claude:engineer').review('1', 'Ready', 'human:dawid', 'approve and merge');
    expect(as('human:dawid').inbox()).toEqual([
      expect.objectContaining({ kind: 'review', recommend: 'approve and merge' }),
    ]);
  });

  it('folds older asks without the field and warns when an ask to a person has none', () => {
    const { as } = setup();
    as('human:dawid').newTask({ title: 'x' });
    as('claude:engineer').start('1');
    const res = as('claude:engineer').ask('1', 'Which database?');
    expect(res.warnings).toEqual([expect.stringMatching(/no --recommend/)]);
    expect(res.events[0]!.recommend).toBeUndefined();
    const [item] = as('human:dawid').inbox();
    expect(item).toMatchObject({ kind: 'ask', summary: 'Which database?' });
    expect(item).not.toHaveProperty('recommend');
  });

  it('does not warn on an ask to an agent', () => {
    const { as } = setup();
    as('human:dawid').newTask({ title: 'x' });
    as('claude:engineer').start('1');
    expect(as('claude:engineer').ask('1', 'Which port?', 'codex:engineer').warnings).toBeFalsy();
  });

  it('refuses a secret in the recommendation and keeps it to one line', () => {
    const { as } = setup();
    as('human:dawid').newTask({ title: 'x' });
    as('claude:engineer').start('1');
    const e = as('claude:engineer');
    expect(() => e.ask('1', 'Which key?', undefined, `use ${fakeToken()}`)).toThrow(/refusing/);
    expect(() => e.ask('1', 'Which?', undefined, 'a'.repeat(501))).toThrow(/500 characters/);
    expect(as('claude:engineer').view('1').status).toBe('in-progress');
    const res = e.ask('1', 'Which?', undefined, 'Postgres,\n  because it is in use');
    expect(res.events[0]!.recommend).toBe('Postgres, because it is in use');
  });
});

describe('what an inbox item blocks', () => {
  it('lists direct waiters (block --on, blocked_by, open children) and indirect ones', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'asks' }); // T-0001
    h.newTask({ title: 'blocks on 1' }); // T-0002
    h.newTask({ title: 'blocked_by 1', blockedBy: ['1'] }); // T-0003
    h.newTask({ title: 'child of 1', parent: '1' }); // T-0004
    h.newTask({ title: 'blocks on 3' }); // T-0005
    h.newTask({ title: 'done child', parent: '1' }); // T-0006
    const e = as('claude:engineer');
    e.start('2');
    e.block('2', 'needs 1', { on: ['1'] });
    e.start('5');
    e.block('5', 'needs 3', { on: ['3'] });
    e.start('6');
    e.done('6');
    e.start('1');
    e.ask('1', 'Which way?', undefined, 'left');
    const expected = { direct: ['T-0002', 'T-0003', 'T-0004'], indirect: ['T-0005'] };
    expect(h.blocks('1')).toEqual(expected);
    expect(h.inbox()).toEqual([
      expect.objectContaining({ kind: 'ask', task: 'T-0001', blocks: expected }),
    ]);
  });

  it('ends at a cycle and never lists the task itself', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'a' }); // T-0001
    h.newTask({ title: 'b' }); // T-0002
    h.newTask({ title: 'c' }); // T-0003
    const e = as('claude:engineer');
    // 2 waits on 1 and 3; 3 waits on 2; 1 waits on 3: every task is in a cycle.
    e.start('2');
    e.block('2', 'needs 1 and 3', { on: ['1', '3'] });
    e.start('3');
    e.block('3', 'needs 2', { on: ['2'] });
    e.start('1');
    e.block('1', 'needs 3', { on: ['3'] });
    expect(h.blocks('1')).toEqual({ direct: ['T-0002'], indirect: ['T-0003'] });
    expect(h.blocks('3')).toEqual({ direct: ['T-0001', 'T-0002'], indirect: [] });
  });

  it('leaves out waiters whose dependencies all closed, and items that block nothing', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'dep' }); // T-0001
    h.newTask({ title: 'waits', blockedBy: ['1'] }); // T-0002
    h.newTask({ title: 'review me' }); // T-0003
    const e = as('claude:engineer');
    e.start('1');
    e.done('1');
    expect(h.blocks('1')).toEqual({ direct: [], indirect: [] });
    e.start('3');
    e.review('3', 'Ready', 'human:dawid');
    const [item] = h.inbox();
    expect(item).toMatchObject({ kind: 'review', task: 'T-0003' });
    expect(item).not.toHaveProperty('blocks');
  });
});
