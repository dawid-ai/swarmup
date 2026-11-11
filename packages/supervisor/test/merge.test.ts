import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initRoot, PATCH_KEY_ARGS, patchKey, secretKind, Workspace } from '@swarmup/core';
import type {
  MergeGitTimeout,
  MergeStatus,
  OpsdSelf,
  ProcLister,
  RunRecord,
} from '../src/index.js';
import {
  CommandRunner,
  DEFAULT_INSTALL,
  insideDir,
  installCommands,
  installSteps,
  isEngineRepo,
  lockfileChanges,
  lockfileDirs,
  MERGE_ACTOR,
  MergeRepo,
  mergeSource,
  notLiveNotice,
  opsdCodeChanges,
  opsdConfig,
  pickMergeSource,
  reviewSources,
  startApi,
  Supervisor,
  systemLister,
} from '../src/index.js';
import { until, WAIT_MS } from './until.js';

const dirs: string[] = [];
const sups: Supervisor[] = [];

// `close` may wait about a minute for killed runs and their wrap-up (its own limits add up to
// 65 s), so the hook gets 90 s. It takes this test's supervisors and directories before it
// awaits anything: a hook that still runs after a timeout must never delete the next test's
// repos (AO-0194).
afterEach(async () => {
  const mine = sups.splice(0);
  const gone = dirs.splice(0);
  try {
    for (const s of mine) {
      s.stop({ killRuns: true });
      await s.close();
    }
  } finally {
    for (const d of gone) {
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
}, 90_000);

/** Whether `dir` could be removed: nothing holds it or a file in it any more. */
function removed(dir: string): boolean {
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** The system's process lister, with every kill refused, as in a sandbox that allows none. */
function refusingLister(): ProcLister {
  const real = systemLister();
  return {
    precise: real.precise,
    clockSlack: real.clockSlack,
    list: () => real.list(),
    kill: (targets) => Promise.resolve(new Map(targets.map((t) => [t.pid, 'error' as const]))),
    ownPids: () => real.ownPids?.() ?? [],
    close: () => real.close(),
  };
}

/**
 * A lister that can neither list nor kill, as in a sandbox that refuses both. With `left`, it
 * lists only that process, for as long as `left.running` says so, and kills nothing.
 */
function blindLister(left?: { pid: number; start: number; running: boolean }): ProcLister {
  const listed = (l: NonNullable<typeof left>) =>
    l.running ? [{ pid: l.pid, ppid: 0, name: 'held', cmd: 'held', start: l.start }] : [];
  return {
    precise: true,
    clockSlack: 0,
    list: () => (left ? Promise.resolve(listed(left)) : Promise.reject(new Error('access denied'))),
    kill: (targets) => Promise.resolve(new Map(targets.map((t) => [t.pid, 'error' as const]))),
    close: () => {},
  };
}

const WIN = process.platform === 'win32';

/**
 * A git timeout that stops only the command a test hangs, whose arguments start with `hung`,
 * after 4 s, and gives every other command a minute. Under full-suite load on Windows, commands
 * that start the test's hook took past 4 s and then past 10 s, so the merge ended in the wrong
 * stage (AO-0213).
 */
function hangOnly(...hung: string[]): MergeGitTimeout {
  return (args) => (hung.every((a, i) => args[i] === a) ? 4_000 : 60_000);
}

/**
 * Whether stopping a process here also stops what it started. On Windows a git timeout stops
 * git's tree with `taskkill /T`, which a sandbox may refuse: a hook then outlives its git, and a
 * test cannot expect the hook's marks to stop (AO-0213). The probe starts a process that starts
 * another, stops the first as a git timeout does, and reports whether the second ended.
 */
async function stopsTrees(): Promise<boolean> {
  if (!WIN) return true;
  const idle = 'setInterval(() => {}, 1000)';
  const parent = spawn(
    process.execPath,
    [
      '-e',
      `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(idle)}], { stdio: 'ignore' }); console.log(c.pid); ${idle};`,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
  );
  let out = '';
  parent.stdout.on('data', (d: Buffer) => (out += d.toString()));
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  };
  let child = 0;
  try {
    await until(() => out.includes('\n'));
    child = Number(out.trim());
    if (!Number.isInteger(child) || child <= 0 || parent.pid === undefined) return false;
    execFileSync('taskkill', ['/T', '/F', '/PID', String(parent.pid)], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 15_000,
    });
    await until(() => !alive(child), 5_000);
    return true;
  } catch {
    return false;
  } finally {
    parent.kill();
    // Only while the probe's own parent still holds the PID's place: a refused stop left it.
    if (child > 0 && alive(child)) {
      try {
        process.kill(child);
      } catch {
        // Gone meanwhile.
      }
    }
  }
}

/**
 * How long a test waits for a merge to reach a stage (a check or build starting): the merge runs
 * git in a worktree and node before that, so the full suite's load stretches it past `WAIT_MS`
 * more often than a single step (AO-0213).
 */
const STAGE_MS = 90_000;

/** Off Windows, ledgers, and with them killing what merge commands start, need exact creation times. */
const precise = systemLister().precise;

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmupd-merge-'));
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
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...ID },
  }).trim();
const text = (file: string): string => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

/**
 * Fails when `code.txt` says `bad`; waits for `go.txt` when it says `slow`; prints a token-like
 * line, then fails, when it says `leak`. When it says `nap`, the first run writes `napped.txt`,
 * waits for `go.txt` and fails, as tests that time out when the PC wakes do.
 */
