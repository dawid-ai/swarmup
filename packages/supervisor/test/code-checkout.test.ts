// A task store in a repo of its own, with the code in another checkout (`swarmupd.code`, AO-0252):
// runs start and task worktrees are made in the code checkout, and a merge pushes its base.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initRoot, Workspace } from '@swarmup/core';
import type { RunRecord } from '../src/index.js';
import { codexWritableDirs, opsdConfig, Supervisor } from '../src/index.js';
import { until, WAIT_MS } from './until.js';

const dirs: string[] = [];
const sups: Supervisor[] = [];

afterEach(async () => {
  const mine = sups.splice(0);
  const gone = dirs.splice(0);
  for (const s of mine) {
    s.stop({ killRuns: true });
    await s.close();
  }
  for (const d of gone) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
}, 90_000);

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmup-code-'));
  dirs.push(d);
  return d;
}

const ID = {
  GIT_AUTHOR_NAME: 'Swarmupd Test',
  GIT_AUTHOR_EMAIL: 'swarmupd@example.com',
  GIT_COMMITTER_NAME: 'Swarmupd Test',
  GIT_COMMITTER_EMAIL: 'swarmupd@example.com',
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...ID },
  }).trim();

const samePath = (a: string, b: string): boolean =>
  resolve(a).toLowerCase() === resolve(b).toLowerCase();

/** A run that saves its prompt to `RUN_PROMPT` and leaves `work.txt` in its folder. */
const RUN = `
let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  require('node:fs').writeFileSync(process.env.RUN_PROMPT, prompt);
  require('node:fs').writeFileSync('work.txt', 'done by the run\\n');
});
`;

/**
 * A store repo (`store`, the task store at its top folder's `.swarmup`, no code) and a code repo
 * (`code`, on `main`, pushed to the bare `remote`), with `swarmupd.code.test` naming the code repo.
 */
function setup(opsd: Record<string, unknown> = {}) {
  const store = temp();
  git(store, 'init', '-q', '-b', 'main');
  initRoot(store, { name: 'test', human: 'human:dawid' });
  const code = temp();
  git(code, 'init', '-q', '-b', 'main');
  writeFileSync(join(code, 'code.txt'), 'code\n');
  writeFileSync(join(code, '.gitignore'), 'out/\n');
  git(code, 'add', '-A');
  git(code, 'commit', '-qm', 'start');
  const remote = temp();
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  git(code, 'remote', 'add', 'origin', remote);
  git(code, 'push', '-q', '-u', 'origin', 'main');
  const state = temp();
  const runFile = join(temp(), 'run.cjs');
  writeFileSync(runFile, RUN);
  const env = {
    ...process.env,
    ...ID,
    SWARMUP_CONFIG: join(store, 'none.yml'),
    SWARMUP_STATE_DIR: state,
    RUN_PROMPT: join(state, 'prompt.txt'),
  } as NodeJS.ProcessEnv;
  delete env.SWARMUP_AGENT;
  delete env.SWARMUP_ROOTS;
  const as = (actor: string) => new Workspace({ cwd: store, env, actor, user: {} });
  as('human:dawid').newTask({ title: 'Change the code', owner: 'fake:engineer' });
  git(store, 'add', '-A');
  git(store, 'commit', '-qm', 'tasks');
  const config = opsdConfig({
    opsd: {
      sync: false,
      max_runs: 16,
      task_worktrees: true,
      code: { test: code },
      runtimes: { fake: { command: process.execPath, args: [runFile] } },
      ...opsd,
    },
  });
  const sup = new Supervisor({
    env,
    cwd: store,
    user: {},
    config,
    freeMem: () => 64 * 2 ** 30,
    version: '0.2.0-test',
  });
  sups.push(sup);
  return { store, code, remote, state, env, sup, as };
}

