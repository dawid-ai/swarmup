/**
 * Definitions at a git ref of the store (W5 phase 5, `--defs-ref`): the files read with
 * `git show` into a snapshot in memory, never checked out, the way a variant's overlay is put
 * together. The store's working files and branch stay as they are.
 */
import { execFileSync } from 'node:child_process';
import { OpsError } from '../ids.js';
import { DEF_FOLDERS, normalText } from './hash.js';
import { SWARM_FILE } from './swarm.js';
import { DEFS_REF_RE } from './values.js';

export { DEFS_REF_RE };

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

/** Snapshots of `from_ref` variants (W5 phase 5) by store folder and ref, or why git failed. */
const keptSnapshots = new Map<string, DefsRefSnapshot | { ref: string; error: string }>();

const snapshotKey = (dir: string, ref: string): string => `${dir}\0${ref}`;

/**
 * Keeps the snapshot of `ref` in the store `dir`, or the reason git could not read it, for the
 * variants whose `from_ref` names it. swarmupd reads them off the event loop and keeps them here,
 * so a launch reads no git; see {@link defsSnapshotAt}.
 */
export function keepDefsSnapshot(
  dir: string,
  ref: string,
  snap: DefsRefSnapshot | { error: string },
): void {
  keptSnapshots.set(snapshotKey(dir, ref), { ...snap, ref });
}

/** The kept snapshot of `ref` in `dir`, or the reason git failed; undefined when none is kept. */
export function keptDefsSnapshot(
  dir: string,
  ref: string,
): DefsRefSnapshot | { ref: string; error: string } | undefined {
  return keptSnapshots.get(snapshotKey(dir, ref));
}

/**
 * The definitions of the store in `dir` at `ref` for a `from_ref` variant: the kept snapshot, else
 * read now with {@link readDefsAtRef} and kept. A ref git cannot read throws with exit 2.
 */
export function defsSnapshotAt(dir: string, ref: string): DefsRefSnapshot {
  let kept = keptDefsSnapshot(dir, ref);
  if (!kept) {
    try {
      kept = readDefsAtRef(dir, ref);
    } catch (err) {
      kept = { ref, error: (err as Error).message };
    }
    keepDefsSnapshot(dir, ref, kept);
  }
  if ('error' in kept) throw new OpsError(kept.error, 2);
  return kept;
}

/** Forgets every kept snapshot. */
export function clearDefsSnapshots(): void {
  keptSnapshots.clear();
}
