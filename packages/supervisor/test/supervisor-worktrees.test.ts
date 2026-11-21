import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { samePath, Workspace } from '@swarmup/core';
import type { RunRecord } from '../src/index.js';
import { clock, Supervisor } from '../src/index.js';
import { HANG_RUNTIME, ended, setup, temp } from './supervisor-setup.js';

describe('task worktrees (AO-0168)', () => {
  const ID = {
    GIT_AUTHOR_NAME: 'Swarmupd Test',
    GIT_AUTHOR_EMAIL: 'swarmupd@example.com',
    GIT_COMMITTER_NAME: 'Swarmupd Test',
    GIT_COMMITTER_EMAIL: 'swarmupd@example.com',
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, ...ID },
    }).trim();
  const wt = (repo: string, id: string) => join(repo, 'out', `wt-${id}`);

  /** Polls `ok` until it holds, or fails after `ms`. */
  async function until(ok: () => boolean, what: string, ms = 30_000): Promise<void> {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** A store checkout with the task store committed, as this repo's `v2` is. */
  function storeSetup(opts: Parameters<typeof setup>[0] = {}) {
    const s = setup({
      ...opts,
      env: { ...ID, ...(opts.env ?? {}) },
      opsd: {
        task_worktrees: true,
        roles: { engineer: { per_project: 2 } },
        ...(opts.opsd ?? {}),
      },
    });
    /** Commits the code and the task store; returns the commit. */
    const commit = (): string => {
      writeFileSync(join(s.repo, 'code.txt'), 'code\n');
      writeFileSync(join(s.repo, '.gitignore'), 'out/\n');
      git(s.repo, 'add', '-A');
      git(s.repo, 'commit', '-qm', 'start');
      return git(s.repo, 'rev-parse', 'HEAD');
    };
    return { ...s, commit };
  }

  it('wakes two code tasks at once, each in its own worktree, and keeps the checkout rule', async () => {
    const { repo, sup, as, commit } = storeSetup({
      mode: 'hang',
      opsd: { agents: { 'fake:engineer': { wake: true } } },
    });
    // What swarmupd said about the worktrees, for the failure message: a `git worktree add` that
    // fails starts the run in the checkout instead.
    const said: string[] = [];
    sup.on('warn', (w: string) => said.push(`warn: ${w}`));
    sup.on('worktree', (w: string) => said.push(`worktree: ${w}`));
    const h = as('human:dawid');
    h.newTask({ title: 'a', owner: 'fake:engineer', priority: 'p1' });
    h.newTask({ title: 'b', owner: 'fake:engineer', priority: 'p2' });
    commit();
    // The worktrees are made first, off the event loop.
    expect(sup.waits().map((w) => w.reason)).toEqual([
      `starts once swarmupd has made its worktree ${wt(repo, 'T-0001')}`,
      `starts once swarmupd has made its worktree ${wt(repo, 'T-0002')}`,
    ]);
    await sup.tick();
    await until(
      () => sup.waits().every((w) => w.reason === 'starts at the next tick'),
      'the worktrees',
    );
    await sup.tick();
    const live = sup.runs({ live: true });
    expect(live.map((r) => r.task).sort()).toEqual(['T-0001', 'T-0002']);
    for (const r of live) {
      expect(
        samePath(r.cwd, wt(repo, r.task!)),
        `${r.task} runs in ${r.cwd}; swarmupd said:\n${said.join('\n')}`,
      ).toBe(true);
    }
    expect(git(repo, 'branch', '--list', 'fake/*', '--format=%(refname:short)')).toBe(
      'fake/t-0001\nfake/t-0002',
    );
    // Each run's `swarmup` works on the real task store, not the worktree's copy of it.
    await until(
      () => ['1', '2'].every((id) => as('human:dawid').view(id).status === 'in-progress'),
      'the runs to start their tasks',
    );
    const copy = new Workspace({
      cwd: wt(repo, 'T-0001'),
      env: { ...process.env, SWARMUP_ROOTS: '' },
      actor: 'human:dawid',
      user: {},
    });
    expect(copy.view('1').status).toBe('todo');
    // A writer in the store checkout itself still has it alone.
    expect(sup.blocker('fake:planner', 'test', { cwd: repo })).toBeNull();
    h.newTask({ title: 'docs', owner: 'fake:writer' });
    sup.launch({ agent: 'fake:writer', task: '3', cwd: repo });
    expect(sup.blocker('fake:planner', 'test', { cwd: repo })).toMatch(
      /fake:writer works on test\/T-0003 in .+; one writing run per checkout/,
    );
  });

  // AO-0380: a worktree with no `node_modules` could not type-check.
  /**
   * A store setup whose `pnpm` is a fake first on PATH: it writes its arguments to
   * `node_modules/installed.txt` in the folder it runs in, then exits with `exit`.
   */
  function fakePnpmSetup(exit: number) {
    const bin = temp();
    writeFileSync(
      join(bin, 'pnpm.cmd'),
      `@mkdir node_modules 2>nul\r\n@echo %*> node_modules\\installed.txt\r\n@exit /b ${exit}\r\n`,
    );
    writeFileSync(
      join(bin, 'pnpm'),
      `#!/bin/sh\nmkdir -p node_modules\necho "$@" > node_modules/installed.txt\nexit ${exit}\n`,
      { mode: 0o755 },
    );
    const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    const s = storeSetup({
      mode: 'hang',
      env: { [key]: `${bin}${delimiter}${process.env[key] ?? ''}` },
      opsd: { agents: { 'fake:engineer': { wake: true } } },
    });
    const said: string[] = [];
    s.sup.on('warn', (w: string) => said.push(`warn: ${w}`));
    s.sup.on('worktree', (w: string) => said.push(`worktree: ${w}`));
    writeFileSync(join(s.repo, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    // Every worktree reads the repo's exclude file: installed packages are no changes.
    writeFileSync(join(s.repo, '.git', 'info', 'exclude'), 'node_modules/\n');
    s.as('human:dawid').newTask({ title: 'a', owner: 'fake:engineer' });
    s.commit();
    /** Makes the worktree and waits until the run may start; returns the fake's arguments. */
    const made = async (): Promise<string> => {
      await s.sup.tick();
      await until(
        () => s.sup.waits().every((w) => w.reason === 'starts at the next tick'),
        'the worktree',
      ).catch((err: Error) => {
        throw new Error(
          `${err.message}; waits: ${JSON.stringify(s.sup.waits())}; said:\n${said.join('\n')}`,
        );
      });
      const marker = join(wt(s.repo, 'T-0001'), 'node_modules', 'installed.txt');
      expect(existsSync(marker), said.join('\n')).toBe(true);
      return readFileSync(marker, 'utf8').trim();
    };
    return { ...s, said, made };
  }

  // AO-0380: a worktree with no `node_modules` could not type-check.
  it('installs a pnpm repo in a new worktree before its run starts', async () => {
    const { said, made } = fakePnpmSetup(0);
    expect(await made()).toBe('install --frozen-lockfile --offline');
    expect(said.join('\n')).toContain('test/T-0001: running `pnpm install');
    expect(said.filter((s) => s.startsWith('warn:'))).toEqual([]);
  });

  /** The fake's arguments in the task's worktree, or null when it did not run there. */
  const installedIn = (repo: string): string | null => {
    const marker = join(wt(repo, 'T-0001'), 'node_modules', 'installed.txt');
    return existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null;
  };

  it('installs a pnpm repo in the worktree of an API launch before the run starts', async () => {
    const { repo, sup, said } = fakePnpmSetup(0);
    const run = await sup.launchFresh({ agent: 'fake:engineer', task: '1' });
    expect(samePath(run.cwd, wt(repo, 'T-0001'))).toBe(true);
    expect(installedIn(repo), said.join('\n')).toBe('install --frozen-lockfile --offline');
    // Made off the event loop, not in place.
    expect(said.join('\n')).toContain(`test/T-0001: making ${wt(repo, 'T-0001')}`);
    expect(said.filter((s) => s.startsWith('warn:'))).toEqual([]);
  });

  it('installs a pnpm repo in the worktree a direct launch makes in place', async () => {
    const { repo, sup, said } = fakePnpmSetup(0);
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    expect(samePath(run.cwd, wt(repo, 'T-0001'))).toBe(true);
    expect(installedIn(repo), said.join('\n')).toBe('install --frozen-lockfile --offline');
    expect(said.join('\n')).toContain('test/T-0001: running `pnpm install');
    expect(said.filter((s) => s.startsWith('warn:'))).toEqual([]);
  });

  it('starts a direct launch in its new worktree when the install fails, with a warning', () => {
    const { repo, sup, said } = fakePnpmSetup(1);
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    expect(samePath(run.cwd, wt(repo, 'T-0001'))).toBe(true);
    expect(said.join('\n')).toMatch(
      /warn: test\/T-0001: `pnpm install --frozen-lockfile --offline` failed in .*wt-T-0001 \(exit 1\).*the run starts without it/,
    );
  });

  it('starts the run in the new worktree when its install fails, with a warning', async () => {
    const { repo, sup, said, made } = fakePnpmSetup(1);
    await made();
    expect(said.join('\n')).toMatch(
      /warn: test\/T-0001: `pnpm install --frozen-lockfile --offline` failed in .*wt-T-0001 \(exit 1\).*the run starts without it/,
    );
    await sup.tick();
    const live = sup.runs({ live: true });
    expect(live.map((r) => r.task)).toEqual(['T-0001']);
    expect(samePath(live[0]!.cwd, wt(repo, 'T-0001'))).toBe(true);
  });

  it('makes the worktree for a launch, reuses one that is there and tells the run', async () => {
    const promptFile = join(temp(), 'prompt.txt');
    const { repo, sup, as, commit } = storeSetup({ env: { FAKE_PROMPT: promptFile } });
    const h = as('human:dawid');
    h.newTask({ title: 'a', owner: 'fake:engineer' });
    h.newTask({ title: 'b', owner: 'fake:engineer' });
    h.newTask({ title: 'c', owner: 'fake:engineer' });
    h.newTask({ title: 'Is T-0001 done?', type: 'question', owner: 'fake:engineer' });
    const start = commit();

    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    expect(samePath(run.cwd, wt(repo, 'T-0001'))).toBe(true);
    expect(run.base).toBe(start);
    await ended(sup, run.id);
    expect(git(wt(repo, 'T-0001'), 'branch', '--show-current')).toBe('fake/t-0001');
    expect(as('human:dawid').view('1').status).toBe('done');
    let prompt = readFileSync(promptFile, 'utf8');
    const path = wt(repo, 'T-0001').replace(/\\/g, '/');
    expect(prompt).toContain(
      `- swarmupd started you in ${path}, the worktree of T-0001, on branch`,
    );
    expect(prompt).toContain('`fake/t-0001`');
    expect(prompt).not.toContain('git worktree add');

    // A worktree of the task that is there is used as it is, on its own branch.
    git(repo, 'worktree', 'add', '-q', '-b', 'mine', wt(repo, 'T-0002'));
    const reused = sup.launch({ agent: 'fake:engineer', task: '2' });
    expect(samePath(reused.cwd, wt(repo, 'T-0002'))).toBe(true);
    await ended(sup, reused.id);
    prompt = readFileSync(promptFile, 'utf8');
    expect(prompt).toContain('on branch `mine`');
    expect(git(repo, 'branch', '--list', 'fake/t-0002')).toBe('');

    // Something else in the way, or a task that is no code: the run starts in the checkout.
    mkdirSync(wt(repo, 'T-0003'), { recursive: true });
    const blocked = sup.launch({ agent: 'fake:engineer', task: '3' });
    expect(samePath(blocked.cwd, repo)).toBe(true);
    await ended(sup, blocked.id);
    expect(readFileSync(promptFile, 'utf8')).toContain('git worktree add out/wt-T-0003');
    const question = sup.launch({ agent: 'fake:engineer', task: '4' });
    expect(samePath(question.cwd, repo)).toBe(true);
    await ended(sup, question.id);
  });

  it('starts the run in the checkout when git cannot make the worktree', async () => {
    const { repo, sup, as } = storeSetup({ mode: 'hang' });
    const warns: string[] = [];
    sup.on('warn', (m: string) => warns.push(m));
    as('human:dawid').newTask({ title: 'a', owner: 'fake:engineer' });
    // No commit to branch from.
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    expect(samePath(run.cwd, repo)).toBe(true);
    expect(warns.join('\n')).toMatch(/test\/T-0001: cannot make worktree .*wt-T-0001/);
    expect(existsSync(wt(repo, 'T-0001'))).toBe(false);
  });

  it('reclaims a closed task worktree after the grace and makes it again from its branch (AO-0230)', async () => {
    let now = Date.now();
    const { repo, sup, as, commit } = storeSetup({ now: () => now });
    const warns: string[] = [];
    sup.on('warn', (m: string) => warns.push(m));
    const h = as('human:dawid');
    h.newTask({ title: 'a', owner: 'fake:engineer' });
    h.newTask({ title: 'b', owner: 'fake:engineer' });
    h.newTask({ title: 'c', owner: 'fake:engineer' });
    commit();
    for (const id of ['1', '2', '3']) {
      await ended(sup, sup.launch({ agent: 'fake:engineer', task: id }).id);
    }
    // The run renamed its branch; T-0002 left a change; T-0003 sits on a commit no branch holds.
    git(wt(repo, 'T-0001'), 'branch', '-m', 'fake/t-0001-named');
    writeFileSync(join(wt(repo, 'T-0002'), 'code.txt'), 'changed\n');
    git(wt(repo, 'T-0003'), 'commit', '-q', '--allow-empty', '-m', 'loose');
    git(wt(repo, 'T-0003'), 'checkout', '-q', '--detach');
    git(repo, 'branch', '-D', 'fake/t-0003');

    // Closed less than `reclaim_after_minutes` ago: every worktree stays.
    await sup.housekeep();
    for (const id of ['T-0001', 'T-0002', 'T-0003']) expect(existsSync(wt(repo, id))).toBe(true);
    // Inside the grace nothing is held back: the sweep has not asked for those folders yet.
    expect(sup.keptWorktrees()).toEqual([]);

    now += 61 * 60_000;
    await sup.housekeep();
    expect(existsSync(wt(repo, 'T-0001'))).toBe(false);
    expect(git(repo, 'branch', '--list', 'fake/t-0001-named')).toContain('fake/t-0001-named');
    expect(git(repo, 'worktree', 'list')).not.toContain('wt-T-0001');
    const note = h.showEvents('1').events.at(-1)!;
    expect(note).toMatchObject({ type: 'comment', actor: 'opsd:worktree' });
    expect(note.body).toContain('branch `fake/t-0001-named`');
    // A worktree with changes or with work no branch holds stays, with one warning each.
    expect(existsSync(wt(repo, 'T-0002'))).toBe(true);
    expect(existsSync(wt(repo, 'T-0003'))).toBe(true);
    await sup.housekeep();
    expect(warns.filter((w) => w.includes('has uncommitted changes (code.txt)'))).toHaveLength(1);
    expect(warns.filter((w) => w.includes('that no branch holds'))).toHaveLength(1);
    // Settings lists what each sweep held back, with the reason (AO-0298).
    expect(sup.keptWorktrees().map((k) => [k.task, k.reason])).toEqual([
      ['test/T-0002', 'uncommitted changes (code.txt)'],
      ['test/T-0003', expect.stringMatching(/^its commit [0-9a-f]{8} is on no branch$/)],
    ]);
    expect(samePath(sup.keptWorktrees()[0]!.path, wt(repo, 'T-0002'))).toBe(true);
    // Committed, the change no longer holds the worktree: the next sweep removes it and drops it
    // from the list.
    git(wt(repo, 'T-0002'), 'add', '-A');
    git(wt(repo, 'T-0002'), 'commit', '-qm', 'keep the change');
    await sup.housekeep();
    expect(existsSync(wt(repo, 'T-0002'))).toBe(false);
    expect(sup.keptWorktrees().map((k) => k.task)).toEqual(['test/T-0003']);

    // Reopened, the task gets its worktree again on the branch its work is on.
    h.reopen('1');
    const again = sup.launch({ agent: 'fake:engineer', task: '1' });
    expect(samePath(again.cwd, wt(repo, 'T-0001'))).toBe(true);
    await ended(sup, again.id);
    expect(git(wt(repo, 'T-0001'), 'branch', '--show-current')).toBe('fake/t-0001-named');
  });

  it('removes a reclaimed worktree without following a junction inside it (AO-0230)', async () => {
    let now = Date.now();
    const { repo, sup, as, commit } = storeSetup({ now: () => now });
    as('human:dawid').newTask({ title: 'a', owner: 'fake:engineer' });
    commit();
    await ended(sup, sup.launch({ agent: 'fake:engineer', task: '1' }).id);
    // Like a `node_modules` entry linked to the main checkout's, in a folder git ignores.
    // `git worktree remove` on Windows deletes what such a junction points to.
    const target = join(temp(), 'shared');
    mkdirSync(join(target, 'pkg'), { recursive: true });
    writeFileSync(join(target, 'pkg', 'keep.txt'), 'keep\n');
    mkdirSync(join(wt(repo, 'T-0001'), 'out'), { recursive: true });
    symlinkSync(target, join(wt(repo, 'T-0001'), 'out', 'linked'), 'junction');
    now += 61 * 60_000;
    await sup.housekeep();
    expect(existsSync(wt(repo, 'T-0001'))).toBe(false);
    expect(git(repo, 'worktree', 'list')).not.toContain('wt-T-0001');
    expect(readFileSync(join(target, 'pkg', 'keep.txt'), 'utf8')).toBe('keep\n');
  });

  it('starts no run in a worktree while it checks it for removal, and keeps a reopened one (AO-0230)', async () => {
    let now = Date.now();
    const { repo, sup, as, commit } = storeSetup({ now: () => now });
    const h = as('human:dawid');
    h.newTask({ title: 'a', owner: 'fake:engineer' });
    commit();
    await ended(sup, sup.launch({ agent: 'fake:engineer', task: '1' }).id);
    now += 61 * 60_000;
    // Reopened, and a launch tried, while swarmupd waits for git during its checks.
    let refused = '';
    sup.on('worktree', (m: string) => {
      if (!m.includes('checking') || refused) return;
      h.reopen('1');
      try {
        sup.launch({ agent: 'fake:engineer', task: '1' });
        refused = 'started';
      } catch (err) {
        refused = String(err);
      }
    });
    await sup.housekeep();
    expect(refused).toMatch(/swarmupd is removing the worktree .*wt-T-0001 of test\/T-0001/);
    // The checks after the git calls saw the reopen: the worktree stays, and runs use it again.
    expect(existsSync(wt(repo, 'T-0001'))).toBe(true);
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    expect(samePath(run.cwd, wt(repo, 'T-0001'))).toBe(true);
    await ended(sup, run.id);
  });

  it('resumes a removal a restart cut off only while the worktree is unchanged (AO-0230)', async () => {
    const now = Date.now();
    const { repo, sup, as, commit, state } = storeSetup({ now: () => now });
    const warns: string[] = [];
    sup.on('warn', (m: string) => warns.push(m));
    const h = as('human:dawid');
    h.newTask({ title: 'a', owner: 'fake:engineer' });
    h.newTask({ title: 'b', owner: 'fake:engineer' });
    commit();
    for (const id of ['1', '2']) {
      await ended(sup, sup.launch({ agent: 'fake:engineer', task: id }).id);
    }
    const record = (id: string) => ({
      path: wt(repo, id),
      branch: `fake/${id.toLowerCase()}`,
      head: git(wt(repo, id), 'rev-parse', 'HEAD'),
      at: new Date(now).toISOString(),
      removing: true,
    });
    // As a swarmupd that stopped mid-deletion left them: T-0001 lost a file to the deletion;
    // T-0002 got a new commit afterwards.
    writeFileSync(
      join(state, 'reclaimed-worktrees.json'),
      JSON.stringify({ 'test/T-0001': record('T-0001'), 'test/T-0002': record('T-0002') }),
    );
    rmSync(join(wt(repo, 'T-0001'), 'code.txt'));
    git(wt(repo, 'T-0002'), 'commit', '-q', '--allow-empty', '-m', 'new work');
    // No run starts in a folder whose removal is under way, whatever chose the folder.
    h.reopen('2');
    expect(() => sup.launch({ agent: 'fake:engineer', task: '2' })).toThrow(
      /swarmupd is removing the worktree/,
    );
    expect(() => sup.launch({ agent: 'fake:engineer', cwd: wt(repo, 'T-0002') })).toThrow(
      /swarmupd is removing the worktree .*wt-T-0002/,
    );
    // Nor while swarmupd checks the folder again before it goes on deleting.
    let during = '';
    sup.on('worktree', (m: string) => {
      if (!m.includes('finishing the removal') || !m.includes('T-0001') || during) return;
      try {
        sup.launch({ agent: 'fake:engineer', cwd: join(wt(repo, 'T-0001'), 'out') });
        during = 'started';
      } catch (err) {
        during = String(err);
      }
    });
    await sup.housekeep();
    expect(during).toMatch(/swarmupd is removing the worktree .*wt-T-0001/);
    expect(existsSync(wt(repo, 'T-0001'))).toBe(false);
    expect(existsSync(wt(repo, 'T-0002'))).toBe(true);
    expect(warns.join('\n')).toMatch(
      /test\/T-0002: swarmupd stopped removing the worktree .*wt-T-0002: it is on fake\/t-0002 at/,
    );
    // The dropped removal no longer holds the worktree.
    const run = sup.launch({ agent: 'fake:engineer', task: '2' });
    expect(samePath(run.cwd, wt(repo, 'T-0002'))).toBe(true);
    await ended(sup, run.id);
  });

  it('keeps a folder whose resumed removal git cannot check, and finishes an emptied one (AO-0230)', async () => {
    const { repo, sup, as, commit, state } = storeSetup();
    const warns: string[] = [];
    sup.on('warn', (m: string) => warns.push(m));
    const h = as('human:dawid');
    for (const t of ['a', 'b', 'c']) h.newTask({ title: t, owner: 'fake:engineer' });
    commit();
    for (const id of ['1', '2', '3']) {
      await ended(sup, sup.launch({ agent: 'fake:engineer', task: id }).id);
    }
    const head = git(wt(repo, 'T-0001'), 'rev-parse', 'HEAD');
    const record = (id: string) => ({
      path: wt(repo, id),
      branch: `fake/${id.toLowerCase()}`,
      head,
      at: new Date().toISOString(),
      removing: true,
    });
    writeFileSync(
      join(state, 'reclaimed-worktrees.json'),
      JSON.stringify({
        'test/T-0001': record('T-0001'),
        'test/T-0002': record('T-0002'),
        'test/T-0003': record('T-0003'),
      }),
    );
    // T-0001 is no worktree any more: something replaced its `.git`.
    rmSync(join(wt(repo, 'T-0001'), '.git'));
    // T-0002's `.git` names a git folder that is gone: git cannot read it. Git for Windows marks
    // the file hidden, which Node cannot overwrite, so it is written anew.
    rmSync(join(wt(repo, 'T-0002'), '.git'));
    writeFileSync(join(wt(repo, 'T-0002'), '.git'), `gitdir: ${join(temp(), 'gone')}\n`);
    // T-0003 is empty: the deletion took everything but the folder.
    rmSync(wt(repo, 'T-0003'), { recursive: true, force: true });
    mkdirSync(wt(repo, 'T-0003'));
    await sup.housekeep();
    expect(existsSync(join(wt(repo, 'T-0001'), 'code.txt'))).toBe(true);
    expect(existsSync(join(wt(repo, 'T-0002'), 'code.txt'))).toBe(true);
    expect(existsSync(wt(repo, 'T-0003'))).toBe(false);
    const said = warns.join('\n');
    expect(said).toMatch(
      /test\/T-0001: swarmupd stopped removing .*: it is no git worktree any more/,
    );
    expect(said).toMatch(/test\/T-0002: swarmupd stopped removing .*: git cannot read it/);
  });

  it('never resumes a removal through a worktree path that became a junction (AO-0230)', async () => {
    const { repo, sup, as, commit, state } = storeSetup();
    const warns: string[] = [];
    sup.on('warn', (m: string) => warns.push(m));
    as('human:dawid').newTask({ title: 'a', owner: 'fake:engineer' });
    commit();
    await ended(sup, sup.launch({ agent: 'fake:engineer', task: '1' }).id);
    const head = git(wt(repo, 'T-0001'), 'rev-parse', 'HEAD');
    writeFileSync(
      join(state, 'reclaimed-worktrees.json'),
      JSON.stringify({
        'test/T-0001': {
          path: wt(repo, 'T-0001'),
          branch: 'fake/t-0001',
          head,
          at: new Date().toISOString(),
          removing: true,
        },
      }),
    );
    // The folder moved, and the path now links to it: through the link, git sees the same branch
    // and commit.
    const moved = join(temp(), 'moved');
    renameSync(wt(repo, 'T-0001'), moved);
    symlinkSync(moved, wt(repo, 'T-0001'), 'junction');
    await sup.housekeep();
    expect(existsSync(join(moved, 'code.txt'))).toBe(true);
    expect(warns.join('\n')).toMatch(
      /test\/T-0001: swarmupd stopped removing .*: its path is a junction or symlink now/,
    );
  });

  it('leaves the worktree of an open task and of a task with a live run (AO-0230)', async () => {
    let now = Date.now();
    const { repo, sup, as, commit } = storeSetup({ mode: 'hang', now: () => now });
    const h = as('human:dawid');
    h.newTask({ title: 'a', owner: 'fake:engineer' });
    h.newTask({ title: 'b', owner: 'fake:engineer' });
    commit();
    const live = sup.launch({ agent: 'fake:engineer', task: '1' });
    git(repo, 'worktree', 'add', '-q', '-b', 'fake/t-0002', wt(repo, 'T-0002'));
    // Closed while its run still works.
    h.done('1', 'closed by hand');
    now += 61 * 60_000;
    await sup.housekeep();
    expect(existsSync(wt(repo, 'T-0001'))).toBe(true);
    expect(existsSync(wt(repo, 'T-0002'))).toBe(true);
    sup.kill(live.id);
    await ended(sup, live.id);
  });

  it('removes a worktree a crash left half made and makes it again (AO-0230)', async () => {
    const { repo, sup, as, commit } = storeSetup();
    const h = as('human:dawid');
    h.newTask({ title: 'a', owner: 'fake:engineer' });
    const start = commit();
    // As if swarmupd stopped mid-checkout: the lock it adds with the worktree is still there.
    git(
      repo,
      'worktree',
      'add',
      '-q',
      '--lock',
      '--reason',
      'swarmupd: making',
      '-b',
      'fake/t-0001',
      wt(repo, 'T-0001'),
      start,
    );
    rmSync(join(wt(repo, 'T-0001'), 'code.txt'));
    await sup.housekeep();
    expect(existsSync(wt(repo, 'T-0001'))).toBe(false);
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    expect(samePath(run.cwd, wt(repo, 'T-0001'))).toBe(true);
    expect(existsSync(join(wt(repo, 'T-0001'), 'code.txt'))).toBe(true);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('locked');
    await ended(sup, run.id);
  });

  it('removes a stale index.lock in the task worktree before a run starts there (AO-0230)', async () => {
    const { repo, sup, as, commit } = storeSetup();
    as('human:dawid').newTask({ title: 'a', owner: 'fake:engineer' });
    commit();
    git(repo, 'worktree', 'add', '-q', '-b', 'fake/t-0001', wt(repo, 'T-0001'));
    const gitDir = git(wt(repo, 'T-0001'), 'rev-parse', '--absolute-git-dir');
    const lock = join(gitDir, 'index.lock');
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, old, old);
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    expect(existsSync(lock)).toBe(false);
    await ended(sup, run.id);
  });

  it('gives each run a scratch folder and names files left next to the checkout (AO-0230)', async () => {
    let now = Date.now();
    const parent = temp();
    const stray = join(parent, 'release-checks.log');
    const envOut = join(temp(), 'env.json');
    const promptFile = join(temp(), 'prompt.txt');
    const { repo, sup, as, commit, state } = storeSetup({
      repo: join(parent, 'proj'),
      mode: 'stray',
      now: () => now,
      env: { FAKE_STRAY: stray, FAKE_ENV_OUT: envOut, FAKE_PROMPT: promptFile },
    });
    as('human:dawid').newTask({ title: 'a', owner: 'fake:engineer' });
    commit();
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    expect(samePath(run.cwd, wt(repo, 'T-0001'))).toBe(true);
    await ended(sup, run.id);
    const scratch = join(state, 'scratch', run.id);
    expect(existsSync(scratch)).toBe(true);
    const seen = JSON.parse(readFileSync(envOut, 'utf8')) as Record<string, string>;
    for (const v of Object.values(seen)) expect(samePath(v, scratch)).toBe(true);
    expect(readFileSync(promptFile, 'utf8')).toContain(
      `- Put scratch files (logs, test output, experiments, downloads, bundles) in ${scratch.replace(/\\/g, '/')}`,
    );
    const end = as('human:dawid')
      .showEvents('1')
      .events.find((e) => e.type === 'run-end')!;
    expect(end.body).toContain(`\`${stray.replace(/\\/g, '/')}\``);
    // The file stays: swarmupd names it and leaves it to a person.
    expect(existsSync(stray)).toBe(true);
    // Removed `scratch_days` (7) after the run ended.
    await sup.housekeep();
    expect(existsSync(scratch)).toBe(true);
    now += 8 * 24 * 3_600_000;
    await sup.housekeep();
    expect(existsSync(scratch)).toBe(false);
  });

  it('skips a scratch folder it cannot remove for a day, and warns about it once', async () => {
    let now = Date.now();
    const { sup, state } = storeSetup({ mode: 'stray', now: () => now });
    const stuck = join(state, 'scratch', '01OLDRUNTHATWINDOWSKEEPS');
    mkdirSync(stuck, { recursive: true });
    const old = new Date(now - 30 * 24 * 3_600_000);
    utimesSync(stuck, old, old);
    const warns: string[] = [];
    sup.on('warn', (m: string) => warns.push(m));
    // As Windows refuses files a Codex sandbox session made.
    let tries = 0;
    sup.removeScratch = async () => {
      tries++;
      throw Object.assign(new Error('EPERM, Permission denied'), { code: 'EPERM' });
    };
    await sup.housekeep();
    await sup.housekeep();
    expect(tries).toBe(1);
    expect(warns.filter((w) => w.includes('cannot remove the scratch folder'))).toEqual([
      expect.stringContaining('swarmupd tries again in a day'),
    ]);
    now += 25 * 3_600_000;
    await sup.housekeep();
    expect(tries).toBe(2);
    expect(warns.filter((w) => w.includes('cannot remove the scratch folder'))).toHaveLength(1);
  });

  it('keeps the scratch folder Git Bash mounts as /tmp, and makes it again when it is gone', async () => {
    const now = Date.now();
    const { sup, state } = storeSetup({ mode: 'stray', now: () => now });
    const old = new Date(now - 30 * 24 * 3_600_000);
    const pinned = join(state, 'scratch', '01PINNEDASMSYSTMP');
    const other = join(state, 'scratch', '01OTHEROLDRUN');
    for (const d of [pinned, other]) {
      mkdirSync(d, { recursive: true });
      utimesSync(d, old, old);
    }
    sup.msysTmp = async () => pinned.toUpperCase();
    await sup.housekeep();
    expect(existsSync(pinned)).toBe(true);
    expect(existsSync(other)).toBe(false);
    // Removed by an older build: the sweep makes it again, so `/tmp` works once more.
    rmSync(pinned, { recursive: true, force: true });
    await sup.housekeep();
    expect(existsSync(pinned)).toBe(true);
  });

  it('removes the logs and process ledgers of runs past log_days, and old merge logs, and keeps the runs', async () => {
    let now = Date.now();
    const { sup, state } = storeSetup({ mode: 'stray', now: () => now });
    const day = 24 * 3_600_000;
    const run = (id: string, endedDaysAgo: number) => {
      sup.store.save({
        id,
        agent: 'fake:engineer',
        pid: 1,
        image: 'fake',
        command: 'fake',
        cwd: state,
        log: join(state, 'logs', `${id}.log`),
        started_at: new Date(now - endedDaysAgo * day - 60_000).toISOString(),
        ended_at: new Date(now - endedDaysAgo * day).toISOString(),
        status: 'ended',
        reason: 'exit',
        exit: 0,
      } as RunRecord);
      writeFileSync(join(state, 'logs', `${id}.log`), 'log\n');
      writeFileSync(join(state, 'procs', `${id}.json`), '{}');
    };
    run('01OLDRUN', 40);
    run('01NEWRUN', 2);
    mkdirSync(join(state, 'merge', 'logs'), { recursive: true });
    const oldMerge = join(state, 'merge', 'logs', 'old.log');
    const newMerge = join(state, 'merge', 'logs', 'new.log');
    writeFileSync(oldMerge, 'x');
    writeFileSync(newMerge, 'x');
    const old = new Date(now - 40 * day);
    utimesSync(oldMerge, old, old);

    await sup.housekeep();
    expect(existsSync(join(state, 'logs', '01OLDRUN.log'))).toBe(false);
    expect(existsSync(join(state, 'procs', '01OLDRUN.json'))).toBe(false);
    expect(existsSync(join(state, 'logs', '01NEWRUN.log'))).toBe(true);
    expect(existsSync(join(state, 'procs', '01NEWRUN.json'))).toBe(true);
    expect(existsSync(oldMerge)).toBe(false);
    expect(existsSync(newMerge)).toBe(true);
    // The run records stay: history and reports keep the run.
    expect(sup.store.get('01OLDRUN')).toMatchObject({ id: '01OLDRUN' });
    now += 1;
  });

  it('says in its log when something held its event loop, and what it was doing', async () => {
    const { sup } = storeSetup({ mode: 'stray' });
    const warns: string[] = [];
    sup.on('warn', (m: string) => warns.push(m));
    sup.start();
    try {
      await new Promise((r) => setTimeout(r, 600));
      // A synchronous step holds the loop, as the scratch cleanup's rmSync retries did.
      const until = Date.now() + 2_600;
      while (Date.now() < until) {
        /* hold the event loop */
      }
      await new Promise((r) => setTimeout(r, 1_200));
      expect(warns.join('\n')).toMatch(/swarmupd was busy for \d+\.\d s and answered nothing/);
    } finally {
      sup.stop();
    }
  });

  describe('one Electron for every worktree (AO-0306)', () => {
    const VERSION = '9.9.9';
    const exe =
      process.platform === 'win32'
        ? 'electron.exe'
        : process.platform === 'darwin'
          ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
          : 'electron';
    const distOf = (dir: string): string => join(dir, 'node_modules', 'electron', 'dist');

    /** A store checkout whose lockfile installs Electron; `node_modules` is ignored. */
    function electronSetup(env: Record<string, string>) {
      const s = storeSetup({
        mode: 'stray',
        // Empty: a swarmupd that runs these tests may have named its own shared Electron.
        env: { ELECTRON_OVERRIDE_DIST_PATH: '', ...env },
      });
      const shared = join(s.state, 'electron', `${VERSION}-${process.platform}-${process.arch}`);
      const commitAll = (): void => {
        s.commit();
        writeFileSync(join(s.repo, '.gitignore'), 'out/\nnode_modules/\n');
        writeFileSync(
          join(s.repo, 'package-lock.json'),
          JSON.stringify({ packages: { 'node_modules/electron': { version: VERSION } } }),
        );
        git(s.repo, 'add', '-A');
        git(s.repo, 'commit', '-qm', 'electron');
      };
      return { ...s, shared, commitAll };
    }

    it("points a run at one copy made from the checkout's Electron", async () => {
      const out = temp();
      const { repo, sup, as, commitAll, shared } = electronSetup({
        FAKE_STRAY: join(out, 'stray.log'),
        FAKE_ENV_OUT: join(out, 'env.json'),
        FAKE_ELECTRON_OUT: join(out, 'electron.txt'),
      });
      as('human:dawid').newTask({ title: 'a', owner: 'fake:engineer' });
      commitAll();
      mkdirSync(distOf(repo), { recursive: true });
      mkdirSync(dirname(join(distOf(repo), exe)), { recursive: true });
      writeFileSync(join(distOf(repo), exe), 'binary');
      writeFileSync(join(distOf(repo), 'version'), VERSION);
      writeFileSync(join(dirname(distOf(repo)), 'path.txt'), exe.replaceAll('\\', '/'));
      const run = sup.launch({ agent: 'fake:engineer', task: '1' });
      expect(samePath(run.cwd, wt(repo, 'T-0001'))).toBe(true);
      await ended(sup, run.id);
      expect(samePath(readFileSync(join(out, 'electron.txt'), 'utf8'), shared)).toBe(true);
      expect(readFileSync(join(shared, exe), 'utf8')).toBe('binary');
      // The checkout keeps its own, and the worktree holds none.
      expect(existsSync(join(distOf(repo), exe))).toBe(true);
      expect(existsSync(distOf(wt(repo, 'T-0001')))).toBe(false);
    });

    it('moves the Electron a run unpacked in its worktree, for the runs after it', async () => {
      const out = temp();
      const { repo, sup, as, commitAll, shared } = electronSetup({
        FAKE_STRAY: join(out, 'stray.log'),
        FAKE_ENV_OUT: join(out, 'env.json'),
        FAKE_ELECTRON_OUT: join(out, 'electron.txt'),
        FAKE_ELECTRON_UNPACK: VERSION,
      });
      as('human:dawid').newTask({ title: 'a', owner: 'fake:engineer' });
      as('human:dawid').newTask({ title: 'b', owner: 'fake:engineer' });
      commitAll();
      // No checkout holds it: the first run gets no folder and unpacks its own.
      const first = sup.launch({ agent: 'fake:engineer', task: '1' });
      await ended(sup, first.id);
      expect(readFileSync(join(out, 'electron.txt'), 'utf8')).toBe('');
      expect(existsSync(distOf(wt(repo, 'T-0001')))).toBe(false);
      expect(readFileSync(join(shared, 'version'), 'utf8')).toBe(VERSION);
      const second = sup.launch({ agent: 'fake:engineer', task: '2' });
      await ended(sup, second.id);
      expect(samePath(readFileSync(join(out, 'electron.txt'), 'utf8'), shared)).toBe(true);
      // What the second run unpacked all the same stays: swarmupd deletes nothing of a checkout.
      expect(existsSync(join(distOf(wt(repo, 'T-0002')), exe))).toBe(true);
    });
  });
});

