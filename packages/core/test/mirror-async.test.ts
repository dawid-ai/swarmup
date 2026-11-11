import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mirrorPairAsync, Root, syncAllAsync, Workspace } from '../src/index.js';
import { hosted, SCENARIO_TIMEOUT, turn, world } from './mirror-world.js';

describe('Master Repo mirror off the event loop (AO-0169)', { timeout: SCENARIO_TIMEOUT }, () => {
  it('mirrors in syncAllAsync with git off the event loop, as syncAll does', async () => {
    const w = world();
    w.m1('human:dawid').newTask({ title: 'shared', owner: '*:engineer' });
    await turn();
    // A synchronous mirror lets no timer fire until it returns; this one serves timers between
    // its git processes.
    let timers = 0;
    const timer = setInterval(() => timers++, 1);
    let results;
    try {
      results = await syncAllAsync(w.m1('human:dawid').roots, w.user1, { pull: true, push: true });
    } finally {
      clearInterval(timer);
    }
    expect(timers).toBeGreaterThan(0);
    const site = results.find((r) => r.root.name === 'site')!;
    expect(site.mirror?.notes).toEqual([]);
    expect(site.mirror?.toMaster).toBeGreaterThan(0);
    // The Master Repo's copy was committed and pushed: the other machine gets the task.
    await w.sync2();
    expect(w.m2('human:dawid').view('site/WEB-0001').meta.title).toBe('shared');
  });

  it('keeps each mirror inside its own pair when two run at once', async () => {
    const pairs = [0, 1].map(() => {
      const site = hosted('site', 'WEB', true);
      const hub = hosted('hub', 'HUB');
      return {
        project: new Root(join(site.clone, '.swarmup')),
        master: new Root(join(hub.clone, '.swarmup')),
        hub: hub.clone,
      };
    });
    for (const p of pairs) {
      // A task to copy, so each mirror writes into its Master Repo while the other waits on git.
      const cwd = join(p.project.dir, '..');
      const env = { SWARMUP_CONFIG: join(cwd, 'none.yml') } as NodeJS.ProcessEnv;
      new Workspace({ cwd, env, actor: 'human:dawid', user: {} }).newTask({ title: 't' });
    }
    const res = await Promise.all(pairs.map((p) => mirrorPairAsync(p.project, p.master)));
    for (const [i, r] of res.entries()) {
      expect(r.notes).toEqual([]);
      expect(r.toMaster).toBeGreaterThan(0);
      const copy = join(pairs[i]!.hub, '.swarmup', 'mirrors', 'site', 'tasks', 'WEB-0001');
      expect(existsSync(join(copy, 'task.md'))).toBe(true);
      expect(readdirSync(join(pairs[i]!.hub, '.swarmup', 'mirrors'))).toEqual(['site']);
    }
  });
});
