import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initRoot, Root, secretKind, syncRoot, Workspace } from '@swarmup/core';
import {
  type ProcLister,
  type ProcTarget,
  type RunRecord,
  daemonCall,
  processStartSync,
  codexWritableDirs,
  invocation,
  isAlive,
  opsdConfig,
  readDaemon,
  runDaemon,
  runPrompt,
  scheduleDue,
  startApi,
  startMs,
  startDaemon,
  stopDaemon,
  Supervisor,
  SyncLog,
  systemLister,
  UsageMeter,
  withStoreCheckoutRule,
} from '../src/index.js';
import { killOwn } from './own-procs.js';
import { until } from './until.js';
import {
  FAKE_AGENT,
  alive,
  ended,
  orphanScripts,
  repoTop,
  setup,
  sups,
  temp,
  tsc,
} from './supervisor-setup.js';

describe('claim races across clones', () => {
  it('stops a live run whose claim lost to one pushed first from another clone', async () => {
    const remote = temp();
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: remote, windowsHide: true });
    // An idle run: a run that starts the task after the sync's pull sees the winner's claim and
    // exits by itself, as it did on Linux, before swarmupd reports the lost claim (AO-0240).
    const { repo, sup, as } = setup({ mode: 'idle', opsd: { sync: true } });
    const g = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' });
    for (const [k, v] of [
      ['user.name', 'Test'],
      ['user.email', 'test@example.invalid'],
    ] as const) {
      g(repo, 'config', k, v);
    }
    as('human:dawid').newTask({ title: 'raced', owner: 'fake:engineer' });
    g(repo, 'checkout', '-q', '-b', 'main');
    g(repo, 'add', '-A');
    g(repo, 'commit', '-q', '-m', 'init');
    g(repo, 'remote', 'add', 'origin', remote);
    g(repo, 'push', '-q', '-u', 'origin', 'main');
    const other = temp();
    g(other, 'clone', '-q', remote, '.');
    g(other, 'config', 'user.name', 'Test');
    g(other, 'config', 'user.email', 'test@example.invalid');
    const otherEnv = {
      ...process.env,
      SWARMUP_CONFIG: join(other, 'none.yml'),
    } as NodeJS.ProcessEnv;
    delete otherEnv.SWARMUP_ROOTS;
    const winner = new Workspace({ cwd: other, env: otherEnv, actor: 'fake:engineer', user: {} })
      .claim('T-0001')
      .events.find((e) => e.type === 'claim')!.token;
    syncRoot(new Root(join(other, '.swarmup')), {});

    const run = sup.launch({ agent: 'fake:engineer', task: 'T-0001' });
    // The wait covers the tick's whole pull and push, about 5 s alone and past 15 s under the
    // full suite's load (AO-0169); the test gets more than the suite's 60 s for it.
    const done = ended(sup, run.id, 60_000);
    await sup.tick();
    const r = await done;
    expect(r.reason).toBe('lost-claim');
    const v = as('human:dawid').view('T-0001');
    expect(v.claimToken).toBe(winner);
    expect(v.status).toBe('claimed');

    // Now the winner's claim is visible here: swarmupd must not launch fake:engineer on it, although
    // the agent id matches.
    expect(() => sup.launch({ agent: 'fake:engineer', task: 'T-0001' })).toThrow(
      /claim from another clone|not claimable/,
    );
    expect(sup.liveFor('fake:engineer')).toBeUndefined();
  });

  it('queues the coordinated sync of its claim and stops the run when the claim lost (AO-0169)', async () => {
    const remote = temp();
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: remote, windowsHide: true });
    // Idle, as in the test before: the run must not see the winner's claim first (AO-0240).
    const { repo, sup, as } = setup({ mode: 'idle' });
    const g = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' });
    g(repo, 'config', 'user.name', 'Test');
    g(repo, 'config', 'user.email', 'test@example.invalid');
    const cfg = join(repo, '.swarmup', 'config.yml');
    writeFileSync(
      cfg,
      readFileSync(cfg, 'utf8').replace('policy: checkpoint', 'policy: coordinated'),
    );
    as('human:dawid').newTask({ title: 'raced', owner: 'fake:engineer' });
    g(repo, 'checkout', '-q', '-b', 'main');
    g(repo, 'add', '-A');
    g(repo, 'commit', '-q', '-m', 'init');
    g(repo, 'remote', 'add', 'origin', remote);
    g(repo, 'push', '-q', '-u', 'origin', 'main');
    const other = temp();
    g(other, 'clone', '-q', remote, '.');
    g(other, 'config', 'user.name', 'Test');
    g(other, 'config', 'user.email', 'test@example.invalid');
    const otherEnv = {
      ...process.env,
      SWARMUP_CONFIG: join(other, 'none.yml'),
    } as NodeJS.ProcessEnv;
    delete otherEnv.SWARMUP_ROOTS;
    // The other clone's claim syncs at once under coordinated sync: it is pushed first.
    const winner = new Workspace({ cwd: other, env: otherEnv, actor: 'fake:engineer', user: {} })
      .claim('T-0001')
      .events.find((e) => e.type === 'claim')!.token;
    const pushed = g(remote, 'rev-parse', 'main');

    // swarmupd's claim returns before any git runs; the queued sync finds the lost race, with no tick.
    const run = sup.launch({ agent: 'fake:engineer', task: 'T-0001' });
    expect(g(remote, 'rev-parse', 'main')).toBe(pushed);
    const r = await ended(sup, run.id, 60_000);
    expect(r.reason).toBe('lost-claim');
    expect(as('human:dawid').view('T-0001').claimToken).toBe(winner);
  });

  it('launches on a claim this clone already holds without claiming again', async () => {
    const { sup, as } = setup({ mode: 'done' });
    as('human:dawid').newTask({ title: 'held', owner: 'fake:engineer' });
    const token = as('fake:engineer')
      .claim('T-0001')
      .events.find((e) => e.type === 'claim')!.token;
    const r = await ended(sup, sup.launch({ agent: 'fake:engineer', task: 'T-0001' }).id);
    expect(r.exit).toBe(0);
    const claims = as('human:dawid')
      .showEvents('T-0001')
      .events.filter((e) => e.type === 'claim');
    expect(claims.map((e) => e.token)).toEqual([token]);
  });
});

