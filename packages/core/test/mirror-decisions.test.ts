import { describe, expect, it } from 'vitest';
import { Workspace } from '../src/index.js';
import { world, SCENARIO_TIMEOUT } from './mirror-world.js';

const notes = (res: Array<{ result: { notes: string[] } }>): string =>
  res.flatMap((r) => r.result.notes).join('\n');

describe('Master Repo mirror: decisions', { timeout: SCENARIO_TIMEOUT }, () => {
  it('copies records both ways, and both sides read the same log', async () => {
    const w = world();
    const h1 = w.m1('human:dawid');
    const top = h1.newTask({ title: 'top', project: 'p' }).id;
    const sub = h1.newTask({ title: 'sub', parent: top }).id;
    const beside = h1.newTask({ title: 'beside', project: 'p' }).id;
    // Made in the project root.
    const first = h1.recordDecision({ text: 'made in the project root', project: 'p' }).meta.id;
    await w.sync1();
    await w.sync2();
    const h2 = w.m2('human:dawid');
    expect(h2.decision(`site/${first}`).meta).toMatchObject({
      kind: 'record',
      question: 'made in the project root',
    });

    // Made in the Master Repo copy, on the other machine: an exception for one tree, and a
    // record that supersedes the first one.
    const site2 = new Workspace({
      cwd: w.hub2,
      env: w.env,
      actor: 'human:dawid',
      user: w.user2,
      root: 'site',
    });
    const narrow = site2.recordDecision({
      text: 'made in the copy',
      task: `site/${top}`,
      narrows: [first],
    }).meta.id;
    await w.sync2();
    await w.sync1();
    expect(w.m1('human:dawid').decision(narrow).meta.question).toBe('made in the copy');

    // `--log --task ID` gives the same lines from either side.
    const lines = (ws: Workspace, task: string): string[] =>
      ws.decisionLog({ task: `site/${task}` }).map((e) => `${e.id} ${e.at} ${e.text}`);
    for (const task of [top, sub, beside]) {
      expect(lines(w.m2('human:dawid'), task)).toEqual(lines(w.m1('human:dawid'), task));
    }
    expect(lines(w.m1('human:dawid'), sub)).toHaveLength(1);
    expect(lines(w.m1('human:dawid'), sub)[0]).toContain('made in the copy');
    expect(lines(w.m1('human:dawid'), beside)[0]).toContain('made in the project root');

    // Superseded on one side reads `superseded` on both after a sync.
    const fresh = site2.recordDecision({ text: 'replaces the first', supersedes: [first] }).meta.id;
    expect(site2.decision(first).tally.state).toBe('superseded');
    expect(w.m1('human:dawid').decision(first).tally.state).toBe('recorded');
    await w.sync2();
    const res = await w.sync1();
    expect(w.m1('human:dawid').decision(first).tally.state).toBe('superseded');
    expect(
      w
        .m1('human:dawid')
        .decisionLog({ task: beside })
        .map((e) => e.id),
    ).toEqual([fresh]);
    expect(notes(res)).not.toMatch(/differs/);
  });

  it('mirrors a forced redecision as a new file, with no conflict', async () => {
    const w = world();
    const h1 = w.m1('human:dawid');
    const v = h1.propose({ question: 'Index?', options: ['JSON', 'SQLite'], deadline: '+1h' }).id;
    h1.decide(v, 'JSON');
    await w.sync1();
    await w.sync2();
    expect(w.m2('human:dawid').decision(`site/${v}`).outcome?.choice).toBe('JSON');
    // Redecided with --force on the other side.
    const forced = new Workspace({
      cwd: w.hub2,
      env: w.env,
      actor: 'human:dawid',
      user: w.user2,
      force: true,
    });
    forced.decide(`site/${v}`, 'SQLite');
    const out2 = await w.sync2();
    const out1 = await w.sync1();
    expect(notes([...out1, ...out2])).not.toMatch(/differs|not merged/);
    for (const ws of [w.m1('human:dawid'), w.m2('human:dawid')]) {
      const d = ws.decision(`site/${v}`);
      expect(d.outcome).toMatchObject({ choice: 'SQLite', forced: true });
      expect(d.outcomes.map((o) => o.choice)).toEqual(['JSON', 'SQLite']);
    }
    expect(w.m1('human:dawid').decisionProblems()).toEqual([]);
  });
});