describe('role file status', () => {
  function role(repo: string, slug: string, status: string): void {
    const dir = join(repo, '.swarmup', 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${slug}.md`), `---\nstatus: ${status}\n---\n`);
  }

  it('starts no wake run for a proposed role and says why in waits', async () => {
    const { sup, as, repo } = setup({
      mode: 'hang',
      opsd: { agents: { 'fake:qa': { wake: true } } },
    });
    role(repo, 'fake-qa', 'proposed');
    // With role files, work goes only to configured agents (AO-0096).
    role(repo, 'codex-engineer', 'active');
    const h = as('human:dawid');
    const meta = h.newTask({ title: 'x', owner: 'codex:engineer' });
    as('codex:engineer').start(meta.id, 'plan');
    as('codex:engineer').review(meta.id, 'check', 'fake:qa');
    h.newTask({ title: 'open work' });
    const waits = sup.waits();
    // The review request waits; the role's queue is empty. Since AO-0099 an open review request
    // is the review item only, not an inbox message too, so no inbox wake waits beside it. The
    // unowned work waits too: no waking agent answers to its role group (AO-0140).
    expect(waits.map((w) => w.kind)).toEqual(['review', 'task']);
    expect(waits[0]!.reason).toMatch(/fake:qa is proposed in its role file/);
    expect(waits[1]!.reason).toMatch(
      /has no owner; swarmupd cannot route it: no waking agent .*\*:engineer/,
    );
    await sup.tick();
    expect(sup.runs({ live: true })).toHaveLength(0);
    expect(() => sup.launch({ agent: 'fake:qa' })).toThrow(/proposed in its role file/);

    role(repo, 'fake-qa', 'active');
    await sup.tick();
    expect(sup.runs({ live: true }).map((r) => r.agent)).toContain('fake:qa');
  });

  it('wakes a role only for task types its can_claim allows (AO-0126)', async () => {
    const { sup, as, repo } = setup({
      mode: 'hang',
      opsd: {
        agents: { 'fake:orchestrator': { wake: true } },
        roles: { orchestrator: { providers: ['fake'] } },
      },
    });
    const dir = join(repo, '.swarmup', 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'fake-orchestrator.md'), '---\ncan_claim: [question]\n---\n');
    const h = as('human:dawid');
    const work = h.newTask({ title: 'Release 2.0.0', owner: '*:orchestrator', priority: 'p0' });
    const q = h.newTask({
      title: 'Is the release on track?',
      type: 'question',
      owner: '*:orchestrator',
      priority: 'p3',
    });
    const byTask = new Map(sup.waits().map((w) => [w.task?.split('/').pop(), w.reason]));
    expect(byTask.get(work.id)).toBe('fake:orchestrator: role takes only question');
    expect(byTask.get(q.id)).toBe('starts at the next tick');
    await sup.tick();
    expect(sup.runs({ live: true }).map((r) => r.task)).toEqual([q.id]);
  });

  it('starts the qa check of a milestone whose plan tasks closed, with the check prompt', async () => {
    const promptFile = join(temp(), 'prompt.txt');
    const { sup, as, repo } = setup({
      env: { FAKE_PROMPT: promptFile },
      opsd: {
        agents: { 'fake:qa': { wake: true } },
        roles: { qa: { providers: ['fake'] } },
        // The person plans the milestone by hand here; the check must not wait for that session.
        outside_session_minutes: 0,
      },
    });
    const dir = join(repo, '.swarmup', 'agents');
    mkdirSync(dir, { recursive: true });
    // What step 5 of the milestone design puts in the `qa` role files (AO-0110).
    writeFileSync(join(dir, 'fake-qa.md'), '---\ncan_claim: [question, milestone]\n---\n');
    const h = as('human:dawid');
    const m = h.newTask({
      title: 'Ship',
      type: 'milestone',
      owner: 'human:dawid',
      doneWhen: ['The installer runs on a clean machine'],
    });
    const item = (key: string): string =>
      `  - key: ${key}\n    title: Item ${key}\n    owner: human:dawid\n    estimate: 1h\n`;
    h.start(m.id, 'plan');
    h.planPropose(m.id, `items:\n${item('build')}${item('sign')}`);
    const [build, sign] = h.planApprove(m.id).created.map((c) => c.id);
    const ref = `test/${m.id}`;
    const waits = (): string | undefined => sup.waits().find((w) => w.task === ref)?.reason;
    /** The prompt of the next check run, which the fake agent ends without a finishing command. */
    const checkPrompt = async (): Promise<string> => {
      expect(waits()).toBe('starts at the next tick');
      await sup.tick();
      const run = sup.runs({ live: true }).find((r) => r.task === m.id)!;
      expect(run).toMatchObject({ agent: 'fake:qa' });
      await ended(sup, run.id);
      if (h.view(m.id).claimedBy) as('fake:qa').release(m.id, 'the fake run ended');
      return readFileSync(promptFile, 'utf8');
    };

    // No check while a plan task is open; a parked one counts as closed.
    h.done(build!, 'built');
    await sup.tick();
    expect(sup.runs()).toEqual([]);
    h.park(sign!, 'dropped: signing moves to the next milestone');

    const first = await checkPrompt();
    expect(first).toContain(`Check the milestone ${m.id}:`);
    expect(first).toContain('"The installer runs on a clean machine"');
    expect(first).toContain(`Parked plan items, whose work was dropped: \`sign\` (${sign})`);
    expect(first).toContain(`swarmup done ${m.id} "check passed: <evidence>"`);
    expect(first).toContain(`swarmup plan amend ${m.id} --kind fix --file -`);
    expect(first).not.toContain('Failed checks so far');
    expect(first).not.toContain(`Work on ${m.id}:`);

    // Two failed checks, each with fix tasks that then close.
    for (const [n, key] of ['fix-a', 'fix-b'].entries()) {
      const fix = h.planAmend(m.id, 'fix', `items:\n${item(key)}`, `check failed: gap ${n + 1}`);
      await sup.tick();
      expect(sup.runs({ live: true })).toEqual([]);
      h.done(fix.created[0]!.id, 'fixed');
      const next = await checkPrompt();
      expect(next).toContain(`Failed checks so far: ${n + 1}.`);
      expect(next).toMatch(
        new RegExp(
          `${m.id}#\\S+ \\(.*human:dawid\\): fixes \`${key}\`; check failed: gap ${n + 1}`,
        ),
      );
      if (n === 0) {
        expect(next).toContain(`swarmup plan amend ${m.id} --kind fix --file -`);
        continue;
      }
      // The third failed check adds no fix tasks: it asks, without --to.
      expect(next).toContain('this is the third failed check, so add no fix tasks');
      expect(next).toContain(`swarmup ask ${m.id} "..." --recommend`);
      expect(next).toContain('change `done_when`, add work, or park');
      expect(next).not.toContain('--kind fix --file -');
    }
  });

  it('starts a task assigned by name to a read-only role whatever its type (AO-0136)', async () => {
    const { sup, as, repo } = setup({
      mode: 'hang',
      opsd: {
        agents: { 'fake:qa': { wake: true }, 'fake:orchestrator': { wake: true } },
        roles: { qa: { providers: ['fake'] }, orchestrator: { providers: ['fake'] } },
      },
    });
    const dir = join(repo, '.swarmup', 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'fake-orchestrator.md'), '---\ncan_claim: [question]\n---\n');
    writeFileSync(join(dir, 'fake-qa.md'), '---\nname: QA\n---\n');
    const h = as('human:dawid');
    // fake:qa's role file has no can_claim, so the read-only default applies; fake:orchestrator's file
    // allows only questions. Both tasks name the agent, so both runs start.
    const qaWork = h.newTask({ title: 'Write the release test plan', owner: 'fake:qa' });
    const orchWork = h.newTask({ title: 'Cut 2.0.0', type: 'bug', owner: 'fake:orchestrator' });
    const byTask = new Map(sup.waits().map((w) => [w.task?.split('/').pop(), w.reason]));
    expect(byTask.get(qaWork.id)).toBe('starts at the next tick');
    expect(byTask.get(orchWork.id)).toBe('starts at the next tick');
    await sup.tick();
    expect(
      sup
        .runs({ live: true })
        .map((r) => r.task)
        .sort(),
    ).toEqual([qaWork.id, orchWork.id].sort());
  });

  it('skips a schedule whose role is paused', async () => {
    const { sup, repo } = setup({
      mode: 'hang',
      opsd: { schedules: [{ name: 'digest', every: '1m', agent: 'fake:writer' }] },
    });
    role(repo, 'fake-writer', 'paused');
    await sup.tick();
    expect(sup.runs()).toHaveLength(0);
    expect(() => sup.runScheduleNow('digest')).toThrow(/fake:writer is paused in its role file/);
  });
});