describe('runtimes', () => {
  it('builds Claude and Codex command lines with the role profile', () => {
    const claude = invocation(
      { command: 'claude' },
      'claude:qa',
      undefined,
      'C:/w',
      ['C:/data'],
      ['C:/data/.swarmup/agents', 'D:\\ops\\agents', '/home/user/.swarmup/agents'],
    );
    const tools = claude.args[claude.args.indexOf('--allowedTools') + 1]!;
    expect(tools).toContain('Bash(swarmup *)');
    expect(tools).toContain('Bash(ops *)');
    expect(tools).toContain('Edit');
    expect(claude.args).toContain('stream-json');
    const denied = claude.args[claude.args.indexOf('--disallowedTools') + 1]!;
    expect(denied).toContain('Bash(taskkill*)');
    expect(denied).toContain('Edit(//c/data/.swarmup/agents/**)');
    expect(denied).toContain('Write(//d/ops/agents/**)');
    expect(denied).toContain('Edit(//home/user/.swarmup/agents/**)');
    expect(claude.args.slice(-2)).toEqual(['--add-dir', 'C:/data']);
    const role = invocation(
      { command: 'claude' },
      'claude:writer',
      { id: 'claude:writer', status: 'active', tools: ['Read'], file: 'f', body: '' },
      '.',
      [],
    );
    expect(role.args[role.args.indexOf('--allowedTools') + 1]).toBe(
      'Read,Bash(swarmup *),Bash(ops *)',
    );
    // A role that does not write gets no Edit or Write, even from its role file (AO-0136).
    const reader = invocation(
      { command: 'claude' },
      'claude:reviewer',
      { id: 'claude:reviewer', status: 'active', tools: ['Read', 'Edit'], file: 'f', body: '' },
      '.',
      [],
      [],
      undefined,
      true,
    );
    expect(reader.args[reader.args.indexOf('--allowedTools') + 1]).toBe(
      'Read,Bash(swarmup *),Bash(ops *)',
    );
    const readerDeny = reader.args[reader.args.indexOf('--disallowedTools') + 1]!.split(',');
    expect(readerDeny).toEqual(expect.arrayContaining(['Edit', 'Write', 'NotebookEdit']));
    const qaDefault = invocation(
      { command: 'claude' },
      'claude:qa',
      undefined,
      '.',
      [],
      [],
      undefined,
      true,
    );
    const qaTools = qaDefault.args[qaDefault.args.indexOf('--allowedTools') + 1]!.split(',');
    expect(qaTools).toContain('Read');
    expect(qaTools).not.toContain('Edit');
    expect(qaTools).not.toContain('Write');
    const codex = invocation(
      opsdConfig({}).runtimes.codex!,
      'codex:engineer',
      undefined,
      'C:/w',
      [],
    );
    expect(codex.unsetEnv).toEqual([]);
    expect(
      invocation(
        { command: 'codex', unset_env: ['GH_TOKEN'] },
        'codex:engineer',
        undefined,
        'C:/w',
        [],
      ).unsetEnv,
    ).toEqual(['GH_TOKEN']);
    expect(codex.args).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      '-C',
      'C:/w',
      '-',
    ]);
    // A writing Codex run in a task worktree gets the shared git metadata folders, so it can
    // commit there (AO-0155). The checkout that holds them is swapped for its task store: Codex
    // keeps that checkout's `.git` read-only, and its Windows sandbox refuses every command when a
    // writable folder lies under it (AO-0173: 171 empty runs).
    const gitDirs = ['C:/w/.git/worktrees/wt-AO-1', 'C:/w/.git/objects'];
    const codexGit = invocation(
      { command: 'codex' },
      'codex:engineer',
      undefined,
      'C:/w/out/wt-AO-1',
      ['C:/w', 'D:/other'],
      [],
      undefined,
      false,
      false,
      ['C:/w/.swarmup', 'D:/other/.swarmup'],
      gitDirs,
    );
    expect(codexGit.args.slice(codexGit.args.indexOf('-C'))).toEqual([
      '-C',
      'C:/w/out/wt-AO-1',
      '--add-dir',
      'C:/w/.swarmup',
      '--add-dir',
      'D:/other',
      '--add-dir',
      'C:/w/.git/worktrees/wt-AO-1',
      '--add-dir',
      'C:/w/.git/objects',
      '-',
    ]);
    // In its task worktree it runs outside the sandbox instead, so git works as for Claude runs:
    // no `--add-dir` folders, since it may write everywhere.
    const codexFull = invocation(
      { command: 'codex' },
      'codex:engineer',
      undefined,
      'C:/w/out/wt-AO-1',
      ['C:/w', 'D:/other'],
      [],
      undefined,
      false,
      false,
      ['C:/w/.swarmup', 'D:/other/.swarmup'],
      [],
      undefined,
      true,
    );
    expect(codexFull.args).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'danger-full-access',
      '--skip-git-repo-check',
      '-C',
      'C:/w/out/wt-AO-1',
      '-',
    ]);
    // A run of a role that does not write keeps its sandbox whatever the caller asks.
    const readOnlyFull = invocation(
      { command: 'codex' },
      'codex:qa',
      undefined,
      'C:/w/out/wt-AO-1',
      [],
      [],
      undefined,
      true,
      false,
      ['C:/w/.swarmup'],
      [],
      undefined,
      true,
    );
    expect(readOnlyFull.args[readOnlyFull.args.indexOf('--sandbox') + 1]).toBe('workspace-write');
    // The rule itself: no writable folder holds another one's `.git` folder.
    const writable = [
      'C:/w/out/wt-AO-1',
      ...codexGit.args.filter((_, i, a) => a[i - 1] === '--add-dir'),
    ];
    for (const g of gitDirs) {
      const holders = writable.filter((d) => g !== d && g.startsWith(`${d}/`));
      expect(holders).toEqual([]);
    }
    // A run in the checkout itself cannot get git dirs under its own `.git`; its commands still run.
    expect(codexWritableDirs('C:/w', ['D:/other'], ['C:/w/.swarmup'], gitDirs)).toEqual([
      'D:/other',
    ]);
    // A read-only Codex run and a Claude run never get them.
    const readerGit = invocation(
      { command: 'codex' },
      'codex:qa',
      undefined,
      'C:/w',
      [],
      [],
      undefined,
      true,
      false,
      ['C:/w/.swarmup'],
      gitDirs,
    );
    expect(readerGit.args.join(' ')).not.toContain('.git');
    const claudeGit = invocation(
      { command: 'claude' },
      'claude:engineer',
      undefined,
      'C:/w',
      [],
      [],
      undefined,
      false,
      false,
      [],
      gitDirs,
    );
    expect(claudeGit.args.join(' ')).not.toContain('.git');
    // A Codex run of a role that does not write starts in its task store, with only the task
    // stores writable, so `swarmup` works and the checkout stays read-only (AO-0138).
    const codexReader = invocation(
      { command: 'codex', model: 'gpt-5-codex' },
      'codex:qa',
      undefined,
      'C:/w',
      ['D:/other'],
      [],
      undefined,
      true,
      false,
      ['C:/w/.swarmup', 'D:/other/.swarmup', 'c:\\W\\.swarmup\\mirrors\\p', 'C:/w/.swarmup'],
    );
    expect(codexReader.args).toEqual([
      'exec',
      '-m',
      'gpt-5-codex',
      '--json',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      '-C',
      'C:/w/.swarmup',
      '--add-dir',
      'D:/other/.swarmup',
      '-',
    ]);
    expect(codexReader.args).not.toContain('C:/w');
    expect(codexReader.args).not.toContain('D:/other');
    expect(codexReader.note).toContain('may not change files in C:/w');
    expect(codexReader.note).toContain('git -C C:/w');
    expect(codexReader.note).not.toContain('scratch folder');
    // Its scratch folder is writable too, unless it holds the checkout or a store (AO-0296).
    const scratchReader = (scratch: string) =>
      invocation(
        { command: 'codex' },
        'codex:reviewer',
        undefined,
        'C:/w',
        [],
        [],
        undefined,
        true,
        false,
        ['C:/w/.swarmup', 'D:/other/.swarmup'],
        [],
        scratch,
      );
    const withScratch = scratchReader('C:\\state\\scratch\\r1');
    expect(withScratch.args.slice(-6)).toEqual([
      'C:/w/.swarmup',
      '--add-dir',
      'D:/other/.swarmup',
      '--add-dir',
      'C:\\state\\scratch\\r1',
      '-',
    ]);
    expect(withScratch.note).toContain(
      'your scratch folder, C:/state/scratch/r1 ($SWARMUP_SCRATCH',
    );
    for (const holds of ['C:/', 'c:/W', 'D:/other', 'C:/w/.swarmup/scratch']) {
      const left = scratchReader(holds);
      expect(left.args.slice(-4)).toEqual(['C:/w/.swarmup', '--add-dir', 'D:/other/.swarmup', '-']);
      expect(left.note).not.toContain('scratch folder');
    }
    // A store inside another one is covered by it, whichever comes first.
    const nested = invocation(
      { command: 'codex' },
      'codex:qa',
      undefined,
      'C:/w',
      [],
      [],
      undefined,
      true,
      false,
      ['C:/w/.swarmup/mirrors/p', 'C:/w/.swarmup'],
    );
    expect(nested.args.slice(-3)).toEqual(['-C', 'C:/w/.swarmup', '-']);
    // With no task store, the sandbox is read-only and the run starts in its checkout.
    const storeless = invocation(
      { command: 'codex' },
      'codex:qa',
      undefined,
      'C:/w',
      ['D:/other'],
      [],
      undefined,
      true,
    );
    expect(storeless.args).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '-C',
      'C:/w',
      '-',
    ]);
    expect(storeless.note).toBeUndefined();
    expect(codex.note).toBeUndefined();
    const prompt = runPrompt({ agent: 'codex:qa', task: 'T-0003', roleFile: 'agents/codex-qa.md' });
    expect(prompt).toContain('Work on T-0003:');
    expect(prompt).toContain('never kill by name');
    // AO-0057: messages to a person must say what they refer to and what is needed.
    expect(prompt).toContain('names the task id');
    expect(prompt).toContain('Never "see the comment of <date>"');
    expect(prompt).not.toContain('holds the task store');
  });

  it("keeps runs in a data root's checkout off git checkout and switch (AO-0135)", () => {
    const deny = (storeCheckout: boolean, agent = 'claude:engineer') => {
      const inv = invocation(
        { command: 'claude' },
        agent,
        undefined,
        'C:/w',
        [],
        [],
        undefined,
        false,
        storeCheckout,
      );
      return inv.args[inv.args.indexOf('--disallowedTools') + 1]!.split(',');
    };
    expect(deny(true)).toEqual(
      expect.arrayContaining(['Bash(git checkout*)', 'Bash(git switch*)', 'Bash(taskkill*)']),
    );
    expect(deny(false)).not.toContain('Bash(git checkout*)');
    expect(deny(false)).not.toContain('Bash(git switch*)');

    const work = runPrompt({
      agent: 'codex:engineer',
      task: 'AO-0001',
      storeCheckout: { top: 'C:\\dev\\repo', branch: 'v2' },
    });
    expect(work).toContain(
      '- C:/dev/repo holds the task store: keep `v2` checked out and never run `git checkout` or',
    );
    expect(work).toContain('`git worktree add out/wt-AO-0001 -b <branch> <base>`');
    // Review runs look at branches too: the rule holds for them, without a known branch here.
    const review = runPrompt({
      agent: 'codex:qa',
      task: 'AO-0001',
      review: true,
      storeCheckout: { top: '/srv/repo', branch: null },
    });
    expect(review).toContain('- /srv/repo holds the task store: keep its branch checked out');

    // A custom prompt keeps its text and gets the rule appended; elsewhere it stays as given.
    const co = { top: '/srv/repo', branch: 'v2' };
    expect(withStoreCheckoutRule('help\n', undefined, 'AO-0001')).toBe('help\n');
    expect(withStoreCheckoutRule('help\n', co, 'AO-0001')).toMatch(
      /^help\n\nRule for this folder:\n- \/srv\/repo holds the task store: keep `v2` checked out/,
    );
    expect(withStoreCheckoutRule('', co)).toMatch(/^Rule for this folder:\n/);
    expect(withStoreCheckoutRule('', co)).toContain('out/wt-<task id>');

    // A run swarmupd started in its task's worktree is told so, for a standard or a custom prompt.
    const taskWorktree = {
      path: 'C:\\dev\\repo\\out\\wt-AO-0001',
      branch: 'claude/ao-0001',
      store: { top: 'C:\\dev\\repo', branch: 'v2' },
    };
    const inWorktree = runPrompt({ agent: 'claude:engineer', task: 'AO-0001', taskWorktree });
    expect(inWorktree).toContain(
      '- swarmupd started you in C:/dev/repo/out/wt-AO-0001, the worktree of AO-0001, on branch',
    );
    expect(inWorktree).toContain('in C:/dev/repo: keep `v2` checked out there');
    expect(inWorktree).not.toContain('git worktree add');
    expect(withStoreCheckoutRule('help\n', undefined, 'AO-0001', taskWorktree)).toMatch(
      /^help\n\nRule for this folder:\n- swarmupd started you in C:\/dev\/repo\/out\/wt-AO-0001/,
    );
  });

  it('logs a sync that repeats the last notes and did nothing only once (AO-0135)', () => {
    const log = new SyncLog();
    const held = {
      root: 'r',
      committed: 0,
      pulled: false,
      pushed: false,
      notes: ['not synced: code is checked out, but the store branch is v2'],
    };
    expect(log.line(held)).toBe(
      'sync r: committed 0; not synced: code is checked out, but the store branch is v2',
    );
    expect(log.line(held)).toBeNull();
    expect(log.line({ ...held, root: 'other' })).not.toBeNull();
    // A new note, or a sync that does something, is logged again.
    expect(log.line({ ...held, notes: ['not synced: HEAD is detached'] })).not.toBeNull();
    expect(log.line(held)).not.toBeNull();
    expect(log.line({ ...held, committed: 2 })).toBe(
      'sync r: committed 2; not synced: code is checked out, but the store branch is v2',
    );
    expect(log.line({ ...held, committed: 2 })).not.toBeNull();
    // Syncs without notes keep their line every time.
    const quiet = { root: 'r', committed: 0, pulled: true, pushed: false };
    expect(log.line(quiet)).toBe('sync r: committed 0, pulled');
    expect(log.line({ ...quiet, pulled: false })).toBe('sync r: committed 0');
    expect(log.line({ ...quiet, pulled: false })).toBe('sync r: committed 0');
  });

  it('counts tokens from Claude and Codex logs', () => {
    const m = new UsageMeter();
    const msg = (id: string, i: number, o: number) =>
      JSON.stringify({
        type: 'assistant',
        message: { id, usage: { input_tokens: i, output_tokens: o } },
      });
    const b = msg('b', 20, 10);
    // A line split across two reads counts once, when it is complete.
    m.feed(`${msg('a', 10, 5)}\n${msg('a', 10, 5)}\n${b.slice(0, 20)}`);
    expect(m.tokens).toBe(15);
    m.feed(`${b.slice(20)}\nnot json\n`);
    expect(m.tokens).toBe(45);
    m.feed(
      `${JSON.stringify({ type: 'result', usage: { input_tokens: 50, cache_creation_input_tokens: 7, output_tokens: 3 } })}\n`,
    );
    expect(m.tokens).toBe(60);
    const c = new UsageMeter();
    c.feed(
      `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 } })}\n`,
    );
    expect(c.tokens).toBe(250);
    const t = new UsageMeter();
    t.feed('codex\ndone\ntokens used\n92,388\n');
    expect(t.tokens).toBe(92_388);
  });

  it('decides when schedules are due', () => {
    const now = new Date(2026, 9, 31, 10, 0).getTime();
    expect(scheduleDue({ every: '30m' }, undefined, now)).toBe(true);
    expect(scheduleDue({ every: '30m' }, now - 10 * 60_000, now)).toBe(false);
    expect(scheduleDue({ every: '30m' }, now - 31 * 60_000, now)).toBe(true);
    expect(scheduleDue({ at: '09:00' }, undefined, now)).toBe(true);
    expect(scheduleDue({ at: '09:00' }, now - 30 * 60_000, now)).toBe(false);
    expect(scheduleDue({ at: '09:00' }, now - 24 * 3600_000, now)).toBe(true);
    expect(scheduleDue({ at: '11:00' }, undefined, now)).toBe(false);
    expect(() => opsdConfig({ opsd: { schedules: [{ name: 'x', agent: 'a:b' }] } })).toThrow(
      /exactly one/,
    );
  });
});