function ended(sup: Supervisor, id: string): Promise<RunRecord> {
  return new Promise((res, rej) => {
    const before = sup.run(id);
    if (before.status === 'ended' && before.wrap_up === 'done') return res(before);
    const timer = setTimeout(() => rej(new Error(`run ${id} did not end`)), WAIT_MS);
    const check = (r: RunRecord): void => {
      if (r.id !== id || r.status !== 'ended') return;
      clearTimeout(timer);
      sup.off('run', check);
      res(r);
    };
    sup.on('run', check);
  });
}

describe('a code checkout apart from the task store (AO-0252)', () => {
  it('starts a code task in a worktree of the code checkout and commits its work there', async () => {
    const { store, code, state, sup } = setup();
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    const wt = join(code, 'out', 'wt-T-0001');
    expect(samePath(run.cwd, wt)).toBe(true);
    await ended(sup, run.id);
    await until(() => sup.run(run.id).wrap_up === 'done');
    // What the run left is committed on a branch of the code repo; the store repo has none.
    const left = sup.run(run.id).leftovers;
    expect(left?.branch).toMatch(/^fake\/t-0001-/);
    expect(samePath(left!.top, wt)).toBe(true);
    expect(git(code, 'show', `${left!.branch}:work.txt`)).toBe('done by the run');
    expect(git(store, 'branch', '--list', 'fake/*')).toBe('');
    // The code checkout holds no task store, and the run is told so.
    expect(git(code, 'status', '--porcelain')).toBe('');
    const prompt = readFileSync(join(state, 'prompt.txt'), 'utf8');
    expect(prompt).toContain('swarmupd merges into the code');
    expect(prompt).not.toContain('`swarmup` here uses the task store');
  });

  it('starts a run without a worktree in the code checkout, with the checkout rule', async () => {
    const { code, state, sup, as } = setup({
      task_worktrees: false,
      merge: { test: { base: 'main', checks: [] } },
    });
    as('human:dawid').newTask({ title: 'Docs', owner: 'fake:writer' });
    const run = sup.launch({ agent: 'fake:writer', task: '2' });
    expect(samePath(run.cwd, code)).toBe(true);
    await ended(sup, run.id);
    const prompt = readFileSync(join(state, 'prompt.txt'), 'utf8');
    expect(prompt).toContain('is the code checkout swarmupd merges into: keep `main` checked out');
    expect(prompt).not.toContain('holds the task store');
  });

  it('pushes the base of the code checkout after a merge', async () => {
    const { code, remote, state, sup, as } = setup({
      merge: { test: { base: 'main', checks: [] } },
    });
    writeFileSync(join(state, 'merge.json'), JSON.stringify({ test: '2000-01-01T00:00:00.000Z' }));
    const wt = join(temp(), 'wt');
    git(code, 'worktree', 'add', '-q', '-b', 'feature', wt, 'main');
    writeFileSync(join(wt, 'code.txt'), 'changed\n');
    git(wt, 'commit', '-qam', 'Change the code');
    const commit = git(wt, 'rev-parse', 'HEAD');
    as('fake:engineer').start('1', 'plan');
    as('fake:engineer').review('1', `${commit.slice(0, 7)} on branch feature: code`, 'human:dawid');
    as('human:dawid').verdict('1', 'approve', 'looks right');
    await sup.tick();
    await sup.mergeSettled();
    const head = git(code, 'rev-parse', 'main');
    expect(git(code, 'show', 'main:code.txt')).toBe('changed');
    await until(() => git(remote, 'rev-parse', 'main') === head);
  });

  it('keeps the store writable for a Codex run in a worktree of the code checkout', () => {
    const store = temp();
    const code = temp();
    const wt = join(code, 'out', 'wt-T-0001');
    mkdirSync(wt, { recursive: true });
    const scratch = join(temp(), 'scratch');
    const gitDirs = [join(code, '.git', 'worktrees', 'wt-T-0001'), join(code, '.git', 'objects')];
    const dirs = codexWritableDirs(wt, [store, scratch], [join(store, '.swarmup')], gitDirs);
    expect(dirs).toContain(store);
    expect(dirs).toContain(scratch);
  });
});
