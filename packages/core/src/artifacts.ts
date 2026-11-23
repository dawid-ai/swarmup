// Review artifacts and publish records (W8): what a reviewer reads at the reviewed commit, and
// what a person published. Git runs through a function the caller passes, so the CLI can run it
// directly and swarmupd off its event loop.
import { isAbsolute } from 'node:path';
import { OpsError } from './ids.js';
import type { OpsEvent, PublishEdits, ReviewArtifact } from './model.js';
import { MERGE_ACTOR } from './model.js';

/** Runs git in the workspace with `args` and resolves to its output; rejects when git fails. */
export type GitRun = (args: string[]) => Promise<string>;

/**
 * Runs git in the workspace with `args` and returns its output; throws when git fails. The CLI's
 * review and publish helpers take it, so `swarmup review` stays synchronous.
 */
export type GitRunSync = (args: string[]) => string;

/** Changed paths a review records on its own leaves out: the project map is not the work. */
const NOT_WORK = /^\.swarmup\//;

/** The most changed files a review records on its own. */
export const MAX_CHANGED_ARTIFACTS = 50;

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
const DOC_HOSTS = /^https?:\/\/(?:docs\.google\.com|[\w-]+\.notion\.site|(?:www\.)?notion\.so)\//i;

/** True for an http(s) URL. */
export function isWebUrl(ref: string): boolean {
  return /^https?:\/\/\S+$/i.test(ref);
}

/** The kind of an artifact ref: a URL (a known document host is a `doc`), an image, or a file. */
export function artifactKindOf(ref: string): ReviewArtifact['kind'] {
  if (isWebUrl(ref)) return DOC_HOSTS.test(ref) ? 'doc' : 'url';
  return IMAGE_RE.test(ref) ? 'image' : 'file';
}

/** The media type of an image path, for a data URL. */
export function imageType(path: string): string {
  const ext = /\.([a-z]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'svg') return 'image/svg+xml';
  return `image/${ext || 'png'}`;
}

/**
 * A path inside the workspace, as git names it: `/`-separated, from the top, without `./`.
 * Refuses an absolute path, a drive, and any `..` that would leave the workspace, with exit 2.
 */
export function workspacePath(path: string): string {
  const p = path.trim().replace(/\\/g, '/');
  if (!p || isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.startsWith('/')) {
    throw new OpsError(`${path}: name a path inside the workspace, from its top`, 2);
  }
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) throw new OpsError(`${path} is outside the workspace`, 2);
      parts.pop();
    } else parts.push(seg);
  }
  if (parts.length === 0) throw new OpsError(`${path}: name a file`, 2);
  return parts.join('/');
}