describe('api', () => {
  it('serves root-qualified inbox refs that the task routes accept with several roots', async () => {
    const alpha = temp();
    const beta = temp();
    for (const [dir, name] of [
      [alpha, 'alpha'],
      [beta, 'beta'],
    ] as const) {
      execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
      initRoot(dir, { name, human: 'human:dawid' });
    }
    const env = {
      ...process.env,
      SWARMUP_CONFIG: join(alpha, 'none.yml'),
      SWARMUP_STATE_DIR: temp(),
      SWARMUP_ROOTS: beta,
    } as NodeJS.ProcessEnv;
    delete env.SWARMUP_AGENT;
    const sup = new Supervisor({
      env,
      cwd: alpha,
      user: {},
      config: opsdConfig({ opsd: { sync: false } }),
    });
    sups.push(sup);
    const as = (actor: string, root?: string) =>
      new Workspace({ cwd: alpha, env, actor, user: {}, root });
    as('human:dawid').newTask({ title: 'in alpha', owner: 'claude:engineer' });
    as('human:dawid', 'beta').newTask({ title: 'in beta', owner: 'claude:engineer' });
    for (const ref of ['alpha/T-0001', 'beta/T-0001']) {
      as('claude:engineer').start(ref, 'plan');
      as('claude:engineer').ask(ref, `question on ${ref}`, undefined, 'yes');
    }
    as('human:dawid').newTask({ title: 'waits in alpha', blockedBy: ['1'] });
    const api = await startApi(sup, { port: 0, token: 'multi-root-token', version: 't' });
    const base = `http://127.0.0.1:${api.port}`;
    const auth = { authorization: 'Bearer multi-root-token' };
    try {
      const inbox = async () =>
        (await (
          await fetch(`${base}/api/inbox?as=human:dawid`, { headers: auth })
        ).json()) as Array<{ kind: string; task: string; root: string; recommend?: string }>;
      const asks = (await inbox()).filter((i) => i.kind === 'ask');
      expect(asks.map((i) => [i.task, i.root]).sort()).toEqual([
        ['alpha/T-0001', 'alpha'],
        ['beta/T-0001', 'beta'],
      ]);
      // The desktop reads the recommendation and the blocked tasks from here (AO-0067).
      expect(asks.find((i) => i.root === 'alpha')).toMatchObject({
        recommend: 'yes',
        blocks: { direct: ['alpha/T-0002'], indirect: [] },
      });
      expect(asks.find((i) => i.root === 'beta')).not.toHaveProperty('blocks');
      const betaAsk = asks.find((i) => i.root === 'beta')!;
      const answered = await fetch(`${base}/api/tasks/${encodeURIComponent(betaAsk.task)}/answer`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ as: 'human:dawid', message: 'yes' }),
      });
      expect(answered.status).toBe(200);
      const left = (await inbox()).filter((i) => i.kind === 'ask').map((i) => i.task);
      expect(left).toEqual(['alpha/T-0001']);
    } finally {
      await api.close();
    }
  });

  it('serves waits, usage, and agents the swarmupd config names', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      opsd: { max_runs: 0, agents: { 'fake:engineer': { wake: true } } },
    });
    as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
    const api = await startApi(sup, { port: 0, token: 'secret-test-token', version: 't' });
    const get = async (path: string): Promise<unknown> =>
      (
        await fetch(`http://127.0.0.1:${api.port}${path}`, {
          headers: { authorization: 'Bearer secret-test-token' },
        })
      ).json();
    try {
      const waits = (await get('/api/waits')) as {
        providers: Record<string, { live: number }>;
        waits: Array<{ task: string; reason: string }>;
      };
      expect(waits.providers.fake).toMatchObject({ live: 0 });
      expect(waits.waits).toEqual([
        expect.objectContaining({
          task: 'test/T-0001',
          reason: 'fake:engineer: 0 runs live; max_runs is 0',
        }),
      ]);
      expect(await get('/api/usage')).toHaveProperty('fake');
      const agents = (await get('/api/agents')) as Array<{ id: string; wake: boolean }>;
      expect(agents).toContainEqual(expect.objectContaining({ id: 'fake:engineer', wake: true }));
    } finally {
      await api.close();
    }
  });

  it('keeps idle API sockets open, so a late request never meets a closing socket', async () => {
    // The shutdown tests send a second POST on the first one's socket after a run ends. Under
    // full-suite load that wait passed Node's 5 s keep-alive timeout, and the server closed the
    // socket as fetch wrote to it ('other side closed'; AO-0192, AO-0223).
    const { sup } = setup();
    const api = await startApi(sup, { port: 0, token: 'secret-test-token', version: 't' });
    try {
      expect(api.server.keepAliveTimeout).toBe(0);
      const res = await fetch(`http://127.0.0.1:${api.port}/api/health`, {
        headers: { authorization: 'Bearer secret-test-token' },
      });
      await res.json();
      // No `Keep-Alive: timeout=5` hint: the server sets no deadline for the client to race.
      expect(res.headers.get('keep-alive')).toBeNull();
    } finally {
      await api.close();
    }
  });

  it('shuts down on ifIdle only with no run live, and refuses launches once it agreed', async () => {
    const { sup, as } = setup({ mode: 'hang' });
    as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
    let shutdowns = 0;
    const api = await startApi(sup, {
      port: 0,
      token: 'secret-test-token',
      version: 't',
      onShutdown: () => shutdowns++,
    });
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${api.port}/api/shutdown`, {
        method: 'POST',
        headers: { authorization: 'Bearer secret-test-token', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      const run = sup.launch({ agent: 'fake:engineer', task: '1' });
      expect((await post({ ifIdle: true })).status).toBe(409);
      // Callers such as the desktop's update install tell the refusal apart by its status.
      const info = {
        pid: 0,
        port: api.port,
        token: 'secret-test-token',
        started_at: '',
        version: 't',
      };
      await expect(
        daemonCall(info, 'POST', '/api/shutdown', { killRuns: false, ifIdle: true }),
      ).rejects.toMatchObject({ name: 'DaemonCallError', status: 409 });
      expect(sup.run(run.id).status).toBe('running');
      sup.kill(run.id);
      await ended(sup, run.id);
      expect((await post({ ifIdle: true })).status).toBe(200);
      expect(() => sup.launch({ agent: 'fake:qa' })).toThrow(/swarmupd is stopping/);
      await until(() => shutdowns === 1);
    } finally {
      await api.close();
    }
  });

  it('refuses a stop that keeps runs where runs end with swarmupd, and ends them on stop', async () => {
    const { sup, as } = setup({ mode: 'hang', runsOutlive: false });
    as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
    let shutdowns = 0;
    const api = await startApi(sup, {
      port: 0,
      token: 'secret-test-token',
      version: 't',
      onShutdown: () => shutdowns++,
    });
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${api.port}/api/shutdown`, {
        method: 'POST',
        headers: { authorization: 'Bearer secret-test-token', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      const health = await fetch(`http://127.0.0.1:${api.port}/api/health`, {
        headers: { authorization: 'Bearer secret-test-token' },
      });
      expect(((await health.json()) as { runs_outlive: boolean }).runs_outlive).toBe(false);
      const run = sup.launch({ agent: 'fake:engineer', task: '1' });
      const res = await post({ killRuns: false });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/1 live run would end/);
      expect(sup.run(run.id).status).toBe('running');
      expect(shutdowns).toBe(0);
      // A signal stop keeps no runs here: they end with their claims released.
      sup.stop();
      const r = await ended(sup, run.id);
      expect(r.reason).toBe('shutdown');
      await until(() => as('human:dawid').view('1').claimedBy === null);
      expect((await post({ killRuns: false })).status).toBe(200);
      await until(() => shutdowns === 1);
    } finally {
      await api.close();
    }
  });

  it('needs the token and a localhost host, launches runs and pushes events', async () => {
    const { sup, as } = setup();
    as('human:dawid').newTask({ title: 'via api', owner: 'fake:engineer' });
    const api = await startApi(sup, { port: 0, token: 'secret-test-token', version: 't' });
    const base = `http://127.0.0.1:${api.port}`;
    const auth = { authorization: 'Bearer secret-test-token' };
    try {
      expect((await fetch(`${base}/api/health`)).status).toBe(401);
      const health = (await (await fetch(`${base}/api/health`, { headers: auth })).json()) as {
        ok: boolean;
      };
      expect(health.ok).toBe(true);
      const tasks = (await (await fetch(`${base}/api/tasks`, { headers: auth })).json()) as Array<{
        id: string;
      }>;
      expect(tasks.map((t) => t.id)).toEqual(['T-0001']);

      const events: string[] = [];
      const stream = await fetch(`${base}/api/events?token=secret-test-token`);
      const reader = stream.body!.getReader();
      const pump = (async () => {
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          events.push(...[...dec.decode(value).matchAll(/^event: (\w+)/gm)].map((m) => m[1]!));
        }
      })();

      const created = await fetch(`${base}/api/runs`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'fake:engineer', task: 'T-0001' }),
      });
      expect(created.status).toBe(201);
      const run = (await created.json()) as RunRecord;
      await ended(sup, run.id);
      const log = await (
        await fetch(`${base}/api/runs/${run.id.slice(-6)}/log`, { headers: auth })
      ).text();
      expect(log).toContain('usage');

      const bad = await fetch(`${base}/api/tasks/T-0001/comment`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'no actor' }),
      });
      expect(bad.status).toBe(400);
      const ok = await fetch(`${base}/api/tasks/T-0001/comment`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ as: 'human:dawid', message: 'thanks' }),
      });
      expect(ok.status).toBe(200);
      const missing = await fetch(`${base}/api/runs/NOPE`, { headers: auth });
      expect(missing.status).toBe(404);
      await until(() => events.includes('run'));
      expect(events[0]).toBe('hello');
      await reader.cancel();
      await pump.catch(() => {});
    } finally {
      await api.close();
    }
  });

  it('rejects other hosts', async () => {
    const { sup } = setup();
    const api = await startApi(sup, { port: 0, token: 't0k', version: 't' });
    try {
      const res = await new Promise<number>((resolve, reject) => {
        // fetch does not let a page set Host; a raw request shows what a rebinding attack sends.
        import('node:http').then(({ request }) => {
          const req = request(
            {
              host: '127.0.0.1',
              port: api.port,
              path: '/api/health',
              headers: { host: 'evil.example:80', authorization: 'Bearer t0k' },
            },
            (r) => resolve(r.statusCode ?? 0),
          );
          req.on('error', reject);
          req.end();
        }, reject);
      });
      expect(res).toBe(403);
    } finally {
      await api.close();
    }
  });
});

