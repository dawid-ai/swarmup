import { readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ActResult, Workspace } from '../src/index.js';
import { OpsError, readDecisionFiles } from '../src/index.js';
import { setup } from './helpers.js';

/** The exit code a call fails with, or 0 when it does not throw. */
function code(fn: () => unknown): number {
  try {
    fn();
  } catch (err) {
    if (err instanceof OpsError) return err.code;
    throw err;
  }
  return 0;
}

function world() {
  const s = setup();
  let t = Date.parse('2026-11-03T10:00:00Z');
  const now = (): number => (t += 60_000);
  const h = s.as('human:dawid', { now });
  const eng = s.as('claude:engineer', { now });
  const root = h.roots[0]!;
  const eventFiles = (task: string): string[] =>
    readdirSync(join(root.taskDir(task), 'events')).sort();
  return { ...s, h, eng, now, root, eventFiles };
}

/** The record and the event of a marked write, checked against each other. */
function expectMark(ws: Workspace, res: ActResult, type: string, task: string): string {
  const root = ws.roots[0]!;
  const ev = res.events[0]!;
  expect(ev.type).toBe(type);
  expect(res.decision).toBeDefined();
  const id = res.decision!.id;
  // The event carries the record's id, and the record names the event as its source.
  expect(ev.decision).toBe(id);
  expect(root.readEvents(task).find((e) => e.id === ev.id)?.decision).toBe(id);
  const meta = readDecisionFiles(root, id, Date.now()).meta;
  expect(meta).toMatchObject({
    kind: 'record',
    source: `${task}#${ev.id}`,
    created_by: 'human:dawid',
    created_at: ev.at,
  });
  expect(meta.recorded_by).toBeUndefined();
  return id;
}

