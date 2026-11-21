import { describe, expect, it } from 'vitest';
import type { OpsEvent } from '../src/index.js';
import { BRIEF_TYPE, foldBrief } from '../src/index.js';
import { setup } from './helpers.js';

const ev = (id: string, type: string, body: string, actor = 'claude:pm'): OpsEvent => ({
  id,
  type,
  actor,
  at: '2026-11-21T10:00:00.000Z',
  body,
});

describe('goal briefs', () => {
  it('folds to the newest brief by event id, skipping empty ones and other events', () => {
    expect(foldBrief([])).toBeNull();
    const events = [
      ev('01M7Y0000000000000000000B2', BRIEF_TYPE, '## Outcome\nsecond'),
      ev('01M7Y0000000000000000000B1', BRIEF_TYPE, 'first'),
      ev('01M7Y0000000000000000000B3', BRIEF_TYPE, '   '),
      ev('01M7Y0000000000000000000B4', 'comment', 'not a brief'),
    ];
    expect(foldBrief(events)).toEqual({
      event: '01M7Y0000000000000000000B2',
      actor: 'claude:pm',
      at: '2026-11-21T10:00:00.000Z',
      body: '## Outcome\nsecond',
    });
  });

  it('writes a brief as a history event that changes no state, and reads the newest', () => {
    const { as } = setup();
    const human = as('human:dawid');
    const m = human.newTask({
      title: 'Ship signing',
      type: 'milestone',
      doneWhen: ['The signed build passes the signature check'],
    });
    const before = human.view(m.id);
    expect(human.briefOf(m.id)).toBeNull();
    const pm = as('claude:pm');
    pm.brief(m.id, '## Outcome\nSigned builds.\n');
    pm.brief(m.id, '## Outcome\nSigned builds.\n\n## Next\nCI job.');
    const after = human.view(m.id);
    expect(after.status).toBe(before.status);
    expect(after.owner).toBe(before.owner);
    const b = human.briefOf(m.id);
    expect(b?.actor).toBe('claude:pm');
    expect(b?.body).toBe('## Outcome\nSigned builds.\n\n## Next\nCI job.');
    expect(human.showEvents(m.id).events.filter((e) => e.type === BRIEF_TYPE)).toHaveLength(2);
  });

  it('refuses an empty brief', () => {
    const { as } = setup();
    const human = as('human:dawid');
    const t = human.newTask({ title: 'Parent' });
    expect(() => human.brief(t.id, '  \n')).toThrow(/needs text/);
  });
});
