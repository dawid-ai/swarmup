import { execFileSync, spawn } from 'node:child_process';
import { lstatSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { samePath } from '@swarmup/core';
import { gitAsync } from './git.js';

/**
 * Task types whose work is code, as `swarmup review` reads them (AO-0136): a run on one gets a
 * worktree of its own when its folder would be a store checkout (AO-0168).
 */
export const CODE_TASK_TYPES = new Set(['task', 'bug', 'feature']);

/** How long one `git worktree add` may take: it checks out every file of the repo. */
export const WORKTREE_TIMEOUT_MS = 5 * 60_000;

/** A task's worktree in a store checkout: `out/wt-<ID>`, on a branch of the task. */
export interface TaskWorktree {
  /** The store checkout the worktree belongs to. */
  top: string;
  /** `<top>/out/wt-<ID>`. */
  path: string;
  /** The branch a new worktree gets: `<runtime>/<id>`, lowercase. */
  branch: string;
  /** The branch a new task branch starts from, when the root names one (its merge base). */
  base?: string;
  /** The worktree is there already; otherwise swarmupd makes it before the run starts. */
  ready: boolean;
}

/** `<top>/out/wt-<ID>`, where runs in a store checkout make code branches (AO-0135). */
export function taskWorktreePath(top: string, id: string): string {
  return join(top, 'out', `wt-${id}`);
}

/** The branch swarmupd gives a task's new worktree: `<runtime>/<id>`, lowercase. */
export function taskBranch(runtime: string, id: string): string {
  return `${runtime}/${id}`.toLowerCase().replace(/[^a-z0-9/._-]/g, '-');
}

/**
 * What is at `path`: `worktree` when it is a linked git worktree (its `.git` is a file), `other`
 * when something else is there, `none` when nothing is.
 */
export function worktreeAt(path: string): 'worktree' | 'other' | 'none' {
  try {
    statSync(path);
  } catch {
    return 'none';
  }
  try {
    return statSync(join(path, '.git')).isFile() ? 'worktree' : 'other';
  } catch {
    return 'other';
  }
}

/**
 * The lock reason a task worktree carries while git makes it. Git writes the lock before it
 * checks out a file, and swarmupd removes it once the worktree is complete, so a worktree that
 * still has it after a crash or power cut is half made: no run ever worked in it.
 */
export const MAKING_LOCK = 'swarmupd: making';

/** The `git worktree add` arguments for `wt`: its branch as is when it exists, else a new one. */
export function worktreeAddArgs(wt: TaskWorktree, branchExists: boolean, base: string): string[] {
  const lock = ['--lock', '--reason', MAKING_LOCK];
  return branchExists
    ? ['worktree', 'add', ...lock, wt.path, wt.branch]
    : ['worktree', 'add', ...lock, '-b', wt.branch, wt.path, base];
}

/**
 * Makes `wt` off the event loop: on its branch when that exists (an earlier worktree of the task
 * was removed), else on a new branch from the root's merge base, else from the store checkout's
 * HEAD. Rejects with git's message when git refuses, such as for a branch checked out elsewhere.
 */
export async function makeTaskWorktree(wt: TaskWorktree, env: NodeJS.ProcessEnv): Promise<void> {
  const git = (args: string[]) =>
    gitAsync(wt.top, args, {
      env: { ...env, GIT_TERMINAL_PROMPT: '0' },
      timeoutMs: WORKTREE_TIMEOUT_MS,
    });
  const commit = async (rev: string) =>
    (await git(['rev-parse', '--verify', '-q', `${rev}^{commit}`]).catch(() => '')).trim();
  const branchExists = (await commit(`refs/heads/${wt.branch}`)) !== '';
  const base = (wt.base ? await commit(`refs/heads/${wt.base}`) : '') || (await commit('HEAD'));
  if (!branchExists && !base) throw new Error(`${wt.top} has no commit to branch from`);
  await git(worktreeAddArgs(wt, branchExists, base));
  await git(['worktree', 'unlock', wt.path]);
}

/** {@link makeTaskWorktree} for a launch that cannot wait: it blocks until git is done. */
export function makeTaskWorktreeSync(wt: TaskWorktree, env: NodeJS.ProcessEnv): void {
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: wt.top,
      encoding: 'utf8',
      windowsHide: true,
      timeout: WORKTREE_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const commit = (rev: string) => {
    try {
      return git(['rev-parse', '--verify', '-q', `${rev}^{commit}`]).trim();
    } catch {
      return '';
    }
  };
  const branchExists = commit(`refs/heads/${wt.branch}`) !== '';
  const base = (wt.base ? commit(`refs/heads/${wt.base}`) : '') || commit('HEAD');
  if (!branchExists && !base) throw new Error(`${wt.top} has no commit to branch from`);
  git(worktreeAddArgs(wt, branchExists, base));
  git(['worktree', 'unlock', wt.path]);
}

/** The branch checked out in the worktree at `path`, or null on a detached HEAD or error. */
export function worktreeBranch(path: string): string | null {
  try {
    return (
      execFileSync('git', ['symbolic-ref', '-q', '--short', 'HEAD'], {
        cwd: path,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/** One linked worktree of a repo, as `git worktree list --porcelain` reads it. */
export interface WorktreeEntry {
  path: string;
  /** The commit checked out. */
  head: string;
  /** The branch checked out, or null on a detached HEAD. */
  branch: string | null;
  /** The lock reason, `''` for a lock without one, or null when not locked. */
  locked: string | null;
}

/** Reads `git worktree list --porcelain -z` output; the main checkout comes first. */
export function parseWorktreeList(out: string): WorktreeEntry[] {
  const list: WorktreeEntry[] = [];
  let cur: WorktreeEntry | undefined;
  for (const field of out.split('\0')) {
    if (field.startsWith('worktree ')) {
      cur = { path: field.slice('worktree '.length), head: '', branch: null, locked: null };
      list.push(cur);
    } else if (!cur) continue;
    else if (field.startsWith('HEAD ')) cur.head = field.slice('HEAD '.length);
    else if (field.startsWith('branch ')) {
      cur.branch = field.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (field === 'locked') cur.locked = '';
    else if (field.startsWith('locked ')) cur.locked = field.slice('locked '.length);
  }
  return list;
}

/** The task id of a worktree at `<top>/out/wt-<ID>`, or null for any other folder. */
export function taskIdOfWorktree(top: string, path: string): string | null {
  const m = /^wt-(.+)$/.exec(basename(path));
  if (!m) return null;
  return samePath(dirname(resolve(path)), join(resolve(top), 'out')) ? m[1]! : null;
}

/** The git folder of the linked worktree at `path` (from its `.git` file), or null. */
export function worktreeGitDir(path: string): string | null {
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(join(path, '.git'), 'utf8'));
    if (!m) return null;
    return isAbsolute(m[1]!) ? m[1]! : resolve(path, m[1]!);
  } catch {
    return null;
  }
}

/** True when `path` is a junction or symlink itself (not followed). */
export function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** How long deleting a worktree's folder may take: `node_modules` alone is ~100,000 files. */
export const DELETE_TIMEOUT_MS = 15 * 60_000;

/** How long one git call of {@link deleteWorktree} other than the prune may take. */
const DELETE_GIT_TIMEOUT_MS = 60_000;

/**
 * The CommonJS program a child process runs to delete the folder named by its last argument,
 * `.git` last: a folder that a crash or a kill left half deleted is still a worktree git reads,
 * so the next sweep can check it before it goes on (see `Supervisor.finishReclaim`). Under
 * Electron, `fs` takes an `.asar` file for a folder and walks into it, and every task worktree
 * has one in `node_modules/electron`: `fs.promises.rm` then never ends (AO-0244).
 * `process.noAsar` turns that off. `fs.rm` removes a junction or symlink itself and leaves its
 * target alone.
 */
const DELETE_SCRIPT = `
process.noAsar = true;
const fs = require('fs');
const { join } = require('path');
const dir = process.argv[process.argv.length - 1];
const opts = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };
(async () => {
  let names = [];
  try { names = fs.readdirSync(dir); } catch {}
  for (const name of names) if (name !== '.git') await fs.promises.rm(join(dir, name), opts);
  await fs.promises.rm(dir, opts);
})().catch((err) => {
  process.stderr.write(String((err && err.message) || err));
  process.exit(1);
});
`;

/** The program that runs {@link DELETE_SCRIPT}: Node, or an Electron app's executable as Node. */
export interface DeleteHost {
  execPath: string;
  /** `execPath` is an Electron executable: it runs as Node with `.asar` support off. */
  electron: boolean;
}

/** Options of {@link deleteWorktree}. */
export interface DeleteOptions {
  /** Stops the deletion when it aborts, such as when swarmupd stops. */
  signal?: AbortSignal;
  /** Stops the deletion after this long; {@link DELETE_TIMEOUT_MS} by default. */
  timeoutMs?: number;
  /** This process's own executable by default. */
  host?: DeleteHost;
}

/**
 * Deletes the folder at `path` in a child process, which a timeout or `signal` kills. In this
 * process, a deletion could never be cut off, and under Electron it ran for 79 minutes, held
 * every stop that waited for it, and kept the tick from starting runs (AO-0244).
 */
export function removeTree(path: string, opts: DeleteOptions = {}): Promise<void> {
  const host = opts.host ?? {
    execPath: process.execPath,
    electron: Boolean(process.versions.electron),
  };
  const timeoutMs = opts.timeoutMs ?? DELETE_TIMEOUT_MS;
  return new Promise((resolvePromise, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error(`deleting ${path} stopped: swarmupd is stopping`));
      return;
    }
    const env: NodeJS.ProcessEnv = host.electron
      ? { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' }
      : process.env;
    const child = spawn(host.execPath, ['-e', DELETE_SCRIPT, path], {
      env,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString();
    });
    let stopped: string | undefined;
    const kill = (why: string): void => {
      stopped ??= why;
      child.kill();
    };
    const timer = setTimeout(
      () => kill(`it took longer than ${Math.round(timeoutMs / 1000)} s`),
      timeoutMs,
    );
    const onAbort = (): void => kill('swarmupd is stopping');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const settle = (): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (err) => {
      settle();
      reject(err);
    });
    child.on('close', (code, signal) => {
      settle();
      if (stopped) reject(new Error(`deleting ${path} stopped: ${stopped}`));
      else if (code === 0) resolvePromise();
      else reject(new Error(stderr.trim() || `deleting ${path} failed (${signal ?? code})`));
    });
  });
}

/**
 * Deletes the linked worktree at `path` and drops git's record of it. Not `git worktree remove`:
 * Git for Windows follows a junction inside the folder, such as a `node_modules` entry linked to
 * the main checkout's, and deletes what it points to (AO-0230). {@link removeTree} removes the
 * link itself and leaves its target alone. The caller checks first that nothing in the folder
 * needs keeping. A deletion that times out or is stopped leaves the folder half deleted.
 */
export async function deleteWorktree(
  top: string,
  path: string,
  opts: DeleteOptions = {},
): Promise<void> {
  // A worktree root that is a junction or symlink would be deleted through: its target's files
  // would go. Such a path is never swarmupd's own worktree, so it refuses.
  if (isLink(path)) throw new Error(`${path} is a link; swarmupd deletes nothing through a link`);
  // A locked worktree is never pruned; swarmupd only deletes its own making lock or none.
  await gitAsync(top, ['worktree', 'unlock', path], { timeoutMs: DELETE_GIT_TIMEOUT_MS }).catch(
    () => '',
  );
  await removeTree(path, opts);
  await gitAsync(top, ['worktree', 'prune'], { timeoutMs: DELETE_TIMEOUT_MS });
}

/** How old an `index.lock` must be before swarmupd takes it for one a dead git left. */
export const STALE_LOCK_MS = 2 * 60_000;

/**
 * Removes the `index.lock` of the worktree at `path` when it is at least `minAgeMs` old, and says
 * whether it did. Git leaves one behind when it is killed mid-write, as in a crash, and every
 * later git command in the worktree then fails. The caller checks that no run works there.
 */
export function clearStaleIndexLock(path: string, now: number, minAgeMs = STALE_LOCK_MS): boolean {
  const dir = worktreeGitDir(path);
  if (!dir) return false;
  const lock = join(dir, 'index.lock');
  try {
    if (now - statSync(lock).mtimeMs < minAgeMs) return false;
    unlinkSync(lock);
    return true;
  } catch {
    return false;
  }
}
