// A git that is killed mid-write leaves `.git/index.lock`, and every later git command that
// writes the index fails with "Unable to create index.lock: File exists". In a task store that
// stops `swarmup sync` for every agent (AO-0302). A sync removes the lock when it is old and no
// live git process can be the one that made it.
import { readFileSync, statSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { GitSteps } from './git-steps.js';

/** How old a store's `index.lock` must be before a sync takes it for one a dead git left. */
export const STALE_INDEX_LOCK_MS = 2 * 60_000;

/**
 * How long after the lock's time a process may have started and still count as its maker: the
 * lock's time is its last write, and `ps` gives a start time to the second.
 */
const START_SLACK_MS = 5_000;

/** A live git process: its start in ms since the epoch, or null when the system does not say. */
export interface GitProc {
  pid: number;
  startMs: number | null;
}

/** What {@link clearStaleIndexLock} did; `lock` is set only when a stale lock was found. */
export interface IndexLockResult {
  removed: boolean;
  lock?: string;
  /** The lock's age in ms. */
  ageMs?: number;
  /** The git processes that may hold the lock, so it was left alone. */
  heldBy?: number[];
}

/** The git folder of the checkout whose top folder is `top`, also for a linked worktree. */
function gitDirOf(top: string): string | null {
  const dotGit = join(top, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
    if (!m) return null;
    return isAbsolute(m[1]!) ? m[1]! : resolve(top, m[1]!);
  } catch {
    return null;
  }
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

// Doubled single quotes, not double quotes: the query survives any argument quoting unchanged.
const WINDOWS_QUERY =
  "Get-CimInstance Win32_Process -Filter 'Name=''git.exe''' -Property ProcessId,CreationDate,CommandLine" +
  " | ForEach-Object { '{0}\t{1}\t{2}' -f $_.ProcessId," +
  " $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') })," +
  " ($_.CommandLine -replace '[\\t\\r\\n]', ' ') }";

/** The command that lists processes for {@link parseGitProcs}. */
export function gitProcsCommand(platform: NodeJS.Platform = process.platform): {
  cmd: string;
  args: string[];
} {
  return platform === 'win32'
    ? {
        cmd: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_QUERY],
      }
    : { cmd: 'ps', args: ['-axo', 'pid=,etime=,args='] };
}

/**
 * Git's long-lived helpers, which never write the index. Without this, a repo with
 * `core.fsmonitor` on would keep every stale lock.
 */
const DAEMON = /\b(?:fsmonitor--daemon|credential-cache--daemon)\b/;

/** `ps` elapsed time, `[[dd-]hh:]mm:ss`, in ms; null when it is not one. */
function etimeMs(text: string): number | null {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text);
  if (!m) return null;
  const [d, h, min, s] = m.slice(1).map((v) => Number(v ?? 0));
  return (((d! * 24 + h!) * 60 + min!) * 60 + s!) * 1000;
}

/**
 * The live git processes in the output of {@link gitProcsCommand}. Errs toward listing: on
 * POSIX any command line with a `git` path component counts, and a process whose start time
 * cannot be read gets a null start.
 */
export function parseGitProcs(
  out: string,
  now: number,
  platform: NodeJS.Platform = process.platform,
): GitProc[] {
  const procs: GitProc[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (platform === 'win32') {
      const [pid, created, command = ''] = line.split('\t');
      if (!/^\d+$/.test(pid ?? '') || DAEMON.test(command)) continue;
      const startMs = created ? Date.parse(created) : NaN;
      procs.push({ pid: Number(pid), startMs: Number.isNaN(startMs) ? null : startMs });
    } else {
      const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!m || !/(?:^|\/)git(?:\s|$)/.test(m[3]!) || DAEMON.test(m[3]!)) continue;
      const elapsed = etimeMs(m[2]!);
      procs.push({ pid: Number(m[1]), startMs: elapsed === null ? null : now - elapsed });
    }
  }
  return procs;
}

export interface IndexLockOptions {
  minAgeMs?: number;
  /**
   * Lists the live git processes instead of asking the system, for tests; null when the list
   * cannot be had.
   */
  gitProcs?: () => GitProc[] | null;
}

/**
 * Removes the `index.lock` of the checkout at `top` when it is at least `minAgeMs` old and no
 * live git process started before the lock was made. A process that started later cannot hold
 * it: git makes the lock itself, so the maker is older than its lock. When the processes cannot
 * be listed, the lock stays. The process list is asked for only when an old lock exists, so a
 * sync without one costs a single `stat`.
 */
export function* clearStaleIndexLock(
  top: string,
  now: number,
  opts: IndexLockOptions = {},
): GitSteps<IndexLockResult> {
  const dir = gitDirOf(top);
  if (!dir) return { removed: false };
  const lock = join(dir, 'index.lock');
  const mtime = mtimeOf(lock);
  if (mtime === null || now - mtime < (opts.minAgeMs ?? STALE_INDEX_LOCK_MS)) {
    return { removed: false };
  }
  const found = { lock, ageMs: now - mtime };
  let procs: GitProc[] | null;
  if (opts.gitProcs) {
    procs = opts.gitProcs();
  } else {
    try {
      procs = parseGitProcs(yield { cwd: top, ...gitProcsCommand() }, Date.now());
    } catch {
      procs = null;
    }
  }
  if (!procs) return { removed: false, ...found, heldBy: [] };
  const heldBy = procs
    .filter((p) => p.startMs === null || p.startMs <= mtime + START_SLACK_MS)
    .map((p) => p.pid);
  if (heldBy.length > 0) return { removed: false, ...found, heldBy };
  // A git that came while the processes were listed made a new lock; that one is not stale.
  if (mtimeOf(lock) !== mtime) return { removed: false };
  try {
    unlinkSync(lock);
    return { removed: true, ...found };
  } catch {
    return { removed: false, ...found, heldBy: [] };
  }
}
