import type { OpsEvent } from '@swarmup/core';
import { MERGE_ACTOR } from '@swarmup/core';
import { type GitFailure, gitAsync } from './git.js';
import { pickMergeSource } from './merge.js';

/** One file of a task's diff. */
export interface DiffFile {
  path: string;
  /** The path before a rename or copy. */
  old?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'type';
  /** Lines added and deleted; 0 for a binary file. */
  added: number;
  deleted: number;
  binary?: true;
  /**
   * The file's hunks in unified format, from the first `@@` line on. Unset for a binary file, a
   * change of mode only, and a patch left out for its size (`omitted`).
   */
  patch?: string;
  /** Why the patch is left out: this file's is too large, or the whole diff is. */
  omitted?: 'file' | 'total';
}

/** One commit of the range a task's diff covers. */
export interface DiffCommit {
  sha: string;
  subject: string;
  author: string;
  /** ISO 8601, the author date. */
  at: string;
}

/** The diff of the work a task's review names (AO-0106). */
export interface TaskDiff {
  /** What the review names, or what swarmupd merged. */
  source: { commit?: string; branch?: string };
  /** The branch the work is compared with, or went into. */
  base: string;
  /** The commits compared, in full. */
  from: string;
  to: string;
  /** swarmupd merged the work: the diff is what the base got, after the rebase. */
  merged: boolean;
  /** Something the reader should know about the range, such as work that is in the base already. */
  note?: string;
  /** The commits from `from` to `to`, oldest first; the newest {@link MAX_COMMITS} of them. */
  commits: DiffCommit[];
  files: DiffFile[];
}

/** The task has no diff to show; `message` says why, for the reader. */
export class NoDiff extends Error {}

/** A file's patch above this many characters is left out. */
export const MAX_FILE_PATCH = 400_000;
/** Patches are left out once the ones before them add up to this many characters. */
export const MAX_TOTAL_PATCH = 3_000_000;
export const MAX_COMMITS = 200;

/** How much git may print for one diff; more gives the file list without patches. */
const MAX_DIFF_OUTPUT = 48 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;

/**
 * Never an external diff driver or a textconv filter: they are commands a repo's config names,
 * and reading a diff must run none. Prefixes and renames as the parser expects them, whatever the
 * user's git config says.
 */
const DIFF_ARGS = ['--no-color', '--no-ext-diff', '--no-textconv', '-M'];

type Git = (args: string[], maxBuffer?: number) => Promise<string>;

/** Git in `top`, off the event loop; read-only commands, with no prompt and no index refresh. */
function gitIn(top: string, env: NodeJS.ProcessEnv): Git {
  return (args, maxBuffer) =>
    gitAsync(top, ['-c', 'core.quotePath=false', ...args], {
      env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      timeoutMs: GIT_TIMEOUT_MS,
      ...(maxBuffer ? { maxBuffer } : {}),
    });
}

/** The commit `rev` names, or null. */
async function commitOf(git: Git, rev: string): Promise<string | null> {
  try {
    return (await git(['rev-parse', '--verify', '-q', `${rev}^{commit}`])).trim() || null;
  } catch {
    return null;
  }
}

const short = (sha: string): string => sha.slice(0, 7);

/**
 * The merge swarmupd recorded after the newest review, if any: the commit the base moved to, the
 * base, and the commit the work was rebased onto, which the merge's text names.
 */
export function mergedWork(
  events: Pick<OpsEvent, 'type' | 'actor' | 'body' | 'commit' | 'into' | 'branch'>[],
): { commit: string; into?: string; branch?: string; onto?: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'review') return null;
    if (e.type !== 'merge' || e.actor !== MERGE_ACTOR || !e.commit) continue;
    const onto = /\brebased onto ([0-9a-f]{7,40})\b/.exec(e.body)?.[1];
    return { commit: e.commit, into: e.into, branch: e.branch, onto };
  }
  return null;
}

/**
 * Reads the diff of the work a task's review names from the repo at `top`. Read-only: it asks git
 * for commits, never checks anything out.
 *
 * - Work swarmupd merged: from the commit it was rebased onto to the commit the base moved to.
 * - Else: what the newest review names (`pickMergeSource`, as the merge picks it), against where
 *   it left the base branch.
 *
 * @param o.base The branch approved work goes into (`swarmupd.merge.<root>.base`); without it,
 *   the remote's default branch, else `main` or `master`.
 * @throws NoDiff when no review names work the repo has.
 */