describe('routing ownerless work (AO-0140)', () => {
  it('starts a run on an accepted finding within one tick, with no manual assign', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      opsd: {
        agents: { 'fake:engineer': { wake: true }, 'fake:qa': { wake: true } },
        roles: { engineer: { providers: ['fake'] }, qa: { providers: ['fake'] } },
      },
    });
    const h = as('human:dawid');
    const work = h.newTask({ title: 'work', owner: 'fake:engineer' });
    as('fake:engineer').start(work.id, 'go');
    const finding = as('fake:engineer').finding({ title: 'Login retries forever', task: work.id });
    const id = finding.meta.id;
    // Untriaged, the finding wakes nothing and swarmupd leaves its owner empty.
    await sup.tick();
    expect(sup.runs({ live: true }).map((r) => r.task)).not.toContain(id);
    expect(h.view(id).owner).toBeNull();

    h.retype(id, 'bug', 'Accepted in triage');
    await sup.tick();
    expect(h.view(id).owner).toBe('*:engineer');
    const live = sup.runs({ live: true }).find((r) => r.task?.endsWith(id));
    expect(live?.agent).toBe('fake:engineer');
    const assign = h.showEvents(id).events.find((e) => e.type === 'assign');
    expect(assign).toMatchObject({ actor: 'opsd:router', to: '*:engineer' });
    expect(assign?.body.trim()).toBe(`${id} has no owner; swarmupd routes bug work to *:engineer`);
  });

  it('routes work whose owner is no configured agent, and lists what it cannot route', async () => {
    const { sup, as, repo } = setup({
      mode: 'hang',
      opsd: {
        agents: { 'fake:engineer': { wake: true } },
        roles: { engineer: { providers: ['fake'] } },
      },
    });
    // Written before any agent is defined, as tasks from before the owner check were.
    const h = as('human:dawid');
    const release = h.newTask({ title: 'release', owner: 'claude:release' });
    const test = h.newTask({ title: 'cover login', type: 'test', owner: 'claude:tester' });
    // The test's user config is empty, so a role file defines the agent.
    writeFileSync(
      join(repo, '.swarmup', 'agents', 'fake-engineer.md'),
      '---\nid: fake:engineer\n---\n',
    );
    const byTask = () => new Map(sup.waits().map((w) => [w.task?.split('/').pop(), w.reason]));
    expect(byTask().get(release.id)).toBe(
      'owner claude:release is not a configured agent; swarmupd routes it to *:engineer at the next tick',
    );
    expect(byTask().get(test.id)).toBe(
      'owner claude:tester is not a configured agent; swarmupd cannot route it: no waking agent answers to *:qa',
    );
    await sup.tick();
    expect(h.view(release.id).owner).toBe('*:engineer');
    expect(sup.runs({ live: true }).map((r) => r.task?.split('/').pop())).toEqual([release.id]);
    // The test task keeps its owner and still says why it waits.
    expect(h.view(test.id).owner).toBe('claude:tester');
    expect(byTask().get(test.id)).toMatch(/no waking agent answers to \*:qa/);
  });

  it('leaves an accepted finding unrouted when no waking agent is one of the role providers', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      opsd: {
        agents: { 'fake:engineer': { wake: true } },
        roles: { engineer: { providers: ['other'] } },
      },
    });
    const h = as('human:dawid');
    const work = h.newTask({ title: 'work', owner: 'fake:engineer' });
    as('fake:engineer').start(work.id, 'go');
    const id = as('fake:engineer').finding({ title: 'Login retries', task: work.id }).meta.id;
    h.retype(id, 'bug', 'Accepted in triage');
    await sup.tick();
    // wakeCandidates would start no run on a *:engineer task here, so swarmupd does not assign one.
    expect(h.view(id).owner).toBeNull();
    expect(h.showEvents(id).events.some((e) => e.type === 'assign')).toBe(false);
    expect(sup.runs({ live: true }).map((r) => r.task?.split('/').pop())).not.toContain(id);
    const wait = sup.waits().find((w) => w.task?.endsWith(id));
    expect(wait?.reason).toBe(
      'no waking agent may take it (role providers, overflow or the expected reviewer); ' +
        'swarmupd cannot route it: no waking agent of *:engineer is one of its providers ' +
        '(swarmupd.roles.engineer.providers, overflow)',
    );
  });

  it('leaves delegated work unrouted when the only waking provider is the expected reviewer', async () => {
    const { sup, as, repo } = setup({
      mode: 'hang',
      opsd: {
        agents: { 'fake:engineer': { wake: true } },
        roles: { engineer: { providers: ['fake'] } },
      },
    });
    // The test's user config is empty, so role files define the agents.
    const agents = join(repo, '.swarmup', 'agents');
    writeFileSync(join(agents, 'fake-engineer.md'), '---\nid: fake:engineer\n---\n');
    writeFileSync(join(agents, 'fake-qa.md'), '---\nid: fake:qa\n---\n');
    const backend = join(agents, 'other-backend.md');
    writeFileSync(backend, '---\nid: other:backend\n---\n');
    const h = as('human:dawid');
    const t = h.newTask({ title: 'fix', type: 'bug' });
    h.delegate(t.id, 'other:backend', { review: 'fake:qa' });
    // The delegate is removed; a routing assign would keep the delegation and its reviewer.
    rmSync(backend);
    await sup.tick();
    // wakeCandidates never starts a fake run on work fake:qa reviews, so swarmupd does not assign.
    expect(h.view(t.id).owner).toBe('other:backend');
    expect(h.showEvents(t.id).events.some((e) => e.type === 'assign')).toBe(false);
    expect(sup.runs({ live: true }).map((r) => r.task?.split('/').pop())).not.toContain(t.id);
    const wait = sup.waits().find((w) => w.task?.endsWith(t.id));
    expect(wait?.reason).toMatch(
      /swarmupd cannot route it: every waking provider of \*:engineer is the provider of the expected reviewer fake:qa$/,
    );
  });
});

