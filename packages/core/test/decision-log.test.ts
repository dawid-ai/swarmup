import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatSourceMessage, Workspace } from '../src/index.js';
import { OpsError, stringifyDoc, writeOutcome } from '../src/index.js';
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

/** The ids in force for a task, newest first. */
const forTask = (ws: Workspace, task: string): string[] =>
  ws.decisionLog({ task }).map((e) => e.id);

/** A clock that moves one minute per reading, so records have distinct, ordered dates. */
function clock(): () => number {
  let t = Date.parse('2026-11-03T10:00:00Z');
  return () => (t += 60_000);
}

function world() {
  const s = setup();
  const now = clock();
  const h = s.as('human:dawid', { now });
  return { ...s, h, now };
}

describe('decision log: scope', () => {
  it('matches a tree across a parent chain and a project by the task project', () => {
    const { h } = world();
    const top = h.newTask({ title: 'top', project: 'p' }).id;
    const child = h.newTask({ title: 'child', parent: top }).id;
    const grand = h.newTask({ title: 'grandchild', parent: child }).id;
    const side = h.newTask({ title: 'beside the tree', project: 'p' }).id;
    const other = h.newTask({ title: 'another project', project: 'q' }).id;

    const tree = h.recordDecision({ text: 'tree at the top', task: top }).meta;
    expect(tree).toMatchObject({ kind: 'record', scope: 'tree', project: 'p', task: top });
    const project = h.recordDecision({ text: 'all of p', project: 'p' }).meta.id;
    const root = h.recordDecision({ text: 'the whole root' }).meta.id;
    const sub = h.recordDecision({ text: 'tree at the child', task: child }).meta.id;

    expect(forTask(h, top)).toEqual([root, project, tree.id]);
    expect(forTask(h, child)).toEqual([sub, root, project, tree.id]);
    // A task two levels down is under both trees.
    expect(forTask(h, grand)).toEqual([sub, root, project, tree.id]);
    // In the project, outside the tree.
    expect(forTask(h, side)).toEqual([root, project]);
    // Outside the project and the tree: only the root-wide decision.
    expect(forTask(h, other)).toEqual([root]);
  });

  it('lists a record made by a person, and filters the log by project', () => {
    const { h } = world();
    h.newTask({ title: 'in p', project: 'p' });
    const q = h.newTask({ title: 'in q', project: 'q' }).id;
    const a = h.recordDecision({ text: 'No AI attribution in any repo', project: 'p' }).meta.id;
    const b = h.recordDecision({ text: 'Tray app first', task: q }).meta.id;
    const c = h.recordDecision({ text: 'Root-wide rule' }).meta.id;
    const log = h.decisionLog();
    expect(log.map((e) => e.id)).toEqual([c, b, a]);
    expect(log[2]).toMatchObject({
      text: 'No AI attribution in any repo',
      scope: 'project',
      project: 'p',
      by: 'human:dawid',
      state: 'recorded',
    });
    // A project filter keeps its own decisions and the root-wide ones, and trees in that project.
    expect(h.decisionLog({ project: 'p' }).map((e) => e.id)).toEqual([c, a]);
    expect(h.decisionLog({ project: 'q' }).map((e) => e.id)).toEqual([c, b]);
    // Votes stay a list of their own: a record is not an open vote.
    expect(h.decisions({ all: true })).toEqual([]);
    expect(h.decision(a).tally.state).toBe('recorded');
  });

  it('takes the scope the flags name', () => {
    const { h } = world();
    const t = h.newTask({ title: 'task', project: 'p' }).id;
    // --scope project on a task: the task's project, and the task is where it came from.
    expect(h.recordDecision({ text: 'widened', task: t, scope: 'project' }).meta).toMatchObject({
      scope: 'project',
      project: 'p',
      task: t,
    });
    expect(code(() => h.recordDecision({ text: 'no top', scope: 'tree' }))).toBe(2);
    expect(code(() => h.recordDecision({ text: 'x', scope: 'everything' }))).toBe(2);
    expect(code(() => h.recordDecision({ text: 'x', scope: 'tree', task: t, project: 'q' }))).toBe(
      2,
    );
  });
});