describe('state', () => {
  it('keeps run records and logs in the state folder', () => {
    const { sup, state } = setup();
    expect(existsSync(join(state, 'runs'))).toBe(true);
    expect(sup.store.logPath('X')).toBe(join(state, 'logs', 'X.log'));
  });
});

describe('daemon', () => {
  it('starts in the background, runs an agent through the API and stops', async () => {
    execFileSync(process.execPath, [tsc, '-b', 'packages/supervisor'], {
      cwd: repoTop,
      windowsHide: true,
    });
    const { repo, as, state } = setup();
    const agentFile = join(temp(), 'fake-agent.mjs');
    writeFileSync(agentFile, FAKE_AGENT);
    const userConfig = join(temp(), 'config.yml');
    writeFileSync(
      userConfig,
      [
        'opsd:',
        '  port: 0',
        '  sync: false',
        // The real swarmupd checks os.freemem(); a busy host must not refuse the run.
        '  min_free_gb: 0',
        '  runtimes:',
        '    fake:',
        `      command: ${JSON.stringify(process.execPath)}`,
        `      args: [${JSON.stringify(agentFile)}]`,
        '',
      ].join('\n'),
    );
    const env = {
      ...process.env,
      SWARMUP_CONFIG: userConfig,
      SWARMUP_STATE_DIR: state,
      FAKE_MODE: 'done',
    } as NodeJS.ProcessEnv;
    delete env.SWARMUP_AGENT;
    delete env.SWARMUP_ROOTS;
    as('human:dawid').newTask({ title: 'daemon work', owner: 'fake:engineer' });
    const info = await startDaemon({ env, cwd: repo });
    try {
      expect(readDaemon(env)?.pid).toBe(info.pid);
      expect((await startDaemon({ env, cwd: repo })).pid).toBe(info.pid);
      const run = await daemonCall<RunRecord>(info, 'POST', '/api/runs', {
        agent: 'fake:engineer',
        task: 'T-0001',
      });
      let r = run;
      for (let i = 0; i < 100 && r.status === 'running'; i++) {
        await new Promise((res) => setTimeout(res, 100));
        r = await daemonCall<RunRecord>(info, 'GET', `/api/runs/${run.id}`);
      }
      expect(r).toMatchObject({ status: 'ended', exit: 0 });
      expect(as('human:dawid').view('1').status).toBe('done');
      await expect(daemonCall(info, 'POST', '/api/runs', { agent: 'bad' })).rejects.toThrow(
        /bad agent id/,
      );
    } finally {
      expect(await stopDaemon({ env })).toBe(true);
    }
    expect(readDaemon(env)).toBeNull();
    expect(readFileSync(join(state, 'opsd.log'), 'utf8')).toContain('swarmupd stopped');
  });

  it('stops and restarts with a live run: the next swarmupd adopts it', async () => {
    execFileSync(process.execPath, [tsc, '-b', 'packages/supervisor'], {
      cwd: repoTop,
      windowsHide: true,
    });
    const { repo, as, state } = setup();
    const agentFile = join(temp(), 'fake-agent.mjs');
    writeFileSync(agentFile, FAKE_AGENT);
    const userConfig = join(temp(), 'config.yml');
    writeFileSync(
      userConfig,
      [
        'opsd:',
        '  port: 0',
        '  sync: false',
        // The real swarmupd checks os.freemem(); a busy host must not refuse the run.
        '  min_free_gb: 0',
        '  runtimes:',
        '    fake:',
        `      command: ${JSON.stringify(process.execPath)}`,
        `      args: [${JSON.stringify(agentFile)}]`,
        '',
      ].join('\n'),
    );
    const env = {
      ...process.env,
      SWARMUP_CONFIG: userConfig,
      SWARMUP_STATE_DIR: state,
      FAKE_MODE: 'hang',
    } as NodeJS.ProcessEnv;
    delete env.SWARMUP_AGENT;
    delete env.SWARMUP_ROOTS;
    as('human:dawid').newTask({ title: 'long work', owner: 'fake:engineer' });
    const first = await startDaemon({ env, cwd: repo });
    let runPid: number | undefined;
    let runSeen = 0;
    try {
      const launched = await daemonCall<RunRecord>(first, 'POST', '/api/runs', {
        agent: 'fake:engineer',
        task: 'T-0001',
      });
      await until(() => as('human:dawid').view('1').status === 'in-progress');
      let run = launched;
      if (launched.shim_pid !== undefined) {
        // Windows: the run starts as a hidden cmd.exe; the record moves on to the launcher behind
        // it, which runs the agent.
        expect(launched.pid).toBe(launched.shim_pid);
        const end = Date.now() + 20_000;
        while (run.pid === launched.shim_pid && Date.now() < end) {
          await new Promise((r) => setTimeout(r, 200));
          run = await daemonCall<RunRecord>(first, 'GET', `/api/runs/${launched.id}`);
        }
        expect(run.pid).not.toBe(launched.shim_pid);
        expect(run.image).toBe('node.exe');
      }
      runPid = run.pid;
      runSeen = Date.now();

      // Before the fix, the run's handles kept the old swarmupd alive and this timed out.
      expect(await stopDaemon({ env })).toBe(true);
      expect(isAlive(first.pid)).toBe(false);
      expect(isAlive(run.pid)).toBe(true);
      // Windows: the job object ended the hidden cmd.exe with swarmupd; the agent outlived both.
      if (launched.shim_pid !== undefined) {
        await until(() => !isAlive(launched.shim_pid!));
        expect(isAlive(run.pid)).toBe(true);
      }

      const second = await startDaemon({ env, cwd: repo });
      expect(second.pid).not.toBe(first.pid);
      const adopted = await daemonCall<RunRecord>(second, 'GET', `/api/runs/${run.id}`);
      expect(adopted).toMatchObject({ status: 'running', pid: run.pid });

      // A restart goes through the same stop: the run survives a second handover.
      expect(await stopDaemon({ env })).toBe(true);
      expect(isAlive(second.pid)).toBe(false);
      expect(isAlive(run.pid)).toBe(true);
      const third = await startDaemon({ env, cwd: repo });
      const again = await daemonCall<RunRecord>(third, 'GET', `/api/runs/${run.id}`);
      expect(again).toMatchObject({ status: 'running', pid: run.pid });

      await daemonCall(third, 'POST', `/api/runs/${run.id}/kill`, {});
      await until(() => !isAlive(run.pid));
      await until(() => as('human:dawid').view('1').claimedBy === null);
      const done = await daemonCall<RunRecord>(third, 'GET', `/api/runs/${run.id}`);
      expect(done).toMatchObject({ status: 'ended', reason: 'killed' });
    } finally {
      if (readDaemon(env)) await stopDaemon({ env, killRuns: true });
      // Only this test's own fake agent, by the PID its swarmupd printed, while it still runs it.
      if (runPid !== undefined && isAlive(runPid)) await killOwn(runPid, runSeen);
    }
  });

  it('says what the child logged when swarmupd does not start (AO-0235)', async () => {
    const state = temp();
    const entry = join(temp(), 'broken.mjs');
    writeFileSync(entry, "console.error('broken entry says no'); process.exit(1);\n");
    writeFileSync(join(state, 'opsd.log'), 'a line from an earlier start\n');
    const env = {
      ...process.env,
      SWARMUP_STATE_DIR: state,
      SWARMUP_DAEMON_ENTRY: entry,
    } as NodeJS.ProcessEnv;
    const err = await startDaemon({ env, cwd: state }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('swarmupd did not start');
    // The entry it started and that start's own output, without older lines of the log.
    expect(message).toContain(entry);
    expect(message).toContain('broken entry says no');
    expect(message).not.toContain('earlier start');
  });

  it('keeps secret-looking child output out of the start error (AO-0235)', async () => {
    const state = temp();
    const entry = join(temp(), 'leaky.mjs');
    // Built here and passed through the environment, so no file holds a secret-looking string.
    const token = `ghp_${'a1B2'.repeat(9)}`;
    const hook = `https://hooks.${'slack'}.com/services/${'T0AB12CD3/'.repeat(3)}`;
    writeFileSync(
      entry,
      [
        "console.error('config read from the state folder');",
        "console.error('GH_TOKEN=' + process.env.LEAKY_TOKEN);",
        "console.error('posting to ' + process.env.LEAKY_HOOK);",
        "console.error('port 7777 is taken');",
        'process.exit(1);',
        '',
      ].join('\n'),
    );
    const env = {
      ...process.env,
      SWARMUP_STATE_DIR: state,
      SWARMUP_DAEMON_ENTRY: entry,
      LEAKY_TOKEN: token,
      LEAKY_HOOK: hook,
    } as NodeJS.ProcessEnv;
    const err = await startDaemon({ env, cwd: state }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('swarmupd did not start');
    expect(message).not.toContain(token);
    expect(message).not.toContain(hook);
    expect(secretKind(message)).toBeNull();
    expect(message).toContain('[line removed: it looks like a GitHub token]');
    expect(message).toContain('[line removed: it looks like a Slack webhook URL]');
    // The lines that help stay.
    expect(message).toContain('config read from the state folder');
    expect(message).toContain('port 7777 is taken');
  });

  it('fails a stop when the old swarmupd is still alive, so a restart cannot start a second one', async () => {
    const state = temp();
    const env = { ...process.env, SWARMUP_STATE_DIR: state } as NodeJS.ProcessEnv;
    // A swarmupd that answers the shutdown but whose process stays: a server here, a live PID there.
    const stuck = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true,
    });
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as AddressInfo).port;
      writeFileSync(
        join(state, 'opsd.json'),
        JSON.stringify({ pid: stuck.pid, port, token: 't', started_at: '', version: 't' }),
      );
      await expect(stopDaemon({ env, waitMs: 500 })).rejects.toThrow(/did not stop in time/);
    } finally {
      server.close();
      stuck.kill();
    }
  });
});