/** The blob of `path` at `commit`, or null when the commit has no such file. */
export async function blobAt(git: GitRun, commit: string, path: string): Promise<string | null> {
  try {
    const out = (await git(['rev-parse', '--verify', '-q', `${commit}:${path}`])).trim();
    return /^[0-9a-f]{40,64}$/i.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** {@link blobAt} with git run synchronously. */
function blobAtSync(git: GitRunSync, commit: string, path: string): string | null {
  try {
    const out = git(['rev-parse', '--verify', '-q', `${commit}:${path}`]).trim();
    return /^[0-9a-f]{40,64}$/i.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** {@link commitOf} with git run synchronously. */
function commitOfSync(git: GitRunSync, rev: string): string | null {
  try {
    const out = git(['rev-parse', '--verify', '-q', `${rev}^{commit}`]).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** The full id of `rev` as a commit, or null when there is none. */
export async function commitOf(git: GitRun, rev: string): Promise<string | null> {
  try {
    const out = (await git(['rev-parse', '--verify', '-q', `${rev}^{commit}`])).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * The files the work of `commit` changed, from its merge base with the first of `bases` that
 * exists, as file and image artifacts with their blobs, minus the project map. Without a base,
 * the files of the commit itself. Deleted files are left out; at most `MAX_CHANGED_ARTIFACTS`.
 */
export function changedArtifacts(
  git: GitRunSync,
  commit: string,
  bases: string[],
): ReviewArtifact[] {
  let names: string[] = [];
  let found = false;
  for (const base of bases) {
    if (!commitOfSync(git, base)) continue;
    try {
      const mb = git(['merge-base', base, commit]).trim();
      if (!mb) continue;
      names = git(['diff', '--name-only', '--no-renames', '--diff-filter=d', mb, commit])
        .split('\n')
        .filter(Boolean);
      found = true;
      break;
    } catch {
      continue;
    }
  }
  if (!found) {
    try {
      names = git(['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=d', '-r', commit])
        .split('\n')
        .filter(Boolean);
    } catch {
      names = [];
    }
  }
  const out: ReviewArtifact[] = [];
  for (const ref of names.filter((n) => !NOT_WORK.test(n)).slice(0, MAX_CHANGED_ARTIFACTS)) {
    const blob = blobAtSync(git, commit, ref);
    if (blob) out.push({ kind: artifactKindOf(ref), ref, blob });
  }
  return out;
}

/**
 * The artifacts `--artifact` names: URLs as given, paths checked against `commit` (they must be
 * in it) with their blobs. Without a commit a path needs `exists` to say it is on disk. `toTop`
 * turns a path as typed (from the folder the command runs in) into one from the workspace top.
 */
export function namedArtifacts(
  git: GitRunSync,
  refs: string[],
  opts: { commit?: string; toTop: (p: string) => string; exists?: (p: string) => boolean },
): ReviewArtifact[] {
  const out: ReviewArtifact[] = [];
  for (const raw of refs) {
    const ref = raw.trim();
    if (isWebUrl(ref)) {
      out.push({ kind: artifactKindOf(ref), ref });
      continue;
    }
    const path = workspacePath(opts.toTop(ref));
    if (opts.commit) {
      const blob = blobAtSync(git, opts.commit, path);
      if (!blob) {
        throw new OpsError(
          `--artifact ${ref}: ${path} is not in ${opts.commit.slice(0, 10)}; commit it first`,
          2,
        );
      }
      out.push({ kind: artifactKindOf(path), ref: path, blob });
    } else {
      if (opts.exists && !opts.exists(path))
        throw new OpsError(`--artifact ${ref}: no such file`, 2);
      out.push({ kind: artifactKindOf(path), ref: path });
    }
  }
  return out;
}

/** The latest review event of a task that names artifacts, else the latest review. */
export function reviewWithArtifacts(events: readonly OpsEvent[]): OpsEvent | undefined {
  const reviews = events.filter((e) => e.type === 'review');
  return [...reviews].reverse().find((e) => e.artifacts?.length) ?? reviews[reviews.length - 1];
}

/** Where a publish happened in the workspace, for the `publish` event. */
export interface PublishTarget {
  commit: string;
  path?: string;
  blob?: string;
  tag: string;
}

/**
 * Finds what `swarmup published ID` records and tags it: the commit of `rev` (default `HEAD`),
 * the blob of `path` there (refused with exit 2 when the commit lacks it), and a new tag
 * `published/<ID>` on that commit, or `published/<ID>-2` and up when the task was published
 * before at another commit. With `create: false` it names the tag without putting it on.
 */
export async function publishTarget(
  git: GitRun,
  id: string,
  opts: { rev?: string; path?: string; create?: boolean } = {},
): Promise<PublishTarget> {
  const rev = opts.rev ?? 'HEAD';
  const commit = await commitOf(git, rev);
  if (!commit) throw new OpsError(`the workspace has no commit ${rev}`, 2);
  let path: string | undefined;
  let blob: string | undefined;
  if (opts.path) {
    path = workspacePath(opts.path);
    blob = (await blobAt(git, commit, path)) ?? undefined;
    if (!blob) throw new OpsError(`--artifact ${opts.path}: not in ${commit.slice(0, 10)}`, 2);
  }
  const base = `published/${id}`;
  const taken = new Set(
    (await git(['tag', '--list', base, `${base}-*`]))
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean),
  );
  let tag = base;
  for (let n = 2; taken.has(tag); n++) {
    // The same commit published again keeps its tag.
    if ((await commitOf(git, `refs/tags/${tag}`)) === commit) return { commit, path, blob, tag };
    tag = `${base}-${n}`;
  }
  if (opts.create !== false) await git(['tag', tag, commit]);
  return { commit, ...(path ? { path } : {}), ...(blob ? { blob } : {}), tag };
}

/** A file of approved work (W8 phase 3): what a publish task publishes and previews. */
export interface ApprovedFile {
  /** From the top of the workspace. */
  path: string;
  /** Its blob at the reviewed commit. */
  blob: string;
  /** The task whose review was approved. */
  task: string;
  /** The reviewed commit, when the review named one. */
  commit?: string;
  /** The approving verdict. */
  verdict: string;
}

/**
 * The files of the approved work of each task, in order: the `file` and `image` artifacts (with
 * blobs) of the latest review before each task's latest approving verdict (swarmupd's own
 * verdicts aside). A task with no approval, or whose approved review names no files, adds
 * none; a path a later task names again is left out.
 */
export function approvedFiles(
  sources: ReadonlyArray<{ id: string; events: readonly OpsEvent[] }>,
): ApprovedFile[] {
  const out: ApprovedFile[] = [];
  const seen = new Set<string>();
  for (const s of sources) {
    let review: OpsEvent | undefined;
    let approved: { review?: OpsEvent; verdict: OpsEvent } | undefined;
    for (const e of s.events) {
      if (e.type === 'review') review = e;
      if (e.type === 'verdict' && e.verdict === 'approve' && e.actor !== MERGE_ACTOR) {
        approved = { review, verdict: e };
      }
      if (e.type === 'reopen') approved = undefined;
    }
    if (!approved?.review) continue;
    for (const a of approved.review.artifacts ?? []) {
      if ((a.kind !== 'file' && a.kind !== 'image') || !a.blob || seen.has(a.ref)) continue;
      seen.add(a.ref);
      out.push({
        path: a.ref,
        blob: a.blob,
        task: s.id,
        ...(approved.review.commit ? { commit: approved.review.commit } : {}),
        verdict: approved.verdict.id,
      });
    }
  }
  return out;
}

/** The most cells the word diff fills; past it, words are compared as multisets. */
const DIFF_CELLS = 16_000_000;

/**
 * The words taken out of `a` plus the words put into it to make `b` (from a longest common
 * subsequence of their words; a pair too long for that compares them as multisets), and the
 * words of both. Whitespace and line breaks do not count.
 */
export function wordEdits(a: string, b: string): { changed: number; total: number } {
  const x = a.split(/\s+/).filter(Boolean);
  const y = b.split(/\s+/).filter(Boolean);
  const total = x.length + y.length;
  if (x.length * y.length > DIFF_CELLS) {
    const count = new Map<string, number>();
    for (const w of x) count.set(w, (count.get(w) ?? 0) + 1);
    let common = 0;
    for (const w of y) {
      const n = count.get(w) ?? 0;
      if (n > 0) {
        common++;
        count.set(w, n - 1);
      }
    }
    return { changed: total - 2 * common, total };
  }
  // One row of the table at a time: lengths of the common subsequence of x and y[..j].
  let prev = new Uint32Array(y.length + 1);
  let cur = new Uint32Array(y.length + 1);
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    [prev, cur] = [cur, prev];
  }
  return { changed: total - 2 * prev[y.length]!, total };
}

/**
 * The edits between approval and publishing of each approved text file the publish has (its
 * path in `paths`, and in `commit`): its approved blob against its blob at `commit`. Undefined
 * when no file has both.
 */
export async function publishEdits(
  git: GitRun,
  approved: readonly ApprovedFile[],
  commit: string,
  paths: readonly string[],
): Promise<PublishEdits | undefined> {
  const files: PublishEdits['files'] = [];
  for (const f of approved) {
    if (!paths.includes(f.path) || artifactKindOf(f.path) !== 'file') continue;
    const now = await blobAt(git, commit, f.path);
    if (!now) continue;
    let before: string;
    let after: string;
    try {
      before = await git(['cat-file', 'blob', f.blob]);
      after = now === f.blob ? before : await git(['cat-file', 'blob', now]);
    } catch {
      continue;
    }
    files.push({ path: f.path, task: f.task, verdict: f.verdict, ...wordEdits(before, after) });
  }
  if (files.length === 0) return undefined;
  return {
    changed: files.reduce((n, f) => n + f.changed, 0),
    total: files.reduce((n, f) => n + f.total, 0),
    files,
  };
}