describe('decision log: supersede and narrow', () => {
  it('project supersedes project in the same project, and takes the old scope by default', () => {
    const { h } = world();
    const t = h.newTask({ title: 'in p', project: 'p' }).id;
    const old = h.recordDecision({ text: 'swarmupd never merges', project: 'p' }).meta.id;
    // No --scope: the new record takes the scope of the one it supersedes.
    const fresh = h.recordDecision({ text: 'swarmupd merges', supersedes: [old] }).meta;
    expect(fresh).toMatchObject({ scope: 'project', project: 'p', supersedes: [old] });
    expect(forTask(h, t)).toEqual([fresh.id]);
    expect(h.decision(old).tally.state).toBe('superseded');
    expect(h.decisionLog().map((e) => e.id)).toEqual([fresh.id]);
    const all = h.decisionLog({ all: true });
    expect(all.map((e) => [e.id, e.state])).toEqual([
      [fresh.id, 'recorded'],
      [old, 'superseded'],
    ]);
    expect(all[1]!.replaced).toEqual([{ by: fresh.id, how: 'superseded', where: 'in project p' }]);
  });

  it('project P supersedes tree T when every task of T is in P', () => {
    const { h } = world();
    const top = h.newTask({ title: 'top', project: 'p' }).id;
    const sub = h.newTask({ title: 'sub', parent: top }).id;
    const old = h.recordDecision({ text: 'old for the tree', task: top }).meta.id;
    const fresh = h.recordDecision({ text: 'new', project: 'p', supersedes: [old] });
    expect(fresh.warnings).toEqual([]);
    expect(forTask(h, top)).toEqual([fresh.meta.id]);
    expect(forTask(h, sub)).toEqual([fresh.meta.id]);
    expect(h.decision(old).tally.state).toBe('superseded');
  });

  it('keeps the old decision for a subtask in another project (cross-project descendant)', () => {
    const { h } = world();
    const top = h.newTask({ title: 'top', project: 'p' }).id;
    const s = h.newTask({ title: 'in q under the tree', parent: top, project: 'q' }).id;
    const old = h.recordDecision({ text: 'old for the tree', task: top }).meta.id;
    const fresh = h.recordDecision({ text: 'new for p', project: 'p', supersedes: [old] }).meta.id;
    expect(forTask(h, s)).toEqual([old]);
    expect(forTask(h, top)).toEqual([fresh]);
    const entry = h.decisionLog().find((e) => e.id === old)!;
    expect(entry.state).toBe('recorded');
    expect(entry.in_force_for).toEqual([s]);
    expect(entry.replaced).toEqual([{ by: fresh, how: 'superseded', where: 'in project p' }]);
    expect(h.decision(old).tally.state).toBe('recorded');
  });

  it('judges a subtask made after the supersede by the same rule (late descendant)', () => {
    const { h } = world();
    const top = h.newTask({ title: 'top', project: 'p' }).id;
    const old = h.recordDecision({ text: 'old for the tree', task: top }).meta.id;
    const fresh = h.recordDecision({ text: 'new for p', project: 'p', supersedes: [old] }).meta.id;
    // Every task of the tree is in p for now.
    expect(h.decision(old).tally.state).toBe('superseded');
    const s = h.newTask({ title: 'added later in q', parent: top, project: 'q' }).id;
    expect(forTask(h, s)).toEqual([old]);
    expect(forTask(h, top)).toEqual([fresh]);
    const entry = h.decisionLog().find((e) => e.id === old)!;
    expect(entry.state).toBe('recorded');
    expect(entry.in_force_for).toEqual([s]);
  });

  it('tree T supersedes tree U below it; refuses U above it or in another tree', () => {
    const { h } = world();
    const top = h.newTask({ title: 'top', project: 'p' }).id;
    const mid = h.newTask({ title: 'mid', parent: top }).id;
    const leaf = h.newTask({ title: 'leaf', parent: mid }).id;
    const apart = h.newTask({ title: 'another tree', project: 'p' }).id;
    const onMid = h.recordDecision({ text: 'for the middle tree', task: mid }).meta.id;
    const onTop = h.recordDecision({ text: 'for the top tree', task: top }).meta.id;
    const onApart = h.recordDecision({ text: 'for the other tree', task: apart }).meta.id;

    // U above T: the new scope is inside the old one, which is an exception.
    const inside = () =>
      h.recordDecision({ text: 'x', scope: 'tree', task: leaf, supersedes: [onMid] });
    expect(code(inside)).toBe(2);
    expect(inside).toThrow(/--narrows/);
    // Another tree: the two can never share a task.
    const disjoint = () =>
      h.recordDecision({ text: 'x', scope: 'tree', task: mid, supersedes: [onApart] });
    expect(code(disjoint)).toBe(2);
    expect(disjoint).toThrow(/never share a task/);

    const fresh = h.recordDecision({
      text: 'replaces the middle tree',
      scope: 'tree',
      task: top,
      supersedes: [onMid],
    }).meta.id;
    expect(forTask(h, leaf)).toEqual([fresh, onTop]);
    expect(h.decision(onMid).tally.state).toBe('superseded');
  });

  it('refuses a tree that supersedes a project, pointing at --narrows', () => {
    const { h } = world();
    const t = h.newTask({ title: 'task', project: 'p' }).id;
    const old = h.recordDecision({ text: 'project rule', project: 'p' }).meta.id;
    const call = () => h.recordDecision({ text: 'x', scope: 'tree', task: t, supersedes: [old] });
    expect(code(call)).toBe(2);
    expect(call).toThrow(new RegExp(`use --narrows ${old}`));
  });

  it('tree T narrows project P: the new one under T, the old one elsewhere in P', () => {
    const { h } = world();
    const top = h.newTask({ title: 'top', project: 'p' }).id;
    const under = h.newTask({ title: 'under the tree', parent: top }).id;
    const beside = h.newTask({ title: 'in p, outside the tree', project: 'p' }).id;
    const old = h.recordDecision({ text: 'project rule', project: 'p' }).meta.id;
    const fresh = h.recordDecision({ text: 'exception', task: top, narrows: [old] }).meta;
    expect(fresh).toMatchObject({ scope: 'tree', task: top, narrows: [old] });
    expect(forTask(h, under)).toEqual([fresh.id]);
    expect(forTask(h, beside)).toEqual([old]);
    const entry = h.decisionLog().find((e) => e.id === old)!;
    expect(entry.state).toBe('recorded');
    expect(entry.replaced).toEqual([{ by: fresh.id, how: 'narrowed', where: `under ${top}` }]);
    // A narrowing needs a strictly smaller scope.
    const same = () => h.recordDecision({ text: 'x', project: 'p', narrows: [old] });
    expect(code(same)).toBe(2);
    expect(same).toThrow(/--supersedes/);
  });

  it('refuses a project Q record that supersedes or narrows a project P record', () => {
    const { h } = world();
    h.newTask({ title: 'in p', project: 'p' });
    h.newTask({ title: 'in q', project: 'q' });
    const old = h.recordDecision({ text: 'rule of p', project: 'p' }).meta.id;
    expect(code(() => h.recordDecision({ text: 'x', project: 'q', supersedes: [old] }))).toBe(2);
    expect(code(() => h.recordDecision({ text: 'x', project: 'q', narrows: [old] }))).toBe(2);
    expect(h.decisionLog().map((e) => e.id)).toEqual([old]);
  });

  it('narrows the whole root to a project, and refuses unknown or doubled targets', () => {
    const { h } = world();
    const p = h.newTask({ title: 'in p', project: 'p' }).id;
    const q = h.newTask({ title: 'in q', project: 'q' }).id;
    const old = h.recordDecision({ text: 'root rule' }).meta.id;
    const fresh = h.recordDecision({ text: 'p differs', project: 'p', narrows: [old] }).meta.id;
    expect(forTask(h, p)).toEqual([fresh]);
    expect(forTask(h, q)).toEqual([old]);
    expect(code(() => h.recordDecision({ text: 'x', supersedes: ['D-0999'] }))).toBe(2);
    expect(code(() => h.recordDecision({ text: 'x', supersedes: ['nope'] }))).toBe(2);
    expect(code(() => h.recordDecision({ text: 'x', supersedes: [old], narrows: [old] }))).toBe(2);
  });

  it('warns when a project record supersedes a tree with no task in that project', () => {
    const { h } = world();
    const top = h.newTask({ title: 'top in q', project: 'q' }).id;
    const old = h.recordDecision({ text: 'tree rule', task: top }).meta.id;
    const res = h.recordDecision({ text: 'for p', project: 'p', supersedes: [old] });
    expect(res.warnings.join(' ')).toMatch(/no task under/);
    expect(forTask(h, top)).toEqual([old]);
  });
});