describe('review fixes', () => {
  it('rolls back its own claim when the launch fails after claiming', () => {
    const { sup, as } = setup();
    as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
    expect(() => sup.launch({ agent: 'fake:engineer', task: '1', budget: 'forever' })).toThrow(
      /bad duration/,
    );
    expect(as('human:dawid').showEvents('1').events).toEqual([]);
    expect(() =>
      sup.launch({ agent: 'fake:engineer', task: '1', cwd: join(temp(), 'missing', 'dir') }),
    ).toThrow();
    const types = as('human:dawid')
      .showEvents('1')
      .events.map((e) => e.type);
    expect(types).toEqual(['claim', 'release']);
    expect(as('human:dawid').view('1').status).toBe('todo');
    expect(sup.runs({ live: true })).toEqual([]);
  });

  it('counts tokens past 4 MiB of output and in a last line without a newline', async () => {
    const big = setup({ mode: 'big' });
    const r1 = await ended(big.sup, big.sup.launch({ agent: 'fake:engineer' }).id);
    expect(r1.tokens).toBe(150 + 1001);
    const tail = setup({ mode: 'tail' });
    const r2 = await ended(tail.sup, tail.sup.launch({ agent: 'fake:engineer' }).id);
    expect(r2.tokens).toBe(1001);
  });

  it('adopts a run only when the PID is still the same process', async () => {
    const { sup, state } = setup();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true,
    });
    await until(() => processStartSync(child.pid!) !== null);
    const start = processStartSync(child.pid!)!;
    const base = {
      agent: 'fake:engineer',
      command: 'x',
      cwd: state,
      log: join(state, 'none.log'),
      started_at: new Date().toISOString(),
      status: 'running' as const,
      budget_minutes: 60,
      tokens: 0,
      pid: child.pid!,
      image: 'node.exe',
    };
    sup.store.save({ ...base, id: '01BBBBBBBBBBBBBBBBBBBBBBB1', proc_start: start });
    // Same PID and image, another start time: a reused PID, never adopted or killed.
    sup.store.save({
      ...base,
      id: '01BBBBBBBBBBBBBBBBBBBBBBB2',
      agent: 'fake:qa',
      proc_start: 'not-this-process',
    });
    sup.adopt();
    expect(sup.runs({ live: true }).map((r) => r.id)).toEqual(['01BBBBBBBBBBBBBBBBBBBBBBB1']);
    expect(sup.run('01BBBBBBBBBBBBBBBBBBBBBBB2').reason).toBe('lost');
    const exited = new Promise((r) => child.once('exit', r));
    sup.kill('01BBBBBBBBBBBBBBBBBBBBBBB1');
    await exited;
    await until(() => sup.run('01BBBBBBBBBBBBBBBBBBBBBBB1').status === 'ended');
    expect(sup.run('01BBBBBBBBBBBBBBBBBBBBBBB1')).toMatchObject({
      status: 'ended',
      reason: 'killed',
    });
  });

  it('never kills an adopted PID that runs another process at the moment of the kill', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true,
    });
    try {
      await until(() => processStartSync(child.pid!) !== null);
      const start = processStartSync(child.pid!)!;
      // Adopted while the PID was the run's; by the kill, the PID runs another process (another
      // creation time in the snapshot).
      const killed: ProcTarget[] = [];
      const lister: ProcLister = {
        precise: true,
        clockSlack: 0,
        list: () =>
          Promise.resolve([{ pid: child.pid!, ppid: 1, name: 'node', cmd: 'node', start: 12_345 }]),
        kill: (targets) => {
          killed.push(...targets);
          return Promise.resolve(new Map(targets.map((t) => [t.pid, 'killed' as const])));
        },
        close: () => {},
      };
      const { sup, state } = setup({ procs: lister });
      sup.store.save({
        id: '01BBBBBBBBBBBBBBBBBBBBBBB3',
        agent: 'fake:engineer',
        command: 'x',
        cwd: state,
        log: join(state, 'none.log'),
        started_at: new Date().toISOString(),
        status: 'running',
        budget_minutes: 60,
        tokens: 0,
        pid: child.pid!,
        image: 'node.exe',
        proc_start: start,
      });
      sup.adopt();
      expect(sup.runs({ live: true })).toHaveLength(1);
      sup.kill('01BBBBBBBBBBBBBBBBBBBBBBB3');
      await until(() => sup.run('01BBBBBBBBBBBBBBBBBBBBBBB3').status === 'ended');
      expect(killed).toEqual([]);
      expect(alive(child.pid!)).toBe(true);
    } finally {
      child.kill();
    }
  });

  it('retries schedules and wakes whose launch failed, and wakes on inbox items', async () => {
    const { sup, as } = setup({
      opsd: {
        runtimes: {
          gone: { command: 'definitely-not-a-command-xyz' },
        },
        agents: { 'gone:engineer': { wake: true }, 'fake:qa': { wake: true } },
        schedules: [{ name: 'digest', every: '24h', agent: 'gone:writer' }],
      },
    });
    const warns: string[] = [];
    sup.on('warn', (m: string) => warns.push(m));
    as('human:dawid').newTask({ title: 'for gone', owner: 'gone:engineer' });
    await sup.tick();
    expect(sup.runs()).toEqual([]);
    expect(warns.some((w) => /not on PATH/.test(w))).toBe(true);
    expect(sup.store.readJson('schedules.json', {})).toEqual({});
    expect(sup.store.readJson('wake.json', {})).toEqual({});
    expect(as('human:dawid').view('1').claimedBy).toBeNull();

    // An addressed comment wakes fake:qa with the inbox prompt, once.
    as('human:dawid').newTask({ title: 'question for qa', owner: 'human:dawid' });
    as('human:dawid').comment('2', 'please look', 'fake:qa');
    await sup.tick();
    const woke = sup.runs({ live: true });
    expect(woke.map((r) => [r.agent, r.task])).toEqual([['fake:qa', undefined]]);
    await ended(sup, woke[0]!.id);
    await sup.tick();
    expect(sup.runs().filter((r) => r.agent === 'fake:qa')).toHaveLength(1);
  });

  it('rejects duplicate schedule names and impossible times', () => {
    const sched = (s: object[]) => () => opsdConfig({ opsd: { schedules: s as never } });
    expect(
      sched([
        { name: 'a', agent: 'x:y', every: '1h' },
        { name: 'a', agent: 'x:y', every: '2h' },
      ]),
    ).toThrow(/twice/);
    expect(sched([{ name: 'a', agent: 'x:y', at: '99:99' }])).toThrow(/00:00 to 23:59/);
    expect(sched([{ name: 'a', agent: 'x:y', at: '24:00' }])).toThrow(/00:00 to 23:59/);
    expect(sched([{ name: 'a', agent: 'x:y', at: '23:59' }])()).toBeTruthy();
  });

  it('takes the token from the URL only for the event stream', async () => {
    const { sup } = setup();
    const api = await startApi(sup, { port: 0, token: 'tok3n', version: 't' });
    try {
      const base = `http://127.0.0.1:${api.port}`;
      expect((await fetch(`${base}/api/health?token=tok3n`)).status).toBe(401);
      expect((await fetch(`${base}/api/runs?token=tok3n`)).status).toBe(401);
      const stream = await fetch(`${base}/api/events?token=tok3n`);
      expect(stream.status).toBe(200);
      await stream.body?.cancel();
    } finally {
      await api.close();
    }
  });

  it('runs one swarmupd per state folder even when two start at once', async () => {
    const { repo, state } = setup();
    const userConfig = join(temp(), 'config.yml');
    writeFileSync(userConfig, 'opsd:\n  port: 0\n  sync: false\n');
    const env = {
      ...process.env,
      SWARMUP_CONFIG: userConfig,
      SWARMUP_STATE_DIR: state,
    } as NodeJS.ProcessEnv;
    delete env.SWARMUP_AGENT;
    const [a, b] = await Promise.all([
      startDaemon({ env, cwd: repo }),
      startDaemon({ env, cwd: repo }),
    ]);
    try {
      expect(a.pid).toBe(b.pid);
      expect(readDaemon(env)?.pid).toBe(a.pid);
      // Exactly one supervisor bound a port; the other start gave up on the lock.
      const started = readFileSync(join(state, 'opsd.log'), 'utf8').match(/ on 127\.0\.0\.1:/g);
      expect(started).toHaveLength(1);
    } finally {
      expect(await stopDaemon({ env })).toBe(true);
    }
    expect(existsSync(join(state, 'opsd.lock'))).toBe(false);
  });
});

