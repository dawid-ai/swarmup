import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UserConfig } from '../src/index.js';
import { initRoot, syncAllAsync, Workspace } from '../src/index.js';
import { git, GIT_TEST_TIMEOUT, gitRepo, tempDir, TEST_IDENTITY, turn } from './helpers.js';

/*
 * Every sync here goes through syncAllAsync, the form swarmupd runs: its git runs off the event
 * loop, so the vitest worker reads its RPC replies between git processes. With the synchronous
 * syncAll, one sync under merge-check load ran past 60 s without a loop turn, and the run failed
 * with 'Timeout calling onTaskUpdate' though every test passed (AO-0238). syncAll and
 * syncAllAsync share their steps; mirror-sync-form.test.ts runs a scenario through syncAll, the
 * form `swarmup sync` uses.
 */

/*
 * The two-machine world the Master Repo mirror tests share. Each scenario lives in its own
 * mirror*.test.ts file: every sync runs real git against real remotes, 1-2 s per sync on Windows,
 * so the scenarios run in parallel workers instead of one after another.
 */

/** A bare remote with one pushed clone holding a data root. */
export function hosted(
  name: string,
  prefix: string,
  mirror = false,
): { remote: string; clone: string } {
  const clone = gitRepo();
  initRoot(clone, { name, prefix, human: 'human:dawid' });
  if (mirror) {
    const file = join(clone, '.swarmup', 'config.yml');
    writeFileSync(file, `${readFileSync(file, 'utf8')}mirror: true\n`);
  }
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'init');
  // The remote is a bare clone of the clone, and the clone tracks it: the state `git push -u`
  // leaves, without a push (half a second on Windows) or `git remote` and `git config` processes.
  const remote = tempDir();
  git(remote, 'clone', '-q', '--bare', clone, '.');
  appendFileSync(
    join(clone, '.git', 'config'),
    [
      '[remote "origin"]',
      // Forward slashes: a backslash starts an escape in git config files.
      `\turl = ${remote.split('\\').join('/')}`,
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      '[branch "main"]',
      '\tremote = origin',
      '\tmerge = refs/heads/main',
      '',
    ].join('\n'),
  );
  git(clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return { remote, clone };
}

export function cloneOf(remote: string): string {
  const dir = tempDir();
  git(dir, 'clone', '-q', remote, '.');
  appendFileSync(join(dir, '.git', 'config'), TEST_IDENTITY);
  return dir;
}

/**
 * Machine 1 has the project repo and the Master Repo; machine 2 has only the Master Repo. Both
 * run every sync through syncAllAsync, as swarmupd does.
 */
export function world() {
  const site = hosted('site', 'WEB', true);
  const hub = hosted('hub', 'HUB');
  const hub2 = cloneOf(hub.remote);
  const env = { SWARMUP_CONFIG: join(site.clone, 'none.yml') } as NodeJS.ProcessEnv;
  const user1: UserConfig = { roots: [site.clone], master: hub.clone, id_block: 0, machine: 'pc' };
  const user2: UserConfig = { master: hub2, id_block: 1, machine: 'laptop' };
  const m1 = (actor: string, now?: () => number) =>
    new Workspace({ cwd: site.clone, env, actor, user: user1, now });
  const m2 = (actor: string, now?: () => number) =>
    new Workspace({ cwd: hub2, env, actor, user: user2, now });
  const sync1 = async () => {
    await turn();
    return syncAllAsync(m1('human:dawid').roots, user1, { pull: true, push: true });
  };
  const sync2 = async () => {
    await turn();
    return syncAllAsync(m2('human:dawid').roots, user2, { pull: true, push: true });
  };
  return { site, hub, hub2, m1, m2, sync1, sync2, env, user1, user2 };
}

/**
 * A machine with one project root and a Master Repo clone, syncing the way swarmupd does. Use it
 * when both machines keep a project root, which world() does not model.
 */
export function machine(site: string, hub: string, block: number) {
  const env = { SWARMUP_CONFIG: join(site, 'none.yml') } as NodeJS.ProcessEnv;
  const user: UserConfig = { roots: [site], master: hub, id_block: block };
  const ws = (actor: string) => new Workspace({ cwd: site, env, actor, user });
  const sync = async () => {
    await turn();
    return syncAllAsync(ws('human:dawid').roots, user, { pull: true, push: true });
  };
  return { ws, sync };
}

export { turn };

/** The test timeout for a scenario: a hang guard, see GIT_TEST_TIMEOUT. */
export const SCENARIO_TIMEOUT = GIT_TEST_TIMEOUT;

/** A world where the project root has a daily repeat that both machines have synced. */
export async function withRepeat() {
  const w = world();
  w.m1('human:dawid').saveRepeat({
    name: 'report',
    title: 'Daily report',
    start: '2026-11-01 09:00',
    repeat: 'daily',
  });
  await w.sync1();
  await w.sync2();
  return w;
}

export const state = (ws: Workspace, ref: string) => {
  const v = ws.view(ref);
  return {
    status: v.status,
    claimedBy: v.claimedBy,
    claimToken: v.claimToken,
    title: v.meta.title,
  };
};