export async function taskDiff(o: {
  top: string;
  env: NodeJS.ProcessEnv;
  events: OpsEvent[];
  base?: string;
}): Promise<TaskDiff> {
  const git = gitIn(o.top, o.env);
  const reviews = o.events.filter((e) => e.type === 'review').reverse();
  if (reviews.length === 0) throw new NoDiff('No review request yet, so there is no work to show.');

  const merged = mergedWork(o.events);
  if (merged?.onto) {
    const to = await commitOf(git, merged.commit);
    const from = await commitOf(git, merged.onto);
    if (to && from) {
      return {
        source: { commit: merged.commit, ...(merged.branch ? { branch: merged.branch } : {}) },
        base: merged.into ?? o.base ?? '',
        from,
        to,
        merged: true,
        ...(await readDiff(git, from, to)),
      };
    }
  }

  const texts = reviews.map((e) => e.body);
  // As the merge does it: a first pass lists the commits the pick may ask about.
  const asked = new Set<string>();
  pickMergeSource(texts, {
    branch: () => false,
    commit: (sha) => {
      asked.add(sha);
      return false;
    },
  });
  const branches = new Set(
    (await git(['for-each-ref', '--format=%(refname)', 'refs/heads']))
      .split(/\r?\n/)
      .filter((l) => l.startsWith('refs/heads/'))
      .map((l) => l.slice('refs/heads/'.length)),
  );
  const found = new Set<string>();
  for (const sha of asked) if (await commitOf(git, sha)) found.add(sha);
  const src = pickMergeSource(texts, {
    branch: (name) => branches.has(name),
    commit: (sha) => found.has(sha),
  });
  if (!src) throw new NoDiff('No review request names a commit or a branch of this repo.');
  const to = src.commit
    ? await commitOf(git, src.commit)
    : ((await commitOf(git, `refs/heads/${src.branch}`)) ?? (await commitOf(git, src.branch!)));
  if (!to) {
    const missing = src.commit ? `Commit ${src.commit}` : `Branch ${src.branch}`;
    throw new NoDiff(`${missing} is not in the repo at ${o.top}.`);
  }

  const base = o.base ?? (await defaultBase(git, branches));
  if (!base) throw new NoDiff(`No base branch to compare with in the repo at ${o.top}.`);
  const baseTip = (await commitOf(git, `refs/heads/${base}`)) ?? (await commitOf(git, base));
  if (!baseTip) throw new NoDiff(`No branch ${base} in the repo at ${o.top}.`);
  let from: string;
  try {
    from = (await git(['merge-base', baseTip, to])).trim();
  } catch {
    from = '';
  }
  if (!from) throw new NoDiff(`${short(to)} and ${base} share no history.`);
  let note: string | undefined;
  if (from === to) {
    // The base already has the work, so its own range is unknown. A named commit still shows
    // what it changed; a branch names nothing more.
    const parent = src.commit ? await commitOf(git, `${to}^`) : null;
    if (!parent) throw new NoDiff(`${base} already has everything ${describe(src)} has.`);
    from = parent;
    note = `${base} already has ${short(to)}, so this shows that commit alone.`;
  }
  return {
    source: src,
    base,
    from,
    to,
    merged: false,
    ...(note ? { note } : {}),
    ...(await readDiff(git, from, to)),
  };
}

function describe(src: { commit?: string; branch?: string }): string {
  return src.commit ? `commit ${short(src.commit)}` : `branch ${src.branch}`;
}

/** The remote's default branch when it is a local branch too, else `main` or `master`. */
async function defaultBase(git: Git, branches: Set<string>): Promise<string | null> {
  try {
    const head = (await git(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])).trim();
    const name = head.replace(/^origin\//, '');
    if (name && branches.has(name)) return name;
  } catch {
    // No remote, or no default branch recorded for it.
  }
  return ['main', 'master'].find((b) => branches.has(b)) ?? null;
}