describe('fail-closed identity', () => {
  it('never adopts a live run whose creation time is missing', async () => {
    const { sup, state } = setup();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true,
    });
    try {
      sup.store.save({
        id: '01CCCCCCCCCCCCCCCCCCCCCCC1',
        agent: 'fake:engineer',
        command: 'x',
        cwd: state,
        log: join(state, 'none.log'),
        started_at: new Date().toISOString(),
        status: 'running',
        budget_minutes: 60,
        tokens: 0,
        pid: child.pid!,
        image: 'node.exe',
      });
      sup.adopt();
      expect(sup.runs({ live: true })).toEqual([]);
      expect(sup.run('01CCCCCCCCCCCCCCCCCCCCCCC1').reason).toBe('lost');
    } finally {
      child.kill();
    }
  });

  it('records the creation time before the run command starts, so it can be adopted', async () => {
    const mark = join(temp(), 'started');
    const { sup } = setup({ mode: 'hang', env: { FAKE_MARK: mark } });
    const run = sup.launch({ agent: 'fake:engineer' });
    if (process.platform !== 'win32') {
      expect(sup.store.get(run.id)?.proc_start).toBeTruthy();
    } else {
      // The launcher holds the command until opsd has read its creation time, without blocking
      // the event loop (AO-0171): once the agent runs, the record names the launcher.
      expect(run.pid).toBe(run.shim_pid);
      await until(() => existsSync(mark), 20_000);
      const r = sup.store.get(run.id)!;
      expect(r.pid).not.toBe(run.shim_pid);
      expect(r.proc_start).toBe(processStartSync(r.pid));
    }
    sup.kill(run.id);
    await ended(sup, run.id);
  });

  const listers: Record<string, () => ProcLister> = {
    slow: () => {
      const real = systemLister();
      return {
        precise: real.precise,
        clockSlack: real.clockSlack,
        list: async () => {
          await new Promise((r) => setTimeout(r, 3000));
          return real.list();
        },
        kill: (t) => real.kill(t),
        ownPids: () => real.ownPids?.() ?? [],
        close: () => real.close(),
      };
    },
    failing: () => ({
      precise: true,
      clockSlack: 0,
      list: () => Promise.reject(new Error('lister down')),
      kill: () => Promise.reject(new Error('lister down')),
      close: () => {},
    }),
  };

  for (const [kind, lister] of Object.entries(listers)) {
    it.runIf(process.platform === 'win32')(
      `hands a run stopped right after launch to the next swarmupd by its launcher (${kind} lister)`,
      async () => {
        const mark = join(temp(), 'started');
        const { sup, as, opsd } = setup({
          mode: 'hang',
          procs: lister(),
          env: { FAKE_MARK: mark },
        });
        as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
        const run = sup.launch({ agent: 'fake:engineer', task: '1' });
        expect(run.pid).toBe(run.shim_pid);
        sup.stop();
        await sup.close();
        // The record names the launcher, read while it waited, before the command started.
        const handed = sup.store.get(run.id)!;
        expect(handed.status).toBe('running');
        expect(handed.pid).not.toBe(run.shim_pid);
        expect(handed.image).toBe('node.exe');
        expect(processStartSync(handed.pid)).toBe(handed.proc_start);
        // The agent is the launcher's child: the exact process the record names.
        await until(() => existsSync(mark));
        expect(Number(readFileSync(mark, 'utf8'))).toBe(handed.pid);

        const next = opsd(systemLister());
        next.adopt();
        expect(next.run(run.id)).toMatchObject({ status: 'running', pid: handed.pid });
        next.kill(run.id);
        const done = await ended(next, run.id);
        expect(done.reason).toBe('killed');
        await until(() => !isAlive(handed.pid));
        expect(as('human:dawid').view('1').claimedBy).toBeNull();
      },
      60_000,
    );
  }

  /** A lister that sees no process, as in a sandbox, but kills through the system lister. */
  const blind = (): ProcLister => {
    const real = systemLister();
    return {
      precise: true,
      clockSlack: 0,
      list: () => Promise.resolve([]),
      kill: (t) => real.kill(t),
      close: () => real.close(),
    };
  };

  for (const how of ['kill', 'stop'] as const) {
    it.runIf(process.platform === 'win32')(
      `stops the launcher and the command when the lister sees no process (${how})`,
      async () => {
        const mark = join(temp(), 'started');
        const agentPid = join(temp(), 'pid');
        const { sup, as } = setup({
          mode: 'hang',
          procs: blind(),
          env: { FAKE_MARK: mark, FAKE_PID: agentPid },
        });
        as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
        const run = sup.launch({ agent: 'fake:engineer', task: '1' });
        await until(() => existsSync(mark) && existsSync(agentPid));
        const launcher = sup.store.get(run.id)!.pid;
        expect(launcher).not.toBe(run.shim_pid);
        expect(Number(readFileSync(mark, 'utf8'))).toBe(launcher);
        const agent = Number(readFileSync(agentPid, 'utf8'));
        const seen = Date.now();
        try {
          if (how === 'kill') {
            sup.kill(run.id);
            expect((await ended(sup, run.id)).reason).toBe('killed');
          } else {
            sup.stop({ killRuns: true });
            await sup.close();
            expect(sup.store.get(run.id)).toMatchObject({ status: 'ended' });
          }
          await until(() => !isAlive(launcher) && !isAlive(agent));
        } finally {
          // Only the PIDs this test's run printed, while they still run its processes.
          for (const pid of [launcher, agent]) if (isAlive(pid)) await killOwn(pid, seen);
        }
      },
      60_000,
    );
  }

  it('kills an adopted run by its recorded identity when the lister sees no process', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true,
    });
    try {
      await until(() => processStartSync(child.pid!) !== null);
      const start = processStartSync(child.pid!)!;
      const killed: ProcTarget[] = [];
      const lister: ProcLister = {
        precise: true,
        clockSlack: 0,
        list: () => Promise.resolve([]),
        kill: (targets) => {
          killed.push(...targets);
          for (const t of targets) process.kill(t.pid);
          return Promise.resolve(new Map(targets.map((t) => [t.pid, 'killed' as const])));
        },
        close: () => {},
      };
      const { sup, state } = setup({ procs: lister });
      sup.store.save({
        id: '01BBBBBBBBBBBBBBBBBBBBBBB4',
        agent: 'fake:engineer',
        command: 'x',
        cwd: state,
        log: join(state, 'none.log'),
        started_at: new Date().toISOString(),
        status: 'running',
        budget_minutes: 60,
        tokens: 0,
        pid: child.pid!,
        image: 'node.exe',
        proc_start: start,
      });
      sup.adopt();
      sup.kill('01BBBBBBBBBBBBBBBBBBBBBBB4');
      await until(() => sup.run('01BBBBBBBBBBBBBBBBBBBBBBB4').status === 'ended');
      expect(killed).toEqual([{ pid: child.pid!, start: startMs(start)! }]);
      await until(() => !alive(child.pid!));
    } finally {
      if (alive(child.pid!)) child.kill();
    }
  });

  it('warns to stop a run it cannot kill when the lister fails', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true,
    });
    try {
      await until(() => processStartSync(child.pid!) !== null);
      const { sup, state } = setup({ procs: listers.failing!() });
      const warns: string[] = [];
      sup.on('warn', (m: string) => warns.push(m));
      sup.store.save({
        id: '01BBBBBBBBBBBBBBBBBBBBBBB5',
        agent: 'fake:engineer',
        command: 'x',
        cwd: state,
        log: join(state, 'none.log'),
        started_at: new Date().toISOString(),
        status: 'running',
        budget_minutes: 60,
        tokens: 0,
        pid: child.pid!,
        image: 'node.exe',
        proc_start: processStartSync(child.pid!)!,
      });
      sup.adopt();
      sup.kill('01BBBBBBBBBBBBBBBBBBBBBBB5');
      await until(() => sup.run('01BBBBBBBBBBBBBBBBBBBBBBB5').status === 'ended');
      expect(
        warns.some((w) => w.includes(`PID ${child.pid}`) && w.includes('stop it yourself')),
      ).toBe(true);
    } finally {
      child.kill();
    }
  });

  it.runIf(process.platform === 'win32')(
    'ends a run still launching at shutdown, before its command starts',
    async () => {
      const mark = join(temp(), 'started');
      const { sup, as } = setup({ mode: 'hang', env: { FAKE_MARK: mark } });
      as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
      // A launcher that never gets its command, as when swarmupd cannot record it in time.
      Object.assign(sup, { handOver: () => Promise.resolve() });
      const run = sup.launch({ agent: 'fake:engineer', task: '1' });
      sup.stop();
      await sup.close();
      expect(sup.store.get(run.id)).toMatchObject({ status: 'ended', reason: 'shutdown' });
      expect(as('human:dawid').view('1').claimedBy).toBeNull();
      await new Promise((r) => setTimeout(r, 1500));
      expect(existsSync(mark)).toBe(false);
    },
    30_000,
  );

  it('rolls back a launch it cannot record, and the command never runs on Windows', async () => {
    const mark = join(temp(), 'started');
    const { sup, as } = setup({ mode: 'hang', env: { FAKE_MARK: mark } });
    as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
    const save = sup.store.save.bind(sup.store);
    let fail = true;
    sup.store.save = (r: RunRecord) => {
      if (fail) {
        fail = false;
        throw new Error('disk full');
      }
      save(r);
    };
    expect(() => sup.launch({ agent: 'fake:engineer', task: '1' })).toThrow(/disk full/);
    expect(sup.runs({ live: true })).toEqual([]);
    expect(as('human:dawid').view('1').claimedBy).toBeNull();
    if (process.platform === 'win32') {
      // The fake agent marks its start before it reads stdin, so it ignores a closed one.
      await new Promise((r) => setTimeout(r, 2000));
      expect(existsSync(mark)).toBe(false);
    }
  });

  it.runIf(process.platform === 'win32')(
    'kills a run before its launcher reports in: nothing starts',
    async () => {
      const mark = join(temp(), 'started');
      const { sup, as } = setup({ mode: 'hang', env: { FAKE_MARK: mark } });
      as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
      const run = sup.launch({ agent: 'fake:engineer', task: '1' });
      sup.kill(run.id);
      expect((await ended(sup, run.id)).reason).toBe('killed');
      expect(as('human:dawid').view('1').claimedBy).toBeNull();
      await new Promise((r) => setTimeout(r, 1500));
      expect(existsSync(mark)).toBe(false);
    },
    30_000,
  );

  it('replaces a lock only when its holder is certainly gone', async () => {
    const { state } = setup();
    const env = {
      ...process.env,
      SWARMUP_CONFIG: join(temp(), 'none.yml'),
      SWARMUP_STATE_DIR: state,
    } as NodeJS.ProcessEnv;
    const lock = join(state, 'opsd.lock');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true,
    });
    try {
      await until(() => processStartSync(child.pid!) !== null);
      // Alive, with no creation time to compare: refuse rather than guess.
      writeFileSync(lock, JSON.stringify({ pid: child.pid, start: null }));
      await expect(runDaemon({ env, port: 0, log: () => {} })).rejects.toThrow(/cannot tell/);
      expect(existsSync(lock)).toBe(true);
      // An empty or broken lock is not proof of anything either.
      writeFileSync(lock, '');
      await expect(runDaemon({ env, port: 0, log: () => {} })).rejects.toThrow(/cannot tell/);
      // Alive with the same creation time: a running swarmupd.
      writeFileSync(lock, JSON.stringify({ pid: child.pid, start: processStartSync(child.pid!) }));
      await expect(runDaemon({ env, port: 0, log: () => {} })).rejects.toThrow(/already runs/);
      // Same PID, another creation time: a reused PID, so the lock is stale.
      writeFileSync(lock, JSON.stringify({ pid: child.pid, start: 'long-gone' }));
      const stopped = runDaemon({ env, port: 0, log: () => {} });
      await until(() => readDaemon(env)?.pid === process.pid);
      expect(JSON.parse(readFileSync(lock, 'utf8')).pid).toBe(process.pid);
      await stopDaemon({ env }).catch(() => false);
      await stopped;
      expect(existsSync(lock)).toBe(false);
    } finally {
      child.kill();
    }
  });
});