describe('decision marks: --decision on a task event', () => {
  it('marks an answer: the record is in the log with the task and the person as source', () => {
    const { h, eng } = world();
    const task = h.newTask({ title: 'merge policy', project: 'p', owner: 'claude:engineer' }).id;
    const child = h.newTask({ title: 'below', parent: task }).id;
    const side = h.newTask({ title: 'beside', project: 'p' }).id;
    eng.start(task);
    eng.ask(task, 'PR or merge?', 'human:dawid', 'pr');

    const res = h.answer(task, 'pr; I merge', { text: 'swarmupd opens PRs; Dawid merges' });
    const id = expectMark(h, res, 'answer', task);
    expect(res.view.status).toBe('todo');
    // Default scope: the tree of the event's task.
    expect(res.decision).toMatchObject({ scope: 'tree', task, project: 'p' });
    expect(h.decisionLog()).toMatchObject([
      {
        id,
        text: 'swarmupd opens PRs; Dawid merges',
        scope: 'tree',
        task,
        by: 'human:dawid',
        source: `${task}#${res.events[0]!.id}`,
      },
    ]);
    expect(h.decisionLog({ task: child }).map((e) => e.id)).toEqual([id]);
    expect(h.decisionLog({ task: side })).toEqual([]);
    expect(h.eventMarks(task).get(res.events[0]!.id)).toEqual([
      { id, text: 'swarmupd opens PRs; Dawid merges', scope: `tree ${task}`, by: 'human:dawid' },
    ]);
    expect(h.decisionProblems()).toEqual([]);
  });

  it('marks a verdict', () => {
    const { h, eng } = world();
    const task = h.newTask({ title: 'docs', owner: 'claude:engineer' }).id;
    eng.start(task);
    eng.review(task, 'SECURITY.md is ready', 'human:dawid');
    const res = h.verdict(task, 'changes', 'Too much jargon.', {
      text: 'SECURITY.md stays in plain English, no jargon',
    });
    expectMark(h, res, 'verdict', task);
    expect(res.events[0]).toMatchObject({ verdict: 'changes' });
  });

  it('marks a comment, with --scope project', () => {
    const { h } = world();
    const task = h.newTask({ title: 'subtasks', project: 'p' }).id;
    const other = h.newTask({ title: 'elsewhere in p', project: 'p' }).id;
    const res = h.comment(task, 'If it is part of an approved task ...', undefined, {
      text: 'Subtasks of an approved task need no approval',
      scope: 'project',
    });
    const id = expectMark(h, res, 'comment', task);
    expect(res.decision).toMatchObject({ scope: 'project', project: 'p', task });
    expect(h.decisionLog({ task: other }).map((e) => e.id)).toEqual([id]);
  });

  it('marks a retype on the retype event, not on the events written with it', () => {
    const { h } = world();
    const task = h.newTask({ title: 'a decision log', type: 'finding' }).id;
    const res = h.retype(task, 'task', 'Accepted', {
      to: 'claude:engineer',
      priority: 'p1',
      mark: { text: 'Decisions are logged and checked' },
    });
    expectMark(h, res, 'retype', task);
    expect(res.events.map((e) => [e.type, e.decision !== undefined])).toEqual([
      ['retype', true],
      ['priority', false],
      ['assign', false],
    ]);
  });

  it('marks a park', () => {
    const { h } = world();
    const task = h.newTask({ title: 'Slack integration' }).id;
    const res = h.park(task, 'Not now', { text: 'No Slack integration in v2' });
    expectMark(h, res, 'park', task);
    expect(res.view.status).toBe('parked');
  });

  it('takes the widest superseded scope with --supersedes, and checks --narrows', () => {
    const { h } = world();
    const task = h.newTask({ title: 'in p', project: 'p' }).id;
    const old = h.recordDecision({ text: 'swarmupd never merges', project: 'p' }).meta.id;

    // No --scope: the replacement covers what it replaces, the project.
    const next = h.comment(task, 'change', undefined, {
      text: 'swarmupd merges approved branches',
      supersedes: [old],
    });
    expect(next.decision).toMatchObject({ scope: 'project', project: 'p', supersedes: [old] });
    expect(h.decisionLog().map((e) => e.id)).toEqual([next.decision!.id]);

    // For this tree only: an exception to the project rule.
    const narrow = h.comment(task, 'only here', undefined, {
      text: 'This tree opens PRs',
      narrows: [next.decision!.id],
    });
    expect(narrow.decision).toMatchObject({ scope: 'tree', task, narrows: [next.decision!.id] });

    // A tree is inside the project scope, so it cannot supersede it; nothing is written.
    const before = h.roots[0]!.readEvents(task).length;
    expect(
      code(() =>
        h.comment(task, 'x', undefined, {
          text: 'x',
          scope: 'tree',
          supersedes: [next.decision!.id],
        }),
      ),
    ).toBe(2);
    expect(code(() => h.comment(task, 'x', undefined, { text: 'x', scope: 'all' }))).toBe(2);
    expect(code(() => h.comment(task, 'x', undefined, { text: 'x', supersedes: ['D-0999'] }))).toBe(
      2,
    );
    expect(h.roots[0]!.readEvents(task)).toHaveLength(before);
    expect(h.decisionLog({ all: true })).toHaveLength(3);
  });

  it('refuses a mark over 200 characters or with a line break, and writes nothing', () => {
    const { h, root } = world();
    const task = h.newTask({ title: 'a task' }).id;
    expect(code(() => h.comment(task, 'text', undefined, { text: 'x'.repeat(201) }))).toBe(2);
    expect(code(() => h.comment(task, 'text', undefined, { text: 'one\ntwo' }))).toBe(2);
    expect(code(() => h.comment(task, 'text', undefined, { text: '  ' }))).toBe(2);
    expect(code(() => h.park(task, 'no', { text: 'x'.repeat(201) }))).toBe(2);
    expect(root.readEvents(task)).toEqual([]);
    expect(h.decisionLog()).toEqual([]);
    // 200 characters fit.
    expect(code(() => h.comment(task, 'text', undefined, { text: 'x'.repeat(200) }))).toBe(0);
  });

  it('refuses a mark by an agent with exit 1 and writes neither file', () => {
    const { h, eng, root, ...s } = world();
    const task = h.newTask({ title: 'a task', owner: 'claude:engineer' }).id;
    const pm = s.as('claude:pm');
    const before = root.readEvents(task).length;

    expect(code(() => eng.comment(task, 'my choice', undefined, { text: 'Use SQLite' }))).toBe(1);
    // The PM records only what a person wrote, and its own event is not that.
    expect(code(() => pm.comment(task, 'noted', undefined, { text: 'Use SQLite' }))).toBe(1);
    expect(code(() => pm.park(task, 'no', { text: 'Not in v2' }))).toBe(1);
    expect(
      code(() => pm.retype(task, 'bug', 'accepted', { mark: { text: 'Bugs come first' } })),
    ).toBe(1);
    expect(root.readEvents(task)).toHaveLength(before);
    expect(h.decisionLog()).toEqual([]);
    expect(h.view(task).status).toBe('todo');

    // The same write without a mark goes through.
    expect(code(() => eng.comment(task, 'my choice'))).toBe(0);
  });

  it('writes no record when the task refuses the event', () => {
    const { h, root } = world();
    const task = h.newTask({ title: 'not blocked' }).id;
    // Nothing waits for an answer, and nothing waits for a review.
    expect(code(() => h.answer(task, 'yes', { text: 'Yes to all' }))).toBe(1);
    expect(code(() => h.verdict(task, 'approve', 'ok', { text: 'Approved' }))).toBe(1);
    expect(root.readEvents(task)).toEqual([]);
    expect(h.decisionLog()).toEqual([]);
  });

  it('reports a record whose source event does not exist', () => {
    const { h, root, eventFiles } = world();
    const task = h.newTask({ title: 'a task' }).id;
    const kept = h.comment(task, 'first', undefined, { text: 'Kept decision' });
    const lost = h.comment(task, 'second', undefined, { text: 'Lost decision' });
    expect(h.decisionProblems()).toEqual([]);

    // A sync orders an unpushed event after the remote's by giving it a new id. The record keeps
    // the old id; the event still names the record, so its source is not missing.
    const dir = join(root.taskDir(task), 'events');
    const first = eventFiles(task).find((n) => n.startsWith(kept.events[0]!.id))!;
    renameSync(join(dir, first), join(dir, `7ZZZZZZZZZZZZZZZZZZZZZZZZZ${first.slice(26)}`));
    expect(h.decisionProblems()).toEqual([]);
    expect(h.eventMarks(task).get('7ZZZZZZZZZZZZZZZZZZZZZZZZZ')).toMatchObject([
      { id: kept.decision!.id },
    ]);

    // The event write failed after the record was written.
    rmSync(
      join(
        dir,
        eventFiles(task).find((n) => n.startsWith(lost.events[0]!.id))!,
      ),
    );
    expect(h.decisionProblems()).toMatchObject([
      {
        root: 'test',
        id: lost.decision!.id,
        kind: 'source',
        detail: expect.stringContaining(`${task}#${lost.events[0]!.id}`),
      },
    ]);
  });

  it('shows a record the PM made from a person’s event on that event', () => {
    const { h, ...s } = world();
    const task = h.newTask({ title: 'a task' }).id;
    const ev = h.comment(task, 'Subtasks of an approved task need no approval.').events[0]!;
    const id = s.as('claude:pm').recordDecision({
      text: 'Subtasks need no approval',
      source: `${task}#${ev.id}`,
    }).meta.id;
    expect(h.eventMarks(task).get(ev.id)).toEqual([
      {
        id,
        text: 'Subtasks need no approval',
        scope: `tree ${task}`,
        by: 'human:dawid',
        recorded_by: 'claude:pm',
      },
    ]);
  });
});
