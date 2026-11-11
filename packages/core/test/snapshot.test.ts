import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

describe('workspace snapshot (AO-0171)', () => {
  it('gives the same queue and inbox from one snapshot as from fresh reads', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'mine', owner: 'claude:engineer' });
    h.newTask({ title: 'any engineer', owner: '*:engineer' });
    h.newTask({ title: 'someone else', owner: 'codex:qa' });
    h.comment('1', 'look at this', 'claude:engineer');
    const eng = as('claude:engineer');
    const views = eng.snapshot();
    expect(eng.queue(undefined, { views }).map((v) => v.meta.id)).toEqual(
      eng.queue().map((v) => v.meta.id),
    );
    expect(eng.inbox(undefined, { views })).toEqual(eng.inbox());
    expect(eng.inbox().length).toBeGreaterThan(0);
  });

  it('leaves archived tasks out of a snapshot-based queue', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'open', owner: 'claude:engineer' });
    const eng = as('claude:engineer');
    const views = eng.snapshot().map((v) => ({ ...v, archived: true }));
    expect(eng.queue(undefined, { views })).toEqual([]);
    expect(eng.inbox(undefined, { views })).toEqual([]);
  });
});
