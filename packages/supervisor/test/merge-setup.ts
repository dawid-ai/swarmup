// Shared setup of the merge-*.test.ts files, split from one merge.test.ts that ran past 25 minutes
// in merge checks (AO-0397). Importing this module registers its afterEach in the importing file.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach } from 'vitest';
import { initRoot, Workspace, type UserConfig } from '@swarmup/core';
import {
  type MergeCheck,
  type MergeGitTimeout,
  type OpsdSelf,
  type ProcLister,
  type RunRecord,
  opsdConfig,
  Supervisor,
  systemLister,
} from '../src/index.js';
import { until, WAIT_MS } from './until.js';

export const dirs: string[] = [];
export const sups: Supervisor[] = [];

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
      await until(() => removed(d), 30_000);
    }
  }
}, 90_000);

/** Whether `dir` could be removed: nothing holds it or a file in it any more. */
export function removed(dir: string): boolean {
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** The system's process lister, with every kill refused, as in a sandbox that allows none. */
export function refusingLister(): ProcLister {
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
export function blindLister(left?: { pid: number; start: number; running: boolean }): ProcLister {
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

export const WIN = process.platform === 'win32';

/**
 * A git timeout that stops only the command a test hangs, whose arguments start with `hung`,
 * after 4 s, and gives every other command a minute. Under full-suite load on Windows, commands
 * that start the test's hook took past 4 s and then past 10 s, so the merge ended in the wrong
 * stage (AO-0213).
 */
export function hangOnly(...hung: string[]): MergeGitTimeout {
  return (args) => (hung.every((a, i) => args[i] === a) ? 4_000 : 60_000);
}

/**
 * Whether stopping a process here also stops what it started. On Windows a git timeout stops
 * git's tree with `taskkill /T`, which a sandbox may refuse: a hook then outlives its git, and a
 * test cannot expect the hook's marks to stop (AO-0213). The probe starts a process that starts
 * another, stops the first as a git timeout does, and reports whether the second ended.
 */
export async function stopsTrees(): Promise<boolean> {
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
export const STAGE_MS = 90_000;

/** Off Windows, ledgers, and with them killing what merge commands start, need exact creation times. */
export const precise = systemLister().precise;

export function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmupd-merge-'));
  dirs.push(d);
  return d;
}

export const ID = {
  GIT_AUTHOR_NAME: 'Swarmupd Test',
  GIT_AUTHOR_EMAIL: 'swarmupd@example.com',
  GIT_COMMITTER_NAME: 'Swarmupd Test',
  GIT_COMMITTER_EMAIL: 'swarmupd@example.com',
};
export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...ID },
  }).trim();
export const text = (file: string): string => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

/**
 * Fails when `code.txt` says `bad`; waits for `go.txt` when it says `slow`; prints a token-like
 * line, then fails, when it says `leak`. When it says `nap`, the first run writes `napped.txt`,
 * waits for `go.txt` and fails, as tests that time out when the PC wakes do.
 */
export const CHECK = `
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
if (code.includes('stuck')) {
  console.log(' FAIL  test/a.test.ts > breaks');
  while (!existsSync(process.env.MERGE_GO)) await new Promise((r) => setTimeout(r, 50));
}
if (code.includes('slow')) while (!existsSync(process.env.MERGE_GO)) await new Promise((r) => setTimeout(r, 50));
if (code.includes('bad')) { console.error('code says bad'); process.exit(1); }
if (existsSync('two.txt') && readFileSync('two.txt', 'utf8').includes('bad')) { console.error('two says bad'); process.exit(1); }
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
export const BUILD = `
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
export const HELD = `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
writeFileSync(process.env.MERGE_BUILDING, String(process.pid));
while (!existsSync(process.env.MERGE_BUILD_GO)) await new Promise((r) => setTimeout(r, 50));
mkdirSync('dist', { recursive: true });
writeFileSync('dist/built.txt', readFileSync('code.txt', 'utf8'));
`;
/** Stands in for `npm install`: notes each run, and the code it saw, in `installed.txt`. */
export const INSTALL = `
import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync(process.env.MERGE_INSTALLED, readFileSync('code.txt', 'utf8'));
`;
/** Stands in for `npm install` run by path from any directory: notes where it ran. */
export const INSTALL_WHERE = `
import { appendFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
appendFileSync(process.env.MERGE_INSTALLED, (existsSync('code.txt') ? '.' : basename(process.cwd())) + '\\n');
`;
/** A writing run that ends by itself once `run-go.txt` exists, so no test has to kill it. */
export const RUN = `
import { existsSync } from 'node:fs';
while (!existsSync(process.env.RUN_GO)) await new Promise((r) => setTimeout(r, 50));
`;

/**
 * A project repo on `main` with code, check and build scripts and its task store committed, a
 * task `1` owned by `fake:engineer`, and swarmupd set to merge approved work into `main`.
 */
export function mergeSetup(
  opts: {
    procs?: () => ProcLister;
    self?: (repo: string) => OpsdSelf;
    build?: string;
    now?: () => number;
    /** Minutes each merge command may take; config allows whole minutes only. */
    timeoutMinutes?: number;
    /** `swarmupd.merge.test.batch` (AO-0381). */
    batch?: number;
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
    /** `swarmupd.merge.test.checks`; default `['node check.mjs']`. */
    checks?: MergeCheck[];
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
        test: {
          base: 'main',
          checks: opts.checks ?? ['node check.mjs'],
          build: ['node build.mjs'],
        },
      },
    },
  });
  if (opts.timeoutMinutes !== undefined) config.merge.test!.timeout_minutes = opts.timeoutMinutes;
  if (opts.batch !== undefined) config.merge.test!.batch = opts.batch;
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

export function ended(sup: Supervisor, id: string, ms = WAIT_MS): Promise<RunRecord> {
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

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The worktree that has `branch` checked out. */
export const worktreeOf = (repo: string, branch: string): string => {
  const block = git(repo, 'worktree', 'list', '--porcelain')
    .split(/\r?\n\r?\n/)
    .find((b) => b.includes(`branch refs/heads/${branch}`))!;
  return /^worktree (.+)$/m.exec(block)![1]!.trim();
};

/** Task 1 approved, with the review naming `commit` and a run-end of its author before the verdict. */
export const approveAfterRun = (
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
