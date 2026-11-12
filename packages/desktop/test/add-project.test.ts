// The main-process side of Add project (AO-0274), without Electron: the folder dialog, swarmupd
// and the page check are stand-ins; the survey, the store and the user config are real files.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { initRoot, Workspace } from '@swarmup/core';
import { addProjectHandlers } from '../src/add-project.js';
import type { AddProjectHandlers, ProjectAdded, ProjectProposal } from '../src/add-project.js';

/** A stand-in for the IPC event: only whether it comes from the app's page matters here. */
interface Caller {
  page: boolean;
}
const PAGE: Caller = { page: true };
const OTHER: Caller = { page: false };

let base: string;
let config: string;
let env: NodeJS.ProcessEnv;
/** The folders the dialog answers with, in order; null is a closed dialog. */
let picks: Array<string | null>;
let titles: string[];
let reloads: number;
let online: boolean;
let h: AddProjectHandlers<Caller>;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, windowsHide: true, stdio: 'ignore' });
}

/** A node repo on branch `main` with a README: the fixture the survey reads. */
function fixtureRepo(name = 'shop'): string {
  const d = join(base, name);
  mkdirSync(join(d, 'src'), { recursive: true });
  git(d, 'init', '-q', '-b', 'main');
  writeFileSync(
    join(d, 'package.json'),
    JSON.stringify({
      name,
      scripts: { build: 'vite build', test: 'vitest run' },
      dependencies: { react: '^19' },
      devDependencies: { vite: '^7', vitest: '^4', typescript: '^5' },
    }),
  );
  writeFileSync(join(d, 'README.md'), '# shop\n');
  writeFileSync(join(d, 'src', 'cart.test.ts'), 'test\n');
  return d;
}