const CHECK = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
const code = readFileSync('code.txt', 'utf8');
console.log('checking ' + code.trim());
appendFileSync(process.env.MERGE_COUNT, 'x');
if (code.includes('nap') && !existsSync(process.env.MERGE_NAPPED)) {
  writeFileSync(process.env.MERGE_NAPPED, '');
  while (!existsSync(process.env.MERGE_GO)) await new Promise((r) => setTimeout(r, 50));
  console.error('Test timed out in 5000ms');
  process.exit(1);
}
if (code.includes('slow')) while (!existsSync(process.env.MERGE_GO)) await new Promise((r) => setTimeout(r, 50));
if (code.includes('bad')) { console.error('code says bad'); process.exit(1); }
if (code.includes('leak')) {
  console.log('GH_TOKEN=' + ['gh', 'p_'].join('') + 'A'.repeat(36));
  console.error('after the token');
  process.exit(1);
}
`;
/**
 * Builds `dist/built.txt` from `code.txt`. When it says `hold`, `held.mjs` builds it instead, in
 * a detached process: outside the shell's process group too, so only swarmupd's process ledger finds
 * it, as where `taskkill /T` is refused. When it says `doze`, the first run writes `dozed.txt`,
 * waits for `build-go.txt` and fails.
 */
const BUILD = `
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const code = readFileSync('code.txt', 'utf8');
if (code.includes('doze') && !existsSync(process.env.MERGE_DOZED)) {
  writeFileSync(process.env.MERGE_DOZED, '');
  while (!existsSync(process.env.MERGE_BUILD_GO)) await new Promise((r) => setTimeout(r, 50));
  process.exit(1);
}
if (code.includes('hold')) {
  const held = spawn(process.execPath, ['held.mjs'], { detached: true, stdio: 'inherit' });
  await new Promise((r) => held.on('exit', r));
} else {
  mkdirSync('dist', { recursive: true });
  writeFileSync('dist/built.txt', code);
}
`;
/** Writes its PID to `building.txt`, waits for `build-go.txt`, then builds. */
const HELD = `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
writeFileSync(process.env.MERGE_BUILDING, String(process.pid));
while (!existsSync(process.env.MERGE_BUILD_GO)) await new Promise((r) => setTimeout(r, 50));
mkdirSync('dist', { recursive: true });
writeFileSync('dist/built.txt', readFileSync('code.txt', 'utf8'));
`;
/** Stands in for `npm install`: notes each run, and the code it saw, in `installed.txt`. */
const INSTALL = `
import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync(process.env.MERGE_INSTALLED, readFileSync('code.txt', 'utf8'));
`;
/** Stands in for `npm install` run by path from any directory: notes where it ran. */
const INSTALL_WHERE = `
import { appendFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
appendFileSync(process.env.MERGE_INSTALLED, (existsSync('code.txt') ? '.' : basename(process.cwd())) + '\\n');
`;
/** A writing run that ends by itself once `run-go.txt` exists, so no test has to kill it. */
const RUN = `
import { existsSync } from 'node:fs';
while (!existsSync(process.env.RUN_GO)) await new Promise((r) => setTimeout(r, 50));
`;

/**
 * A project repo on `main` with code, check and build scripts and its task store committed, a
 * task `1` owned by `fake:engineer`, and swarmupd set to merge approved work into `main`.
 */
function mergeSetup(
  opts: {
    procs?: () => ProcLister;
    self?: (repo: string) => OpsdSelf;
    build?: string;
    now?: () => number;
    /** Minutes each merge command may take; config allows whole minutes only. */
    timeoutMinutes?: number;
    gitTimeoutMs?: MergeGitTimeout;
    /** `opsd.merge.test.install`, or a function of the repo that returns it. */
    install?: string[] | ((repo: string) => string[]);
  } = {},
) {
  const repo = temp();
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, windowsHide: true });
  initRoot(repo, { name: 'test', human: 'human:dawid' });
  writeFileSync(join(repo, 'code.txt'), 'one\n');
  writeFileSync(join(repo, 'check.mjs'), CHECK);
  writeFileSync(join(repo, 'build.mjs'), BUILD);
  writeFileSync(join(repo, 'held.mjs'), HELD);
  writeFileSync(join(repo, 'install.mjs'), INSTALL);
  writeFileSync(join(repo, 'install-where.mjs'), INSTALL_WHERE);
  writeFileSync(join(repo, '.gitignore'), 'dist/\n');
  const state = temp();
  const runFile = join(temp(), 'run.mjs');
  writeFileSync(runFile, RUN);
  const env = {
    ...process.env,
    ...ID,
    SWARMUP_CONFIG: join(repo, 'none.yml'),
    SWARMUP_STATE_DIR: state,
    MERGE_GO: join(state, 'go.txt'),
    MERGE_COUNT: join(state, 'checks.txt'),
    MERGE_BUILDING: join(state, 'building.txt'),
    MERGE_BUILD_GO: join(state, 'build-go.txt'),
    MERGE_NAPPED: join(state, 'napped.txt'),
    MERGE_DOZED: join(state, 'dozed.txt'),
    MERGE_INSTALLED: join(state, 'installed.txt'),
    RUN_GO: join(state, 'run-go.txt'),
  } as NodeJS.ProcessEnv;
  delete env.SWARMUP_AGENT;
  delete env.SWARMUP_ROOTS;
  const as = (actor: string) => new Workspace({ cwd: repo, env, actor, user: {} });
  as('human:dawid').newTask({ title: 'Change the code', owner: 'fake:engineer' });
  as('human:dawid').newTask({ title: 'Other work', owner: 'fake:engineer' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'start');
  // Every verdict in these tests comes after swarmupd first saw the merge setting.
  writeFileSync(join(state, 'merge.json'), JSON.stringify({ test: '2000-01-01T00:00:00.000Z' }));
  const config = opsdConfig({
    opsd: {
      sync: false,
      // The writing run holds the store checkout, as the merge hold tests need (AO-0168).
      task_worktrees: false,
      runtimes: { fake: { command: process.execPath, args: [runFile] } },
      merge: { test: { base: 'main', checks: ['node check.mjs'], build: ['node build.mjs'] } },
    },
  });
  if (opts.timeoutMinutes !== undefined) config.merge.test!.timeout_minutes = opts.timeoutMinutes;
  if (opts.install) {
    config.merge.test!.install =
      typeof opts.install === 'function' ? opts.install(repo) : opts.install;
  }
  /** A swarmupd on the same state, like the one a restart starts. */
  const opsd = (): Supervisor => {
    const s = new Supervisor({
      env,
      cwd: repo,
      user: {},
      config,
      // Each swarmupd closes its own lister when it stops.
      procs: opts.procs?.(),
      now: opts.now,
      freeMem: () => 64 * 2 ** 30,
      self: opts.self?.(repo),
      build: opts.build,
      version: '0.2.0-test',
      mergeGitTimeoutMs: opts.gitTimeoutMs,
    });
    sups.push(s);
    return s;
  };
  const sup = opsd();

  /** A branch `feature` from main's tip, in a worktree of its own, with `code.txt` as `code`. */
  const branch = (code: string, files: Record<string, string> = {}): string => {
    const wt = join(temp(), 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt, 'main');
    writeFileSync(join(wt, 'code.txt'), code);
    for (const [f, content] of Object.entries(files)) {
      mkdirSync(dirname(join(wt, f)), { recursive: true });
      writeFileSync(join(wt, f), content);
    }
    git(wt, 'add', '-A');
    git(wt, 'commit', '-qm', 'Change the code');
    return git(wt, 'rev-parse', 'HEAD');
  };
  /** A commit on main in the repo's own checkout, as another merge or a sync makes. */
  const onMain = (file: string, content: string): string => {
    writeFileSync(join(repo, file), content);
    git(repo, 'add', '--', file);
    git(repo, 'commit', '-qm', `Change ${file}`);
    return git(repo, 'rev-parse', 'HEAD');
  };
  /** Task 1 through review and approval, with the review naming `commit` on `feature`. */
  const approve = (commit: string): void => {
    as('fake:engineer').start('1', 'plan');
    as('fake:engineer').review(
      '1',
      `${commit.slice(0, 7)} on branch feature: changes the code, tests`,
      'human:dawid',
    );
    as('human:dawid').verdict('1', 'approve', 'looks right');
  };
  const merged = async (): Promise<void> => {
    await sup.tick();
    await sup.mergeSettled();
  };
  const last = () => as('human:dawid').showEvents('1').events.at(-1)!;
  return { repo, sup, opsd, as, state, branch, onMain, approve, merged, last };
}

function ended(sup: Supervisor, id: string, ms = WAIT_MS): Promise<RunRecord> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`run ${id} did not end`)), ms);
    const check = (r: RunRecord): void => {
      if (r.id !== id || r.status !== 'ended') return;
      clearTimeout(timer);
      sup.off('run', check);
      resolve(r);
    };
    sup.on('run', check);
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

describe('merging approved work', () => {
  it('reads the branch and commit a review names', () => {
    expect(mergeSource('3959772 on branch claude/ao-0103-run-commit (pushed; worktree x)')).toEqual(
      { commit: '3959772', branch: 'claude/ao-0103-run-commit' },
    );
    expect(mergeSource('abc1234 on branch `fix/a.b`: done')).toEqual({
      commit: 'abc1234',
      branch: 'fix/a.b',
    });
    expect(mergeSource('Work is on branch feature/x. Tests pass.')).toEqual({
      branch: 'feature/x',
    });
    expect(mergeSource('PR: https://github.com/o/r/pull/1')).toBeNull();
  });

  it('takes a loose branch word only when the repo has that branch, else an earlier review (AO-0153)', () => {
    const branches = new Set(['claude/ao-0148-speed', 'claude/ao-0147-speed']);
    const has = {
      branch: (b: string) => branches.has(b),
      commit: (c: string) => c === 'ca2b7d9b',
    };
    // Prose from the AO-0148 and AO-0147 reviews that named a stray word as the branch.
    const prose148 =
      'AO-0148: the failure came from the PC sleeping, not from the branch, and the same commits ' +
      'rebased onto v2 pass. I did not force-push the rebase: the rebased branch is local.';
    const prose147 =
      'AO-0147: the merge failed on a file this branch does not touch; commit it on ' +
      'claude/ao-0147-speed or directly on v2.';
    expect(reviewSources(prose148)).toEqual({ loose: ['is'] });
    expect(reviewSources(prose147)).toEqual({ loose: ['does'] });
    const older148 = 'AO-0148: ca2b7d9b on branch claude/ao-0148-speed (pushed) moves the tests.';
    const older147 = 'AO-0147: f14a8416 + f441744d on branch claude/ao-0147-speed make it fast.';
    // The branch an earlier review names, at its tip: it holds what the last review describes.
    expect(pickMergeSource([prose148, older148], has)).toEqual({ branch: 'claude/ao-0148-speed' });
    expect(pickMergeSource([prose147, older147], has)).toEqual({ branch: 'claude/ao-0147-speed' });
    // A stray word alone merges nothing.
    expect(pickMergeSource([prose148], has)).toBeNull();
    // A loose name that is a branch still counts, after the stray ones.
    expect(pickMergeSource(['this branch does; see branch claude/ao-0148-speed.'], has)).toEqual({
      branch: 'claude/ao-0148-speed',
    });
    // The newest review's `<commit> on branch <name>` stands as it is, even when the repo lacks
    // it: swarmupd tells the human instead of merging older work.
    expect(pickMergeSource(['abc1234 on branch gone', older148], has)).toEqual({
      commit: 'abc1234',
      branch: 'gone',
    });
    // An earlier review whose branch is gone counts by its commit.
    expect(pickMergeSource([prose148, 'ca2b7d9b on branch deleted-one'], has)).toEqual({
      commit: 'ca2b7d9b',
      branch: 'deleted-one',
    });
  });

  it('merges the branch an earlier review names when the approved review names none (AO-0153)', async () => {
    const s = mergeSetup();
    const first = s.branch('two\n');
    const eng = s.as('fake:engineer');
    eng.start('1', 'plan');
    eng.review('1', `${first.slice(0, 7)} on branch feature: changes the code`, 'human:dawid');
    s.as('human:dawid').verdict('1', 'changes', 'one more line');
    // The fix lands on the branch; the next review names no source, only prose.
    const block = git(s.repo, 'worktree', 'list', '--porcelain')
      .split(/\r?\n\r?\n/)
      .find((b) => b.includes('branch refs/heads/feature'))!;
    const wt = /^worktree (.+)$/m.exec(block)![1]!.trim();
    writeFileSync(join(wt, 'code.txt'), 'two\nthree\n');
    git(wt, 'commit', '-qam', 'One more line');
    const tip = git(wt, 'rev-parse', 'HEAD');
    eng.start('1', 'fix');
    eng.review('1', 'Added the line; this branch is ready and the tests pass.', 'human:dawid');
    s.as('human:dawid').verdict('1', 'approve', 'looks right');
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'merge', actor: MERGE_ACTOR, branch: 'feature' });
    expect(git(s.repo, 'rev-parse', 'main')).toBe(tip);
    expect(text(join(s.repo, 'code.txt'))).toBe('two\nthree\n');
  });

  it('rebases onto the base, runs the checks, fast-forwards the base, builds and records it', async () => {
    const s = mergeSetup();
    const commit = s.branch('two\n');
    // main moves on after the branch was cut, so the merge is a real rebase.
    const before = s.onMain('other.txt', 'other\n');
    s.approve(commit);
    // The task store has events no commit holds; a merge leaves them alone.
    const pending = git(s.repo, 'status', '--porcelain', '--', '.swarmup');
    expect(pending).not.toBe('');
    await s.merged();

    const tip = git(s.repo, 'rev-parse', 'main');
    expect(git(s.repo, 'rev-parse', `${tip}^`)).toBe(before);
    expect(git(s.repo, 'log', '-1', '--format=%s', tip)).toBe('Change the code');
    // The checkout follows main, and the build ran there.
    expect(text(join(s.repo, 'code.txt'))).toBe('two\n');
    expect(text(join(s.repo, 'other.txt'))).toBe('other\n');
    expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('two\n');
    expect(git(s.repo, 'status', '--porcelain', '--', '.swarmup')).toBe(pending);

    expect(s.as('human:dawid').view('1').status).toBe('done');
    const e = s.last();
    expect(e).toMatchObject({
      type: 'merge',
      actor: MERGE_ACTOR,
      commit: tip,
      into: 'main',
      branch: 'feature',
    });
    expect(e.body).toContain(`as ${tip.slice(0, 7)}, rebased onto ${before.slice(0, 7)}`);
    expect(e.body).toContain('Checks passed: `node check.mjs`.');
    expect(e.body).toContain('Built with `node build.mjs`.');

    // Done once: a second tick merges nothing again.
    await s.merged();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(tip);
    expect(
      s
        .as('human:dawid')
        .showEvents('1')
        .events.filter((x) => x.type === 'merge'),
    ).toHaveLength(1);
  });

  it('approves the merged patch for its own repo and base only, for 30 days (AO-0193)', async () => {
    let now = Date.now();
    const s = mergeSetup({ now: () => now });
    const commit = s.branch('two\n');
    s.onMain('other.txt', 'other\n');
    s.approve(commit);
    await s.merged();
    const tip = git(s.repo, 'rev-parse', 'main');
    const key = patchKey(git(s.repo, ...PATCH_KEY_ARGS, tip));
    expect(key).toBeTruthy();
    type Approving = { approved(): (top: string, branch: string) => ReadonlySet<string> };
    const approved = (top: string, branch: string, sup = s.sup) => [
      ...(sup as unknown as Approving).approved()(top, branch),
    ];
    expect(approved(s.repo, 'main')).toEqual([key]);
    // Another branch of the repo, or another repo with an equal patch on main, is not approved.
    expect(approved(s.repo, 'feature')).toEqual([]);
    const other = temp();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: other, windowsHide: true });
    expect(approved(other, 'main')).toEqual([]);
    // A swarmupd started later reads the same file.
    expect(approved(s.repo, 'main', s.opsd())).toEqual([key]);
    // Expired keys stop counting when read, before any later merge prunes them.
    now += 30 * 86_400_000 + 1;
    expect(approved(s.repo, 'main')).toEqual([]);
    // The first, unscoped form of the file approves nothing.
    now = Date.now();
    const unscoped = { [key!]: new Date(now).toISOString() };
    writeFileSync(join(s.state, 'approved.json'), JSON.stringify(unscoped));
    expect(approved(s.repo, 'main')).toEqual([]);
  });

  it('installs dependencies in the checkout before the build when the merge changed a lockfile (AO-0185)', async () => {
    const s = mergeSetup({ install: ['node install.mjs'] });
    const installed = join(s.state, 'installed.txt');
    const commit = s.branch('two\n', { 'package-lock.json': '{"lockfileVersion":3}\n' });
    s.approve(commit);
    await s.merged();
    expect(s.as('human:dawid').view('1').status).toBe('done');
    // It ran once, in the checkout, after the base moved there.
    expect(text(installed)).toBe('two\n');
    expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('two\n');
    expect(s.last().body).toContain('Built with `node install.mjs`, `node build.mjs`.');
  });

  it('installs in each directory whose lockfile the merge changed, without a root lockfile (AO-0185)', async () => {
    const s = mergeSetup({
      install: (repo) => [`node "${join(repo, 'install-where.mjs').replace(/\\/g, '/')}"`],
    });
    const commit = s.branch('two\n', {
      'site/package-lock.json': '{"lockfileVersion":3}\n',
      'app/web/npm-shrinkwrap.json': '{"lockfileVersion":3}\n',
      'docs/note.md': 'a note\n',
    });
    s.approve(commit);
    await s.merged();
    expect(s.as('human:dawid').view('1').status).toBe('done');
    // Once in each changed directory, in order, and not in the checkout itself.
    expect(text(join(s.state, 'installed.txt'))).toBe('web\nsite\n');
    expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('two\n');
    const body = s.last().body;
    expect(body).toContain('install-where.mjs" (in app/web)`');
    expect(body).toContain('install-where.mjs" (in site)`, `node build.mjs`.');
  });

  it('skips the install when the merge left the lockfiles alone (AO-0185)', async () => {
    const s = mergeSetup({ install: ['node install.mjs'] });
    const commit = s.branch('two\n', { 'docs/note.md': 'a note\n' });
    s.approve(commit);
    await s.merged();
    expect(existsSync(join(s.state, 'installed.txt'))).toBe(false);
    expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('two\n');
    expect(s.last().body).toContain('Built with `node build.mjs`.');
  });

  it('finds lockfile changes and picks the install commands (AO-0185)', () => {
    expect(
      lockfileChanges([
        'package-lock.json',
        'packages/desktop/package.json',
        'site/npm-shrinkwrap.json',
        'docs/package-lock.json.md',
        'src/main.ts',
      ]),
    ).toEqual(['package-lock.json', 'site/npm-shrinkwrap.json']);
    expect(
      lockfileDirs([
        'site/package-lock.json',
        'package-lock.json',
        'site/npm-shrinkwrap.json',
        'app/web/package-lock.json',
        'src/main.ts',
      ]),
    ).toEqual(['.', 'app/web', 'site']);
    expect(lockfileDirs(['src/main.ts'])).toEqual([]);
    const top = temp();
    // No lockfile in the checkout: nothing to install unless the config says so.
    expect(installCommands(undefined, top)).toEqual([]);
    expect(installCommands(['pnpm install --frozen-lockfile'], top)).toEqual([
      'pnpm install --frozen-lockfile',
    ]);
    writeFileSync(join(top, 'package-lock.json'), '{}');
    expect(installCommands(undefined, top)).toEqual([DEFAULT_INSTALL]);
    // `[]` turns it off.
    expect(installCommands([], top)).toEqual([]);
    // The default runs in each changed directory that still has a lockfile; the root has none
    // here, and `gone` lost its lockfile in the merge.
    const nested = temp();
    mkdirSync(join(nested, 'site'));
    writeFileSync(join(nested, 'site', 'package-lock.json'), '{}');
    const site = join(nested, 'site');
    expect(installSteps(undefined, nested, ['.', 'gone', 'site'])).toEqual([
      { command: DEFAULT_INSTALL, cwd: site, label: `${DEFAULT_INSTALL} (in site)` },
    ]);
    // A configured install runs in each of them; in the checkout itself as a bare command.
    expect(installSteps(['node i.mjs'], nested, ['.', 'site'])).toEqual([
      'node i.mjs',
      { command: 'node i.mjs', cwd: site, label: 'node i.mjs (in site)' },
    ]);
    expect(installSteps([], nested, ['.', 'site'])).toEqual([]);
    // Never `npm ci`, which deletes node_modules under a running swarmupd or app first.
    expect(DEFAULT_INSTALL).not.toMatch(/\bnpm ci\b/);
    expect(DEFAULT_INSTALL).toContain('--no-save');
    // The user config reads `install` like `build`.
    const merge = (install: unknown) =>
      opsdConfig({ opsd: { merge: { x: { base: 'main', install: install as string[] } } } }).merge
        .x!.install;
    expect(merge(['npm ci'])).toEqual(['npm ci']);
    expect(merge([])).toEqual([]);
    expect(merge(undefined)).toBeUndefined();
    expect(() => merge('npm ci')).toThrow('opsd.merge.x.install: use a list of commands');
  });

  it("finds changes to swarmupd's own code and says what makes them live (AO-0156)", () => {
    expect(
      opsdCodeChanges([
        'packages/supervisor/src/supervisor.ts',
        'packages/core/src/workspace.ts',
        'packages/supervisor/test/merge.test.ts',
        'packages/core/README.md',
        'packages/desktop/src/main.ts',
        'docs/supervisor.md',
      ]),
    ).toEqual(['packages/supervisor/src/supervisor.ts', 'packages/core/src/workspace.ts']);
    expect(insideDir('C:/dev/agent-ops', 'C:/dev/agent-ops/packages/supervisor/dist')).toBe(true);
    expect(insideDir('C:/dev/agent-ops', 'C:/Program Files/SwarmUp/resources/app')).toBe(false);
    expect(insideDir('C:/dev/agent-ops', 'C:/dev/agent-ops-2/packages')).toBe(false);
    const o = {
      task: 'AO-0150',
      what: 'ea4cfd5b on branch claude/ao-0150-auth-backoff',
      base: 'v2',
      commit: 'f61d5299aaaa',
      files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
      top: 'C:/dev/agent-ops',
      pid: 1992,
      version: '0.2.0-beta.2',
    };
    const installed = notLiveNotice({ ...o, runs: 'installed', built: true });
    expect(installed).toMatch(
      /^AO-0150: swarmupd merged ea4cfd5b on branch claude\/ao-0150-auth-backoff into `v2` as f61d529, which changes swarmupd's own code \(`a\.ts`, `b\.ts`, `c\.ts` and 1 more\)\. The running swarmupd \(pid 1992, 0\.2\.0-beta\.2\) does not have it yet\./,
    );
    expect(installed).toContain('swarmupd runs the installed app, not `C:/dev/agent-ops`');
    expect(installed).toContain('install a new build of the app');
    expect(notLiveNotice({ ...o, runs: 'checkout', built: true })).toContain(
      'The build in `C:/dev/agent-ops` has it: restart swarmupd with **Restart swarmupd** in the tray',
    );
    expect(notLiveNotice({ ...o, runs: 'checkout', built: false })).toContain(
      'Build `C:/dev/agent-ops` (`npm run build`), then restart swarmupd',
    );
  });

  it("tells the human once when a merge changes swarmupd's own code (AO-0156)", async () => {
    // swarmupd runs from somewhere else, as the installed app does.
    const s = mergeSetup({ self: () => ({ dir: temp(), stamp: () => 'new' }), build: 'old' });
    const pkg = JSON.stringify({ name: '@swarmup/supervisor' });
    mkdirSync(join(s.repo, 'packages', 'supervisor'), { recursive: true });
    s.onMain('packages/supervisor/package.json', pkg);
    expect(isEngineRepo(s.repo)).toBe(true);
    const commit = s.branch('two\n', {
      'packages/supervisor/src/x.ts': 'export const x = 1;\n',
      'packages/supervisor/test/x.test.ts': '// test\n',
    });
    s.approve(commit);
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'merge' });
    const notices = () =>
      s
        .as('human:dawid')
        .channel('general')
        .filter((m) => m.body.includes("changes swarmupd's own code"));
    expect(notices()).toHaveLength(1);
    const n = notices()[0]!;
    expect(n.actor).toBe(MERGE_ACTOR);
    expect(n.mentions).toContain('human:dawid');
    expect(n.task).toBe('T-0001');
    expect(n.body).toMatch(/^T-0001: swarmupd merged [0-9a-f]{7} on branch feature into `main`/);
    expect(n.body).toContain('(`packages/supervisor/src/x.ts`)');
    expect(n.body).not.toContain('x.test.ts');
    expect(n.body).toContain('(pid ');
    expect(n.body).toContain('0.2.0-test');
    expect(n.body).toContain('swarmupd runs the installed app');
    // Once: the next tick says nothing new.
    await s.merged();
    expect(notices()).toHaveLength(1);
  });

  it('says to restart when swarmupd runs from the checkout it just built (AO-0156)', async () => {
    // swarmupd's code is inside the repo it merges into, and the build there wrote a new stamp.
    const s = mergeSetup({
      self: (repo) => ({ dir: join(repo, 'packages', 'supervisor', 'dist'), stamp: () => 'new' }),
      build: 'old',
    });
    mkdirSync(join(s.repo, 'packages', 'supervisor'), { recursive: true });
    s.onMain('packages/supervisor/package.json', JSON.stringify({ name: '@swarmup/supervisor' }));
    s.approve(s.branch('two\n', { 'packages/core/src/y.ts': 'export const y = 1;\n' }));
    await s.merged();
    const body = s
      .as('human:dawid')
      .channel('general')
      .find((m) => m.body.includes("changes swarmupd's own code"))!.body;
    expect(body).toContain(`The build in \`${s.repo}\` has it: restart swarmupd`);
  });

  it('sends no notice for a repo that is not the engine, even with the same folders', async () => {
    const s = mergeSetup({ self: () => ({ dir: temp(), stamp: () => 'new' }), build: 'old' });
    s.approve(s.branch('two\n', { 'packages/supervisor/src/x.ts': 'x\n' }));
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'merge' });
    expect(
      s
        .as('human:dawid')
        .channel('general')
        .some((m) => m.body.includes("changes swarmupd's own code")),
    ).toBe(false);
  });

  it('sends the task back on a conflict and leaves the base alone', async () => {
    const s = mergeSetup();
    const commit = s.branch('two\n');
    const before = s.onMain('code.txt', 'three\n');
    s.approve(commit);
    await s.merged();

    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    expect(text(join(s.repo, 'code.txt'))).toBe('three\n');
    expect(existsSync(join(s.repo, 'dist'))).toBe(false);
    const v = s.as('human:dawid').view('1');
    expect(v.status).toBe('todo');
    const e = s.last();
    expect(e).toMatchObject({
      type: 'verdict',
      verdict: 'changes',
      actor: MERGE_ACTOR,
      to: 'fake:engineer',
    });
    expect(e.body).toContain(`swarmupd did not merge ${commit.slice(0, 7)} on branch feature`);
    expect(e.body).toContain(`does not rebase onto main (${before.slice(0, 7)})`);
    expect(e.body).toContain('conflicts in code.txt');
    // The engineer has it in the inbox.
    expect(
      s
        .as('fake:engineer')
        .inbox()
        .some((i) => i.task.endsWith('1')),
    ).toBe(true);
  });

  it('sends the task back with the output when a check fails', async () => {
    const s = mergeSetup();
    const before = git(s.repo, 'rev-parse', 'main');
    const commit = s.branch('bad\n');
    s.approve(commit);
    await s.merged();

    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    expect(existsSync(join(s.repo, 'dist'))).toBe(false);
    expect(s.as('human:dawid').view('1').status).toBe('todo');
    const e = s.last();
    expect(e).toMatchObject({ type: 'verdict', verdict: 'changes', actor: MERGE_ACTOR });
    expect(e.body).toContain('`node check.mjs` failed (exit 1)');
    expect(e.body).toContain('checking bad');
    expect(e.body).toContain('code says bad');
    const log = /Full output: (\S+)/.exec(e.body)?.[1];
    expect(log && text(log)).toContain('code says bad');
  });

  it('merges again instead of sending the task back when the PC slept during the checks (AO-0151)', async () => {
    let slept = 0;
    const s = mergeSetup({ now: () => Date.now() + slept });
    const warns: string[] = [];
    s.sup.on('warn', (m: string) => warns.push(m));
    const before = git(s.repo, 'rev-parse', 'main');
    s.approve(s.branch('nap\n'));
    await s.sup.tick();
    await until(() => existsSync(join(s.state, 'napped.txt')), STAGE_MS);
    // The PC sleeps for an hour; the check fails on wake.
    slept = 60 * 60_000;
    writeFileSync(join(s.state, 'go.txt'), 'go\n');
    await s.sup.mergeSettled();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    expect(s.as('human:dawid').view('1').status).toBe('done');
    expect(s.last()).toMatchObject({ type: 'verdict', verdict: 'approve' });
    expect(warns.join('\n')).toMatch(
      /`node check\.mjs` failed \(exit 1\) after the PC slept or swarmupd stopped responding; merging again/,
    );
    // The next tick merges it from the start, and the check passes.
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'merge', actor: MERGE_ACTOR });
    expect(text(join(s.state, 'checks.txt'))).toBe('xx');
    expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('nap\n');
  });

  it('builds again instead of sending the task back when the PC slept during the build (AO-0151)', async () => {
    let slept = 0;
    const s = mergeSetup({ now: () => Date.now() + slept });
    s.approve(s.branch('doze\n'));
    await s.sup.tick();
    await until(() => existsSync(join(s.state, 'dozed.txt')), STAGE_MS);
    slept = 60 * 60_000;
    writeFileSync(join(s.state, 'build-go.txt'), 'go\n');
    await s.sup.mergeSettled();
    const merged = s.last();
    expect(merged).toMatchObject({ type: 'merge', actor: MERGE_ACTOR });
    expect(merged.body).toContain(
      'Build: `node build.mjs` failed (exit 1) after the PC slept or swarmupd stopped responding; swarmupd runs the build again.',
    );
    expect(existsSync(join(s.repo, 'dist'))).toBe(false);
    // The next tick runs the pending build.
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'comment', actor: MERGE_ACTOR });
    expect(s.last().body).toContain(
      'Built main with `node build.mjs` after the earlier build did not finish',
    );
    expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('doze\n');
    expect(s.as('human:dawid').view('1').status).toBe('done');
  });

  it('merges again, keeping the timeout retry, when a check times out as the PC wakes (AO-0170)', async () => {
    // As the AO-0165 merge: the PC sleeps during a check that hangs, and its timeout ends it on
    // wake. 0.05 min is 3 s.
    let slept = 0;
    const s = mergeSetup({ timeoutMinutes: 0.05, now: () => Date.now() + slept });
    const warns: string[] = [];
    s.sup.on('warn', (m: string) => warns.push(m));
    const before = git(s.repo, 'rev-parse', 'main');
    s.approve(s.branch('slow\n'));
    await s.sup.tick();
    // The rebase before the check can take over 10 s under the full suite.
    await until(() => existsSync(join(s.state, 'checks.txt')), 30_000);
    slept = 60 * 60_000;
    await s.sup.mergeSettled();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    expect(s.last()).toMatchObject({ type: 'verdict', verdict: 'approve' });
    expect(warns.join('\n')).toMatch(
      /`node check\.mjs` failed \(timed out after \d+ min\) after the PC slept or swarmupd stopped responding; merging again/,
    );
    expect(warns.join('\n')).not.toContain('merges once more');

    // A timeout with no sleep still gets its one retry (AO-0172).
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'verdict', verdict: 'approve' });
    expect(warns.join('\n')).toMatch(
      /timed out after \d+ min; swarmupd stopped it and merges once more/,
    );
    writeFileSync(join(s.state, 'go.txt'), 'go\n');
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'merge', actor: MERGE_ACTOR });
    expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('slow\n');
  });

  it('stops a check past its timeout, merges once more, then sends the task back and frees the checkout (AO-0172)', async () => {
    // 0.05 min is 3 s; the `slow` check waits for go.txt, which never comes. The checks.txt
    // count below needs each check to start before its stop: 600 ms flaked under the full suite.
    const s = mergeSetup({ timeoutMinutes: 0.05 });
    const warns: string[] = [];
    s.sup.on('warn', (m: string) => warns.push(m));
    const before = git(s.repo, 'rev-parse', 'main');
    s.approve(s.branch('slow\n'));
    await s.merged();
    expect(s.sup.merge).toBeNull();
    expect(s.last()).toMatchObject({ type: 'verdict', verdict: 'approve' });
    expect(warns.join('\n')).toMatch(
      /merge of test\/T-0001: `node check\.mjs` timed out after \d+ min; swarmupd stopped it and merges once more/,
    );

    await s.merged();
    expect(s.sup.merge).toBeNull();
    expect(text(join(s.state, 'checks.txt'))).toBe('xx');
    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    const e = s.last();
    expect(e).toMatchObject({ type: 'verdict', verdict: 'changes', actor: MERGE_ACTOR });
    expect(e.body).toContain('`node check.mjs` failed (timed out after');
    expect(s.as('human:dawid').view('1').status).toBe('todo');

    // Nothing holds the checkout: a writing run starts there.
    const run = s.sup.launch({ agent: 'fake:engineer', task: '2' });
    const end = ended(s.sup, run.id);
    writeFileSync(join(s.state, 'run-go.txt'), 'go\n');
    await end;
  });

  it('gives a later review its own merge once more after a check timeout, when the earlier merge ended another way (AO-0172)', async () => {
    const s = mergeSetup({ timeoutMinutes: 0.01 });
    const warns: string[] = [];
    s.sup.on('warn', (m: string) => warns.push(m));
    const once = () => warns.filter((w) => w.includes('swarmupd stopped it and merges once more'));
    const commit = s.branch('slow\n');
    s.approve(commit);
    await s.merged();
    expect(once()).toHaveLength(1);

    // The merge once more ends on a conflict, before any check.
    s.onMain('code.txt', 'three\n');
    await s.merged();
    let e = s.last();
    expect(e).toMatchObject({ type: 'verdict', verdict: 'changes', actor: MERGE_ACTOR });
    expect(e.body).toContain('does not rebase onto main');

    // A later review of the same work: its first check timeout gets its own merge once more.
    s.onMain('code.txt', 'one\n');
    s.approve(commit);
    await s.merged();
    expect(once()).toHaveLength(2);
    e = s.last();
    expect(e).toMatchObject({ type: 'verdict', verdict: 'approve' });
    expect(s.as('human:dawid').view('1').status).toBe('done');
  });

  it('stops a git command of the merge that never exits, with what it started, and tells the human (AO-0172)', async () => {
    // Probed before the merge starts, so the size check follows the merge's end at once.
    const treeStops = await stopsTrees();
    const s = mergeSetup({ gitTimeoutMs: hangOnly('rebase', '-q') });
    const beat = join(s.state, 'beat.txt').split(sep).join('/');
    // A pre-rebase hook that says why it waits, never ends by itself, and leaves a mark every
    // 100 ms.
    writeFileSync(
      join(s.repo, '.git', 'hooks', 'pre-rebase'),
      `#!/bin/sh\necho 'hook waits for the lock' >&2\nwhile [ ! -f "$MERGE_GO" ]; do printf x >> '${beat}'; sleep 0.1; done\nexit 1\n`,
      { mode: 0o755 },
    );
    const commit = s.branch('two\n');
    // main moves on, so the merge has to rebase and git runs the hook.
    const before = s.onMain('other.txt', 'other\n');
    s.approve(commit);
    await s.merged();

    expect(s.sup.merge).toBeNull();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    const e = s.last();
    expect(e).toMatchObject({ type: 'comment', actor: MERGE_ACTOR, to: 'human:dawid' });
    expect(e.body).toMatch(
      /swarmupd could not merge .+: `git rebase -q [0-9a-f]+` in .+ timed out after 4 s; swarmupd stopped it \(stage: rebase\)/,
    );
    // What it printed before the stop is in the note, and whole in the log.
    expect(e.body).toMatch(/Last output:\n\n```\n[^`]*hook waits for the lock/);
    const log = /Full output: (\S+)/.exec(e.body)?.[1];
    expect(log && text(log)).toContain('hook waits for the lock');
    expect(existsSync(beat)).toBe(true);
    if (treeStops) {
      // The hook was stopped with git: its marks stop.
      const size = statSync(beat).size;
      await new Promise((r) => setTimeout(r, 800));
      expect(statSync(beat).size).toBe(size);
    }
    // Where the stop could not reach the hook, this ends it.
    writeFileSync(join(s.state, 'go.txt'), 'go\n');

    // Nothing holds the checkout: a writing run starts there.
    const run = s.sup.launch({ agent: 'fake:engineer', task: '2' });
    const end = ended(s.sup, run.id);
    writeFileSync(join(s.state, 'run-go.txt'), 'go\n');
    await end;
  });

  it('ends the merge on a fast-forward whose git never exits, without trying it again (AO-0172)', async () => {
    // Every ref update starts `sh` for the hook below, so `git worktree add` and `git checkout`
    // in the rebase stage take seconds under the full suite on Windows: only the fast-forward
    // gets the short timeout.
    const s = mergeSetup({ gitTimeoutMs: hangOnly('merge', '-q', '--ff-only') });
    const warns: string[] = [];
    s.sup.on('warn', (m: string) => warns.push(m));
    const beat = join(s.state, 'beat.txt').split(sep).join('/');
    // Hangs while git updates main: the fast-forward in the checkout, not the rebase.
    writeFileSync(
      join(s.repo, '.git', 'hooks', 'reference-transaction'),
      [
        '#!/bin/sh',
        '[ "$1" = prepared ] || exit 0',
        "grep -q 'refs/heads/main' || exit 0",
        `while [ ! -f "$MERGE_GO" ]; do printf x >> '${beat}'; sleep 0.1; done`,
        'exit 1',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const before = git(s.repo, 'rev-parse', 'main');
    s.approve(s.branch('two\n'));
    await s.merged();

    expect(s.sup.merge).toBeNull();
    expect(readFileSync(join(s.repo, '.git', 'refs', 'heads', 'main'), 'utf8').trim()).toBe(before);
    // The merge ends on the timeout. Tried again, it ends on a refusal instead: the killed git
    // leaves main.lock, so later attempts fail fast. A wall-clock bound flaked under the full suite.
    const e = s.last();
    expect(e).toMatchObject({ type: 'comment', actor: MERGE_ACTOR, to: 'human:dawid' });
    expect(e.body).toMatch(
      /`git merge -q --ff-only [0-9a-f]+` in .+ timed out after 4 s; swarmupd stopped it \(stage: fast-forward\)/,
    );
    expect(warns.join('\n')).not.toMatch(/kept moving|did not move/);
    writeFileSync(join(s.state, 'go.txt'), 'go\n');
  });

  it('rebases again when the base moves during the checks, and checks again only for code', async () => {
    const s = mergeSetup();
    const count = () =>
      existsSync(join(s.state, 'checks.txt')) ? text(join(s.state, 'checks.txt')).length : 0;
    const commit = s.branch('slow\n');
    s.approve(commit);
    await s.sup.tick();
    await until(() => count() === 1, STAGE_MS);
    // A task store sync lands on main while the check runs: no code changed.
    const synced = s.onMain('.swarmup/sync-note.md', 'note\n');
    writeFileSync(join(s.state, 'go.txt'), 'go\n');
    await s.sup.mergeSettled();
    const tip = git(s.repo, 'rev-parse', 'main');
    expect(git(s.repo, 'rev-parse', `${tip}^`)).toBe(synced);
    expect(count()).toBe(1);
    expect(s.last()).toMatchObject({ type: 'merge', commit: tip });
  });

  it('records work already in the base without moving it', async () => {
    const s = mergeSetup();
    const commit = s.branch('two\n');
    git(s.repo, 'merge', '-q', '--ff-only', 'feature');
    const tip = git(s.repo, 'rev-parse', 'main');
    s.approve(commit);
    await s.merged();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(tip);
    expect(existsSync(join(s.state, 'checks.txt'))).toBe(false);
    expect(s.last()).toMatchObject({ type: 'merge', commit: tip });
    expect(s.last().body).toContain('is already in main; nothing to merge');
  });

  it('sends back a branch that changes task store files', async () => {
    const s = mergeSetup();
    const before = git(s.repo, 'rev-parse', 'main');
    const wt = join(temp(), 'wt');
    git(s.repo, 'worktree', 'add', '-q', '-b', 'feature', wt, 'main');
    writeFileSync(join(wt, 'code.txt'), 'two\n');
    writeFileSync(join(wt, '.swarmup', 'stray.md'), 'stray\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-qm', 'Change the code');
    s.approve(git(wt, 'rev-parse', 'HEAD'));
    await s.merged();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    expect(s.last()).toMatchObject({ type: 'verdict', verdict: 'changes', actor: MERGE_ACTOR });
    expect(s.last().body).toContain('changes task store files (.swarmup/stray.md)');
  });

  it('merges nothing approved before swarmupd first saw the merge setting', async () => {
    const s = mergeSetup();
    const before = git(s.repo, 'rev-parse', 'main');
    s.approve(s.branch('two\n'));
    rmSync(join(s.state, 'merge.json'));
    await s.merged();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    expect(s.last().type).toBe('verdict');
  });

  /**
   * Holds the first `MergeRepo` call to `method` until the returned `release` runs, so a test can
   * act while merge planning waits for git; `asked` resolves once planning asks. Counts the
   * calls to `branches` and `hasCommit`.
   */
  function gateGit(method: 'branches' | 'hasCommit') {
    const real = {
      branches: MergeRepo.prototype.branches,
      hasCommit: MergeRepo.prototype.hasCommit,
    };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let asked!: () => void;
    const askedP = new Promise<void>((r) => (asked = r));
    let first = true;
    const hold = async (): Promise<void> => {
      if (!first) return;
      first = false;
      asked();
      await gate;
    };
    const branches = vi.spyOn(MergeRepo.prototype, 'branches').mockImplementation(async function (
      this: MergeRepo,
    ) {
      if (method === 'branches') await hold();
      return real.branches.call(this);
    });
    const hasCommit = vi.spyOn(MergeRepo.prototype, 'hasCommit').mockImplementation(async function (
      this: MergeRepo,
      rev: string,
    ) {
      if (method === 'hasCommit') await hold();
      return real.hasCommit.call(this, rev);
    });
    const restore = (): void => {
      branches.mockRestore();
      hasCommit.mockRestore();
    };
    return { asked: askedP, release, hasCommit, restore };
  }

  it('merges nothing when the task is reopened while git answers the merge plan (AO-0169)', async () => {
    const s = mergeSetup();
    const before = git(s.repo, 'rev-parse', 'main');
    s.approve(s.branch('two\n'));
    const g = gateGit('branches');
    try {
      const tick = s.sup.tick();
      await g.asked;
      s.as('human:dawid').reopen('1', 'one more thing');
      g.release();
      await tick;
      await s.sup.mergeSettled();
    } finally {
      g.restore();
    }
    expect(s.sup.merge).toBeNull();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    const events = s.as('human:dawid').showEvents('1').events;
    expect(events.some((e) => e.actor === MERGE_ACTOR)).toBe(false);
    expect(s.last().type).toBe('reopen');
  });

  it.each([
    ['branches', 0],
    ['hasCommit', 1],
  ] as const)(
    'ends the merge plan at the git answer to %s when swarmupd stops meanwhile (AO-0169)',
    async (method, probes) => {
      const s = mergeSetup();
      const before = git(s.repo, 'rev-parse', 'main');
      const eng = s.as('fake:engineer');
      // Two earlier reviews name commits on branches the repo lacks, so planning asks git about
      // both commits; the approved review names no source.
      for (const [sha, branch] of [
        ['1111111', 'gone-one'],
        ['2222222', 'gone-two'],
      ]) {
        eng.start('1', 'plan');
        eng.review('1', `${sha} on branch ${branch}: changes the code`, 'human:dawid');
        s.as('human:dawid').verdict('1', 'changes', 'not yet');
      }
      eng.start('1', 'fix');
      eng.review('1', 'Ready; the tests pass.', 'human:dawid');
      s.as('human:dawid').verdict('1', 'approve', 'looks right');
      const g = gateGit(method);
      try {
        const tick = s.sup.tick();
        await g.asked;
        s.sup.stop({ killRuns: true });
        g.release();
        await tick;
        await s.sup.mergeSettled();
        // No rev-parse starts after the stop.
        expect(g.hasCommit).toHaveBeenCalledTimes(probes);
      } finally {
        g.restore();
      }
      expect(s.sup.merge).toBeNull();
      expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
      expect(s.last()).toMatchObject({ type: 'verdict', actor: 'human:dawid' });
    },
  );

  it('waits for a writing run in the checkout, lets runs start during the checks, and holds the checkout from the fast-forward (AO-0160)', async () => {
    const s = mergeSetup();
    // The check waits for go.txt; the build waits for build-go.txt, then builds.
    const commit = s.branch('slow hold\n');
    s.approve(commit);
    const before = git(s.repo, 'rev-parse', 'main');
    const runGo = join(s.state, 'run-go.txt');
    const run = s.sup.launch({ agent: 'fake:engineer', task: '2' });
    await s.merged();
    expect(s.sup.merge).toBeNull();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    expect(s.last().type).toBe('verdict');

    // Each run ends by itself: a killed run's process may outlive the kill on Windows, keeping
    // the scratch repo busy past the test.
    let end = ended(s.sup, run.id);
    writeFileSync(runGo, 'go\n');
    await end;
    rmSync(runGo);
    await s.sup.tick();
    await until(() => existsSync(join(s.state, 'checks.txt')), STAGE_MS);
    // The checks run in swarmupd's worktree and hold nothing: a writing run starts meanwhile.
    expect(s.sup.merge).toMatchObject({ base: 'main', holds: false });
    const during = s.sup.launch({ agent: 'fake:engineer', task: '2' });

    // The checks pass; the base does not move while that run is live.
    writeFileSync(join(s.state, 'go.txt'), 'go\n');
    await until(() => s.sup.merge?.holds === true);
    await new Promise((r) => setTimeout(r, 300));
    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    // A task store sync lands on main during the wait: the merge rebases onto it, checks once.
    const synced = s.onMain('.swarmup/sync-note.md', 'note\n');

    end = ended(s.sup, during.id);
    writeFileSync(runGo, 'go\n');
    await end;
    rmSync(runGo);
    await s.sup.tick();
    // The build waits for build-go.txt: the checkout is held until it is over.
    await until(() => existsSync(join(s.state, 'building.txt')), STAGE_MS);
    expect(git(s.repo, 'rev-parse', 'main^')).toBe(synced);
    expect(text(join(s.state, 'checks.txt'))).toHaveLength(1);
    expect(() => s.sup.launch({ agent: 'fake:engineer', task: '2' })).toThrow(
      /^swarmupd merges test\/T-0001 into main in /,
    );
    writeFileSync(join(s.state, 'build-go.txt'), 'go\n');
    await s.sup.mergeSettled();
    expect(s.sup.merge).toBeNull();
    expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('slow hold\n');
    expect(s.last()).toMatchObject({ type: 'merge', commit: git(s.repo, 'rev-parse', 'main') });
  });

  it('shows the merge under way with its step and command, marks the work it holds, and logs each step (AO-0161)', async () => {
    const s = mergeSetup();
    const lines: string[] = [];
    s.sup.on('merge', (m: string) => lines.push(m));
    expect(s.sup.mergeStatus()).toBeNull();
    // The check waits for go.txt; the build waits for build-go.txt.
    s.approve(s.branch('slow hold\n'));
    await s.sup.tick();
    await until(() => existsSync(join(s.state, 'checks.txt')), STAGE_MS);
    const checking = s.sup.mergeStatus()!;
    expect(checking).toMatchObject({
      task: 'test/T-0001',
      base: 'main',
      step: 'checks',
      holds: false,
      command: { text: 'node check.mjs', index: 0, count: 1 },
      timeout_minutes: 30,
    });
    expect(checking.what).toMatch(/^[0-9a-f]{7} on branch feature$/);
    expect(Date.parse(checking.command!.started_at)).toBeGreaterThanOrEqual(
      Date.parse(checking.started_at),
    );
    expect(lines).toEqual([
      expect.stringMatching(
        /^test\/T-0001: starts: [0-9a-f]{7} on branch feature into main, built in /,
      ),
      "test/T-0001: check 1/1 `node check.mjs` starts in swarmupd's worktree, timeout 30 min",
    ]);

    writeFileSync(join(s.state, 'go.txt'), 'go\n');
    await until(() => existsSync(join(s.state, 'building.txt')), STAGE_MS);
    expect(s.sup.mergeStatus()).toMatchObject({
      step: 'build',
      holds: true,
      command: { text: 'node build.mjs', index: 0, count: 1 },
    });
    // Work a waking agent would start in the held checkout waits for the merge, and says so.
    s.sup.config.agents['fake:engineer'] = { ...s.sup.config.agents['fake:engineer'], wake: true };
    const held = s.sup.waits().find((w) => w.task === 'test/T-0002');
    expect(held).toMatchObject({ merge: true });
    expect(held!.reason).toMatch(
      /^fake:engineer: swarmupd merges test\/T-0001 into main in .+; it holds the checkout until its build ends$/,
    );
    expect(lines.slice(2)).toEqual([
      expect.stringMatching(/^test\/T-0001: check 1\/1 `node check\.mjs` passed after \d+s$/),
      expect.stringMatching(/^test\/T-0001: holds .+ from new writing runs until the build ends$/),
      expect.stringMatching(/^test\/T-0001: moved main to [0-9a-f]{7}; builds it in /),
      expect.stringMatching(
        /^test\/T-0001: build 1\/1 `node build\.mjs` starts in .+, timeout 30 min$/,
      ),
    ]);

    writeFileSync(join(s.state, 'build-go.txt'), 'go\n');
    await s.sup.mergeSettled();
    expect(s.sup.mergeStatus()).toBeNull();
    expect(lines.slice(6)).toEqual([
      expect.stringMatching(/^test\/T-0001: build 1\/1 `node build\.mjs` passed after \d+s$/),
      expect.stringMatching(/^test\/T-0001: ends after \d+s$/),
    ]);
    expect(s.sup.waits().some((w) => w.merge)).toBe(false);
  });

  it('sends each change of the merge under way on the event stream, so open app windows read it again (AO-0161)', async () => {
    const s = mergeSetup();
    const api = await startApi(s.sup, { port: 0, token: 'merge-token', version: 't' });
    const merges: Array<MergeStatus | null> = [];
    let hello = false;
    const stream = await fetch(`http://127.0.0.1:${api.port}/api/events?token=merge-token`);
    const reader = stream.body!.getReader();
    const pump = (async () => {
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          if (event === 'hello') hello = true;
          if (event !== 'merge') continue;
          merges.push(JSON.parse(/^data: (.+)$/m.exec(frame)![1]!) as MergeStatus | null);
        }
      }
    })();
    try {
      await until(() => hello);
      // The check waits for go.txt; the build waits for build-go.txt.
      // `slow` and `hold` make them wait; without them both end at once, and on a fast machine
      // the stream had moved past each step before the test read it (AO-0240).
      s.approve(s.branch('slow hold stream\n'));
      await s.sup.tick();
      await until(() => merges.some((m) => m?.command?.text === 'node check.mjs'), STAGE_MS);
      expect(merges[0]).toMatchObject({ task: 'test/T-0001', base: 'main', step: 'rebase' });
      expect(merges.at(-1)).toMatchObject({ step: 'checks', holds: false });

      writeFileSync(join(s.state, 'go.txt'), 'go\n');
      await until(() => merges.some((m) => m?.command?.text === 'node build.mjs'), STAGE_MS);
      expect(merges.at(-1)).toMatchObject({ step: 'build', holds: true });

      writeFileSync(join(s.state, 'build-go.txt'), 'go\n');
      await s.sup.mergeSettled();
      await until(() => merges.at(-1) === null);
      // Every step the app shows arrived as it began.
      const steps = merges.filter((m) => m !== null).map((m) => m.step);
      expect(steps).toEqual(expect.arrayContaining(['rebase', 'checks', 'build']));
    } finally {
      await reader.cancel();
      await pump.catch(() => {});
      await api.close();
    }
  });

  it.runIf(precise)(
    'records the merge when swarmupd stops during the build, ends what the build started, and builds again after a restart',
    async () => {
      const s = mergeSetup();
      const commit = s.branch('hold\n');
      s.approve(commit);
      await s.sup.tick();
      await until(() => existsSync(join(s.state, 'building.txt')), STAGE_MS);
      const build = Number(text(join(s.state, 'building.txt')));
      const tip = git(s.repo, 'rev-parse', 'main');
      expect(text(join(s.repo, 'code.txt'))).toBe('hold\n');
      s.sup.stop();
      await s.sup.close();

      // The stop ended the detached build process too: nothing is left to race the next build.
      expect(alive(build)).toBe(false);
      expect(existsSync(join(s.state, 'merge-procs.json'))).toBe(false);
      // The base moved, so the merge is on record; the build is not done.
      expect(existsSync(join(s.repo, 'dist', 'built.txt'))).toBe(false);
      const e = s.last();
      expect(e).toMatchObject({ type: 'merge', actor: MERGE_ACTOR, commit: tip });
      expect(e.body).toContain('was stopped with swarmupd; the next swarmupd runs the build again');
      expect(s.as('human:dawid').view('1').status).toBe('done');

      writeFileSync(join(s.state, 'build-go.txt'), 'go\n');
      const next = s.opsd();
      await next.tick();
      await next.mergeSettled();
      expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('hold\n');
      expect(git(s.repo, 'rev-parse', 'main')).toBe(tip);
      expect(s.last()).toMatchObject({ type: 'comment', actor: MERGE_ACTOR });
      expect(s.last().body).toContain(
        'Built main with `node build.mjs` after the earlier build did not finish',
      );
      // One merge event, and the build is not run a third time.
      expect(
        s
          .as('human:dawid')
          .showEvents('1')
          .events.filter((x) => x.type === 'merge'),
      ).toHaveLength(1);
      const events = s.as('human:dawid').showEvents('1').events.length;
      await next.tick();
      await next.mergeSettled();
      expect(s.as('human:dawid').showEvents('1').events).toHaveLength(events);
    },
    45_000,
  );

  // On Windows the job object ends the build whatever the lister can do; see the next test.
  it.runIf(precise && !WIN)(
    'waits for a build no kill could end before it builds again',
    async () => {
      const s = mergeSetup({ procs: refusingLister });
      const warns: string[] = [];
      s.approve(s.branch('hold\n'));
      await s.sup.tick();
      await until(() => existsSync(join(s.state, 'building.txt')), STAGE_MS);
      const build = Number(text(join(s.state, 'building.txt')));
      s.sup.stop();
      await s.sup.close();

      // The detached build survived every kill; swarmupd keeps it on record.
      expect(alive(build)).toBe(true);
      const left = JSON.parse(text(join(s.state, 'merge-procs.json'))) as Array<{ pid: number }>;
      expect(left.map((p) => p.pid)).toContain(build);
      expect(s.last().body).toContain('the next swarmupd runs the build again');

      // The next swarmupd neither builds nor merges while it runs.
      const next = s.opsd();
      next.on('warn', (m: string) => warns.push(m));
      await next.tick();
      await next.mergeSettled();
      expect(next.merge).toBeNull();
      expect(existsSync(join(s.repo, 'dist'))).toBe(false);
      expect(warns.join('\n')).toContain('waiting for what an earlier merge left running');

      // Once it ends by itself, the next look clears it and the build runs.
      writeFileSync(join(s.state, 'build-go.txt'), 'go\n');
      const end = Date.now() + 15_000;
      while (s.last().type !== 'comment' && Date.now() < end) {
        await next.tick();
        await next.mergeSettled();
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(alive(build)).toBe(false);
      expect(JSON.parse(text(join(s.state, 'merge-procs.json')))).toEqual([]);
      expect(s.last()).toMatchObject({ type: 'comment', actor: MERGE_ACTOR });
      expect(s.last().body).toContain(
        'Built main with `node build.mjs` after the earlier build did not finish',
      );
    },
    45_000,
  );

  it.runIf(WIN)(
    'ends the whole build on a stop where listing and killing processes are refused, and waits for recorded leftovers',
    async () => {
      // The sandbox case: no process list, no kill by PID. Only the job object can end the build.
      let lister = blindLister();
      const s = mergeSetup({ procs: () => lister });
      s.approve(s.branch('hold\n'));
      await s.sup.tick();
      await until(() => existsSync(join(s.state, 'building.txt')), STAGE_MS);
      const build = Number(text(join(s.state, 'building.txt')));
      const start = Date.now();
      s.sup.stop();
      await s.sup.close();
      expect(Date.now() - start).toBeLessThan(10_000);
      expect(alive(build)).toBe(false);
      expect(existsSync(join(s.state, 'merge-procs.json'))).toBe(false);
      expect(s.last().body).toContain('the next swarmupd runs the build again');

      // A leftover on record, from a swarmupd before this one, holds the build until it is gone.
      const left = { pid: 999_999, start: Date.now() - 60_000, running: true };
      writeFileSync(
        join(s.state, 'merge-procs.json'),
        JSON.stringify([
          { ...left, ppid: 0, name: 'held', cmd: 'held', first_seen: '', last_seen: '' },
        ]),
      );
      writeFileSync(join(s.state, 'build-go.txt'), 'go\n');
      const warns: string[] = [];
      lister = blindLister(left);
      const next = s.opsd();
      next.on('warn', (m: string) => warns.push(m));
      await next.tick();
      await next.mergeSettled();
      expect(existsSync(join(s.repo, 'dist'))).toBe(false);
      expect(warns.join('\n')).toContain('waiting for what an earlier merge left running');

      left.running = false;
      const end = Date.now() + 15_000;
      while (s.last().type !== 'comment' && Date.now() < end) {
        await next.tick();
        await next.mergeSettled();
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(s.last()).toMatchObject({ type: 'comment', actor: MERGE_ACTOR });
      expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('hold\n');
    },
    45_000,
  );

  it.runIf(WIN)('runs each command in a job object that ends everything it started', async () => {
    const dir = temp();
    // tree.mjs starts a detached child, which starts one more; each writes its PID and waits.
    writeFileSync(
      join(dir, 'tree.mjs'),
      `
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
const depth = Number(process.argv[2] ?? 0);
writeFileSync('pid' + depth + '.txt', String(process.pid));
if (depth < 2) spawn(process.execPath, ['tree.mjs', String(depth + 1)], { detached: depth === 0, stdio: 'ignore' });
if (depth === 0 && process.argv[3] === 'exit') {
  while (!existsSync('pid2.txt')) await new Promise((r) => setTimeout(r, 50));
  process.exit(3);
}
setInterval(() => {}, 1000);
`,
    );
    const pids = (): number[] => [0, 1, 2].map((d) => Number(text(join(dir, `pid${d}.txt`))));
    const ready = (): boolean => [0, 1, 2].every((d) => existsSync(join(dir, `pid${d}.txt`)));

    // A stop ends the tree, detached child included.
    const runner = new CommandRunner(process.env, { killTree: () => {} });
    const stopped = runner.runAll(['node tree.mjs 0'], dir, 60_000);
    await until(ready);
    const first = pids();
    runner.stop();
    expect((await stopped)[0]).toMatchObject({ ok: false, why: 'stopped' });
    await until(() => first.every((p) => !alive(p)));

    // A command that exits by itself keeps its exit code and leaves nothing running.
    for (const d of [0, 1, 2]) rmSync(join(dir, `pid${d}.txt`));
    const [r] = await new CommandRunner(process.env).runAll(['node tree.mjs 0 exit'], dir, 60_000);
    expect(r).toMatchObject({ ok: false, why: 'exit 3' });
    await until(() => pids().every((p) => !alive(p)));
    await until(() => removed(dir));
  });

  it('ends a stopped command even when what it started outlives the stop', async () => {
    const dir = temp();
    const pid = join(dir, 'pid.txt');
    const go = join(dir, 'go.txt');
    // Holds the output open until go.txt exists.
    writeFileSync(
      join(dir, 'hold.mjs'),
      `
import { existsSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pid)}, String(process.pid));
while (!existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 50));
`,
    );
    // No job, no watch and no group kill: ending the shell may leave node running.
    const runner = new CommandRunner(process.env, { killTree: () => {}, job: false });
    const result = runner.runAll(['node hold.mjs'], dir, 60_000);
    await until(() => existsSync(pid) && text(pid) !== '');
    const start = Date.now();
    runner.stop();
    const [r] = await result;
    expect(r).toMatchObject({ ok: false, why: 'stopped' });
    expect(Date.now() - start).toBeLessThan(9_000);
    // The leftover ends by itself and lets go of the folder.
    writeFileSync(go, 'go\n');
    await until(() => removed(dir));
  });

  it('keeps secret-looking output out of the send-back and the log', async () => {
    const s = mergeSetup();
    s.approve(s.branch('leak\n'));
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'verdict', verdict: 'changes', actor: MERGE_ACTOR });
    expect(secretKind(e.body)).toBeNull();
    expect(e.body).toContain('[line removed: it looks like a GitHub token]');
    expect(e.body).toContain('after the token');
    const log = /Full output: (\S+)/.exec(e.body)?.[1];
    expect(log).toBeDefined();
    const kept = text(log!);
    expect(secretKind(kept)).toBeNull();
    expect(kept).toContain('after the token');
    // Nothing else swarmupd keeps holds it either.
    for (const f of readdirSync(join(s.state, 'merge', 'logs'))) {
      expect(secretKind(text(join(s.state, 'merge', 'logs', f)))).toBeNull();
    }
  });
});
