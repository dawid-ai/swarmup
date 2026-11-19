import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { samePath } from '@swarmup/core';
import {
  type ProcLister,
  type ProcTarget,
  type RunRecord,
  codexGitDirs,
  systemLister,
} from '../src/index.js';
import { Checkout, LEFTOVER_FILE_LIMIT } from '../src/checkout.js';
import { spySyncProcs } from './sync-procs.js';
import { until } from './until.js';
import { ended, setup, temp } from './supervisor-setup.js';

describe('what runs leave in the checkout', () => {
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
  /** A file's text with Windows line endings (`core.autocrlf`) read as Unix ones. */
  const text = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

  /** A checkout with code and the task store committed, as in a project repo. */
  function codeSetup(mode: string, env: Record<string, string> = {}, procs?: ProcLister) {
    const s = setup({ mode, env: { ...ID, ...env }, procs });
    writeFileSync(join(s.repo, 'tracked.txt'), 'original\n');
    writeFileSync(join(s.repo, 'gone.txt'), 'deleted by the run\n');
    writeFileSync(join(s.repo, '.gitignore'), 'dist/\n');
    s.as('human:dawid').newTask({ title: 'Fix the parser', owner: 'fake:engineer' });
    git(s.repo, 'add', '-A');
    git(s.repo, 'commit', '-qm', 'start');
    return {
      ...s,
      start: git(s.repo, 'rev-parse', 'HEAD'),
      branch: git(s.repo, 'branch', '--show-current'),
    };
  }

  it('commits what a run left on a branch of its own, restores the checkout and asks for review', async () => {
    const { repo, sup, as, start, branch } = codeSetup('edit');
    // Ignored output is no change of the checkout.
    mkdirSync(join(repo, 'dist'));
    writeFileSync(join(repo, 'dist', 'out.js'), 'built\n');
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    await ended(sup, run.id);

    const name = `fake/t-0001-${run.id.toLowerCase()}`;
    const commit = git(repo, 'rev-parse', name);
    expect(git(repo, 'rev-parse', `${commit}^`)).toBe(start);
    expect(git(repo, 'log', '-1', '--format=%B', commit)).toBe(
      `Fix the parser\n\nChanges left by run ${run.id} (fake:engineer).`,
    );
    // Only the run's code: the task store's new events never go into the branch.
    expect(git(repo, 'diff-tree', '-r', '--no-renames', '--name-status', start, commit)).toBe(
      ['D\tgone.txt', 'A\tsrc/new/added.txt', 'M\ttracked.txt'].join('\n'),
    );
    expect(git(repo, 'show', `${commit}:tracked.txt`)).toBe('changed by the run');

    // The checkout is back on its branch and commit, clean outside the task store.
    expect(git(repo, 'branch', '--show-current')).toBe(branch);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(start);
    expect(git(repo, 'status', '--porcelain', '--', '.', ':(exclude).swarmup')).toBe('');
    expect(text(join(repo, 'tracked.txt'))).toBe('original\n');
    expect(existsSync(join(repo, 'gone.txt'))).toBe(true);
    expect(existsSync(join(repo, 'src'))).toBe(false);
    expect(readFileSync(join(repo, 'dist', 'out.js'), 'utf8')).toBe('built\n');

    const v = as('human:dawid').view('1');
    expect(v.status).toBe('needs-review');
    expect(v.reviewer).toBe('human:dawid');
    const { events } = as('human:dawid').showEvents('1');
    expect(events.find((e) => e.type === 'run-end')?.body).toContain(
      `swarmupd committed them as ${commit.slice(0, 7)} on branch ${name}`,
    );
    const last = events.at(-1)!;
    expect(last).toMatchObject({ type: 'review', actor: 'fake:engineer' });
    expect(last.body.startsWith(`${commit.slice(0, 7)} on branch ${name}: `)).toBe(true);
    expect(last.body).toContain('ended without `swarmup review`');
    expect(last.body).toContain(`Merge into ${branch} after approval.`);
  });

  it("sends the review to another provider's qa agent", async () => {
    const { repo, sup, as } = codeSetup('edit');
    as('human:dawid').saveRole({ id: 'claude:qa', status: 'active' }, { create: true });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'qa role');
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    await ended(sup, run.id);
    expect(as('human:dawid').view('1')).toMatchObject({
      status: 'needs-review',
      reviewer: 'claude:qa',
    });
  });

  it('sends what a run left on a release task to the person, not a qa agent', async () => {
    const { repo, sup, as } = codeSetup('edit');
    const h = as('human:dawid');
    h.newTask({ title: 'Cut 0.2.0', owner: 'fake:engineer', labels: ['release'] });
    h.saveRole({ id: 'claude:qa', status: 'active' }, { create: true });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'release task');
    const run = sup.launch({ agent: 'fake:engineer', task: '2' });
    await ended(sup, run.id);
    expect(h.view('2')).toMatchObject({ status: 'needs-review', reviewer: 'human:dawid' });
  });

  it('sends what a run left to the reviewer agent of another provider', async () => {
    const { repo, sup, as } = codeSetup('edit');
    const h = as('human:dawid');
    h.saveRole({ id: 'claude:qa', status: 'active' }, { create: true });
    h.saveRole({ id: 'claude:reviewer', status: 'active' }, { create: true });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'roles');
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    await ended(sup, run.id);
    expect(h.view('1')).toMatchObject({ status: 'needs-review', reviewer: 'claude:reviewer' });
  });

  it('tells the reviewer where the files went when the run asked for review itself', async () => {
    const { sup, as } = codeSetup('edit-review');
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    await ended(sup, run.id);
    expect(as('human:dawid').view('1').status).toBe('needs-review');
    const last = as('human:dawid').showEvents('1').events.at(-1)!;
    expect(last).toMatchObject({ type: 'comment', to: 'human:dawid' });
    expect(last.body).toContain(`fake/t-0001-${run.id.toLowerCase()}`);
    expect(last.body).toContain('asked for review with 3 file(s) it could not commit');
  });

  it('leaves runs that commit themselves alone', async () => {
    const { repo, sup, as, start } = codeSetup('commit');
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    await ended(sup, run.id);
    expect(git(repo, 'branch', '--list', 'fake/*')).toBe('');
    expect(git(repo, 'rev-parse', 'HEAD^')).toBe(start);
    expect(as('human:dawid').view('1').status).toBe('done');
    const end = as('human:dawid')
      .showEvents('1')
      .events.find((e) => e.type === 'run-end');
    expect(end?.body).toBe('');
  });

  it('starts no writing run in a checkout with uncommitted changes, and says why it waits', async () => {
    const { repo, sup, as } = setup({
      mode: 'hang',
      env: ID,
      opsd: { agents: { 'fake:engineer': { wake: true } } },
    });
    writeFileSync(join(repo, 'tracked.txt'), 'original\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'start');
    // New tasks and events in the task store are no changes of the checkout.
    const t = as('human:dawid').newTask({ title: 'a', owner: 'fake:engineer' });
    writeFileSync(join(repo, 'tracked.txt'), 'a person at work\n');
    writeFileSync(join(repo, 'notes.txt'), 'notes\n');
    expect(() => sup.launch({ agent: 'fake:engineer', task: '1' })).toThrow(
      /^checkout has uncommitted changes in .+: (tracked|notes)\.txt and 1 more$/,
    );
    expect(sup.waits().map((w) => [w.task?.split('/').pop(), w.reason])).toEqual([
      [t.id, expect.stringMatching(/^fake:engineer: checkout has uncommitted changes in /)],
    ]);
    await sup.tick();
    expect(sup.runs({ live: true })).toHaveLength(0);
    expect(as('human:dawid').view('1').status).toBe('todo');
    // Roles that only read start anyway.
    sup.launch({ agent: 'fake:qa' });
    // Once the checkout is clean, the writer starts.
    git(repo, 'checkout', '--', 'tracked.txt');
    rmSync(join(repo, 'notes.txt'));
    sup.launch({ agent: 'fake:engineer', task: '1' });
    expect(sup.runs({ live: true })).toHaveLength(2);
  });

  it('tells the human once per checkout that its changes hold a writing run (AO-0137)', async () => {
    const { repo, sup, as } = setup({
      mode: 'hang',
      env: ID,
      opsd: { agents: { 'fake:engineer': { wake: true } } },
    });
    writeFileSync(join(repo, 'tracked.txt'), 'original\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'start');
    const t = as('human:dawid').newTask({ title: 'a', owner: 'fake:engineer' });
    const notices = () =>
      as('human:dawid')
        .inbox('human:dawid')
        .filter((i) => i.kind === 'mention' && i.from === 'opsd:checkout');
    // A live run in the checkout may be what made the changes: no notice while it runs.
    writeFileSync(join(repo, 'tracked.txt'), 'a person at work\n');
    const qa = sup.launch({ agent: 'fake:qa' });
    await sup.tick();
    expect(sup.runs({ live: true }).map((r) => r.agent)).toEqual(['fake:qa']);
    expect(notices()).toHaveLength(0);
    sup.kill(qa.id);
    await ended(sup, qa.id);
    // The read-only run found the changes, so it left them; now nothing works in the checkout.
    await sup.tick();
    expect(sup.runs({ live: true })).toHaveLength(0);
    const first = notices();
    expect(first).toHaveLength(1);
    expect(first[0]!.summary).toMatch(
      new RegExp(
        `^fake:engineer waits to work on (test/)?${t.id} in .+, but that checkout has uncommitted changes and no run works in it: tracked\\.txt\\. `,
      ),
    );
    // Once per checkout, while it stays dirty.
    writeFileSync(join(repo, 'notes.txt'), 'notes\n');
    await sup.tick();
    expect(notices()).toHaveLength(1);
    // Clean again, the writer starts; changes made later are news.
    git(repo, 'checkout', '--', 'tracked.txt');
    rmSync(join(repo, 'notes.txt'));
    await sup.tick();
    const writer = sup.runs({ live: true });
    expect(writer.map((r) => r.agent)).toEqual(['fake:engineer']);
    sup.kill(writer[0]!.id);
    await ended(sup, writer[0]!.id);
    as('human:dawid').assign(t.id, 'human:dawid');
    writeFileSync(join(repo, 'later.txt'), 'later\n');
    as('human:dawid').newTask({ title: 'b', owner: 'fake:engineer' });
    await sup.tick();
    expect(notices().map((n) => n.summary)).toEqual([
      first[0]!.summary,
      expect.stringMatching(/: later\.txt\. /),
    ]);
  });

  it('commits what a read-only run left when it started on a clean checkout (AO-0136)', async () => {
    const { repo, sup, start, branch } = codeSetup('edit');
    const run = sup.launch({ agent: 'fake:qa' });
    const rec = await ended(sup, run.id);
    expect(rec.base).toBe(start);
    const name = `fake/run-${run.id.toLowerCase()}`;
    expect(sup.run(run.id)).toMatchObject({ leftovers: { branch: name } });
    expect(git(repo, 'rev-parse', `${name}^`)).toBe(start);
    // The checkout is clean again, so writing runs there start.
    expect(git(repo, 'branch', '--show-current')).toBe(branch);
    expect(git(repo, 'status', '--porcelain', '--', '.', ':(exclude).swarmup')).toBe('');
  });

  it('wraps up a run without blocking the event loop on git: commit, sync, branch push (AO-0205)', async () => {
    const s = setup({ mode: 'edit', env: ID, opsd: { sync: true } });
    writeFileSync(join(s.repo, 'tracked.txt'), 'original\n');
    writeFileSync(join(s.repo, 'gone.txt'), 'deleted by the run\n');
    s.as('human:dawid').newTask({ title: 'Fix the parser', owner: 'fake:engineer' });
    git(s.repo, 'add', '-A');
    git(s.repo, 'commit', '-qm', 'start');
    const remote = temp();
    git(remote, 'init', '-q', '--bare');
    git(s.repo, 'remote', 'add', 'origin', remote);
    git(s.repo, 'push', '-q', '-u', 'origin', 'HEAD');
    const sup = s.sup;
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    const name = `fake/t-0001-${run.id.toLowerCase()}`;
    const synced = new Promise<void>((res) => sup.on('sync', () => res()));
    const spy = spySyncProcs();
    try {
      await ended(sup, run.id);
      await synced;
      // The branch push follows the sync on the same queue.
      const until = Date.now() + 30_000;
      while (!git(remote, 'branch', '--list', name) && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      spy.restore();
    }
    expect(sup.run(run.id)).toMatchObject({ wrap_up: 'done', leftovers: { branch: name } });
    expect(git(remote, 'branch', '--list', name)).toContain(name);
    // Each of these held every API request for 0.5-2 s on a loaded Windows machine.
    expect(spy.calls.map((c) => `${c.command} at ${c.at}`)).toEqual([]);
  });

  it('starts a writing run from a tick or the API without running git on the event loop (AO-0215)', async () => {
    const s = setup({
      mode: 'edit',
      env: ID,
      opsd: { agents: { 'fake:engineer': { wake: true } } },
    });
    writeFileSync(join(s.repo, 'tracked.txt'), 'original\n');
    writeFileSync(join(s.repo, 'gone.txt'), 'deleted by the run\n');
    s.as('human:dawid').newTask({ title: 'Fix the parser', owner: 'fake:engineer' });
    git(s.repo, 'add', '-A');
    git(s.repo, 'commit', '-qm', 'start');
    const start = git(s.repo, 'rev-parse', 'HEAD');
    const sup = s.sup;
    // The app's Waiting list plans first: opsd learns the checkout, and each tick reads it.
    expect(sup.waits().map((w) => w.reason)).toEqual(['starts at the next tick']);
    const spy = spySyncProcs();
    try {
      await sup.tick();
    } finally {
      spy.restore();
    }
    const [run] = sup.runs({ live: true });
    expect(run).toMatchObject({ agent: 'fake:engineer', task: 'T-0001', base: start });
    // `git status` and `git rev-parse` each held the API for 0.3-1.8 s per launch under load.
    expect(spy.calls.map((c) => `${c.command} at ${c.at}`)).toEqual([]);
    const rec = await ended(sup, run!.id);
    expect(rec.wrap_up).toBe('done');
    // A dirty checkout still holds the next writing run, from the state the tick read.
    s.as('human:dawid').newTask({ title: 'Next', owner: 'fake:engineer' });
    writeFileSync(join(s.repo, 'notes.txt'), 'a person at work\n');
    await sup.tick();
    expect(sup.runs({ live: true })).toEqual([]);
    expect(sup.waits().map((w) => w.reason)).toEqual([
      expect.stringContaining('checkout has uncommitted changes'),
    ]);
    // A launch from the API reads the checkout again, off the event loop: clean once more.
    rmSync(join(s.repo, 'notes.txt'));
    const apiSpy = spySyncProcs();
    let next: RunRecord;
    try {
      next = await sup.launchFresh({ agent: 'fake:engineer', task: 'T-0002' });
    } finally {
      apiSpy.restore();
    }
    expect(next).toMatchObject({ task: 'T-0002', base: start });
    expect(apiSpy.calls.map((c) => `${c.command} at ${c.at}`)).toEqual([]);
    await ended(sup, next.id);
  });

  it('never commits changes a read-only run found in the checkout (AO-0136)', async () => {
    const { repo, sup } = codeSetup('edit');
    writeFileSync(join(repo, 'notes.txt'), 'a person at work\n');
    const run = sup.launch({ agent: 'fake:qa' });
    const rec = await ended(sup, run.id);
    expect(rec.base).toBeUndefined();
    expect(sup.run(run.id)?.leftovers).toBeUndefined();
    expect(git(repo, 'branch', '--list', 'fake/*')).toBe('');
    expect(text(join(repo, 'notes.txt'))).toBe('a person at work\n');
  });

  it('starts a read-only Codex run in its task store with only the stores writable (AO-0138)', async () => {
    const out = join(temp(), 'codex-call.json');
    const recorder = join(temp(), 'codex.mjs');
    writeFileSync(
      recorder,
      [
        "import { writeFileSync } from 'node:fs';",
        "let prompt = '';",
        'for await (const c of process.stdin) prompt += c;',
        'writeFileSync(process.env.CODEX_CALL, JSON.stringify({ args: process.argv.slice(2), prompt }));',
      ].join('\n'),
    );
    const { repo, sup } = setup({
      env: { CODEX_CALL: out },
      opsd: { runtimes: { codex: { command: process.execPath, args: [recorder] } } },
    });
    const run = sup.launch({ agent: 'codex:qa' });
    await ended(sup, run.id);
    const call = JSON.parse(text(out)) as { args: string[]; prompt: string };
    const store = join(repo, '.swarmup');
    const cd = call.args[call.args.indexOf('-C') + 1]!;
    expect(samePath(cd, store)).toBe(true);
    expect(call.args[call.args.indexOf('--sandbox') + 1]).toBe('workspace-write');
    // Its scratch folder, where `TEMP` points, is the one other folder it may write (AO-0296).
    const scratch = sup.run(run.id).scratch!;
    expect(call.args.filter((_, i) => call.args[i - 1] === '--add-dir')).toEqual([scratch]);
    expect(call.prompt).toMatch(/may not change files in .+: Codex starts you in the task store/);
    expect(call.prompt).toContain('You can also write your scratch folder');
    expect(call.prompt).toContain('swarmupd commits and pushes the task store when this run ends');
    // A writing Codex run still works in its checkout.
    const writer = sup.launch({ agent: 'codex:engineer' });
    await ended(sup, writer.id);
    const wcall = JSON.parse(text(out)) as { args: string[]; prompt: string };
    expect(samePath(wcall.args[wcall.args.indexOf('-C') + 1]!, repo)).toBe(true);
    expect(wcall.prompt).not.toContain('may not change files');
    // In the checkout itself it gets no git dirs: they would lie under the checkout's read-only
    // `.git`, and the Codex Windows sandbox then refuses every command (AO-0173). A run in a
    // worktree gets them (next test).
    const added = wcall.args.filter((_, i) => wcall.args[i - 1] === '--add-dir');
    expect(added.some((d) => samePath(d, repo) || d.includes('.git'))).toBe(false);
    expect(call.args.join(' ')).not.toContain('.git');
  });

  it('gives a writing Codex run in a worktree the main repo git metadata (AO-0155)', async () => {
    const out = join(temp(), 'codex-call.json');
    const recorder = join(temp(), 'codex.mjs');
    writeFileSync(
      recorder,
      [
        "import { writeFileSync } from 'node:fs';",
        'writeFileSync(process.env.CODEX_CALL, JSON.stringify({ args: process.argv.slice(2) }));',
      ].join('\n'),
    );
    const { repo, sup } = setup({
      env: { CODEX_CALL: out },
      opsd: { runtimes: { codex: { command: process.execPath, args: [recorder] } } },
    });
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'start');
    const wt = join(temp(), 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'side', wt);
    const run = sup.launch({ agent: 'codex:engineer', cwd: wt });
    await ended(sup, run.id);
    const call = JSON.parse(text(out)) as { args: string[] };
    const added = call.args.filter((_, i) => call.args[i - 1] === '--add-dir');
    expect(added.some((d) => samePath(d, join(repo, '.git', 'worktrees', 'wt')))).toBe(true);
    expect(added.some((d) => samePath(d, join(repo, '.git', 'objects')))).toBe(true);
    // The checkout that holds them is swapped for its task store, so no writable folder has them
    // under its read-only `.git` (AO-0173).
    expect(added.some((d) => samePath(d, repo))).toBe(false);
    expect(added.some((d) => samePath(d, join(repo, '.swarmup')))).toBe(true);
  });

  it('starts a writing Codex run with the git dirs git named, without running git (AO-0215)', async () => {
    const out = join(temp(), 'codex-call.json');
    const recorder = join(temp(), 'codex.mjs');
    writeFileSync(
      recorder,
      [
        "import { writeFileSync } from 'node:fs';",
        'writeFileSync(process.env.CODEX_CALL, JSON.stringify({ args: process.argv.slice(2) }));',
      ].join('\n'),
    );
    const { repo, sup } = setup({
      env: { CODEX_CALL: out },
      opsd: { runtimes: { codex: { command: process.execPath, args: [recorder] } } },
    });
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'start');
    const wt = join(temp(), 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'side', wt);
    // The first launch there teaches swarmupd the checkout; each later one reads it beforehand.
    await ended(sup, (await sup.launchFresh({ agent: 'codex:engineer', cwd: wt })).id);
    rmSync(out);
    const spy = spySyncProcs();
    let run: RunRecord;
    try {
      run = await sup.launchFresh({ agent: 'codex:engineer', cwd: wt });
    } finally {
      spy.restore();
    }
    // `git rev-parse --git-dir --git-common-dir` held the API for 0.2-1.5 s per launch under load.
    expect(spy.calls.map((c) => `${c.command} at ${c.at}`)).toEqual([]);
    await ended(sup, run.id);
    const call = JSON.parse(text(out)) as { args: string[] };
    const added = call.args.filter((_, i) => call.args[i - 1] === '--add-dir');
    for (const d of [join(repo, '.git', 'worktrees', 'wt'), join(repo, '.git', 'objects')]) {
      expect(added.some((a) => samePath(a, d))).toBe(true);
    }
  });

  it('gives a writing Codex run no git dirs that git itself refuses (AO-0215)', () => {
    const repo = temp();
    git(repo, 'init', '-q');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'start');
    const wt = join(temp(), 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'side', wt);
    expect(codexGitDirs(wt).length).toBe(4);
    expect(codexGitDirs(temp())).toEqual([]);

    // A `.git` file that names a folder which is no git dir: nothing there becomes writable,
    // and no `logs` folder is made in it.
    const lure = temp();
    mkdirSync(join(lure, 'objects'));
    mkdirSync(join(lure, 'refs'));
    const fake = temp();
    writeFileSync(join(fake, '.git'), `gitdir: ${lure}\n`);
    expect(codexGitDirs(fake)).toEqual([]);
    expect(existsSync(join(lure, 'logs'))).toBe(false);

    // A `.git` folder that is no git dir.
    const hollow = temp();
    mkdirSync(join(hollow, '.git', 'objects'), { recursive: true });
    expect(codexGitDirs(hollow)).toEqual([]);
    expect(existsSync(join(hollow, '.git', 'logs'))).toBe(false);

    // A checkout git refuses for its owner (`safe.directory`).
    const none = join(temp(), 'gitconfig');
    writeFileSync(none, '');
    const unsafe = {
      ...process.env,
      GIT_TEST_ASSUME_DIFFERENT_OWNER: '1',
      GIT_CONFIG_GLOBAL: none,
      GIT_CONFIG_NOSYSTEM: '1',
    };
    expect(codexGitDirs(wt, unsafe)).toEqual([]);

    // A worktree whose `commondir` names a folder that is no repo.
    const empty = temp();
    writeFileSync(join(repo, '.git', 'worktrees', 'wt', 'commondir'), `${empty}\n`);
    expect(codexGitDirs(wt)).toEqual([]);
    expect(existsSync(join(empty, 'logs'))).toBe(false);
  });

  it('lets a chat turn neither hold a checkout nor wait on one (AO-0136)', async () => {
    const { repo, sup, as } = setup({ mode: 'hang', env: ID });
    writeFileSync(join(repo, 'tracked.txt'), 'original\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'start');
    as('human:dawid').newTask({ title: 'a', owner: 'fake:engineer' });
    as('human:dawid').newTask({ title: 'b', owner: 'fake:planner' });
    // A chat turn of a role that writes starts beside a writing run in the same checkout...
    sup.launch({ agent: 'fake:engineer', task: '1' });
    expect(sup.blocker('fake:planner', 'test', { cwd: repo })).toMatch(
      /one writing run per checkout/,
    );
    expect(sup.blocker('fake:planner', 'test', { cwd: repo, chat: true })).toBeNull();
    // ...and on a checkout with changes, and gets no start commit there.
    writeFileSync(join(repo, 'tracked.txt'), 'a person at work\n');
    const turn = sup.launch({ agent: 'fake:planner', chat: { session: 's1', resume: false } });
    expect(turn.base).toBeUndefined();
    // A live chat turn holds no writing run in its checkout.
    git(repo, 'checkout', '--', 'tracked.txt');
    expect(sup.blocker('fake:engineer', 'test', { cwd: repo, live: [turn] })).toBeNull();
    const engineer = sup.runs({ live: true }).find((r) => r.agent === 'fake:engineer')!;
    expect(sup.blocker('fake:qa', 'test', { cwd: repo, live: [turn, engineer] })).toBeNull();
    expect(sup.blocker('fake:writer', 'test', { cwd: repo, live: [turn, engineer] })).toMatch(
      /fake:engineer works .*one writing run per checkout/,
    );
  });

  it('keeps a file whose staged version is in neither HEAD nor the commit', async () => {
    const repo = temp();
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    writeFileSync(join(repo, 'b.txt'), 'one\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'start');
    writeFileSync(join(repo, 'a.txt'), 'staged\n');
    git(repo, 'add', 'a.txt');
    writeFileSync(join(repo, 'a.txt'), 'working\n');
    writeFileSync(join(repo, 'b.txt'), 'two\n');
    const co = new Checkout(repo, [], { ...process.env, ...ID });
    const head = co.head();
    expect(co.changes().sort()).toEqual(['a.txt', 'b.txt']);
    const left = (await co.commitLeftovers('codex/t-0009-run', 'T\n', head))!;
    expect(left).toMatchObject({ files: ['a.txt', 'b.txt'], kept: ['a.txt'] });
    expect(git(repo, 'show', `${left.commit}:a.txt`)).toBe('working');
    // The staged version stays staged and the work stays in the file.
    expect(git(repo, 'show', ':a.txt')).toBe('staged');
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('working\n');
    expect(text(join(repo, 'b.txt'))).toBe('one\n');
    expect(await co.commitLeftovers('codex/again', 'T\n', head)).toMatchObject({
      files: ['a.txt'],
      kept: ['a.txt'],
    });
  });

  it('never touches a checkout that is itself a task store', async () => {
    const repo = temp();
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'x.txt'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'start');
    writeFileSync(join(repo, 'x.txt'), 'y\n');
    const co = new Checkout(repo, [repo], { ...process.env, ...ID });
    expect(co.isStore).toBe(true);
    expect(co.changes()).toEqual([]);
    expect(await co.commitLeftovers('codex/x', 'T\n', co.head())).toBeNull();
    expect(readFileSync(join(repo, 'x.txt'), 'utf8')).toBe('y\n');
  });

  it('leaves package caches out of the dirty check and the leftover commit', async () => {
    // AO-0372: a run's `.pnpm-store` put 19,498 cache files on a review branch.
    const repo = temp();
    git(repo, 'init', '-q');
    // One cache folder the repo ignores, the others it doesn't: neither kind is a change.
    writeFileSync(join(repo, '.gitignore'), '.pnpm-store/\n');
    writeFileSync(join(repo, 'x.txt'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'start');
    const co = new Checkout(repo, [], { ...process.env, ...ID });
    const head = co.head();
    for (const dir of [
      '.pnpm-store/v3/files/00',
      'node_modules/a',
      'pkg/node_modules/b',
      '.npm/c',
    ]) {
      mkdirSync(join(repo, dir), { recursive: true });
      writeFileSync(join(repo, dir, 'f'), 'cache\n');
    }
    expect(co.changes()).toEqual([]);
    expect(await co.commitLeftovers('codex/cache-only', 'T\n', head)).toBeNull();
    writeFileSync(join(repo, 'x.txt'), 'y\n');
    const left = (await co.commitLeftovers('codex/cache', 'T\n', head))!;
    expect(left.files).toEqual(['x.txt']);
    // The caches stay where the run left them.
    expect(existsSync(join(repo, 'pkg', 'node_modules', 'b', 'f'))).toBe(true);
  });

  it('refuses a leftover commit of more files than the limit and leaves them', async () => {
    const repo = temp();
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'x.txt'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'start');
    const co = new Checkout(repo, [], { ...process.env, ...ID });
    const head = co.head();
    mkdirSync(join(repo, 'build'));
    for (let i = 0; i <= LEFTOVER_FILE_LIMIT; i++) writeFileSync(join(repo, 'build', `${i}`), '');
    await expect(co.commitLeftovers('codex/big', 'T\n', head)).rejects.toThrow(
      `${LEFTOVER_FILE_LIMIT + 1} changed files, more than ${LEFTOVER_FILE_LIMIT}`,
    );
    expect(git(repo, 'branch', '--list', 'codex/big')).toBe('');
    expect(existsSync(join(repo, 'build', '0'))).toBe(true);
  });

  it('commits only from the commit the run started on', async () => {
    const repo = temp();
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'x.txt'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'start');
    const co = new Checkout(repo, [], { ...process.env, ...ID });
    const start = co.head()!;
    writeFileSync(join(repo, 'x.txt'), 'y\n');
    git(repo, 'commit', '-qam', 'moved');
    // Committed by the run itself and nothing left: nothing to do.
    expect(await co.commitLeftovers('codex/a', 'T\n', start)).toBeNull();
    writeFileSync(join(repo, 'x.txt'), 'z\n');
    await expect(co.commitLeftovers('codex/b', 'T\n', start)).rejects.toThrow(
      `HEAD moved from ${start.slice(0, 7)} to `,
    );
    await expect(co.commitLeftovers('codex/c', 'T\n', null)).rejects.toThrow(
      /no start commit recorded/,
    );
    expect(git(repo, 'branch', '--list', 'codex/*')).toBe('');
    expect(text(join(repo, 'x.txt'))).toBe('z\n');
  });

  it('counts no linked worktree inside the checkout as a change and never commits it (AO-0135)', async () => {
    const repo = temp();
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'x.txt'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'start');
    // A code branch in a worktree the repo does not ignore, as the run prompt asks for.
    git(repo, 'worktree', 'add', '-q', 'out/wt-T-0001', '-b', 'fake/t-0001');
    writeFileSync(join(repo, 'out', 'wt-T-0001', 'x.txt'), 'work in the worktree\n');
    expect(git(repo, 'status', '--porcelain')).toContain('out/');
    const co = new Checkout(repo, [], { ...process.env, ...ID });
    expect(co.changes()).toEqual([]);
    writeFileSync(join(repo, 'y.txt'), 'left in the checkout\n');
    expect(co.changes()).toEqual(['y.txt']);
    const left = (await co.commitLeftovers('fake/run-x', 'T\n', co.head()))!;
    expect(left.files).toEqual(['y.txt']);
    expect(git(repo, 'ls-tree', '-r', '--name-only', left.commit)).toBe('x.txt\ny.txt');
    // The worktree and its work stay as they were.
    expect(text(join(repo, 'out', 'wt-T-0001', 'x.txt'))).toBe('work in the worktree\n');
  });

  it('commits what a run left when its worktrees are in an ignored folder (AO-0197)', async () => {
    const repo = temp();
    git(repo, 'init', '-q');
    writeFileSync(join(repo, '.gitignore'), 'out/\n');
    writeFileSync(join(repo, 'x.txt'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'start');
    // `git add` exits 1 when a pathspec names an ignored path, an exclude one too.
    git(repo, 'worktree', 'add', '-q', 'out/wt-T-0001', '-b', 'fake/t-0001');
    git(repo, 'worktree', 'add', '-q', 'out/wt-T-0002', '-b', 'fake/t-0002');
    writeFileSync(join(repo, 'out', 'wt-T-0001', 'x.txt'), 'work in the worktree\n');
    // One outside the ignored folder still needs its exclude.
    git(repo, 'worktree', 'add', '-q', 'side/wt-T-0003', '-b', 'fake/t-0003');
    writeFileSync(join(repo, 'side', 'wt-T-0003', 'x.txt'), 'work in the side worktree\n');
    // A task store in the ignored folder takes no exclude either.
    const store = join(repo, 'out', 'store');
    mkdirSync(store, { recursive: true });
    const co = new Checkout(repo, [store], { ...process.env, ...ID });
    expect(co.changes()).toEqual([]);
    writeFileSync(join(repo, 'y.txt'), 'left in the checkout\n');
    expect(co.changes()).toEqual(['y.txt']);
    const left = (await co.commitLeftovers('fake/run-y', 'T\n', co.head()))!;
    expect(left).toMatchObject({ files: ['y.txt'], kept: [] });
    expect(git(repo, 'ls-tree', '-r', '--name-only', left.commit)).toBe('.gitignore\nx.txt\ny.txt');
    expect(existsSync(join(repo, 'y.txt'))).toBe(false);
    expect(text(join(repo, 'out', 'wt-T-0001', 'x.txt'))).toBe('work in the worktree\n');
  });

  it('reads the worktree list again only after a worktree is added or removed (AO-0171)', () => {
    const repo = temp();
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'x.txt'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'start');
    const co = new Checkout(repo, [], { ...process.env, ...ID });
    expect(co.changes()).toEqual([]);
    // A worktree added after the list was read still stays out of the changes.
    git(repo, 'worktree', 'add', '-q', 'out/wt-T-0001', '-b', 'fake/t-0001');
    writeFileSync(join(repo, 'out', 'wt-T-0001', 'x.txt'), 'one\n');
    expect(co.changes()).toEqual([]);
    git(repo, 'worktree', 'add', '-q', 'out/wt-T-0002', '-b', 'fake/t-0002');
    expect(new Checkout(repo, [], { ...process.env, ...ID }).changes()).toEqual([]);
    // After a removal, the folder it left is an ordinary untracked change again.
    git(repo, 'worktree', 'remove', '--force', 'out/wt-T-0002');
    mkdirSync(join(repo, 'out', 'wt-T-0002'), { recursive: true });
    writeFileSync(join(repo, 'out', 'wt-T-0002', 'left.txt'), 'left\n');
    expect(co.changes()).toEqual(['out/wt-T-0002/left.txt']);
  });

  it("tells runs in a data root's checkout to branch in worktrees, and no run in a worktree (AO-0135)", async () => {
    const promptFile = join(temp(), 'prompt.txt');
    const { repo, sup, as } = setup({
      env: { ...ID, FAKE_PROMPT: promptFile },
      opsd: {
        schedules: [{ name: 'digest', every: '24h', agent: 'fake:writer', prompt: 'Write it.' }],
      },
    });
    writeFileSync(join(repo, 'x.txt'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'start');
    as('human:dawid').newTask({ title: 'a', owner: 'fake:engineer' });
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    await ended(sup, run.id);
    const top = git(repo, 'rev-parse', '--show-toplevel');
    let prompt = readFileSync(promptFile, 'utf8');
    expect(prompt).toContain(
      `- ${top} holds the task store: keep its branch checked out and never`,
    );
    expect(prompt).toContain('`git worktree add out/wt-T-0001 -b <branch> <base>`');

    // With a store branch set, the prompt names it; a schedule's prompt carries the rule too.
    const file = join(repo, '.swarmup', 'config.yml');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('policy: checkpoint', 'policy: checkpoint\n  branch: v2'),
    );
    const scheduled = sup.runScheduleNow('digest');
    await ended(sup, scheduled.id);
    prompt = readFileSync(promptFile, 'utf8');
    expect(prompt).toContain('Write it.');
    expect(prompt).toContain(`- ${top} holds the task store: keep \`v2\` checked out`);

    // A custom prompt is used as given, with the rule appended.
    const custom = sup.launch({ agent: 'fake:engineer', prompt: 'Look into X.\n' });
    await ended(sup, custom.id);
    prompt = readFileSync(promptFile, 'utf8');
    expect(prompt.startsWith('Look into X.\n\nRule for this folder:\n')).toBe(true);
    expect(prompt).toContain(`- ${top} holds the task store: keep \`v2\` checked out`);
    expect(prompt).not.toContain('Rules for supervised runs');

    // A run in a linked worktree of the repo is in no data root's checkout.
    const wt = join(temp(), 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'code');
    as('human:dawid').newTask({ title: 'b', owner: 'fake:engineer' });
    const inWorktree = sup.launch({ agent: 'fake:engineer', task: '2', cwd: wt });
    await ended(sup, inWorktree.id);
    expect(readFileSync(promptFile, 'utf8')).not.toContain('holds the task store');
  });

  it('leaves the changes alone when HEAD moved during the run', async () => {
    const { repo, sup, as, start } = codeSetup('edit-move');
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    expect(run.base).toBe(start);
    await ended(sup, run.id);
    expect(git(repo, 'branch', '--list', 'fake/*')).toBe('');
    expect(text(join(repo, 'tracked.txt'))).toBe('changed after the move\n');
    const end = as('human:dawid')
      .showEvents('1')
      .events.find((e) => e.type === 'run-end');
    expect(end?.body).toMatch(/cannot commit what it left in .+: HEAD moved from /);
    expect(as('human:dawid').view('1').status).toBe('todo');
  });

  it('tells the reviewer when a run asked for review with changes swarmupd could not commit (AO-0300)', async () => {
    const { repo, sup, as } = codeSetup('edit-move-review');
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    await ended(sup, run.id);
    expect(text(join(repo, 'tracked.txt'))).toBe('changed after the move\n');
    expect(as('human:dawid').view('1').status).toBe('needs-review');
    const last = as('human:dawid').showEvents('1').events.at(-1)!;
    expect(last).toMatchObject({ type: 'comment', to: 'human:dawid' });
    expect(last.body).toContain(`run ${run.id} (fake:engineer) asked for review, and swarmupd`);
    expect(last.body).toMatch(/cannot commit what it left in .+: HEAD moved from /);
    expect(last.body).toContain('lacks those changes');
  });

  it('commits only after the processes the run left behind are killed', async () => {
    const real = systemLister();
    if (!real.precise) {
      real.close();
      return;
    }
    const go = join(temp(), 'go');
    // A process of the run that writes in the checkout until it is killed, after the run ended.
    const late = { pid: 0x7ffffff0, start: 0, alive: false, ppid: 0 };
    let repoDir = '';
    // The run's stored wrap-up step while its process is reaped: what a restart would resume.
    let wrapStep = (): string | undefined => undefined;
    let wrapAtReap: string | undefined;
    const lister: ProcLister = {
      precise: true,
      clockSlack: real.clockSlack,
      list: async () => {
        const procs = await real.list();
        return late.alive
          ? [
              ...procs,
              { pid: late.pid, ppid: late.ppid, name: 'node', cmd: 'late', start: late.start },
            ]
          : procs;
      },
      kill: async (targets: ProcTarget[]) => {
        const out = await real.kill(targets.filter((t) => t.pid !== late.pid));
        if (targets.some((t) => t.pid === late.pid)) {
          wrapAtReap = wrapStep();
          await new Promise((r) => setTimeout(r, 300));
          writeFileSync(join(repoDir, 'late.txt'), 'written while dying\n');
          late.alive = false;
          out.set(late.pid, 'killed');
        }
        return out;
      },
      ownPids: () => real.ownPids?.() ?? [],
      close: () => real.close(),
    };
    const { repo, sup, start } = codeSetup('edit-wait', { FAKE_GO: go }, lister);
    repoDir = repo;
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    wrapStep = () => sup.store.get(run.id)?.wrap_up;
    await until(() => existsSync(join(repo, 'src', 'new', 'added.txt')));
    await sup.trackProcs();
    Object.assign(late, { alive: true, ppid: sup.run(run.id).pid, start: Date.now() });
    await sup.trackProcs();
    expect(sup.store.procs(run.id)?.entries.map((e) => e.pid)).toContain(late.pid);
    writeFileSync(go, '');
    await ended(sup, run.id, 30_000);
    expect(wrapAtReap).toBe('pending');
    expect(sup.run(run.id).wrap_up).toBe('done');

    const commit = git(repo, 'rev-parse', `fake/t-0001-${run.id.toLowerCase()}`);
    expect(git(repo, 'rev-parse', `${commit}^`)).toBe(start);
    expect(git(repo, 'show', `${commit}:late.txt`)).toBe('written while dying');
    expect(git(repo, 'status', '--porcelain', '--', '.', ':(exclude).swarmup')).toBe('');
  });

  it('commits only after the helpers of the run ended', async () => {
    const { repo, sup, as, start } = codeSetup('edit-wait', {
      FAKE_GO: join(temp(), 'never'),
      FAKE_HELPER_GO: 'helper.txt',
    });
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    await until(() => as('human:dawid').view('1').status === 'in-progress');
    const helper = sup.launch({ agent: 'fake:engineer', parent: run.id, prompt: 'help' });
    // Helpers write until they are killed; the parent ends first. The file exists before its
    // first line is in it, so wait for the content the commit must hold (AO-0239).
    await until(() => !!statSync(join(repo, 'helper.txt'), { throwIfNoEntry: false })?.size);
    sup.kill(run.id);
    await ended(sup, run.id, 30_000);
    expect(sup.run(helper.id).status).toBe('ended');
    const commit = git(repo, 'rev-parse', `fake/t-0001-${run.id.toLowerCase()}`);
    expect(git(repo, 'rev-parse', `${commit}^`)).toBe(start);
    expect(git(repo, 'show', `${commit}:helper.txt`)).not.toBe('');
    expect(git(repo, 'status', '--porcelain', '--', '.', ':(exclude).swarmup')).toBe('');
  });

  /**
   * A run whose helper ends first and leaves a process behind in the checkout: `dies` says
   * whether that process writes `late.txt` while it is killed, or survives every kill. A dying
   * one holds its kill until the parent committed or 3 s after the parent ended.
   */
  async function helperEndsFirst(dies: boolean) {
    const real = systemLister();
    if (!real.precise) {
      real.close();
      return null;
    }
    const go = join(temp(), 'go');
    const late = { pid: 0x7ffffff1, start: 0, alive: false, ppid: 0 };
    let repoDir = '';
    let parentId = '';
    const lister: ProcLister = {
      precise: true,
      clockSlack: real.clockSlack,
      list: async () => {
        const procs = await real.list();
        return late.alive
          ? [
              ...procs,
              { pid: late.pid, ppid: late.ppid, name: 'node', cmd: 'late', start: late.start },
            ]
          : procs;
      },
      kill: async (targets: ProcTarget[]) => {
        const out = await real.kill(targets.filter((t) => t.pid !== late.pid));
        if (!targets.some((t) => t.pid === late.pid)) return out;
        if (!dies) {
          out.set(late.pid, 'error');
          return out;
        }
        await until(() => sup.run(parentId).status === 'ended');
        const wait = Date.now() + 3000;
        while (Date.now() < wait && git(repoDir, 'branch', '--list', 'fake/*') === '') {
          await new Promise((r) => setTimeout(r, 50));
        }
        writeFileSync(join(repoDir, 'late.txt'), 'written while dying\n');
        late.alive = false;
        out.set(late.pid, 'killed');
        return out;
      },
      ownPids: () => real.ownPids?.() ?? [],
      close: () => real.close(),
    };
    const s = codeSetup('edit-wait', { FAKE_GO: go, FAKE_HELPER_GO: 'helper.txt' }, lister);
    const { repo, sup, as } = s;
    repoDir = repo;
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    parentId = run.id;
    await until(() => as('human:dawid').view('1').status === 'in-progress');
    const helper = sup.launch({ agent: 'fake:engineer', parent: run.id, prompt: 'help' });
    await until(() => existsSync(join(repo, 'helper.txt')));
    await sup.trackProcs();
    Object.assign(late, { alive: true, ppid: sup.run(helper.id).pid, start: Date.now() });
    await sup.trackProcs();
    expect(sup.store.procs(helper.id)?.entries.map((e) => e.pid)).toContain(late.pid);
    // The helper ends first; its process is still alive when the parent ends.
    sup.kill(helper.id);
    await until(() => sup.run(helper.id).status === 'ended');
    expect(late.alive).toBe(true);
    writeFileSync(go, '');
    await ended(sup, run.id, 30_000);
    return { ...s, run };
  }

  it('commits only after a helper that ended first finished its wrap-up', async () => {
    const s = await helperEndsFirst(true);
    if (!s) return;
    const { repo, run, start } = s;
    const commit = git(repo, 'rev-parse', `fake/t-0001-${run.id.toLowerCase()}`);
    expect(git(repo, 'rev-parse', `${commit}^`)).toBe(start);
    expect(git(repo, 'show', `${commit}:late.txt`)).toBe('written while dying');
    expect(git(repo, 'status', '--porcelain', '--', '.', ':(exclude).swarmup')).toBe('');
  });

  it('commits nothing while a process a helper left behind is still alive', async () => {
    const s = await helperEndsFirst(false);
    if (!s) return;
    const { repo, as } = s;
    expect(git(repo, 'branch', '--list', 'fake/*')).toBe('');
    expect(text(join(repo, 'tracked.txt'))).toBe('changed by the run\n');
    const end = as('human:dawid')
      .showEvents('1')
      .events.find((e) => e.type === 'run-end' && e.body !== '');
    expect(end?.body.trim()).toBe(
      'left changes uncommitted: 1 process(es) of its helpers still alive',
    );
    expect(as('human:dawid').view('1').status).toBe('todo');
  });

  /**
   * A run of `fake:engineer` on task 1 that ended under an earlier swarmupd, which stopped before
   * the wrap-up was over: its record says how far it got, and it left the usual edits.
   */
  function endedBeforeRestart(s: ReturnType<typeof codeSetup>, patch: Partial<RunRecord> = {}) {
    const id = '01RESUME00000000000000000A';
    s.sup.ws('fake:engineer', id).claim('1');
    writeFileSync(join(s.repo, 'tracked.txt'), 'changed by the run');
    rmSync(join(s.repo, 'gone.txt'));
    mkdirSync(join(s.repo, 'src', 'new'), { recursive: true });
    writeFileSync(join(s.repo, 'src', 'new', 'added.txt'), 'added\n');
    const at = new Date().toISOString();
    s.sup.store.save({
      id,
      agent: 'fake:engineer',
      task: 'T-0001',
      root: 'test',
      pid: 1,
      image: 'node.exe',
      command: 'x',
      cwd: s.repo,
      log: join(s.state, 'none.log'),
      started_at: at,
      ended_at: at,
      status: 'ended',
      exit: 0,
      reason: 'exit',
      budget_minutes: 60,
      tokens: 0,
      base: s.start,
      wrap_up: 'pending',
      ...patch,
    });
    return id;
  }

  it('resumes a wrap-up that a restart of swarmupd cut off', async () => {
    const s = codeSetup('edit');
    const { repo, as, start, branch } = s;
    const id = endedBeforeRestart(s);
    const next = s.opsd();
    const done = ended(next, id);
    next.adopt();
    // Until the wrap-up is over, the run still holds its checkout.
    expect(next.quiesceIfIdle()).toBe(false);
    await done;

    const name = `fake/t-0001-${id.toLowerCase()}`;
    const commit = git(repo, 'rev-parse', name);
    expect(git(repo, 'rev-parse', `${commit}^`)).toBe(start);
    expect(git(repo, 'show', `${commit}:tracked.txt`)).toBe('changed by the run');
    expect(git(repo, 'branch', '--show-current')).toBe(branch);
    expect(git(repo, 'status', '--porcelain', '--', '.', ':(exclude).swarmup')).toBe('');
    expect(next.run(id)).toMatchObject({ wrap_up: 'done', leftovers: { commit, branch: name } });
    expect(as('human:dawid').view('1')).toMatchObject({
      status: 'needs-review',
      reviewer: 'human:dawid',
    });
    const runEnds = () =>
      as('human:dawid')
        .showEvents('1')
        .events.filter((e) => e.type === 'run-end');
    expect(runEnds()).toHaveLength(1);
    expect(runEnds()[0]!.body).toContain(`swarmupd committed them as ${commit.slice(0, 7)}`);

    // A wrap-up that is over is never run again.
    const third = s.opsd();
    third.adopt();
    expect(third.quiesceIfIdle()).toBe(true);
    expect(runEnds()).toHaveLength(1);
  });

  it('resumes a wrap-up from the step it got to', async () => {
    const s = codeSetup('edit');
    const { repo, as } = s;
    // Committed and recorded already: only the review is left.
    const leftovers = {
      commit: s.start,
      branch: 'fake/t-0001-earlier',
      base: s.start,
      files: ['tracked.txt'],
      kept: [],
      top: repo,
      into: s.branch,
    };
    const id = endedBeforeRestart(s, { wrap_up: 'recorded', leftovers });
    const next = s.opsd();
    const done = ended(next, id);
    next.adopt();
    await done;
    // Nothing committed again, no second run-end event.
    expect(git(repo, 'branch', '--list', 'fake/*')).toBe('');
    expect(text(join(repo, 'tracked.txt'))).toBe('changed by the run');
    const { events } = as('human:dawid').showEvents('1');
    expect(events.filter((e) => e.type === 'run-end')).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: 'review', actor: 'fake:engineer' });
    expect(events.at(-1)!.body).toContain('fake/t-0001-earlier');
    expect(next.run(id).wrap_up).toBe('done');
  });

  it('resumes a wrap-up after a restart without running git on the event loop (AO-0205)', async () => {
    // A new swarmupd knows no git top yet: the resumed or adopted run's wrap-up, the store sync
    // and the branch push must find them off the event loop too.
    const base = setup({ mode: 'edit', env: ID, opsd: { sync: true } });
    writeFileSync(join(base.repo, 'tracked.txt'), 'original\n');
    writeFileSync(join(base.repo, 'gone.txt'), 'deleted by the run\n');
    base.as('human:dawid').newTask({ title: 'Fix the parser', owner: 'fake:engineer' });
    git(base.repo, 'add', '-A');
    git(base.repo, 'commit', '-qm', 'start');
    const remote = temp();
    git(remote, 'init', '-q', '--bare');
    git(base.repo, 'remote', 'add', 'origin', remote);
    git(base.repo, 'push', '-q', '-u', 'origin', 'HEAD');
    const s = {
      ...base,
      start: git(base.repo, 'rev-parse', 'HEAD'),
      branch: git(base.repo, 'branch', '--show-current'),
    };
    const id = endedBeforeRestart(s);
    const name = `fake/t-0001-${id.toLowerCase()}`;
    const next = s.opsd();
    const synced = new Promise<void>((res) => next.on('sync', () => res()));
    const done = ended(next, id);
    const spy = spySyncProcs();
    try {
      next.adopt();
      await done;
      await synced;
      const until = Date.now() + 30_000;
      while (!git(remote, 'branch', '--list', name) && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      spy.restore();
    }
    expect(next.run(id)).toMatchObject({ wrap_up: 'done', leftovers: { branch: name } });
    expect(git(remote, 'branch', '--list', name)).toContain(name);
    expect(spy.calls.map((c) => `${c.command} at ${c.at}`)).toEqual([]);
  });

  it('finishes the restore of a commit an earlier wrap-up made', async () => {
    const repo = temp();
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    writeFileSync(join(repo, 'b.txt'), 'one\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'start');
    const co = new Checkout(repo, [], { ...process.env, ...ID });
    const head = co.head();
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    writeFileSync(join(repo, 'b.txt'), 'two\n');
    writeFileSync(join(repo, 'c.txt'), 'new\n');
    const first = (await co.commitLeftovers('codex/t-0009-run', 'T\n', head))!;
    // As if swarmupd stopped after restoring b.txt only.
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    writeFileSync(join(repo, 'c.txt'), 'new\n');
    const again = (await co.commitLeftovers('codex/t-0009-run', 'T\n', head))!;
    expect(again).toMatchObject({ commit: first.commit, files: ['a.txt', 'b.txt', 'c.txt'] });
    expect(again.kept).toEqual([]);
    expect(text(join(repo, 'a.txt'))).toBe('one\n');
    expect(text(join(repo, 'b.txt'))).toBe('one\n');
    expect(existsSync(join(repo, 'c.txt'))).toBe(false);
    // A branch of that name on another commit is not this run's.
    writeFileSync(join(repo, 'a.txt'), 'three\n');
    git(repo, 'branch', 'codex/other', first.commit);
    git(repo, 'commit', '-qam', 'moved');
    await expect(co.commitLeftovers('codex/other', 'T\n', co.head())).rejects.toThrow(
      /branch codex\/other exists and does not start from /,
    );
  });
});
