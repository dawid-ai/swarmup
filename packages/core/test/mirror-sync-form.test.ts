import { describe, expect, it } from 'vitest';
import { syncAll } from '../src/index.js';
import { SCENARIO_TIMEOUT, turn, world } from './mirror-world.js';

// The other mirror scenarios sync through syncAllAsync (see mirror-world.ts). This one keeps
// syncAll, the synchronous form `swarmup sync` runs, covered end to end: two syncs, with a loop
// turn before each.
describe('Master Repo mirror through syncAll', { timeout: SCENARIO_TIMEOUT }, () => {
  it('carries a project task to a machine that has only the Master Repo', async () => {
    const w = world();
    w.m1('human:dawid').newTask({ title: 'shared', owner: '*:engineer' });
    await turn();
    const first = syncAll(w.m1('human:dawid').roots, w.user1, { pull: true, push: true });
    const site = first.find((r) => r.root.name === 'site')!;
    expect(site.mirror?.notes).toEqual([]);
    expect(site.mirror?.toMaster).toBeGreaterThan(0);
    await turn();
    syncAll(w.m2('human:dawid').roots, w.user2, { pull: true, push: true });
    expect(w.m2('human:dawid').view('site/WEB-0001').meta.title).toBe('shared');
  });
});