describe('decision log: decided votes', () => {
  const vote = (h: Workspace, question: string, task?: string): string =>
    h.propose({ question, options: ['A', 'B'], voters: ['human:dawid'], task }).id;

  it('derives the scope of a decided vote from its task', () => {
    const { h, rootDir } = world();
    const top = h.newTask({ title: 'top', project: 'p' }).id;
    const sub = h.newTask({ title: 'sub', parent: top }).id;
    const beside = h.newTask({ title: 'beside', project: 'p' }).id;
    const onTask = vote(h, 'Shell?', top);
    const noTask = vote(h, 'Name?');
    const open = vote(h, 'Still open?');
    // A vote whose task is gone: the frontmatter names an id the root does not hold.
    const gone = vote(h, 'Gone?');
    const file = join(rootDir, 'decisions', gone, 'decision.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('question:', 'task: T-0999\nquestion:'));

    // An open vote is not in the log.
    expect(h.decisionLog()).toEqual([]);
    h.decide(onTask, 'A');
    h.decide(noTask, 'B');
    h.decide(gone, 'A');
    const log = new Map(h.decisionLog().map((e) => [e.id, e]));
    expect(log.has(open)).toBe(false);
    expect(log.get(onTask)).toMatchObject({
      kind: 'vote',
      text: 'Shell? → A',
      scope: 'tree',
      project: 'p',
      task: top,
      by: 'human:dawid',
    });
    expect(log.get(noTask)).toMatchObject({ scope: 'project', text: 'Name? → B' });
    expect(log.get(noTask)!.project).toBeUndefined();
    // Task missing: a tree at that id, with no project.
    expect(log.get(gone)).toMatchObject({ scope: 'tree', task: 'T-0999' });
    expect(log.get(gone)!.project).toBeUndefined();

    expect(forTask(h, sub)).toEqual([noTask, onTask]);
    expect(forTask(h, beside)).toEqual([noTask]);
  });

  it('stores the scope given to swarmup decide, and a record can supersede a vote', () => {
    const { h, rootDir } = world();
    const top = h.newTask({ title: 'top', project: 'p' }).id;
    const beside = h.newTask({ title: 'beside', project: 'p' }).id;
    const v = vote(h, 'Shell?', top);
    expect(code(() => h.decide(v, 'A', '', { scope: 'root' }))).toBe(2);
    h.decide(v, 'A', '', { scope: 'project' });
    const dir = join(rootDir, 'decisions', v, 'outcomes');
    const text = readFileSync(join(dir, readdirSync(dir)[0]!), 'utf8');
    expect(text).toMatch(/^scope: project$/m);
    expect(text).toMatch(/^project: p$/m);
    expect(forTask(h, beside)).toEqual([v]);
    // A tree scope needs a task to be the top of.
    const bare = vote(h, 'No task?');
    expect(code(() => h.decide(bare, 'A', '', { scope: 'tree' }))).toBe(2);

    const fresh = h.recordDecision({ text: 'Tauri after all', supersedes: [v] }).meta;
    expect(fresh).toMatchObject({ scope: 'project', project: 'p' });
    expect(forTask(h, beside)).toEqual([fresh.id]);
    expect(h.decisionLog({ all: true }).find((e) => e.id === v)!.state).toBe('superseded');
    // An undecided vote is not in the log, so nothing can supersede it.
    expect(code(() => h.recordDecision({ text: 'x', supersedes: [bare] }))).toBe(2);
    // A record is not a vote.
    expect(code(() => h.decide(fresh.id, 'A'))).toBe(2);
    expect(code(() => h.vote(fresh.id, 'A'))).toBe(2);
  });
});

describe('decision log: outcome revisions', () => {
  it('adds a file on a forced redecision and reads the new choice', () => {
    const s = setup();
    const now = clock();
    const h = s.as('human:dawid', { now });
    const v = h.propose({ question: 'Index?', options: ['JSON', 'SQLite'], deadline: '+1h' }).id;
    h.decide(v, 'JSON', 'no native module');
    const dir = join(s.rootDir, 'decisions', v, 'outcomes');
    const first = readdirSync(dir);
    expect(first).toHaveLength(1);
    const before = readFileSync(join(dir, first[0]!), 'utf8');
    // Without --force a decided vote stays decided.
    expect(() => h.decide(v, 'SQLite')).toThrow(/is decided/);
    const forced = s.as('human:dawid', { now, force: true }).decide(v, 'SQLite', 'changed my mind');
    expect(forced.outcome).toMatchObject({ choice: 'SQLite', forced: true });
    expect(forced.outcomes.map((o) => o.choice)).toEqual(['JSON', 'SQLite']);
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    // The first outcome is still the file it was.
    expect(files[0]).toBe(first[0]);
    expect(readFileSync(join(dir, first[0]!), 'utf8')).toBe(before);
    expect(h.decision(v).outcome?.choice).toBe('SQLite');
    // The log shows the current choice and lists the earlier one as revised.
    const entry = h.decisionLog({ all: true })[0]!;
    expect(entry.text).toBe('Index? → SQLite');
    expect(entry.revised).toMatchObject([{ choice: 'JSON', by: 'human:dawid' }]);
    // A forced redecision is no problem to report.
    expect(h.decisionProblems()).toEqual([]);
  });

  it('reads a legacy outcome.md as older than any new outcome file', () => {
    const s = setup();
    const h = s.as('human:dawid', { now: clock() });
    const v = h.propose({ question: 'Index?', options: ['JSON', 'SQLite'], deadline: '+1h' }).id;
    const dir = join(s.rootDir, 'decisions', v);
    writeFileSync(
      join(dir, 'outcome.md'),
      stringifyDoc({ choice: 'JSON', decided_by: 'human:dawid', at: '2026-10-01T00:00:00.000Z' }),
    );
    // No migration: the old file alone decides the vote.
    expect(h.decision(v)).toMatchObject({
      outcome: { choice: 'JSON' },
      tally: { state: 'decided' },
    });
    expect(h.decision(v).outcome?.id).toBeUndefined();
    s.as('human:dawid', { force: true, now: clock() }).decide(v, 'SQLite');
    const d = h.decision(v);
    expect(d.outcomes.map((o) => o.choice)).toEqual(['JSON', 'SQLite']);
    expect(d.outcome).toMatchObject({ choice: 'SQLite', forced: true });
    // The legacy file is left as it was.
    expect(readFileSync(join(dir, 'outcome.md'), 'utf8')).toMatch(/choice: JSON/);
  });

  it('keeps two unforced outcomes and reports the vote', () => {
    const s = setup();
    const h = s.as('human:dawid', { now: clock() });
    const v = h.propose({ question: 'Index?', options: ['JSON', 'SQLite'], deadline: '+1h' }).id;
    h.decide(v, 'JSON');
    // The other side of a sync decided too, before the two met: its file arrives as it is.
    const root = h.roots[0]!;
    mkdirSync(join(root.dir, 'decisions', v, 'outcomes'), { recursive: true });
    writeOutcome(
      root,
      v,
      { choice: 'SQLite', decided_by: 'human:anna', at: '2026-11-04T00:00:00.000Z', body: '' },
      Date.parse('2026-11-04T00:00:00Z'),
    );
    const d = h.decision(v);
    expect(d.outcomes.map((o) => o.choice)).toEqual(['JSON', 'SQLite']);
    // The newest stands.
    expect(d.outcome?.choice).toBe('SQLite');
    expect(h.decisionProblems()).toMatchObject([
      { root: 'test', id: v, kind: 'outcomes', detail: expect.stringMatching(/2 times/) },
    ]);
  });
});

describe('decision log: who records', () => {
  it('lets a person record anything and refuses other agents', () => {
    const { as, h } = world();
    const long = 'x'.repeat(201);
    expect(code(() => h.recordDecision({ text: long }))).toBe(2);
    expect(code(() => h.recordDecision({ text: 'two\nlines' }))).toBe(2);
    expect(code(() => h.recordDecision({ text: '   ' }))).toBe(2);
    expect(h.recordDecision({ text: 'x'.repeat(200), body: 'Why: context.' }).meta.id).toBe(
      'D-0001',
    );
    expect(h.decision('D-0001').body).toBe('Why: context.');
    for (const agent of ['claude:engineer', 'codex:reviewer', 'claude:orchestrator']) {
      const call = () => as(agent).recordDecision({ text: 'my own choice' });
      expect(code(call)).toBe(1);
      expect(call).toThrow(/cannot record a decision/);
    }
  });

  it('lets the PM record only what a person wrote in a task event', () => {
    const { as, h, now } = world();
    const pm = as('claude:pm', { now });
    const t = h.newTask({ title: 'subtasks', project: 'p' }).id;
    const said = h.comment(t, 'If it is part of an approved task, it needs no approval.')
      .events[0]!;
    const agents = as('claude:engineer', { now }).comment(t, 'I think so too').events[0]!;

    // No source: the PM cannot record its own choice.
    const bare = () => pm.recordDecision({ text: 'Subtasks need no approval' });
    expect(code(bare)).toBe(1);
    expect(bare).toThrow(/--source/);
    // A file is not what a person wrote in an event or the chat.
    expect(code(() => pm.recordDecision({ text: 'x', source: 'docs/notes.md' }))).toBe(1);
    // An agent's event is not a person's.
    const byAgent = () => pm.recordDecision({ text: 'x', source: `${t}#${agents.id}` });
    expect(code(byAgent)).toBe(1);
    expect(byAgent).toThrow(/not by a person/);
    // An event that does not exist.
    expect(
      code(() => pm.recordDecision({ text: 'x', source: `${t}#01AAAAAAAAAAAAAAAAAAAAAAAA` })),
    ).toBe(2);

    const rec = pm.recordDecision({
      text: 'Subtasks of an approved task need no approval',
      source: `${t}#${said.id}`,
    }).meta;
    // The decider and the date are the person's; the PM is who wrote it down.
    expect(rec).toMatchObject({
      scope: 'tree',
      task: t,
      source: `${t}#${said.id}`,
      created_by: 'human:dawid',
      created_at: said.at,
      recorded_by: 'claude:pm',
    });
    expect(h.decisionLog()[0]).toMatchObject({ by: 'human:dawid', recorded_by: 'claude:pm' });
    // A person names any event as the source and stays the decider.
    const own = h.recordDecision({ text: 'Agreed', source: `${t}#${agents.id}` }).meta;
    expect(own.created_by).toBe('human:dawid');
    expect(own.recorded_by).toBeUndefined();
  });
});

describe('decision log: a PM chat message as the source', () => {
  const message: ChatSourceMessage = {
    id: '01M7B2XK4T9QZ8R5V3W1Y6N0PD',
    role: 'user',
    at: '2026-11-13T04:12:00.000Z',
    text: 'The design still stands.\nBuild it as planned.',
    from: 'human:dawid',
  };
  const source = `chat:${message.id}`;

  it("records a person's message with its words, time and author", () => {
    const { as, h, now } = world();
    const pm = as('claude:pm', { now });
    const res = pm.recordDecision({
      text: 'The AO-0109 design is the plan',
      source,
      chat: message,
    });
    expect(res.existing).toBe(false);
    expect(res.meta).toMatchObject({
      source,
      created_by: 'human:dawid',
      created_at: message.at,
      recorded_by: 'claude:pm',
      scope: 'project',
    });
    const d = h.decision(res.meta.id);
    expect(d.body).toBe(
      [
        '> human:dawid, 2026-11-13T04:12:00.000Z, in the PM chat:',
        '>',
        '> The design still stands.',
        '> Build it as planned.',
      ].join('\n'),
    );
    // The effective date is when the person said it, not when the PM wrote it down.
    expect(h.decisionLog()[0]).toMatchObject({ at: message.at, by: 'human:dawid' });

    // The same message with the same text is recorded once.
    const again = pm.recordDecision({
      text: 'The AO-0109 design is the plan',
      source,
      chat: message,
    });
    expect(again).toMatchObject({ existing: true, meta: { id: res.meta.id } });
    // One message can hold two decisions.
    const second = pm.recordDecision({ text: 'Step 1 comes first', source, chat: message });
    expect(second.existing).toBe(false);
    expect(second.meta.id).not.toBe(res.meta.id);
    expect(h.decisionLog()).toHaveLength(2);
  });

  it('refuses a reply of the PM, a channel mention and an unknown id', () => {
    const { as, h, now } = world();
    const pm = as('claude:pm', { now });
    const reply = { ...message, role: 'assistant', from: undefined };
    const fromReply = () => pm.recordDecision({ text: 'x', source, chat: reply });
    expect(code(fromReply)).toBe(2);
    expect(fromReply).toThrow(/reply of the agent/);

    const mention = { ...message, channel: 'dev' };
    const fromChannel = () => pm.recordDecision({ text: 'x', source, chat: mention });
    expect(code(fromChannel)).toBe(2);
    expect(fromChannel).toThrow(/post in #dev/);
    // A channel post by an agent that mentions the PM is not a person's message either.
    const agentPost = { ...message, from: 'codex:engineer' };
    expect(code(() => pm.recordDecision({ text: 'x', source, chat: agentPost }))).toBe(2);

    // swarmupd holds no such message.
    const unknown = () => pm.recordDecision({ text: 'x', source });
    expect(code(unknown)).toBe(2);
    expect(unknown).toThrow(/no message/);
    // A person is held to the same rule: a chat source is a person's chat message.
    expect(code(() => h.recordDecision({ text: 'x', source, chat: reply }))).toBe(2);
    expect(h.decisionLog()).toEqual([]);
  });
});