describe('reviews of a provider that cannot run (AO-0341)', () => {
  const HOUR = 3_600_000;
  /** fake stands for the paused provider (Claude), other for the author's (Codex). */
  function paused(opsd: Record<string, unknown> = {}) {
    let now = Date.now();
    const env = setup({
      mode: 'hang',
      now: () => now,
      opsd: {
        agents: {
          'fake:reviewer': { wake: true },
          'other:reviewer': { wake: true },
          'other:engineer': { wake: true },
        },
        runtimes: { other: HANG_RUNTIME },
        roles: { engineer: { providers: ['other'] } },
        ...opsd,
      },
    });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const meta = env.as('human:dawid').newTask({
        title: `built ${i}`,
        owner: 'other:engineer',
        project: 'a',
      });
      env.as('other:engineer').start(meta.id, 'plan');
      env.as('other:engineer').review(meta.id, `ready ${i}`, 'fake:reviewer');
      ids.push(meta.id);
    }
    const work = env
      .as('human:dawid')
      .newTask({ title: 'new work', owner: 'other:engineer', project: 'a' });
    const resets = now + 3 * 24 * HOUR;
    const pause = (): void => {
      env.sup['usage'].fake = {
        windows: { seven_day: { utilization: 0.92, resets_at: resets } },
        updated_at: now,
      };
      env.sup['waitsMemo'] = null;
    };
    const advance = (ms: number): void => {
      now += ms;
    };
    const notes = () =>
      env
        .as('human:dawid')
        .inbox('human:dawid')
        .filter((i) => i.kind === 'mention' && i.from === 'opsd:runtime');
    return { ...env, ids, work, resets, pause, advance, notes };
  }
  const byTask = (sup: Supervisor) =>
    new Map(sup.waits().map((w) => [(w.task ?? '').split('/').pop(), w]));

  it('holds no work for reviews whose reviewer is paused or signed out', () => {
    const { sup, work, pause } = paused();
    expect(byTask(sup).get(work.id)?.reason).toMatch(/3 reviews wait in a; new work there waits/);
    pause();
    expect(byTask(sup).get(work.id)?.reason).toBe('starts at the next tick');
    delete sup['usage'].fake;
    sup['markSignedOut']('fake', 'check');
    sup['waitsMemo'] = null;
    expect(byTask(sup).get(work.id)?.reason).toBe('starts at the next tick');
  });

  it('moves the reviews to the author provider after review_fallback_hours, and the verdict notes it', async () => {
    const { sup, as, ids, resets, pause, advance } = paused();
    pause();
    await sup.tick();
    const reviewerOf = (id: string) => as('human:dawid').view(id).reviewer;
    expect(ids.map(reviewerOf)).toEqual(['fake:reviewer', 'fake:reviewer', 'fake:reviewer']);
    advance(2 * HOUR - 60_000);
    await sup.tick();
    expect(reviewerOf(ids[0]!)).toBe('fake:reviewer');
    advance(60_000);
    await sup.tick();
    expect(ids.map(reviewerOf)).toEqual(['other:reviewer', 'other:reviewer', 'other:reviewer']);
    const reason = `fake paused until ${clock(resets)}`;
    const moved = as('human:dawid')
      .showEvents(ids[0]!)
      .events.find((e) => e.type === 'review-fallback')!;
    expect(moved).toMatchObject({ actor: 'opsd:runtime', to: 'other:reviewer', fallback: reason });
    expect(moved.body.startsWith(`fallback: ${reason}. `)).toBe(true);
    // The request stays the author's: the reviewer reads it, not the fallback note.
    expect(as('human:dawid').view(ids[0]!).lastReview).toMatchObject({
      actor: 'other:engineer',
      body: 'ready 0',
      fallback: reason,
    });
    expect(sup.runs({ live: true }).some((r) => r.agent === 'other:reviewer')).toBe(true);
    as('other:reviewer').verdict(ids[0]!, 'approve', 'looks right');
    const verdict = as('human:dawid')
      .showEvents(ids[0]!)
      .events.find((e) => e.type === 'verdict')!;
    expect(verdict.fallback).toBe(reason);
    // Only swarmupd moves a review to a reviewer of the author's provider.
    expect(() =>
      as('other:engineer').reviewFallback(ids[1]!, 'other:reviewer', reason, 'x'),
    ).toThrow();
  });

  it('does not move an Opus review for a Fable-only window (AO-0362)', async () => {
    const { sup, as, ids, advance } = paused({
      agents: {
        'fake:reviewer': { wake: true, model: 'claude-opus-5-5' },
        'other:reviewer': { wake: true },
        'other:engineer': { wake: true },
      },
    });
    sup['usage'].fake = {
      windows: {
        seven_day_fable: {
          utilization: 1,
          resets_at: Date.now() + 3 * 24 * HOUR,
          status: 'rejected',
        },
      },
      updated_at: Date.now(),
    };
    sup['waitsMemo'] = null;

    expect(sup.providerHold('fake')).toBeNull();
    await sup.tick();
    advance(2 * HOUR);
    await sup.tick();

    const reviewerOf = (id: string) => as('human:dawid').view(id).reviewer;
    expect(ids.map(reviewerOf)).toEqual(['fake:reviewer', 'fake:reviewer', 'fake:reviewer']);
    expect(sup.runs({ live: true }).some((r) => r.agent === 'fake:reviewer')).toBe(true);
  });

  it('ignores a non-waking Opus agent for a Fable provider hold (AO-0368)', async () => {
    const { sup, as, ids, advance } = paused({
      agents: {
        'fake:reviewer': { wake: true, model: 'claude-fable-5-2' },
        'fake:engineer': { wake: false, model: 'claude-opus-5-5' },
        'other:reviewer': { wake: true },
        'other:engineer': { wake: true },
      },
    });
    sup['usage'].fake = {
      windows: {
        seven_day_fable: {
          utilization: 1,
          resets_at: Date.now() + 3 * 24 * HOUR,
          status: 'rejected',
        },
      },
      updated_at: Date.now(),
    };
    sup['waitsMemo'] = null;

    expect(sup.providerHold('fake')?.text).toMatch(/seven_day_fable window .*fable runs only/);
    await sup.tick();
    advance(2 * HOUR);
    await sup.tick();

    const reviewerOf = (id: string) => as('human:dawid').view(id).reviewer;
    expect(ids.map(reviewerOf)).toEqual(['other:reviewer', 'other:reviewer', 'other:reviewer']);
    expect(sup.runs({ live: true }).some((r) => r.agent === 'other:reviewer')).toBe(true);
  });

  it('never moves a review with review_fallback_hours 0', async () => {
    const { sup, as, ids, pause, advance } = paused({ review_fallback_hours: 0 });
    pause();
    await sup.tick();
    advance(48 * HOUR);
    await sup.tick();
    expect(as('human:dawid').view(ids[0]!).reviewer).toBe('fake:reviewer');
    expect(sup.stalls()[0]?.text).toMatch(/review fallback is off/);
  });

  it('tells the person once per pause, and shows the stall as one line', async () => {
    const { sup, ids, resets, pause, advance, notes } = paused({ review_fallback_hours: 0 });
    pause();
    await sup.tick();
    advance(10 * 60_000);
    await sup.tick();
    await sup.tick();
    const told = notes();
    expect(told).toHaveLength(1);
    const text = told[0]!.detail ?? told[0]!.summary;
    expect(text).toContain(`until ${clock(resets)}`);
    expect(text).toContain(`3 reviews (${ids.join(', ')})`);
    expect(text).toContain('raise `pause_at` for fake');
    expect(text).toContain('review_fallback_hours');
    const stalls = sup.stalls();
    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toMatchObject({ provider: 'fake', reviews: ids, tasks: [] });
    expect(stalls[0]!.text).toMatch(/^fake usage at 92% .*: 3 reviews \(/);
    expect(sup.waits().filter((w) => w.stall === 'fake')).toHaveLength(3);
  });
});