describe('lock takeover', () => {
  function daemonEnv() {
    const { repo, state } = setup();
    const userConfig = join(temp(), 'config.yml');
    writeFileSync(userConfig, 'opsd:\n  port: 0\n  sync: false\n');
    const env = {
      ...process.env,
      SWARMUP_CONFIG: userConfig,
      SWARMUP_STATE_DIR: state,
    } as NodeJS.ProcessEnv;
    delete env.SWARMUP_AGENT;
    return { repo, state, env, lock: join(state, 'opsd.lock') };
  }

  it('treats a lock with its own PID but another start time as stale', async () => {
    const { env, lock } = daemonEnv();
    writeFileSync(lock, JSON.stringify({ pid: process.pid, start: 'a-dead-swarmupd' }));
    const running = runDaemon({ env, port: 0, log: () => {} });
    await until(() => readDaemon(env)?.pid === process.pid);
    const held = JSON.parse(readFileSync(lock, 'utf8')) as { pid: number; start: string };
    expect(held.start).toBe(processStartSync(process.pid));
    await stopDaemon({ env }).catch(() => false);
    await running;
    expect(existsSync(lock)).toBe(false);
  });

  it('writes the default providers into a config without them once, with a note in its log', async () => {
    const { env } = daemonEnv();
    const lines: string[] = [];
    const running = runDaemon({ env, port: 0, log: (l) => lines.push(l) });
    await until(() => readDaemon(env)?.pid === process.pid);
    await stopDaemon({ env }).catch(() => false);
    await running;
    const text = readFileSync(env.SWARMUP_CONFIG!, 'utf8');
    expect(text).toContain('seeded: 1');
    expect(text).toMatch(/claude:\s+command: claude/);
    // An existing config's agents are its own: none are added.
    expect(text).not.toContain('agents');
    expect(lines.filter((l) => l.includes('seeded'))).toEqual([
      expect.stringMatching(/^swarmupd: seeded.*: wrote providers claude, codex; edit or remove/),
    ]);
    // The next start finds it seeded and writes nothing.
    lines.length = 0;
    const again = runDaemon({ env, port: 0, log: (l) => lines.push(l) });
    await until(() => readDaemon(env)?.pid === process.pid);
    await stopDaemon({ env }).catch(() => false);
    await again;
    expect(readFileSync(env.SWARMUP_CONFIG!, 'utf8')).toBe(text);
    expect(lines.some((l) => l.includes('seeded'))).toBe(false);
  });

  it('lets exactly one of three starters take over a stale lock', async () => {
    const { repo, state, env, lock } = daemonEnv();
    const gone = spawn(process.execPath, ['-e', ''], { windowsHide: true });
    await new Promise((r) => gone.once('exit', r));
    writeFileSync(lock, JSON.stringify({ pid: gone.pid, start: 'whatever' }));
    const infos = await Promise.all([
      startDaemon({ env, cwd: repo }),
      startDaemon({ env, cwd: repo }),
      startDaemon({ env, cwd: repo }),
    ]);
    try {
      expect(new Set(infos.map((i) => i.pid)).size).toBe(1);
      const started = readFileSync(join(state, 'opsd.log'), 'utf8').match(/ on 127\.0\.0\.1:/g);
      expect(started).toHaveLength(1);
      expect(JSON.parse(readFileSync(lock, 'utf8')).pid).toBe(infos[0]!.pid);
      expect(existsSync(`${lock}.takeover`)).toBe(false);
    } finally {
      expect(await stopDaemon({ env })).toBe(true);
    }
  });
});