/** The commits and files between two commits, with each file's patch within the size limits. */
async function readDiff(
  git: Git,
  from: string,
  to: string,
): Promise<Pick<TaskDiff, 'commits' | 'files'>> {
  const [log, numstat, names] = await Promise.all([
    git([
      'log',
      `--max-count=${MAX_COMMITS}`,
      '--format=%H%x1f%s%x1f%an%x1f%aI%x1e',
      `${from}..${to}`,
    ]),
    git(['diff', ...DIFF_ARGS, '--numstat', '-z', from, to]),
    git(['diff', ...DIFF_ARGS, '--name-status', '-z', from, to]),
  ]);
  const commits = log
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha = '', subject = '', author = '', at = ''] = r.split('\x1f');
      return { sha, subject, author, at };
    })
    .reverse();
  const files = parseFiles(numstat, names);
  let patches: Map<string, string> | null;
  try {
    const text = await git(
      ['diff', ...DIFF_ARGS, '--src-prefix=a/', '--dst-prefix=b/', from, to],
      MAX_DIFF_OUTPUT,
    );
    patches = splitPatch(text);
  } catch (err) {
    if ((err as GitFailure).code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw err;
    patches = null;
  }
  let total = 0;
  for (const f of files) {
    if (f.binary) continue;
    const patch = patches?.get(f.path);
    if (!patches || total >= MAX_TOTAL_PATCH) {
      if (!patches || patch) f.omitted = 'total';
    } else if (patch === undefined) {
      continue;
    } else if (patch.length > MAX_FILE_PATCH) {
      f.omitted = 'file';
    } else {
      f.patch = patch;
      total += patch.length;
    }
  }
  return { commits, files };
}

const STATUS: Record<string, DiffFile['status']> = {
  A: 'added',
  D: 'deleted',
  M: 'modified',
  R: 'renamed',
  C: 'copied',
  T: 'type',
};

/**
 * The files of `git diff --numstat -z` and `--name-status -z` for the same range, in git's
 * order. A rename or copy takes two paths in both: `<added>\t<deleted>\t\0<old>\0<new>\0` and
 * `R<score>\0<old>\0<new>\0`.
 */
export function parseFiles(numstat: string, nameStatus: string): DiffFile[] {
  const status = new Map<string, DiffFile['status']>();
  const names = nameStatus.split('\0');
  for (let i = 0; i < names.length;) {
    const code = names[i++]!;
    if (!code) continue;
    const two = code[0] === 'R' || code[0] === 'C';
    if (two) i++;
    const path = names[i++];
    if (path !== undefined) status.set(path, STATUS[code[0]!] ?? 'modified');
  }
  const files: DiffFile[] = [];
  const parts = numstat.split('\0');
  for (let i = 0; i < parts.length;) {
    const head = parts[i++]!;
    if (!head) continue;
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(head);
    if (!m) continue;
    let path = m[3]!;
    let old: string | undefined;
    if (path === '') {
      old = parts[i++];
      path = parts[i++] ?? '';
    }
    if (!path) continue;
    const binary = m[1] === '-';
    files.push({
      path,
      ...(old !== undefined ? { old } : {}),
      status: status.get(path) ?? (old !== undefined ? 'renamed' : 'modified'),
      added: binary ? 0 : Number(m[1]),
      deleted: binary ? 0 : Number(m[2]),
      ...(binary ? { binary: true as const } : {}),
    });
  }
  return files;
}

/**
 * Splits `git diff` output into each file's hunks, by the file's new path (its old path when
 * deleted). A file with no hunks, such as a binary one, gets no entry. Git quotes a path with a
 * tab, a line break or a quote in it; such a file's hunks end up under no real path and are not
 * shown.
 */
export function splitPatch(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    if (!lines[i]!.startsWith('diff --git ')) {
      i++;
      continue;
    }
    let path: string | undefined;
    let older: string | undefined;
    i++;
    // The header, up to the first hunk or the next file.
    while (i < lines.length && !lines[i]!.startsWith('@@') && !isFileStart(lines[i]!)) {
      const l = lines[i]!.replace(/\r$/, '');
      if (l.startsWith('rename to ')) path = l.slice('rename to '.length);
      else if (l.startsWith('copy to ')) path = l.slice('copy to '.length);
      else if (l.startsWith('+++ b/')) path ??= l.slice(6).replace(/\t$/, '');
      else if (l.startsWith('--- a/')) older = l.slice(6).replace(/\t$/, '');
      i++;
    }
    const start = i;
    // Inside the hunks every line starts with ' ', '+', '-', '\' or '@', so a line that starts
    // with 'diff --git ' is the next file.
    while (i < lines.length && !isFileStart(lines[i]!)) i++;
    const key = path ?? older;
    if (key === undefined || i === start) continue;
    let hunks = lines.slice(start, i).join('\n');
    if (!hunks.endsWith('\n')) hunks += '\n';
    out.set(key, (out.get(key) ?? '') + hunks);
  }
  return out;
}

function isFileStart(line: string): boolean {
  return line.startsWith('diff --git ');
}
