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
import { initRoot, PATCH_KEY_ARGS, patchKey, samePath, secretKind, Workspace } from '@swarmup/core';
import type { UserConfig } from '@swarmup/core';
import type {
  MergeGitTimeout,
  MergeStatus,
  OpsdSelf,
  ProcLister,
  RunRecord,
} from '../src/index.js';
import { Checkout } from '../src/checkout.js';
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
  pathGone,
  missingOptionalPackages,
  notLiveNotice,
  npmRegistry,
  withoutScriptEnv,
  opsdCodeChanges,
  opsdConfig,
  pickMergeSource,
  repairInstallCommand,
  reviewSources,
  staleWorktree,
  startApi,
  Supervisor,
  systemLister,
  uncommittedRun,
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
if (process.env.MERGE_ENV_OUT) {
  const names = ['SWARMUP_DAEMON_ENTRY', 'OPS_DAEMON_ENTRY', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR', 'MERGE_KEEP', 'npm_config_registry', 'npm_config_user_agent', 'npm_execpath', 'INIT_CWD'];
  writeFileSync(process.env.MERGE_ENV_OUT, JSON.stringify(names.filter((n) => process.env[n] !== undefined)));
}
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
 * waits for `build-go.txt` and fails. It fails when it says `broken`, and when it says `deps`
 * until `install.mjs` ran.
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
if (code.includes('broken')) { console.error('code says broken'); process.exit(1); }
if (code.includes('deps') && !existsSync(process.env.MERGE_INSTALLED)) {
  console.error("'tsc' is not recognized as an internal or external command");
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
    /** `swarmupd.merge.test.install`, or a function of the repo that returns it. */
    install?: string[] | ((repo: string) => string[]);
    /** More of swarmupd's own environment. */
    env?: Record<string, string>;
    /** The user config names the merge too, so a task blocked on approved work waits (AO-0228). */
    userMerge?: boolean;
    /** When swarmupd first saw the merge setting; default long ago. */
    since?: string;
    /** `swarmupd.merge` of other roots, by root name. */
    otherMerge?: Record<string, { base: string }>;
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
    ...opts.env,
  } as NodeJS.ProcessEnv;
  delete env.SWARMUP_AGENT;
  delete env.SWARMUP_ROOTS;
  const user = (
    opts.userMerge ? { opsd: { merge: { test: { base: 'main' } } } } : {}
  ) as UserConfig;
  const as = (actor: string, run?: string) => new Workspace({ cwd: repo, env, actor, user, run });
  as('human:dawid').newTask({ title: 'Change the code', owner: 'fake:engineer' });
  as('human:dawid').newTask({ title: 'Other work', owner: 'fake:engineer' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'start');
  // Every verdict in these tests comes after swarmupd first saw the merge setting.
  writeFileSync(
    join(state, 'merge.json'),
    JSON.stringify({ test: opts.since ?? '2000-01-01T00:00:00.000Z' }),
  );
  const config = opsdConfig({
    opsd: {
      sync: false,
      // The writing run holds the store checkout, as the merge hold tests need (AO-0168).
      task_worktrees: false,
      runtimes: { fake: { command: process.execPath, args: [runFile] } },
      merge: {
        ...opts.otherMerge,
        test: { base: 'main', checks: ['node check.mjs'], build: ['node build.mjs'] },
      },
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
      user,
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

  /** The worktree that has `branch` checked out. */
  const worktreeOf = (repo: string, branch: string): string => {
    const block = git(repo, 'worktree', 'list', '--porcelain')
      .split(/\r?\n\r?\n/)
      .find((b) => b.includes(`branch refs/heads/${branch}`))!;
    return /^worktree (.+)$/m.exec(block)![1]!.trim();
  };
  /** Task 1 approved, with the review naming `commit` and a run-end of its author before the verdict. */
  const approveAfterRun = (
    s: ReturnType<typeof mergeSetup>,
    commit: string,
    runEnd: string,
  ): void => {
    const eng = s.as('fake:engineer', 'R1');
    eng.start('1', 'plan');
    eng.review('1', `${commit.slice(0, 7)} on branch feature: changes the code`, 'human:dawid');
    eng.recordRun('1', 'run-end', { run: 'R1', exit: 0, reason: 'exit', minutes: 1 }, runEnd);
    s.as('human:dawid').verdict('1', 'approve', 'after swarmupd commits the staged files');
  };

  it('commits what a run could not commit in the worktree, then merges it (AO-0300)', async () => {
    const s = mergeSetup();
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    // As the AO-0287 run left it: a staged new file and a changed one on top of its commit.
    writeFileSync(join(wt, 'extra.txt'), 'staged\n');
    git(wt, 'add', 'extra.txt');
    writeFileSync(join(wt, 'code.txt'), 'two\nthree\n');
    approveAfterRun(
      s,
      commit,
      `cannot commit what it left in ${wt}: HEAD moved from 1111111 to ${commit.slice(0, 7)} during the run; the changes stay for a person`,
    );
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'merge', actor: MERGE_ACTOR, branch: 'fake/t-0001-r1-merge' });
    expect(e.body).toContain('2 file(s) run R1 left uncommitted');
    expect(text(join(s.repo, 'extra.txt'))).toBe('staged\n');
    expect(text(join(s.repo, 'code.txt'))).toBe('two\nthree\n');
    expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('two\nthree\n');
    // The commit holds the reviewed one, and the worktree is back on it with nothing left.
    expect(git(s.repo, 'rev-parse', 'main^')).toBe(commit);
    expect(git(wt, 'status', '--porcelain')).toBe('');
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(commit);
  });

  it('merges the commit of what a run left when the merge starts again after it (AO-0300)', async () => {
    let slept = 0;
    const s = mergeSetup({ now: () => Date.now() + slept });
    const commit = s.branch('nap\n');
    const wt = worktreeOf(s.repo, 'feature');
    writeFileSync(join(wt, 'extra.txt'), 'staged\n');
    git(wt, 'add', 'extra.txt');
    approveAfterRun(s, commit, `cannot commit what it left in ${wt}: HEAD moved during the run`);
    await s.sup.tick();
    await until(() => existsSync(join(s.state, 'napped.txt')), STAGE_MS);
    // The PC sleeps during the check: the merge ends with the worktree clean and starts again.
    slept = 60 * 60_000;
    writeFileSync(join(s.state, 'go.txt'), 'go\n');
    await s.sup.mergeSettled();
    expect(s.last()).toMatchObject({ type: 'verdict', verdict: 'approve' });
    expect(git(wt, 'status', '--porcelain')).toBe('');
    const left = git(s.repo, 'rev-parse', 'fake/t-0001-r1-merge');
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'merge', actor: MERGE_ACTOR, branch: 'fake/t-0001-r1-merge' });
    expect(e.body).toContain('what run R1 left uncommitted');
    expect(git(s.repo, 'rev-parse', 'main')).toBe(left);
    expect(git(s.repo, 'rev-parse', 'main^')).toBe(commit);
    expect(text(join(s.repo, 'extra.txt'))).toBe('staged\n');
  });

  it('sends the task back when its worktree has changes no run-end accounts for (AO-0300)', async () => {
    const s = mergeSetup();
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    writeFileSync(join(wt, 'stray.txt'), 'whose?\n');
    s.approve(commit);
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({
      type: 'verdict',
      verdict: 'changes',
      actor: MERGE_ACTOR,
      to: 'fake:engineer',
    });
    expect(e.body).toContain('1 uncommitted change(s) (`stray.txt`)');
    expect(e.body).toContain('no run-end');
    expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
    expect(text(join(wt, 'stray.txt'))).toBe('whose?\n');
    expect(git(s.repo, 'branch', '--list', 'fake/*')).toBe('');
  });

  /** Run R1 asks for review and ends with changes swarmupd could not commit; the review gets `changes`. */
  const olderUncommittedRun = (s: ReturnType<typeof mergeSetup>, commit: string, wt: string) => {
    const eng = s.as('fake:engineer', 'R1');
    eng.start('1', 'plan');
    eng.review('1', `${commit.slice(0, 7)} on branch feature: changes the code`, 'human:dawid');
    eng.recordRun(
      '1',
      'run-end',
      { run: 'R1', exit: 0, reason: 'exit', minutes: 1 },
      `cannot commit what it left in ${wt}: HEAD moved during the run`,
    );
    s.as('human:dawid').verdict('1', 'changes', 'not yet');
    return s.as('fake:engineer');
  };

  it('commits nothing for a later review when only an older run ended with changes uncommitted (AO-0300)', async () => {
    const s = mergeSetup();
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    const eng = olderUncommittedRun(s, commit, wt);
    // A later review, made outside that run: it does not cover the files now in the worktree.
    writeFileSync(join(wt, 'extra.txt'), 'staged\n');
    git(wt, 'add', 'extra.txt');
    eng.start('1', 'fix');
    eng.review('1', `${commit.slice(0, 7)} on branch feature: ready`, 'human:dawid');
    s.as('human:dawid').verdict('1', 'approve', 'looks right');
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({
      type: 'verdict',
      verdict: 'changes',
      actor: MERGE_ACTOR,
      to: 'fake:engineer',
    });
    expect(e.body).toContain('1 uncommitted change(s) (`extra.txt`)');
    expect(e.body).toContain('no run-end of the run that asked for this review');
    expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
    expect(git(wt, 'status', '--porcelain')).toBe('A  extra.txt');
    expect(git(s.repo, 'branch', '--list', 'fake/*')).toBe('');
  });

  it('leaves the leftover branch of an older run out of the merge of a later review (AO-0300)', async () => {
    const s = mergeSetup();
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    const eng = olderUncommittedRun(s, commit, wt);
    // What an earlier start of a merge would have committed for run R1, on the reviewed commit.
    git(wt, 'checkout', '-q', '-b', 'fake/t-0001-r1-merge');
    writeFileSync(join(wt, 'extra.txt'), 'stale\n');
    git(wt, 'add', 'extra.txt');
    git(wt, 'commit', '-qm', 'What run R1 left');
    git(wt, 'checkout', '-q', 'feature');
    eng.start('1', 'fix');
    eng.review('1', `${commit.slice(0, 7)} on branch feature: ready`, 'human:dawid');
    s.as('human:dawid').verdict('1', 'approve', 'looks right');
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'merge', actor: MERGE_ACTOR, branch: 'feature' });
    expect(git(s.repo, 'rev-parse', 'main')).toBe(commit);
    expect(existsSync(join(s.repo, 'extra.txt'))).toBe(false);
  });

  it('commits nothing for the review of run R2 when the run-end of run R1 comes after it (AO-0300)', async () => {
    const s = mergeSetup();
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    // Run R1 asks for review and gets `changes` before swarmupd records its end.
    const r1 = s.as('fake:engineer', 'R1');
    r1.recordRun('1', 'run-start', { run: 'R1' }, 'fake run');
    r1.start('1', 'plan');
    r1.review('1', `${commit.slice(0, 7)} on branch feature: changes the code`, 'human:dawid');
    s.as('human:dawid').verdict('1', 'changes', 'not yet');
    // Run R2 leaves a file of its own and asks for review; only then does the end of R1 arrive.
    const r2 = s.as('fake:engineer', 'R2');
    r2.recordRun('1', 'run-start', { run: 'R2' }, 'fake run');
    r2.start('1', 'fix');
    writeFileSync(join(wt, 'extra.txt'), 'not reviewed\n');
    git(wt, 'add', 'extra.txt');
    r2.review('1', `${commit.slice(0, 7)} on branch feature: ready`, 'human:dawid');
    r1.recordRun(
      '1',
      'run-end',
      { run: 'R1', exit: 0, reason: 'exit', minutes: 1 },
      `cannot commit what it left in ${wt}: HEAD moved during the run`,
    );
    r2.recordRun('1', 'run-end', { run: 'R2', exit: 0, reason: 'exit', minutes: 1 }, '');
    s.as('human:dawid').verdict('1', 'approve', 'looks right');
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({
      type: 'verdict',
      verdict: 'changes',
      actor: MERGE_ACTOR,
      to: 'fake:engineer',
    });
    expect(e.body).toContain('1 uncommitted change(s) (`extra.txt`)');
    expect(e.body).toContain('no run-end of the run that asked for this review');
    expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
    expect(git(wt, 'status', '--porcelain')).toBe('A  extra.txt');
    expect(git(s.repo, 'branch', '--list', 'fake/*')).toBe('');
  });

  it('leaves the leftover branch of run R1 out when its run-end comes after the review of run R2 (AO-0300)', async () => {
    const s = mergeSetup();
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    const r1 = s.as('fake:engineer', 'R1');
    r1.start('1', 'plan');
    r1.review('1', `${commit.slice(0, 7)} on branch feature: changes the code`, 'human:dawid');
    s.as('human:dawid').verdict('1', 'changes', 'not yet');
    // What an earlier start of a merge would have committed for run R1, on the reviewed commit.
    git(wt, 'checkout', '-q', '-b', 'fake/t-0001-r1-merge');
    writeFileSync(join(wt, 'extra.txt'), 'stale\n');
    git(wt, 'add', 'extra.txt');
    git(wt, 'commit', '-qm', 'What run R1 left');
    git(wt, 'checkout', '-q', 'feature');
    const r2 = s.as('fake:engineer', 'R2');
    r2.start('1', 'fix');
    r2.review('1', `${commit.slice(0, 7)} on branch feature: ready`, 'human:dawid');
    r1.recordRun(
      '1',
      'run-end',
      { run: 'R1', exit: 0, reason: 'exit', minutes: 1 },
      `cannot commit what it left in ${wt}: HEAD moved during the run`,
    );
    s.as('human:dawid').verdict('1', 'approve', 'looks right');
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'merge', actor: MERGE_ACTOR, branch: 'feature' });
    expect(git(s.repo, 'rev-parse', 'main')).toBe(commit);
    expect(existsSync(join(s.repo, 'extra.txt'))).toBe(false);
  });

  it('records the run that asks on the review event (AO-0300)', () => {
    const s = mergeSetup();
    const commit = s.branch('two\n');
    const r1 = s.as('fake:engineer', 'R1');
    r1.start('1', 'plan');
    r1.review('1', `${commit.slice(0, 7)} on branch feature: changes the code`, 'human:dawid');
    expect(s.last()).toMatchObject({ type: 'review', run: 'R1' });
    s.as('human:dawid').verdict('1', 'changes', 'not yet');
    const byHand = s.as('fake:engineer');
    byHand.start('1', 'fix');
    byHand.review('1', `${commit.slice(0, 7)} on branch feature: ready`, 'human:dawid');
    expect(s.last().type).toBe('review');
    expect(s.last().run).toBeUndefined();
  });

  it('takes a run-end for the approved review only from the run the review names (AO-0300)', () => {
    const ev = (type: string, actor: string, more: object = {}) =>
      ({ type, actor, ...more }) as unknown as Parameters<typeof uncommittedRun>[0][number];
    const end = (run: string, body = 'cannot commit what it left in /wt: HEAD moved') =>
      ev('run-end', 'a:eng', { run, body });
    const review = (run?: string) => ev('review', 'a:eng', run ? { run } : {});
    const start = (run: string) => ev('run-start', 'a:eng', { run });
    const approve = ev('verdict', 'h:d', { verdict: 'approve' });
    const got = { id: 'R1', agent: 'a:eng' };
    expect(uncommittedRun([review('R1'), end('R1'), approve])).toEqual(got);
    expect(uncommittedRun([start('R1'), review('R1'), end('R1'), approve])).toEqual(got);
    // The end of another run between the review and the verdict changes nothing.
    expect(uncommittedRun([review('R1'), end('R0', 'ok'), end('R1'), approve])).toEqual(got);
    // A review that names no run (made by hand, or an older event) ties to none.
    expect(uncommittedRun([review(), end('R1'), approve])).toBeNull();
    expect(uncommittedRun([start('R1'), review(), end('R1'), approve])).toBeNull();
    // The run-end comes before the review, or belongs to an earlier review.
    expect(uncommittedRun([end('R1'), review('R1'), approve])).toBeNull();
    expect(
      uncommittedRun([review('R1'), end('R1'), ev('verdict', 'h:d'), review('R2'), approve]),
    ).toBeNull();
    // The run that made the review ended with nothing left; an older one does not count.
    expect(uncommittedRun([end('R1'), review('R2'), end('R2', 'ok'), approve])).toBeNull();
    // Interleaved: the run-end of R1 arrives after the review of R2, before or after R2 ends.
    const twoRuns = [start('R1'), review('R1'), ev('verdict', 'h:d'), start('R2'), review('R2')];
    expect(uncommittedRun([...twoRuns, end('R1'), approve])).toBeNull();
    expect(uncommittedRun([...twoRuns, end('R1'), end('R2', 'ok'), approve])).toBeNull();
    expect(uncommittedRun([...twoRuns, end('R2', 'ok'), end('R1'), approve])).toBeNull();
    expect(uncommittedRun([...twoRuns, end('R1'), end('R2'), approve])).toEqual({
      id: 'R2',
      agent: 'a:eng',
    });
    // Two ends of the named run, or one by another actor, are not a record to act on.
    expect(uncommittedRun([review('R1'), end('R1'), end('R1'), approve])).toBeNull();
    const other = ev('run-end', 'b:eng', { run: 'R1', body: 'left changes uncommitted: x' });
    expect(uncommittedRun([review('R1'), other, approve])).toBeNull();
  });

  /** A branch `feature` checked out in the repo's own checkout, as a run without a task worktree leaves it. */
  const featureInRepo = (repo: string): string => {
    git(repo, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(repo, 'code.txt'), 'two\n');
    git(repo, 'commit', '-qam', 'Change the code');
    return git(repo, 'rev-parse', 'HEAD');
  };

  it("sends the task back when the repo's own checkout is on the reviewed branch with changes (AO-0300)", async () => {
    const s = mergeSetup();
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = featureInRepo(s.repo);
    writeFileSync(join(s.repo, 'stray.txt'), 'whose?\n');
    s.approve(commit);
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({
      type: 'verdict',
      verdict: 'changes',
      actor: MERGE_ACTOR,
      to: 'fake:engineer',
    });
    expect(e.body).toContain('1 uncommitted change(s) (`stray.txt`)');
    expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
    expect(text(join(s.repo, 'stray.txt'))).toBe('whose?\n');
  });

  it("looks at the repo's own checkout when another root's base has the reviewed branch's name (AO-0300)", async () => {
    // A second root merges into a branch named `feature` in a repo of its own. That name says
    // nothing about this repo, where `feature` is the reviewed branch.
    const s = mergeSetup({ otherMerge: { other: { base: 'feature' } } });
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = featureInRepo(s.repo);
    writeFileSync(join(s.repo, 'stray.txt'), 'whose?\n');
    s.approve(commit);
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({
      type: 'verdict',
      verdict: 'changes',
      actor: MERGE_ACTOR,
      to: 'fake:engineer',
    });
    expect(e.body).toContain('1 uncommitted change(s) (`stray.txt`)');
    expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
    expect(text(join(s.repo, 'stray.txt'))).toBe('whose?\n');
  });

  it("takes what a run could not commit in the repo's own checkout on the reviewed branch (AO-0300)", async () => {
    const s = mergeSetup();
    const commit = featureInRepo(s.repo);
    writeFileSync(join(s.repo, 'extra.txt'), 'staged\n');
    git(s.repo, 'add', 'extra.txt');
    approveAfterRun(
      s,
      commit,
      `cannot commit what it left in ${s.repo}: HEAD moved during the run`,
    );
    await s.merged();
    // The run's file is in a commit on top of the reviewed one, and the merge works with that.
    const left = git(s.repo, 'rev-parse', 'fake/t-0001-r1-merge');
    expect(git(s.repo, 'rev-parse', `${left}^`)).toBe(commit);
    expect(git(s.repo, 'show', `${left}:extra.txt`)).toBe('staged');
    expect(s.last()).toMatchObject({ type: 'merge', branch: 'fake/t-0001-r1-merge' });
    expect(git(s.repo, 'rev-parse', 'main')).toBe(left);
    expect(git(s.repo, 'status', '--porcelain', '--', 'extra.txt')).toBe('');
  });

  it('sends the task back when the worktree with the changes is not on the commit to merge (AO-0300)', async () => {
    const s = mergeSetup();
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    writeFileSync(join(wt, 'code.txt'), 'two\nthree\n');
    git(wt, 'commit', '-qam', 'One more line');
    writeFileSync(join(wt, 'code.txt'), 'two\nthree\nfour\n');
    approveAfterRun(s, commit, 'left changes uncommitted: 1 process(es) of the run still alive');
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'verdict', verdict: 'changes', actor: MERGE_ACTOR });
    expect(e.body).toContain('not on the commit to merge');
    expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
    expect(text(join(wt, 'code.txt'))).toBe('two\nthree\nfour\n');
  });

  it('merges nothing when a file changes while swarmupd commits what the run left (AO-0300)', async () => {
    const s = mergeSetup();
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    writeFileSync(join(wt, 'extra.txt'), 'staged\n');
    git(wt, 'add', 'extra.txt');
    writeFileSync(join(wt, 'code.txt'), 'two\nthree\n');
    approveAfterRun(s, commit, `cannot commit what it left in ${wt}: HEAD moved during the run`);
    // `code.txt` changes between the commit and the look that follows it (the `check` index).
    type Stage = (index: string, head: string, excludes: string[]) => Generator;
    const proto = Checkout.prototype as unknown as { stage: Stage };
    const real = proto.stage;
    const stage = vi.spyOn(proto, 'stage').mockImplementation(function (this: Checkout, ...a) {
      if (a[0].endsWith('check')) writeFileSync(join(wt, 'code.txt'), 'two\nthree\nfour\n');
      return real.apply(this, a);
    });
    try {
      await s.merged();
    } finally {
      stage.mockRestore();
    }
    const e = s.last();
    expect(e).toMatchObject({
      type: 'verdict',
      verdict: 'changes',
      actor: MERGE_ACTOR,
      to: 'fake:engineer',
    });
    expect(e.body).toContain('1 file(s) there changed again');
    expect(e.body).toContain('`code.txt`');
    expect(e.body).toContain('on branch `fake/t-0001-r1-merge`');
    // The commit holds the older `code.txt`: the base stays, and the newer content stays in the file.
    expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
    expect(git(s.repo, 'show', 'fake/t-0001-r1-merge:code.txt')).toBe('two\nthree');
    expect(text(join(wt, 'code.txt'))).toBe('two\nthree\nfour\n');
    expect(git(s.repo, 'show', 'fake/t-0001-r1-merge:extra.txt')).toBe('staged');
  });

  it('merges nothing when the worktree stays changed with nothing in it to commit (AO-0300)', async () => {
    const s = mergeSetup();
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    // A staged version of `code.txt`, and the file changed back: the files equal the commit, so
    // the commit of what the run left has nothing to hold, and git still reports the change.
    writeFileSync(join(wt, 'code.txt'), 'two\nthree\n');
    git(wt, 'add', 'code.txt');
    writeFileSync(join(wt, 'code.txt'), 'two\n');
    approveAfterRun(s, commit, `cannot commit what it left in ${wt}: HEAD moved during the run`);
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({
      type: 'verdict',
      verdict: 'changes',
      actor: MERGE_ACTOR,
      to: 'fake:engineer',
    });
    expect(e.body).toContain('1 uncommitted change(s) (`code.txt`)');
    expect(e.body).toContain('found nothing in them to commit');
    // The base stays, no branch is made, and the staged version stays in the index.
    expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
    expect(git(s.repo, 'branch', '--list', 'fake/*')).toBe('');
    expect(git(wt, 'show', ':code.txt')).toBe('two\nthree');
  });

  it('merges nothing when the worktree is still changed after the commit of what the run left (AO-0300)', async () => {
    const s = mergeSetup();
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    writeFileSync(join(wt, 'extra.txt'), 'staged\n');
    git(wt, 'add', 'extra.txt');
    approveAfterRun(s, commit, `cannot commit what it left in ${wt}: HEAD moved during the run`);
    // A file appears after the commit and its restore, before the worktree is read again.
    const real = Checkout.prototype.commitLeftovers;
    const spy = vi.spyOn(Checkout.prototype, 'commitLeftovers').mockImplementation(async function (
      this: Checkout,
      ...a
    ) {
      const c = await real.apply(this, a);
      writeFileSync(join(wt, 'late.txt'), 'late\n');
      return c;
    });
    try {
      await s.merged();
    } finally {
      spy.mockRestore();
    }
    const e = s.last();
    expect(e).toMatchObject({ type: 'verdict', verdict: 'changes', actor: MERGE_ACTOR });
    expect(e.body).toContain('1 file(s) there still show as changed after the commit (`late.txt`)');
    expect(e.body).toContain('on branch `fake/t-0001-r1-merge`');
    expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
    expect(text(join(wt, 'late.txt'))).toBe('late\n');
  });

  /** Makes git fail in the worktree `wt` (a broken index); the returned function repairs it. */
  const breakIndex = (wt: string): (() => void) => {
    const index = join(git(wt, 'rev-parse', '--absolute-git-dir'), 'index');
    const good = readFileSync(index);
    writeFileSync(index, 'not an index\n');
    return () => writeFileSync(index, good);
  };

  it('merges nothing while git cannot read the task worktree, then what the run left (AO-0300)', async () => {
    const s = mergeSetup();
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    writeFileSync(join(wt, 'extra.txt'), 'staged\n');
    git(wt, 'add', 'extra.txt');
    approveAfterRun(s, commit, `cannot commit what it left in ${wt}: HEAD moved during the run`);
    const warns: string[] = [];
    s.sup.on('warn', (m: string) => warns.push(m));
    const repair = breakIndex(wt);
    await s.merged();
    // The reviewed commit lacks `extra.txt`: with the worktree unread, the base stays.
    expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
    expect(s.last()).toMatchObject({ type: 'verdict', verdict: 'approve' });
    expect(warns.join('\n')).toContain('cannot read the worktree');
    repair();
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'merge', branch: 'fake/t-0001-r1-merge' });
    expect(git(s.repo, 'rev-parse', 'main^')).toBe(commit);
    expect(text(join(s.repo, 'extra.txt'))).toBe('staged\n');
  });

  it('tells the human and merges nothing when the task worktree stays unreadable (AO-0300)', async () => {
    const s = mergeSetup();
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = s.branch('two\n');
    const repair = breakIndex(worktreeOf(s.repo, 'feature'));
    s.approve(commit);
    await s.merged();
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'verdict', verdict: 'approve' });
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'comment', actor: MERGE_ACTOR, to: 'human:dawid' });
    expect(e.body).toContain('cannot read the worktree');
    expect(e.body).toContain('Nothing is merged');
    // Told once: the merge does not start again until the task changes.
    repair();
    await s.merged();
    expect(s.last().id).toBe(e.id);
    expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
  });

  it('merges nothing while git cannot list the worktrees (AO-0300)', async () => {
    const s = mergeSetup();
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = s.branch('two\n');
    writeFileSync(join(worktreeOf(s.repo, 'feature'), 'stray.txt'), 'whose?\n');
    s.approve(commit);
    const list = vi
      .spyOn(MergeRepo.prototype, 'worktreeList')
      .mockRejectedValueOnce(new Error('fatal: cannot list'));
    try {
      await s.merged();
      expect(list).toHaveBeenCalledTimes(1);
      expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
      expect(s.last()).toMatchObject({ type: 'verdict', verdict: 'approve' });
      // The next look reads the list and finds the changes.
      await s.merged();
      expect(s.last()).toMatchObject({ type: 'verdict', verdict: 'changes', actor: MERGE_ACTOR });
      expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
    } finally {
      list.mockRestore();
    }
  });

  it('merges nothing while the folder of the task worktree cannot be looked at (AO-0300)', async () => {
    const s = mergeSetup();
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    writeFileSync(join(wt, 'extra.txt'), 'staged\n');
    git(wt, 'add', 'extra.txt');
    approveAfterRun(s, commit, `cannot commit what it left in ${wt}: HEAD moved during the run`);
    const warns: string[] = [];
    s.sup.on('warn', (m: string) => warns.push(m));
    // What `statSync` throws for a folder on a drive that does not answer: not `ENOENT`.
    const denied = Object.assign(new Error(`EACCES: permission denied, stat '${wt}'`), {
      code: 'EACCES',
    });
    const gone = vi.spyOn(MergeRepo.prototype, 'worktreeGone').mockImplementationOnce(() => {
      throw denied;
    });
    try {
      await s.merged();
      expect(gone).toHaveBeenCalledTimes(1);
      expect(samePath(gone.mock.calls[0]![0], wt)).toBe(true);
      // The reviewed commit lacks `extra.txt`: with the folder unseen, the base stays.
      expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
      expect(s.last()).toMatchObject({ type: 'verdict', verdict: 'approve' });
      expect(warns.join('\n')).toContain('cannot read the worktree');
      await s.merged();
      expect(s.last()).toMatchObject({ type: 'merge', branch: 'fake/t-0001-r1-merge' });
      expect(git(s.repo, 'rev-parse', 'main^')).toBe(commit);
      expect(text(join(s.repo, 'extra.txt'))).toBe('staged\n');
    } finally {
      gone.mockRestore();
    }
  });

  it('merges the reviewed commit when the folder of the task worktree is deleted (AO-0300)', async () => {
    const s = mergeSetup();
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    // Git still lists the worktree (prunable); nothing is left in it to miss.
    rmSync(wt, { recursive: true, force: true });
    s.approve(commit);
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'merge' });
    expect(git(s.repo, 'rev-parse', 'main')).toBe(commit);
  });

  it('pathGone says gone only for a path the file system reports missing (AO-0300)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gone-'));
    try {
      expect(pathGone(dir)).toBe(false);
      expect(pathGone(join(dir, 'none'))).toBe(true);
      writeFileSync(join(dir, 'file'), '');
      expect(pathGone(join(dir, 'file', 'under'))).toBe(true);
      for (const code of ['EACCES', 'EPERM', 'EBUSY', 'EIO']) {
        const err = Object.assign(new Error(code), { code });
        expect(() =>
          pathGone(dir, () => {
            throw err;
          }),
        ).toThrow(err);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges nothing while git cannot read the branch of an earlier start of the merge (AO-0300)', async () => {
    const s = mergeSetup();
    const start = git(s.repo, 'rev-parse', 'main');
    const commit = s.branch('two\n');
    const wt = worktreeOf(s.repo, 'feature');
    // As an earlier start of the merge left it: the changes committed on their branch, the
    // worktree clean on the reviewed commit.
    writeFileSync(join(wt, 'extra.txt'), 'staged\n');
    git(wt, 'add', 'extra.txt');
    git(wt, 'commit', '-qm', 'What the run left');
    const left = git(wt, 'rev-parse', 'HEAD');
    git(wt, 'branch', 'fake/t-0001-r1-merge');
    git(wt, 'reset', '-q', '--hard', commit);
    approveAfterRun(s, commit, `cannot commit what it left in ${wt}: HEAD moved during the run`);
    const tip = vi
      .spyOn(MergeRepo.prototype, 'branchOn')
      .mockRejectedValueOnce(new Error('fatal: cannot read refs'));
    try {
      await s.merged();
      expect(tip).toHaveBeenCalledTimes(1);
      expect(git(s.repo, 'rev-parse', 'main')).toBe(start);
      await s.merged();
      expect(git(s.repo, 'rev-parse', 'main')).toBe(left);
    } finally {
      tip.mockRestore();
    }
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

  it('makes its worktree again when it is left from another repo (AO-0273)', async () => {
    const s = mergeSetup();
    // swarmupd's worktree as an earlier merge left it, when the code checkout was another repo.
    const old = temp();
    git(old, 'init', '-q', '-b', 'main');
    git(old, 'commit', '-q', '--allow-empty', '-m', 'start');
    const wt = join(s.state, 'merge', 'test');
    mkdirSync(dirname(wt), { recursive: true });
    git(old, 'worktree', 'add', '-q', '--detach', wt);
    writeFileSync(join(wt, 'left.txt'), 'from an earlier merge\n');
    const commit = s.branch('two\n');
    s.approve(commit);
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'merge', actor: MERGE_ACTOR, branch: 'feature' });
    expect(git(s.repo, 'rev-parse', 'main')).toBe(commit);
    // The folder is a worktree of the checkout now, and the old repo lists it no more.
    const listed = (repo: string): string[] =>
      git(repo, 'worktree', 'list', '--porcelain')
        .split(/\r?\n/)
        .filter((l) => l.startsWith('worktree '))
        .map((l) => l.slice('worktree '.length).trim());
    expect(listed(s.repo).some((p) => samePath(p, wt))).toBe(true);
    expect(listed(old)).toHaveLength(1);
    const entries = join(old, '.git', 'worktrees');
    expect(existsSync(entries) ? readdirSync(entries) : []).toEqual([]);
    expect(existsSync(join(wt, 'left.txt'))).toBe(false);
  });

  it('leaves a folder inside another checkout alone and names its repo (AO-0273)', async () => {
    const s = mergeSetup();
    const other = temp();
    git(other, 'init', '-q', '-b', 'main');
    git(other, 'commit', '-q', '--allow-empty', '-m', 'start');
    const inside = join(other, 'merge');
    mkdirSync(inside);
    writeFileSync(join(inside, 'notes.txt'), 'someone else\n');
    const repo = new MergeRepo(s.repo, inside, [], { ...process.env, ...ID });
    await expect(repo.ensureWorktree(git(s.repo, 'rev-parse', 'main'))).rejects.toThrow(
      /belongs to the repo at .* remove it/,
    );
    expect(text(join(inside, 'notes.txt'))).toBe('someone else\n');
  });

  it('makes its worktree again when its old repo was deleted (AO-0275)', async () => {
    const s = mergeSetup();
    const old = temp();
    git(old, 'init', '-q', '-b', 'main');
    git(old, 'commit', '-q', '--allow-empty', '-m', 'start');
    const wt = join(s.state, 'merge', 'test');
    mkdirSync(dirname(wt), { recursive: true });
    git(old, 'worktree', 'add', '-q', '--detach', wt);
    writeFileSync(join(wt, 'left.txt'), 'from an earlier merge\n');
    rmSync(old, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    const commit = s.branch('two\n');
    s.approve(commit);
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'merge', actor: MERGE_ACTOR, branch: 'feature' });
    expect(git(s.repo, 'rev-parse', 'main')).toBe(commit);
    expect(
      samePath(
        git(wt, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
        join(s.repo, '.git'),
      ),
    ).toBe(true);
    expect(existsSync(join(wt, 'left.txt'))).toBe(false);
  });

  it('keeps a folder whose .git names no missing worktree entry (AO-0275)', async () => {
    const s = mergeSetup();
    const at = git(s.repo, 'rev-parse', 'main');
    const cases: [string, (dir: string) => void][] = [
      ['no .git', () => undefined],
      ['a .git folder', (dir) => mkdirSync(join(dir, '.git'))],
      ['other text', (dir) => writeFileSync(join(dir, '.git'), 'notes\n')],
      // A submodule of a checkout that is gone: not a worktree swarmupd made.
      [
        'a submodule',
        (dir) =>
          writeFileSync(join(dir, '.git'), `gitdir: ${join(temp(), 'gone', 'modules', 'x')}\n`),
      ],
    ];
    for (const [name, make] of cases) {
      const dir = join(temp(), 'merge');
      mkdirSync(dir);
      make(dir);
      writeFileSync(join(dir, 'notes.txt'), 'someone else\n');
      expect(staleWorktree(dir), name).toBe(false);
      const repo = new MergeRepo(s.repo, dir, [], { ...process.env, ...ID });
      await expect(repo.ensureWorktree(at), name).rejects.toThrow(/is no git worktree; remove it/);
      expect(text(join(dir, 'notes.txt')), name).toBe('someone else\n');
    }
  });

  it('keeps a task blocked on approved work until the merge is recorded (AO-0228)', async () => {
    const s = mergeSetup({ userMerge: true });
    const commit = s.branch('slow\n');
    const eng = s.as('fake:engineer');
    eng.start('2', 'plan');
    eng.block('2', 'needs the change of T-0001', { on: ['T-0001'] });
    s.approve(commit);
    const waiter = () => s.as('human:dawid').view('2');
    expect(waiter()).toMatchObject({ unblocked: false, mergeWait: ['T-0001'] });
    // The merge is under way: its check waits for go.txt, and the base has not moved.
    await s.sup.tick();
    expect(s.sup.merge?.ref).toBe('test/T-0001');
    expect(waiter().unblocked).toBe(false);
    expect(s.as('fake:engineer').next()).toBeUndefined();
    writeFileSync(join(s.state, 'go.txt'), '');
    await s.sup.mergeSettled();
    expect(s.last()).toMatchObject({ type: 'merge', actor: MERGE_ACTOR });
    expect(text(join(s.repo, 'code.txt'))).toBe('slow\n');
    expect(waiter().unblocked).toBe(true);
  });

  it('frees a task blocked on approved work that has nothing to merge (AO-0228)', async () => {
    const s = mergeSetup({ userMerge: true });
    const eng = s.as('fake:engineer');
    eng.start('2', 'plan');
    eng.block('2', 'needs T-0001', { on: ['T-0001'] });
    eng.start('1', 'plan');
    // Prose that names no branch the repo has.
    eng.review('1', 'This branch is ready and the tests pass.', 'human:dawid');
    s.as('human:dawid').verdict('1', 'approve', 'looks right');
    const waiter = () => s.as('human:dawid').view('2');
    expect(waiter()).toMatchObject({ unblocked: false, mergeWait: ['T-0001'] });
    // The first tick finds nothing to merge; the next one notes it.
    await s.merged();
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'comment', actor: MERGE_ACTOR, no_merge: true });
    expect(e.body).toContain('swarmupd merges nothing for T-0001: no review request names');
    expect(waiter().unblocked).toBe(true);
    // Once only.
    await s.merged();
    await s.merged();
    expect(s.last().id).toBe(e.id);
  });

  it('keeps a task blocked on approved work whose merge failed (AO-0228)', async () => {
    const s = mergeSetup({ userMerge: true });
    const eng = s.as('fake:engineer');
    eng.start('2', 'plan');
    eng.block('2', 'needs T-0001', { on: ['T-0001'] });
    // The review names a commit and a branch the repo lacks, so the merge fails.
    s.approve('0123abc');
    const waiter = () => s.as('human:dawid').view('2');
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'comment', actor: MERGE_ACTOR, to: 'human:dawid' });
    expect(e).not.toHaveProperty('no_merge');
    expect(e.body).toContain('swarmupd cannot merge 0123abc on branch feature');
    expect(s.as('human:dawid').view('1')).toMatchObject({ status: 'done', awaitsMerge: true });
    expect(waiter()).toMatchObject({ status: 'blocked', unblocked: false, mergeWait: ['T-0001'] });
    expect(s.as('fake:engineer').next()).toBeUndefined();
    // Later ticks add no note that would free it.
    await s.merged();
    await s.merged();
    expect(s.last().id).toBe(e.id);
    expect(waiter().unblocked).toBe(false);
  });

  it('keeps the worktree of approved work whose merge failed (AO-0228)', async () => {
    let now = Date.now();
    const s = mergeSetup({ userMerge: true, now: () => now });
    const wt = join(s.repo, 'out', 'wt-T-0001');
    git(s.repo, 'worktree', 'add', '-q', '-b', 'fake/t-0001', wt, 'main');
    // The review names a commit the repo lacks, so the merge fails with a note.
    s.approve('0123abc');
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'comment', actor: MERGE_ACTOR });
    expect(e.body).toContain('swarmupd cannot merge 0123abc on branch feature');
    // Closed for longer than `reclaim_after_minutes`, but its work is still not in the base.
    now += 61 * 60_000;
    await s.sup.housekeep();
    expect(existsSync(wt)).toBe(true);
    expect(s.last().id).toBe(e.id);
    // A note that nothing is left to merge settles it, and the worktree goes.
    s.as(MERGE_ACTOR).noMerge('1', 'swarmupd merges nothing for T-0001.');
    now += 61 * 60_000;
    await s.sup.housekeep();
    expect(existsSync(wt)).toBe(false);
  });

  it('keeps a task blocked on approved work that the repo lacks, and tells the human (AO-0228)', async () => {
    const s = mergeSetup({ userMerge: true });
    const eng = s.as('fake:engineer');
    eng.start('2', 'plan');
    eng.block('2', 'needs T-0001', { on: ['T-0001'] });
    eng.start('1', 'plan');
    eng.review('1', '0123abc on branch gone: the change', 'human:dawid');
    s.as('human:dawid').verdict('1', 'changes', 'one more test');
    eng.start('1', 'plan');
    // The newest review names nothing; the earlier one names work the repo does not have.
    eng.review('1', 'Added the test.', 'human:dawid');
    s.as('human:dawid').verdict('1', 'approve', 'looks right');
    const waiter = () => s.as('human:dawid').view('2');
    await s.merged();
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'comment', actor: MERGE_ACTOR, to: 'human:dawid' });
    expect(e).not.toHaveProperty('no_merge');
    expect(e.body).toContain('swarmupd cannot merge T-0001');
    expect(e.body).toContain('stay blocked');
    expect(waiter()).toMatchObject({ status: 'blocked', unblocked: false, mergeWait: ['T-0001'] });
    // Once only.
    await s.merged();
    await s.merged();
    expect(s.last().id).toBe(e.id);
    expect(waiter().unblocked).toBe(false);
  });

  it('frees a task blocked on work approved before the merge setting (AO-0228)', async () => {
    const s = mergeSetup({ userMerge: true, since: '2999-01-01T00:00:00.000Z' });
    const commit = s.branch('two\n');
    const eng = s.as('fake:engineer');
    eng.start('2', 'plan');
    eng.block('2', 'needs T-0001', { on: ['T-0001'] });
    s.approve(commit);
    expect(s.as('human:dawid').view('2').unblocked).toBe(false);
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'comment', actor: MERGE_ACTOR });
    expect(e.body).toContain('it was approved before swarmupd merged approved work of test');
    expect(s.as('human:dawid').view('2').unblocked).toBe(true);
    expect(text(join(s.repo, 'code.txt'))).toBe('one\n');
  });

  it('frees a task blocked on work approved before the merge setting and commented on after it (AO-0228)', async () => {
    const s = mergeSetup({ userMerge: true });
    const commit = s.branch('two\n');
    const eng = s.as('fake:engineer');
    eng.start('2', 'plan');
    eng.block('2', 'needs T-0001', { on: ['T-0001'] });
    s.approve(commit);
    // swarmupd first sees the merge setting after the approval, and a comment comes later still.
    const since = new Date(Date.parse(s.last().at) + 1).toISOString();
    while (new Date().toISOString() <= since) await new Promise((r) => setTimeout(r, 2));
    writeFileSync(join(s.state, 'merge.json'), JSON.stringify({ test: since }));
    s.as('human:dawid').comment('1', 'Thanks, this reads well.');
    expect(s.last().at > since).toBe(true);
    expect(s.as('human:dawid').view('2').unblocked).toBe(false);
    // The first tick finds nothing to merge; no later one may take the named work for missing.
    await s.merged();
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'comment', actor: MERGE_ACTOR, no_merge: true });
    expect(e.body).toContain('it was approved before swarmupd merged approved work of test');
    expect(s.as('human:dawid').view('2').unblocked).toBe(true);
    expect(text(join(s.repo, 'code.txt'))).toBe('one\n');
    // Once only.
    await s.merged();
    await s.merged();
    expect(s.last().id).toBe(e.id);
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

  it("runs the checks without the installed app's swarmupd entry and Electron host flags (AO-0235)", async () => {
    const out = join(temp(), 'env.json');
    // What swarmupd has in its environment when the installed desktop app hosts it.
    const s = mergeSetup({
      env: {
        SWARMUP_DAEMON_ENTRY: 'C:/app/swarmupd.mjs',
        OPS_DAEMON_ENTRY: 'C:/app/opsd.mjs',
        ELECTRON_RUN_AS_NODE: '1',
        ELECTRON_NO_ASAR: '1',
        MERGE_KEEP: 'yes',
        MERGE_ENV_OUT: out,
        // And when `pnpm swarmup` started it (AO-0307).
        npm_config_registry: 'https://registry.npmjs.org/',
        npm_config_user_agent: 'pnpm/9.15.4 npm/? node/v22.0.0 win32 x64',
        npm_execpath: 'C:/pnpm/bin/pnpm.cjs',
        INIT_CWD: 'C:/engine',
      },
    });
    s.approve(s.branch('two\n'));
    await s.merged();
    expect(s.as('human:dawid').view('1').status).toBe('done');
    // A check that starts swarmupd, as this repo's tests do, starts its own checkout's build.
    expect(JSON.parse(text(out))).toEqual(['MERGE_KEEP']);
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

  it('installs in the checkout and builds once more when the build fails there (AO-0232)', async () => {
    const s = mergeSetup({ install: ['node install.mjs'] });
    // No lockfile change, so no install before the build; the build misses its dependencies.
    const commit = s.branch('deps\n');
    s.approve(commit);
    await s.merged();
    expect(s.as('human:dawid').view('1').status).toBe('done');
    expect(text(join(s.state, 'installed.txt'))).toBe('deps\n');
    expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('deps\n');
    expect(s.last().type).toBe('merge');
    expect(s.last().body).toContain(
      'Built with `node install.mjs`, `node build.mjs`, after `node build.mjs` failed (exit 1) before the install.',
    );
  });

  it('tells the human, not the author, when the install in the checkout fails (AO-0232)', async () => {
    const s = mergeSetup({ install: ['node fail.mjs'] });
    const fail = "console.error('EBUSY: resource busy or locked'); process.exit(3);\n";
    const commit = s.branch('deps\n', { 'fail.mjs': fail });
    s.approve(commit);
    await s.merged();
    // The merge landed and its code passed the checks: the task stays closed.
    expect(s.as('human:dawid').view('1').status).toBe('done');
    const events = s.as('human:dawid').showEvents('1').events;
    expect(events.filter((e) => e.type === 'verdict')).toHaveLength(1);
    expect(events.at(-2)!.body).toContain('Build: `node fail.mjs` failed (exit 3).');
    const e = s.last();
    expect(e.type).toBe('comment');
    expect(e.to).toBe('human:dawid');
    expect(e.body).toMatch(
      /^\S*T-0001: swarmupd merged .* into `main` as [0-9a-f]{7}, but could not install the dependencies in /,
    );
    expect(e.body).toContain('`node fail.mjs` failed (exit 3)');
    expect(e.body).toContain('EBUSY: resource busy or locked');
    expect(e.body).toContain('Action: once no other install runs in');
  });

  it('sends the task back when the build still fails after the install (AO-0232)', async () => {
    const s = mergeSetup({ install: ['node install.mjs'] });
    const commit = s.branch('broken\n');
    s.approve(commit);
    await s.merged();
    expect(text(join(s.state, 'installed.txt'))).toBe('broken\n');
    const e = s.last();
    expect(e.type).toBe('verdict');
    expect(e.verdict).toBe('changes');
    expect(e.body).toContain(
      ', also after swarmupd installed the dependencies there; fix it in a new commit',
    );
    expect(e.body).toContain('code says broken');
  });

  it('builds once when the checkout has nothing to install (AO-0232)', async () => {
    const s = mergeSetup();
    const commit = s.branch('broken\n');
    s.approve(commit);
    await s.merged();
    const e = s.last();
    expect(e.verdict).toBe('changes');
    expect(e.body).toContain('`node build.mjs` failed (exit 1) in ');
    expect(e.body).not.toContain('also after swarmupd installed');
  });

  it('sends the task back when the build fails after a default install with nothing left out (AO-0229)', async () => {
    const s = mergeSetup();
    // The default install runs npm; with no packages it is quick and needs no network. Its
    // second step has nothing to install and leaves no result, so the failed build is the
    // second result of three entries: still a build step, not an install.
    const commit = s.branch('broken\n', {
      'package.json': '{"name":"t","version":"1.0.0","private":true}\n',
      'package-lock.json':
        '{"name":"t","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"t","version":"1.0.0"}}}\n',
    });
    s.approve(commit);
    await s.merged();
    const e = s.last();
    expect(e.type).toBe('verdict');
    expect(e.verdict).toBe('changes');
    expect(e.body).toContain('`node build.mjs` failed (exit 1) in ');
    expect(e.body).not.toContain('also after swarmupd installed');
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
    // After the default install comes the step that installs what it left out (AO-0229).
    expect(installSteps(undefined, nested, ['.', 'gone', 'site'])).toEqual([
      { command: DEFAULT_INSTALL, cwd: site, label: `${DEFAULT_INSTALL} (in site)` },
      expect.any(Function),
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
    expect(() => merge('npm ci')).toThrow('swarmupd.merge.x.install: use a list of commands');
  });

  it('installs by name the optional packages that npm install left out (AO-0229)', async () => {
    const top = temp();
    const win = { os: 'win32', cpu: 'x64' };
    const optional = (more: object = {}) => ({ version: '1.32.0', optional: true, ...more });
    const lock = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'app' },
        'node_modules/css': { version: '1.32.0' },
        // The package for this platform, which `npm install` left out.
        'node_modules/css-win32-x64-msvc': optional({ os: ['win32'], cpu: ['x64'], peer: true }),
        'node_modules/css-win32-arm64-msvc': optional({ os: ['win32'], cpu: ['arm64'] }),
        'node_modules/css-linux-x64-gnu': optional({
          os: ['linux'],
          cpu: ['x64'],
          libc: ['glibc'],
        }),
        'node_modules/css-linux-x64-musl': optional({
          os: ['linux'],
          cpu: ['x64'],
          libc: ['musl'],
        }),
        'node_modules/@scope/here': optional({ os: ['win32'] }),
        'node_modules/@scope/gone': optional({ version: '2.0.0-beta.1', os: ['win32', 'linux'] }),
        'node_modules/alias': optional({ name: 'real-name', cpu: ['x64'] }),
        // No platform list, or exclusions only: npm may leave these out on purpose (a failed or
        // omitted optional install), so the step must not turn them into a required install.
        'node_modules/anywhere': optional(),
        'node_modules/empty-lists': optional({ os: [], cpu: [] }),
        'node_modules/not-aix': optional({ os: ['!aix'] }),
        'node_modules/not-arm': optional({ os: ['!aix'], cpu: ['!arm'] }),
        // Names this cpu, and excludes this os.
        'node_modules/x64-not-win': optional({ os: ['!win32'], cpu: ['x64'] }),
        // Not optional, nested, linked, bundled, or not a plain version: left alone.
        'node_modules/required': { version: '1.0.0' },
        'node_modules/css/node_modules/nested': optional(),
        'packages/web/node_modules/nested': optional(),
        'node_modules/linked': { link: true, optional: true, resolved: 'packages/linked' },
        'node_modules/bundled': optional({ inBundle: true }),
        'node_modules/from-git': { optional: true, resolved: 'git+ssh://git@example.com/x.git' },
        'node_modules/odd': optional({ version: '1.0.0 && echo no' }),
        // A plain version, and a source that is not the registry: `name@version` would fetch
        // another package.
        'node_modules/git-semver': optional({
          os: ['win32'],
          resolved: 'git+ssh://git@example.com/x/git-semver.git#0123456789abcdef',
        }),
        'node_modules/file-semver': optional({
          os: ['win32'],
          resolved: 'file:vendor/f-1.32.0.tgz',
        }),
        'node_modules/url-semver': optional({
          os: ['win32'],
          resolved: 'https://example.com/downloads/url-semver-1.32.0.tgz',
        }),
        'node_modules/other-name': optional({
          os: ['win32'],
          resolved: 'https://registry.npmjs.org/evil/-/evil-1.32.0.tgz',
        }),
        'node_modules/other-version': optional({
          os: ['win32'],
          resolved: 'https://registry.npmjs.org/other-version/-/other-version-1.31.0.tgz',
        }),
        'node_modules/odd-resolved': optional({ os: ['win32'], resolved: 7 }),
        // A tarball with the path of a registry tarball, not in the registry npm installs this
        // name from: another host, scheme, port or folder, or the registry of another scope.
        'node_modules/shaped': optional({
          os: ['win32'],
          resolved: 'https://example.com/shaped/-/shaped-1.32.0.tgz',
        }),
        'node_modules/shaped-http': optional({
          os: ['win32'],
          resolved: 'http://registry.npmjs.org/shaped-http/-/shaped-http-1.32.0.tgz',
        }),
        'node_modules/shaped-port': optional({
          os: ['win32'],
          resolved: 'https://registry.npmjs.org:8443/shaped-port/-/shaped-port-1.32.0.tgz',
        }),
        'node_modules/shaped-folder': optional({
          os: ['win32'],
          resolved: 'https://registry.npmjs.org/files/shaped-folder/-/shaped-folder-1.32.0.tgz',
        }),
        'node_modules/shaped-user': optional({
          os: ['win32'],
          resolved: 'https://registry.npmjs.org@example.com/shaped-user/-/shaped-user-1.32.0.tgz',
        }),
        'node_modules/@scope/shaped': optional({
          os: ['win32'],
          resolved: 'https://registry.npmjs.org/@scope/shaped/-/shaped-1.32.0.tgz',
        }),
        'node_modules/shaped-scope-host': optional({
          os: ['win32'],
          resolved: 'https://npm.example.com/repo/shaped-scope-host/-/shaped-scope-host-1.32.0.tgz',
        }),
        'node_modules/@down/shaped': optional({
          os: ['win32'],
          resolved: 'https://registry.npmjs.org/@down/shaped/-/shaped-1.32.0.tgz',
        }),
        // From the configured registry: the tarball of this name and version there, also scoped
        // (in the registry of its scope), encoded or aliased.
        'node_modules/reg': optional({
          os: ['win32'],
          resolved: 'https://registry.npmjs.org/reg/-/reg-1.32.0.tgz',
        }),
        'node_modules/@scope/reg': optional({
          os: ['win32'],
          resolved: 'https://npm.example.com/repo/@scope%2freg/-/reg-1.32.0.tgz',
        }),
        'node_modules/reg-alias': optional({
          name: '@scope/real',
          os: ['win32'],
          resolved: 'https://npm.example.com/repo/@scope/real/-/real-1.32.0.tgz',
        }),
      },
    };
    writeFileSync(join(top, 'package-lock.json'), JSON.stringify(lock));
    mkdirSync(join(top, 'node_modules', '@scope', 'here'), { recursive: true });
    writeFileSync(join(top, 'node_modules', '@scope', 'here', 'package.json'), '{}');
    // The hidden lockfile lists nothing, as after an install from a lockfile without them.
    writeFileSync(join(top, 'node_modules', '.package-lock.json'), '{"packages":{}}');
    const registry = ['@scope/reg@1.32.0', 'reg-alias@npm:@scope/real@1.32.0', 'reg@1.32.0'];
    // npm's configuration: `@scope` has its own registry, and that of `@down` is not known.
    const asked: (string | undefined)[] = [];
    const reg = (scope: string | undefined): string | undefined => {
      asked.push(scope);
      if (scope === '@down') return undefined;
      return scope === '@scope' ? 'https://npm.example.com/repo/' : 'https://registry.npmjs.org';
    };
    expect(missingOptionalPackages(top, win, reg)).toEqual([
      '@scope/gone@2.0.0-beta.1',
      registry[0],
      'alias@npm:real-name@1.32.0',
      'css-win32-x64-msvc@1.32.0',
      registry[1],
      registry[2],
    ]);
    // One lookup a scope, however many packages have it.
    expect(asked).toHaveLength(3);
    expect(new Set(asked)).toEqual(new Set(['@down', '@scope', undefined]));
    // With npm's public registry for every scope, the tarballs on the other host are left alone.
    expect(missingOptionalPackages(top, win, () => 'https://registry.npmjs.org/')).toEqual([
      '@down/shaped@1.32.0',
      '@scope/gone@2.0.0-beta.1',
      '@scope/shaped@1.32.0',
      'alias@npm:real-name@1.32.0',
      'css-win32-x64-msvc@1.32.0',
      'reg@1.32.0',
    ]);
    // No registry known, or a lookup that throws: only packages without `resolved`.
    const noResolved = [
      '@scope/gone@2.0.0-beta.1',
      'alias@npm:real-name@1.32.0',
      'css-win32-x64-msvc@1.32.0',
    ];
    expect(missingOptionalPackages(top, win, () => undefined)).toEqual(noResolved);
    expect(
      missingOptionalPackages(top, win, () => {
        throw new Error('no npm');
      }),
    ).toEqual(noResolved);
    for (const spec of registry) {
      const name = spec.slice(0, spec.indexOf('@', 1));
      mkdirSync(join(top, 'node_modules', ...name.split('/')), { recursive: true });
      writeFileSync(join(top, 'node_modules', ...name.split('/'), 'package.json'), '{}');
    }
    expect(missingOptionalPackages(top, { os: 'linux', cpu: 'x64', libc: 'musl' }, reg)).toContain(
      'css-linux-x64-musl@1.32.0',
    );
    expect(missingOptionalPackages(top, { os: 'linux', cpu: 'x64', libc: 'musl' }, reg)).toEqual([
      '@scope/gone@2.0.0-beta.1',
      'alias@npm:real-name@1.32.0',
      'css-linux-x64-musl@1.32.0',
      'x64-not-win@1.32.0',
    ]);
    expect(repairInstallCommand(top, win, reg)).toBe(
      `${DEFAULT_INSTALL} @scope/gone@2.0.0-beta.1 alias@npm:real-name@1.32.0 css-win32-x64-msvc@1.32.0`,
    );
    // The step reads `node_modules` when its turn comes, after the default install ran.
    const [first, repair] = installSteps(undefined, top, ['.'], win, reg);
    expect(first).toBe(DEFAULT_INSTALL);
    for (const name of ['@scope/gone', 'alias']) {
      mkdirSync(join(top, 'node_modules', ...name.split('/')), { recursive: true });
      writeFileSync(join(top, 'node_modules', ...name.split('/'), 'package.json'), '{}');
    }
    expect((repair as () => unknown)()).toBe(`${DEFAULT_INSTALL} css-win32-x64-msvc@1.32.0`);
    mkdirSync(join(top, 'node_modules', 'css-win32-x64-msvc'));
    writeFileSync(join(top, 'node_modules', 'css-win32-x64-msvc', 'package.json'), '{}');
    expect((repair as () => unknown)()).toBeNull();
    expect(repairInstallCommand(top, win, reg)).toBeNull();
    // In another directory the step names it; a configured install gets no such step.
    mkdirSync(join(top, 'site'));
    writeFileSync(
      join(top, 'site', 'package-lock.json'),
      JSON.stringify({
        packages: {
          'node_modules/css-win32-x64-msvc': lock.packages['node_modules/css-win32-x64-msvc'],
        },
      }),
    );
    const inSite = installSteps(undefined, top, ['site'], win)[1] as () => unknown;
    const command = `${DEFAULT_INSTALL} css-win32-x64-msvc@1.32.0`;
    expect(inSite()).toEqual({ command, cwd: join(top, 'site'), label: `${command} (in site)` });
    expect(installSteps(['node i.mjs'], top, ['.'], win)).toEqual(['node i.mjs']);
    // No lockfile, an old one without `packages`, or one that does not parse: nothing to do.
    const bare = temp();
    expect(missingOptionalPackages(bare, win)).toEqual([]);
    writeFileSync(join(bare, 'package-lock.json'), '{"lockfileVersion":1,"dependencies":{}}');
    expect(missingOptionalPackages(bare, win)).toEqual([]);
    writeFileSync(join(bare, 'package-lock.json'), 'not json');
    expect(missingOptionalPackages(bare, win)).toEqual([]);
    // npm reads `npm-shrinkwrap.json` first.
    writeFileSync(
      join(bare, 'npm-shrinkwrap.json'),
      JSON.stringify({
        packages: {
          'node_modules/not-aix': optional({ os: ['!aix'] }),
          'node_modules/win': optional({ os: ['win32'] }),
        },
      }),
    );
    expect(missingOptionalPackages(bare, win)).toEqual(['win@1.32.0']);
  });

  it("reads the registry of a scope from npm's configuration (AO-0229)", () => {
    const dir = temp();
    writeFileSync(join(dir, 'package.json'), '{"name":"app"}');
    writeFileSync(
      join(dir, '.npmrc'),
      'registry=https://npm.example.com/all/\n@scope:registry=https://npm.example.com/scope/\n',
    );
    expect(npmRegistry(dir, undefined)).toBe('https://npm.example.com/all/');
    expect(npmRegistry(dir, '@scope')).toBe('https://npm.example.com/scope/');
    expect(npmRegistry(dir, '@other')).toBe('https://npm.example.com/all/');
    // A swarmupd started with `pnpm swarmup` has pnpm's registry in its environment, and npm
    // takes that variable over an `.npmrc` file; the project's own registry still answers (AO-0307).
    const script = {
      ...process.env,
      npm_config_registry: 'https://registry.example.org/',
      npm_config_user_agent: 'pnpm/9.15.4 npm/? node/v22.0.0 win32 x64',
    };
    expect(npmRegistry(dir, undefined, script)).toBe('https://npm.example.com/all/');
    expect(npmRegistry(dir, '@scope', script)).toBe('https://npm.example.com/scope/');
    // A variable a person set for their shell, with no script around it, still wins, as in npm.
    const shell = withoutScriptEnv(process.env);
    shell.npm_config_registry = 'https://registry.example.org/';
    expect(npmRegistry(dir, undefined, shell)).toBe('https://registry.example.org/');
    // The default lookup of `missingOptionalPackages` is this one, in the directory it reads.
    const here = { os: 'win32', cpu: 'x64' };
    const write = (host: string) =>
      writeFileSync(
        join(dir, 'package-lock.json'),
        JSON.stringify({
          packages: {
            'node_modules/pkg': {
              version: '1.0.0',
              optional: true,
              os: ['win32'],
              resolved: `https://${host}/all/pkg/-/pkg-1.0.0.tgz`,
            },
          },
        }),
      );
    write('npm.example.com');
    expect(missingOptionalPackages(dir, here)).toEqual(['pkg@1.0.0']);
    write('example.com');
    expect(missingOptionalPackages(dir, here)).toEqual([]);
  }, 60_000);

  it('runs commands with the environment given for them, with and without the job launcher (AO-0306)', async () => {
    const dir = temp();
    writeFileSync(
      join(dir, 'env.mjs'),
      "import { appendFileSync } from 'node:fs';\nappendFileSync('env.txt', (process.env.ELECTRON_OVERRIDE_DIST_PATH ?? 'none') + '\\n');\n",
    );
    const base = { ...process.env };
    delete base.ELECTRON_OVERRIDE_DIST_PATH;
    for (const job of process.platform === 'win32' ? [false, true] : [false]) {
      const runner = new CommandRunner(base, { killTree: () => {}, job });
      const own = { ...base, ELECTRON_OVERRIDE_DIST_PATH: 'shared-electron' };
      const first = await runner.runAll(['node env.mjs'], dir, 60_000, undefined, own);
      // The next commands get the runner's own environment again.
      const second = await runner.runAll(['node env.mjs'], dir, 60_000);
      expect([...first, ...second].map((r) => r.ok)).toEqual([true, true]);
    }
    expect(text(join(dir, 'env.txt'))).toBe(
      process.platform === 'win32'
        ? 'shared-electron\nnone\nshared-electron\nnone\n'
        : 'shared-electron\nnone\n',
    );
  }, 60_000);

  it('asks a function entry for its command when its turn comes, and skips a null (AO-0229)', async () => {
    const dir = temp();
    writeFileSync(
      join(dir, 'mark.mjs'),
      "import { appendFileSync } from 'node:fs';\nappendFileSync('ran.txt', process.argv[2] + '\\n');\n",
    );
    const steps: string[] = [];
    const runner = new CommandRunner(process.env, { killTree: () => {}, job: false });
    const results = await runner.runAll(
      [
        'node mark.mjs one',
        () => null,
        // Sees what the first command wrote.
        () => (existsSync(join(dir, 'ran.txt')) ? 'node mark.mjs two' : 'node mark.mjs early'),
        'node mark.mjs three',
      ],
      dir,
      60_000,
      (s) => steps.push(`${s.index + 1}/${s.count} ${s.command}${s.result ? ' done' : ''}`),
    );
    expect(text(join(dir, 'ran.txt'))).toBe('one\ntwo\nthree\n');
    // `entry` is the place in the list given, so a skipped entry does not shift the later ones.
    expect(results.map((r) => [r.command, r.ok, r.entry])).toEqual([
      ['node mark.mjs one', true, 0],
      ['node mark.mjs two', true, 2],
      ['node mark.mjs three', true, 3],
    ]);
    expect(steps).toEqual([
      '1/4 node mark.mjs one',
      '1/4 node mark.mjs one done',
      '2/3 node mark.mjs two',
      '2/3 node mark.mjs two done',
      '3/3 node mark.mjs three',
      '3/3 node mark.mjs three done',
    ]);
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
    // 0.05 min is 3 s; the `slow` check waits for go.txt, which never comes.
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
    // One retry and no more. checks.txt counts only the checks that got as far as writing it
    // before their stop, and under the full suite Node can take longer than the 3 s to start:
    // an exact count of 2 failed the AO-0247 merge. So bound it instead.
    expect(warns.filter((w) => w.includes('merges once more'))).toHaveLength(1);
    const checks = join(s.state, 'checks.txt');
    expect(existsSync(checks) ? text(checks) : '').toMatch(/^x{0,2}$/);
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
    // Where the stop is refused, the note says the hook may still run instead (AO-0251).
    expect(e.body).toMatch(
      treeStops
        ? /swarmupd could not merge .+: `git rebase -q [0-9a-f]+` in .+ timed out after 4 s; swarmupd stopped it \(stage: rebase\)/
        : /swarmupd could not merge .+: `git rebase -q [0-9a-f]+` in .+ timed out after 4 s; swarmupd stopped (it|git, but what git started, such as a hook, may still run: .+) \(stage: rebase\)/,
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
      /`git merge -q --ff-only [0-9a-f]+` in .+ timed out after 4 s; swarmupd stopped (it|git, but what git started, such as a hook, may still run: .+) \(stage: fast-forward\)/,
    );
    expect(warns.join('\n')).not.toMatch(/kept moving|did not move/);
    writeFileSync(join(s.state, 'go.txt'), 'go\n');
  });

  it('says what git started may still run when the stop of a timed-out git is refused (AO-0251)', async () => {
    const repo = temp();
    const state = temp();
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'code.txt'), 'one\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'one');
    const from = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', '-b', 'work');
    writeFileSync(join(repo, 'code.txt'), 'two\n');
    git(repo, 'commit', '-q', '-am', 'two');
    const to = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    const beat = join(state, 'beat.txt').split(sep).join('/');
    const go = join(state, 'go.txt').split(sep).join('/');
    // Hangs while git updates main, and leaves a mark every 100 ms until `go.txt` exists.
    writeFileSync(
      join(repo, '.git', 'hooks', 'reference-transaction'),
      [
        '#!/bin/sh',
        '[ "$1" = prepared ] || exit 0',
        "grep -q 'refs/heads/main' || exit 0",
        `while [ ! -f '${go}' ]; do printf x >> '${beat}'; sleep 0.1; done`,
        'exit 1',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const refused = '`taskkill /T` exited 1: Access is denied.';
    const merge = new MergeRepo(
      repo,
      join(state, 'wt'),
      [],
      { ...process.env, ...ID },
      hangOnly('merge', '-q', '--ff-only'),
      // As where a sandbox refuses `taskkill /T`: nothing under git is stopped.
      () => Promise.resolve(refused),
    );

    const err = await merge.fastForward('main', from, to).catch((e: unknown) => e as Error);

    try {
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      // No claim that the tree stopped; the reason is in the message.
      expect(message).toMatch(
        /`git merge -q --ff-only [0-9a-f]+` in .+ timed out after 4 s; swarmupd stopped git, but what git started, such as a hook, may still run: /,
      );
      expect(message).toContain(refused);
      expect(message).not.toContain('swarmupd stopped it');
      // The hook did outlive the merge's git: its marks go on.
      const size = statSync(beat).size;
      await until(() => statSync(beat).size > size, 5_000);
    } finally {
      // Ends the hook, so nothing has to kill it; waits for its marks to stop.
      writeFileSync(go, 'go\n');
      let size = -1;
      const end = Date.now() + 10_000;
      while (Date.now() < end && existsSync(beat) && size !== statSync(beat).size) {
        size = statSync(beat).size;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }, 60_000);

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
