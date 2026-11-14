// AO-0109, step 5: the PM checks asks, plans and new records against the decision log. A decision
// a person records reaches the PM's inbox, and the PM role template states the three checks.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RECORD_INBOX_DAYS, TEMPLATES_DIR } from '../src/index.js';
import type { InboxItem, Workspace } from '../src/index.js';
import { setup } from './helpers.js';

function team(...slugs: string[]) {
  const s = setup();
  mkdirSync(join(s.rootDir, 'agents'), { recursive: true });
  for (const slug of slugs) {
    writeFileSync(join(s.rootDir, 'agents', `${slug}.md`), '---\nstatus: active\n---\n');
  }
  return s;
}

const records = (ws: Workspace): InboxItem[] => ws.inbox().filter((i) => i.kind === 'record');

describe('a recorded decision reaches the PM inbox', () => {
  it('lists a record of a person for the PM, and for nobody else', () => {
    const { as } = team('claude-pm', 'codex-pm', 'claude-engineer');
    const h = as('human:dawid');
    const old = h.recordDecision({ text: 'swarmupd never merges', project: 'v2' }).meta.id;
    const t = h.newTask({ title: 'merge approved work', owner: 'claude:engineer' });
    const marked = h.comment(t.id, 'Merge it for me from now on.', undefined, {
      text: 'swarmupd merges approved work',
    }).decision!.id;
    const fresh = h.recordDecision({
      text: 'Releases go out on Mondays',
      project: 'v2',
      supersedes: [old],
    }).meta.id;

    const items = records(as('claude:pm'));
    expect(items.map((i) => i.task).sort()).toEqual([old, marked, fresh].sort());
    expect(items.find((i) => i.task === fresh)).toMatchObject({
      kind: 'record',
      from: 'human:dawid',
      title: 'Releases go out on Mondays',
      summary: `decision recorded (project v2; supersedes ${old}): Releases go out on Mondays`,
    });
    expect(items.find((i) => i.task === marked)).toMatchObject({
      summary: `decision recorded (tree ${t.id}): swarmupd merges approved work`,
    });
    // Only the PM that triages gets them.
    expect(records(as('codex:pm'))).toEqual([]);
    expect(records(as('claude:engineer'))).toEqual([]);
    expect(records(as('human:dawid'))).toEqual([]);
  });

  it('leaves out a record the PM wrote down itself, one marked read and an old one', () => {
    const { as } = team('claude-pm', 'claude-engineer');
    const h = as('human:dawid');
    const t = h.newTask({ title: 'x', owner: 'claude:engineer' });
    const said = h.comment(t.id, 'No Slack integration in v2.').events[0]!;
    const pm = as('claude:pm');
    pm.recordDecision({ text: 'No Slack integration in v2', source: `${t.id}#${said.id}` });
    expect(records(pm)).toEqual([]);

    const mine = h.recordDecision({ text: 'Docs stay in plain English' }).meta.id;
    expect(records(pm).map((i) => i.task)).toEqual([mine]);
    // Reading without the flag changes nothing; `--mark-read` clears it.
    expect(records(pm)).toHaveLength(1);
    pm.inbox('claude:pm', { markRead: true });
    expect(records(pm)).toEqual([]);
    // A later record is new again.
    const next = h.recordDecision({ text: 'No AI attribution' }).meta.id;
    expect(records(pm).map((i) => i.task)).toEqual([next]);

    // After `RECORD_INBOX_DAYS` it leaves the inbox unread.
    const later = Date.now() + (RECORD_INBOX_DAYS + 1) * 24 * 3_600_000;
    const pmLater = as('claude:pm', { now: () => later });
    expect(records(pmLater)).toEqual([]);
  });

  it('sends nothing without a PM', () => {
    const { as } = team('claude-engineer');
    as('human:dawid').recordDecision({ text: 'No AI attribution' });
    expect(records(as('claude:engineer'))).toEqual([]);
    expect(records(as('human:dawid'))).toEqual([]);
  });
});

describe('the PM role template', () => {
  const text = readFileSync(join(TEMPLATES_DIR, 'agents', 'claude-pm.md'), 'utf8');

  it('states the ask check and the escalation wording', () => {
    expect(text).toContain('**The ask check.** Before you answer an ask, compare the answer');
    expect(text).toContain('swarmup decisions --log --task <ID>');
    expect(text).toContain(
      'swarmup ask <ID> "contradiction with D-NNNN (YYYY-MM-DD): <the line of the decision>.',
    );
    expect(text).toMatch(/keep: <what the task does then>\. change: <what replaces D-NNNN>\."/);
    expect(text).toContain('--recommend "keep: <why>"');
  });

  it('states the plan check and the conflict note', () => {
    expect(text).toContain('**The plan check.** swarmupd starts you at most once per 30 minutes');
    expect(text).toContain('--to <the worker>');
    expect(text).toContain('**The conflict note.** A `record` item in `swarmup inbox`');
    expect(text).toContain(
      'swarmup comment <ID> "D-0050 conflicts with D-0012 (YYYY-MM-DD): supersede D-0012, or keep',
    );
    expect(text).toContain('names in neither `supersedes`\n  nor `narrows`');
  });
});
