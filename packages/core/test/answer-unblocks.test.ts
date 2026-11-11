// AO-0068: an answer, unblock or approving verdict records the tasks it let move, how long the
// request waited, and whether it took the recommendation.
import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

const T0 = Date.parse('2026-11-01T09:00:00Z');
const MIN = 60_000;

function team() {
  const s = setup();
  let now = T0;
  const at = (actor: string) => s.as(actor, { now: () => now });
  const h = at('human:dawid');
  h.newTask({ title: 'asks' }); // T-0001
  h.newTask({ title: 'blocks on 1' }); // T-0002
  h.newTask({ title: 'blocks on 2' }); // T-0003
  const e = at('claude:engineer');
  e.start('2');
  e.block('2', 'needs 1', { on: ['1'] });
  e.start('3');
  e.block('3', 'needs 2', { on: ['2'] });
  e.start('1');
  return { ...s, at, h, e, tick: (min: number) => (now += min * MIN) };
}

describe('what an answer frees', () => {
  it('records the task, its waiters, the wait and an accepted recommendation on the answer', () => {
    const { at, e, tick } = team();
    e.ask('1', 'Which way?', undefined, 'Left.');
    tick(90);
    const ev = at('human:dawid').answer('1', 'left').events[0]!;
    expect(ev).toMatchObject({
      type: 'answer',
      freed: ['T-0001', 'T-0002'],
      freed_indirect: ['T-0003'],
      waited_minutes: 90,
      accepted: true,
    });
    // The fields are written to the event file and read back.
    expect(at('human:dawid').showEvents('1').events.at(-1)).toMatchObject({
      freed: ['T-0001', 'T-0002'],
      waited_minutes: 90,
      accepted: true,
    });
  });

  it('marks a different answer as not accepted and leaves accepted out without a recommendation', () => {
    const { at, e, tick } = team();
    e.ask('1', 'Which way?', undefined, 'left');
    tick(5);
    expect(at('human:dawid').answer('1', 'right').events[0]!.accepted).toBe(false);
    e.start('1');
    e.ask('1', 'And now?');
    const ev = at('human:dawid').answer('1', 'up').events[0]!;
    expect(ev).not.toHaveProperty('accepted');
    expect(ev.waited_minutes).toBe(0);
  });

  it('counts the same on an unblock', () => {
    const { at, e, tick } = team();
    e.block('1', 'waiting for the key');
    tick(30);
    const ev = at('human:dawid').unblock('1', 'key is in place').events[0]!;
    expect(ev).toMatchObject({
      type: 'unblock',
      freed: ['T-0001', 'T-0002'],
      freed_indirect: ['T-0003'],
      waited_minutes: 30,
    });
    expect(ev).not.toHaveProperty('accepted');
  });

  it('counts the waiters, not the task, on an approving verdict, and nothing on changes', () => {
    const { at, e, tick } = team();
    e.review('1', 'Ready', 'human:dawid', 'approve and merge');
    tick(120);
    const changes = at('human:dawid').verdict('1', 'changes', 'fix the test').events[0]!;
    expect(changes).not.toHaveProperty('freed');
    expect(changes).toMatchObject({ waited_minutes: 120, accepted: false });
    e.start('1');
    e.review('1', 'Fixed', 'human:dawid', 'approve');
    tick(10);
    const ok = at('human:dawid').verdict('1', 'approve', '').events[0]!;
    expect(ok).toMatchObject({
      freed: ['T-0002'],
      freed_indirect: ['T-0003'],
      waited_minutes: 10,
      accepted: true,
    });
  });

  it('writes an empty freed list when nothing waits, so the answer still counts as measured', () => {
    const { at, h } = team();
    h.newTask({ title: 'alone' }); // T-0004
    const e = at('claude:engineer');
    e.start('4');
    e.review('4', 'Ready', 'human:dawid');
    const ev = at('human:dawid').verdict('4', 'approve', 'ok').events[0]!;
    expect(ev.freed).toEqual([]);
    expect(ev).not.toHaveProperty('freed_indirect');
    expect(ev).not.toHaveProperty('accepted');
  });

  it('records what a triage answer frees', () => {
    const s = team();
    const { at, h } = s;
    h.newTask({ title: 'found', type: 'finding' }); // T-0004
    s.as('claude:engineer', { force: true }).start('4');
    at('claude:engineer').ask('4', 'Bug or idea?', undefined, 'bug');
    const res = h.retype('4', 'bug', '', { answer: 'Bug' });
    expect(res.events.find((x) => x.type === 'answer')).toMatchObject({
      freed: ['T-0004'],
      accepted: true,
    });
  });
});