describe('takeover guard', () => {
  it('never displaces a takeover in progress, however long it pauses', async () => {
    const { state } = setup();
    const env = {
      ...process.env,
      SWARMUP_CONFIG: join(temp(), 'none.yml'),
      SWARMUP_STATE_DIR: state,
    } as NodeJS.ProcessEnv;
    const lock = join(state, 'opsd.lock');
    const guard = `${lock}.takeover`;
    // Starter A: alive, holding the guard, paused between its read and its delete.
    const a = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true });
    const gone = spawn(process.execPath, ['-e', ''], { windowsHide: true });
    await new Promise((r) => gone.once('exit', r));
    try {
      await until(() => processStartSync(a.pid!) !== null);
      const staleLock = JSON.stringify({ pid: gone.pid, start: 'dead' });
      const guardText = JSON.stringify({ pid: a.pid, start: processStartSync(a.pid!) });
      writeFileSync(lock, staleLock);
      writeFileSync(guard, guardText);
      // Make the guard look old: age alone must not matter.
      const old = new Date(Date.now() - 3600_000);
      utimesSync(guard, old, old);
      await expect(runDaemon({ env, port: 0, log: () => {} })).rejects.toThrow(
        /another swarmupd is starting/,
      );
      expect(readFileSync(guard, 'utf8')).toBe(guardText);
      expect(readFileSync(lock, 'utf8')).toBe(staleLock);

      // The guard's holder is certainly gone: refuse and name the file, change nothing.
      const deadGuard = JSON.stringify({ pid: gone.pid, start: 'dead' });
      writeFileSync(guard, deadGuard);
      await expect(runDaemon({ env, port: 0, log: () => {} })).rejects.toThrow(
        /crashed while taking over/,
      );
      expect(readFileSync(guard, 'utf8')).toBe(deadGuard);
      expect(readFileSync(lock, 'utf8')).toBe(staleLock);
    } finally {
      a.kill();
    }
  });
});

describe('push on collaboration changes', () => {
  it('sends changed when an agent posts to a channel or votes', async () => {
    const { sup, as } = setup();
    const api = await startApi(sup, { port: 0, token: 'push-token', version: 't' });
    const events: string[] = [];
    const stream = await fetch(`http://127.0.0.1:${api.port}/api/events?token=push-token`);
    const reader = stream.body!.getReader();
    const pump = (async () => {
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        events.push(...[...dec.decode(value).matchAll(/^event: (\w+)/gm)].map((m) => m[1]!));
      }
    })();
    try {
      await until(() => events.includes('hello'));
      // Let the first signature settle before writing.
      await new Promise((r) => setTimeout(r, 500));
      as('codex:qa').post('dev', 'hello @human:dawid');
      await until(() => events.includes('changed'));
      expect(events).not.toContain('tasks');
      const before = events.length;
      as('claude:orchestrator').propose({
        question: 'Q?',
        options: ['a', 'b'],
        voters: ['claude:qa', 'codex:qa'],
      });
      await until(() => events.length > before);
      const mid = events.length;
      as('codex:qa').vote('D-1', 'a');
      await until(() => events.length > mid);
      expect(events.filter((e) => e === 'changed').length).toBeGreaterThanOrEqual(3);
    } finally {
      await reader.cancel();
      await pump.catch(() => {});
      await api.close();
    }
  });
});

describe('process ledger', () => {
  it('kills by PID only while the PID still runs the process with the recorded creation time', async () => {
    const lister = systemLister();
    const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      await until(() => alive(victim.pid!));
      const me = (await lister.list()).find((p) => p.pid === victim.pid)!;
      expect(me).toBeDefined();
      if (!lister.precise) return;
      // A creation time 1 ms off stands for a PID that another process took over.
      const wrong = await lister.kill([{ pid: victim.pid!, start: me.start + 1 }]);
      expect(wrong.get(victim.pid!)).toBe('other');
      expect(alive(victim.pid!)).toBe(true);
      const right = await lister.kill([{ pid: victim.pid!, start: me.start }]);
      expect(right.get(victim.pid!)).toBe('killed');
      await until(() => !alive(victim.pid!));
      const again = await lister.kill([{ pid: victim.pid!, start: me.start }]);
      expect(['gone', 'other']).toContain(again.get(victim.pid!));
    } finally {
      lister.close();
      if (victim.pid && alive(victim.pid)) victim.kill();
    }
  });

  it('records what a run started and kills a grandchild left behind after its parent exited', async () => {
    const { env, marker } = orphanScripts();
    const { sup } = setup({ mode: 'orphan', env });
    const run = sup.launch({ agent: 'fake:engineer' });
    await until(() => existsSync(marker) && readFileSync(marker, 'utf8') !== '');
    const cPid = Number(readFileSync(marker, 'utf8'));
    const cSeen = Date.now();
    try {
      await sup.trackProcs();
      expect(sup.store.procs(run.id)?.entries.map((e) => e.pid)).toEqual(
        expect.arrayContaining([run.pid, cPid]),
      );
      await ended(sup, run.id, 20_000);
      // The agent and B exited on their own; C is an orphan that only the ledger knows about.
      await until(() => !alive(cPid));
      await until(
        () => sup.store.procs(run.id)?.entries.find((e) => e.pid === cPid)?.killed_at !== undefined,
      );
      expect(sup.run(run.id).procs_left).toBeUndefined();
      const views = await sup.procs(run.id);
      expect(views.find((v) => v.pid === cPid)).toMatchObject({ alive: false });
    } finally {
      if (alive(cPid)) await killOwn(cPid, cSeen);
    }
  });

  it('sweeps processes of ended runs at startup, but never a PID that now runs something else', async () => {
    const { sup, state } = setup();
    const keep = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const left = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      await until(() => alive(keep.pid!) && alive(left.pid!));
      const lister = systemLister();
      const snap = await lister.list().finally(() => lister.close());
      const info = (pid: number) => snap.find((p) => p.pid === pid)!;
      const now = new Date().toISOString();
      const record: RunRecord = {
        id: '01KOLD0000000000000000RUN1',
        agent: 'fake:engineer',
        pid: left.pid!,
        image: 'node.exe',
        command: 'node',
        cwd: state,
        log: join(state, 'logs', 'x.log'),
        started_at: now,
        ended_at: now,
        status: 'ended',
        reason: 'exit',
        exit: 0,
        budget_minutes: 10,
        tokens: 0,
      };
      sup.store.save(record);
      const entry = (pid: number, start: number) => ({
        pid,
        ppid: 1,
        name: 'node.exe',
        cmd: 'node',
        start,
        first_seen: now,
        last_seen: now,
      });
      sup.store.saveProcs({
        run: record.id,
        root_pid: left.pid!,
        root_start: info(left.pid!).start,
        // keep's PID with another creation time stands for a PID reused by another process.
        entries: [
          entry(left.pid!, info(left.pid!).start),
          entry(keep.pid!, info(keep.pid!).start - 5000),
        ],
      });
      await sup.sweep();
      await until(() => !alive(left.pid!));
      expect(alive(keep.pid!)).toBe(true);
      expect(sup.store.procs(record.id)?.entries[0]?.killed_at).toBeDefined();
      expect(sup.store.procs(record.id)?.entries[1]?.killed_at).toBeUndefined();
    } finally {
      for (const c of [keep, left]) if (c.pid && alive(c.pid)) c.kill();
    }
  });

  it('never kills an unsure process on its own, but kills it when a human picks it', async () => {
    const { sup, state } = setup();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      await until(() => alive(child.pid!));
      const lister = systemLister();
      const snap = await lister.list().finally(() => lister.close());
      const start = snap.find((x) => x.pid === child.pid)!.start;
      const now = new Date().toISOString();
      const record: RunRecord = {
        id: '01KOLD0000000000000000RUN2',
        agent: 'fake:engineer',
        pid: 1,
        image: 'node.exe',
        command: 'node',
        cwd: state,
        log: join(state, 'logs', 'y.log'),
        started_at: now,
        ended_at: now,
        status: 'ended',
        reason: 'exit',
        exit: 0,
        budget_minutes: 10,
        tokens: 0,
      };
      sup.store.save(record);
      sup.store.saveProcs({
        run: record.id,
        root_pid: 1,
        root_start: null,
        entries: [
          {
            pid: child.pid!,
            ppid: 1,
            name: 'node.exe',
            cmd: 'node',
            start,
            first_seen: now,
            last_seen: now,
            unsure: true,
          },
        ],
      });
      await sup.reap(record.id);
      expect(alive(child.pid!)).toBe(true);
      expect(sup.run(record.id).procs_left).toBeUndefined();
      expect((await sup.procs(record.id))[0]).toMatchObject({ alive: true, unsure: true });
      await expect(sup.reapNow(record.id, 999_999)).rejects.toThrow(/no live process/);
      await sup.reapNow(record.id, child.pid!);
      await until(() => !alive(child.pid!));
    } finally {
      if (child.pid && alive(child.pid)) child.kill();
    }
  });
});
