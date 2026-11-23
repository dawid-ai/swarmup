/**
 * Definitions at a git ref of the store (W5 phase 5, `--defs-ref`): the files read with
 * `git show` into a snapshot in memory, never checked out, the way a variant's overlay is put
 * together. The store's working files and branch stay as they are.
 */
import { execFileSync } from 'node:child_process';
import { OpsError } from '../ids.js';
import { DEF_FOLDERS, normalText } from './hash.js';
import { SWARM_FILE } from './swarm.js';

/** A git ref as `--defs-ref` takes it: a branch, tag, commit or `HEAD~N`, never an option. */
export const DEFS_REF_RE = /^(?!-)[A-Za-z0-9._/@{}~^:-]{1,200}$/;

/** Checks a `--defs-ref` value; exit 2 otherwise. */
export function checkDefsRef(ref: unknown): string {
  if (typeof ref !== 'string' || !DEFS_REF_RE.test(ref) || ref.includes('..')) {
    throw new OpsError(
      `bad definitions ref '${String(ref)}': name a branch, tag or commit, such as main or HEAD~3`,
      2,
    );
  }
  return ref;
}

/** The git calls that read a store's definitions at `ref`, run in the store's folder. */
export const defsRefGit = {
  /** Resolves the ref to its commit. */
  commit: (ref: string): string[] => ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
  /** Lists the definition files at the ref, relative to the store's folder. */
  list: (ref: string): string[] => [
    'ls-tree',
    '-r',
    '--name-only',
    ref,
    '--',
    SWARM_FILE,
    ...DEF_FOLDERS,
  ],
  /** Reads one file at the ref, by its path relative to the store's folder. */
  show: (ref: string, path: string): string[] => ['show', `${ref}:./${path}`],
};

/** A snapshot of a store's definitions at a git ref. */
export interface DefsRefSnapshot {
  ref: string;
  /** The commit the ref resolved to. */
  commit: string;
  /** Path to text as hashed (no BOM, LF line ends), sorted by path. */
  texts: Map<string, string>;
}

/** Sorts a snapshot's texts by path, normalized as the hash reads them. */
export function snapshotTexts(files: Iterable<[string, string]>): Map<string, string> {
  return new Map(
    [...files]
      .map(([p, t]) => [p, normalText(t)] as [string, string])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** The first line of a git failure, for messages. */
export function gitWhy(err: unknown): string {
  const e = err as { stderr?: string | Buffer; message?: string };
  const text = (e.stderr ? String(e.stderr) : '') || e.message || String(err);
  return text.trim().split('\n')[0] ?? 'git failed';
}

function gitIn(dir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * The definition files of the store in `dir` at git `ref`, read with `git show`. Synchronous: for
 * the CLI. swarmupd reads them off the event loop with the same {@link defsRefGit} calls. Refuses
 * a ref git cannot resolve with exit 2.
 */
export function readDefsAtRef(dir: string, ref: string): DefsRefSnapshot {
  checkDefsRef(ref);
  let commit: string;
  let names: string[];
  try {
    commit = gitIn(dir, defsRefGit.commit(ref)).trim();
    names = gitIn(dir, defsRefGit.list(ref)).split('\n').filter(Boolean);
  } catch (err) {
    throw new OpsError(`git cannot read ${ref} in ${dir}: ${gitWhy(err)}`, 2);
  }
  if (!commit) throw new OpsError(`git cannot read ${ref} in ${dir}: no such commit`, 2);
  return {
    ref,
    commit,
    texts: snapshotTexts(names.map((n) => [n, gitIn(dir, defsRefGit.show(ref, n))])),
  };
}