function userConfig(): Record<string, unknown> {
  return YAML.parse(readFileSync(config, 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'swarmup-add-project-'));
  config = join(base, 'config.yml');
  writeFileSync(config, '# my machine\nme: human:dawid\nswarmupd:\n  max_runs: 3\n');
  env = { SWARMUP_CONFIG: config };
  picks = [];
  titles = [];
  reloads = 0;
  online = true;
  h = addProjectHandlers<Caller>({
    env,
    fromPage: (e) => e.page,
    pickFolder: async (title) => {
      titles.push(title);
      return picks.shift() ?? null;
    },
    reload: async () => {
      if (!online) throw new Error('swarmupd offline');
      reloads++;
    },
  });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

async function proposal(repo: string): Promise<ProjectProposal> {
  picks.push(repo);
  const res = await h.pick(PAGE);
  if (!res.ok || res.data.kind !== 'proposal') throw new Error(JSON.stringify(res));
  return res.data;
}

describe('add project handlers', () => {
  it('refuse every call that is not from the app page, and write nothing', async () => {
    const repo = fixtureRepo();
    const refused = { ok: false, error: 'not allowed from this page' };
    picks.push(repo);
    expect(await h.pick(OTHER)).toEqual(refused);
    // The dialog never opened for the other page.
    expect(titles).toEqual([]);
    await proposal(repo);
    const before = readFileSync(config, 'utf8');
    const input = { name: 'shop', prefix: 'SHOP', tasks: [0], where: 'repo' };
    expect(await h.plan(OTHER, 'x')).toEqual(refused);
    expect(await h.pickStore(OTHER)).toEqual(refused);
    expect(await h.create(OTHER, input)).toEqual(refused);
    expect(existsSync(join(repo, '.swarmup'))).toBe(false);
    expect(readFileSync(config, 'utf8')).toBe(before);
    expect(reloads).toBe(0);
  });

  it('survey a picked repo into a proposal and write nothing', async () => {
    const repo = fixtureRepo();
    const p = await proposal(repo);
    expect(p.dir).toBe(repo);
    expect(p.branch).toBe('main');
    expect(p.survey).toMatchObject({
      stacks: ['node', 'typescript'],
      frameworks: ['react', 'vite'],
      tests: { runner: 'vitest', command: 'npm test', files: 1 },
      build: 'npm run build',
      lint: null,
      docs: ['README.md'],
      ci: [],
    });
    expect(p.plan.name).toBe('shop');
    expect(p.plan.prefix).toBe('SHO');
    expect(p.plan.agents.map((a) => a.id)).toEqual(['cursor:frontend', 'claude:qa']);
    expect(p.plan.tasks.map((t) => t.title)).toEqual([
      'Record the baseline: build and test shop',
      'Write AGENTS.md for shop',
      'Run the build and tests in CI',
      'Add a linter and a formatter',
    ]);
    expect(existsSync(join(repo, '.swarmup'))).toBe(false);
    // Another name gets its own task titles and prefix.
    const renamed = await h.plan(PAGE, 'web store');
    expect(renamed).toMatchObject({ ok: true, data: { name: 'web store', prefix: 'WS' } });
    expect(renamed.ok && renamed.data.tasks[1]!.title).toBe('Write AGENTS.md for web store');
  });

  it('create the store in the repo, with the edited name, prefix and ticked tasks', async () => {
    const repo = fixtureRepo();
    await proposal(repo);
    const res = await h.create(PAGE, { name: 'store', prefix: 'st', tasks: [0, 2], where: 'repo' });
    expect(res).toMatchObject({
      ok: true,
      data: { name: 'store', dir: join(repo, '.swarmup'), store: null, reloaded: true },
    });
    expect(res.ok && res.data.tasks).toEqual([
      { id: 'ST-0001', title: 'Record the baseline: build and test store' },
      { id: 'ST-0002', title: 'Run the build and tests in CI' },
    ]);
    const ws = new Workspace({ cwd: repo, env, actor: 'human:dawid' });
    expect(ws.view('ST-0002').meta.blocked_by).toEqual(['ST-0001']);
    expect(readFileSync(config, 'utf8')).toContain('# my machine');
    expect(userConfig()).toEqual({
      me: 'human:dawid',
      swarmupd: { max_runs: 3 },
      roots: [repo],
    });
    expect(reloads).toBe(1);
    // The pick is used up: a second Create needs a new one.
    expect(await h.create(PAGE, { name: 'x', prefix: 'X', tasks: [], where: 'repo' })).toEqual({
      ok: false,
      error: 'pick a folder first',
    });
  });

  it('create the store in a separate folder and name the code checkout', async () => {
    const repo = fixtureRepo();
    const store = join(base, 'shop-tasks');
    await proposal(repo);
    const input = { name: 'shop', prefix: 'SHOP', tasks: [0, 1, 2, 3], where: 'store' };
    expect(await h.create(PAGE, input)).toEqual({
      ok: false,
      error: 'pick a folder for the tasks',
    });
    // A folder inside the repo is refused at the pick; a closed dialog changes nothing.
    picks.push(join(repo, 'tasks'), null, store);
    expect(await h.pickStore(PAGE)).toMatchObject({ ok: false, error: /outside the repo/ });
    expect(await h.pickStore(PAGE)).toEqual({ ok: false, error: 'cancelled' });
    expect(await h.pickStore(PAGE)).toEqual({ ok: true, data: { dir: store } });
    online = false;
    const res = await h.create(PAGE, input);
    expect(res).toMatchObject({
      ok: true,
      data: { dir: join(store, '.swarmup'), store, base: 'main', reloaded: false },
    });
    expect(existsSync(join(repo, '.swarmup'))).toBe(false);
    expect(new Workspace({ cwd: store, env, actor: 'human:dawid' }).view('SHOP-0004')).toBeTruthy();
    expect(userConfig()).toEqual({
      me: 'human:dawid',
      swarmupd: {
        max_runs: 3,
        code: { shop: repo },
        merge: { shop: { base: 'main', checkout: repo } },
      },
      roots: [store],
    });
  });

  it('only add a folder that has a data root to roots', async () => {
    const repo = fixtureRepo('site');
    initRoot(repo, { name: 'site', prefix: 'SITE' });
    picks.push(repo, repo);
    const first = await h.pick(PAGE);
    const added: ProjectAdded = {
      kind: 'added',
      dir: repo,
      name: 'site',
      added: true,
      reloaded: true,
    };
    expect(first).toEqual({ ok: true, data: added });
    expect(userConfig()).toEqual({ me: 'human:dawid', swarmupd: { max_runs: 3 }, roots: [repo] });
    // No proposal was kept, and nothing in the root changed.
    expect(await h.plan(PAGE, 'site')).toEqual({ ok: false, error: 'pick a folder first' });
    expect(existsSync(join(repo, '.swarmup', 'tasks', 'SITE-0001'))).toBe(false);
    const again = await h.pick(PAGE);
    expect(again).toEqual({ ok: true, data: { ...added, added: false } });
    expect(userConfig().roots).toEqual([repo]);
  });

  it('answer with the error instead of throwing', async () => {
    const plain = join(base, 'plain');
    mkdirSync(plain);
    picks.push(null, plain, join(base, 'missing'));
    expect(await h.pick(PAGE)).toEqual({ ok: false, error: 'cancelled' });
    expect(await h.pick(PAGE)).toMatchObject({ ok: false, error: /is not a git repo/ });
    expect(await h.pick(PAGE)).toMatchObject({ ok: false, error: /is not a folder/ });
    const repo = fixtureRepo();
    await proposal(repo);
    const bad = [
      [{ name: '', prefix: 'S', tasks: [], where: 'repo' }, /give the project a name/],
      [{ name: 'a/b', prefix: 'S', tasks: [], where: 'repo' }, /project name/],
      [{ name: 'shop', prefix: '9', tasks: [], where: 'repo' }, /id prefix/],
      [{ name: 'shop', prefix: 'S', tasks: ['0'], where: 'repo' }, /tasks/],
      [{ name: 'shop', prefix: 'S', tasks: [], where: 'C:\\x' }, /where/],
      [null, /give the project a name/],
    ] as const;
    for (const [input, error] of bad) {
      expect(await h.create(PAGE, input)).toMatchObject({ ok: false, error });
    }
    // A root made meanwhile (the CLI, another window) is an error in the dialog.
    initRoot(repo, { name: 'shop' });
    const input = { name: 'shop', prefix: 'S', tasks: [], where: 'repo' };
    expect(await h.create(PAGE, input)).toMatchObject({
      ok: false,
      error: /has a data root already/,
    });
    expect(userConfig().roots).toBeUndefined();
  });
});
