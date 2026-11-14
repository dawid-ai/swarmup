import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Workspace } from '../src/index.js';
import { world, SCENARIO_TIMEOUT } from './mirror-world.js';

describe('Master Repo mirror: decision ids and conflicts', { timeout: SCENARIO_TIMEOUT }, () => {
  it('hands out one id per pair, and reports a differing decision.md without merging it', async () => {
    const w = world();
    const h1 = w.m1('human:dawid');
    h1.newTask({ title: 'a task' });
    // The first sync creates the Master Repo's copy of the project root.
    await w.sync1();

    // The same machine, working in the Master Repo with the project root not loaded: its record
    // lands in the copy, under this machine's id block.
    const inCopy = new Workspace({
      cwd: w.hub.clone,
      env: w.env,
      actor: 'human:dawid',
      user: { master: w.hub.clone, id_block: 0 },
      root: 'site',
    });
    const copied = inCopy.recordDecision({ text: 'made in the copy' }).meta.id;
    expect(copied).toBe('D-0001');
    // The project root has no decision yet, and still skips the id its copy uses.
    const mine = h1.recordDecision({ text: 'made in the project root' }).meta.id;
    expect(mine).toBe('D-0002');
    // A vote takes its id from the same space.
    const vote = h1.propose({ question: 'Q?', options: ['A', 'B'], deadline: '+1h' }).id;
    expect(vote).toBe('D-0003');

    let res = await w.sync1();
    expect(res.flatMap((r) => r.result.notes).join('\n')).not.toMatch(/differs/);
    expect(h1.decision('D-0001').meta.question).toBe('made in the copy');

    // The copy's file changes by hand: the two sides now differ.
    const projectFile = join(w.site.clone, '.swarmup', 'decisions', 'D-0002', 'decision.md');
    const copyFile = join(
      w.hub.clone,
      '.swarmup',
      'mirrors',
      'site',
      'decisions',
      'D-0002',
      'decision.md',
    );
    const before = readFileSync(projectFile, 'utf8');
    expect(readFileSync(copyFile, 'utf8')).toBe(before);
    appendFileSync(copyFile, '\nEdited in the copy.\n');
    const edited = readFileSync(copyFile, 'utf8');

    res = await w.sync1();
    expect(res.flatMap((r) => r.result.notes).join('\n')).toMatch(
      /site\/D-0002\/decision\.md: differs between the project root and the Master Repo; not merged/,
    );
    // Neither side is overwritten.
    expect(readFileSync(projectFile, 'utf8')).toBe(before);
    expect(readFileSync(copyFile, 'utf8')).toBe(edited);
    // `swarmup doctor` reads the same list.
    expect(w.m1('human:dawid').decisionProblems()).toMatchObject([
      {
        root: 'site',
        id: 'D-0002',
        kind: 'conflict',
        detail: expect.stringMatching(/^decision\.md differs/),
      },
    ]);
  });
});
