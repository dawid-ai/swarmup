// Review artifacts and publish records (W8): what a reviewer reads at the reviewed commit, and
// what a person published. Git runs through a function the caller passes, so the CLI can run it
// directly and swarmupd off its event loop.
import { isAbsolute } from 'node:path';
import { OpsError } from './ids.js';
import type { OpsEvent, ReviewArtifact } from './model.js';

/** Runs git in the workspace with `args` and resolves to its output; rejects when git fails. */
export type GitRun = (args: string[]) => Promise<string>;

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
export async function changedArtifacts(
  git: GitRun,
  commit: string,
  bases: string[],
): Promise<ReviewArtifact[]> {
  let names: string[] = [];
  let found = false;
  for (const base of bases) {
    if (!(await commitOf(git, base))) continue;
    try {
      const mb = (await git(['merge-base', base, commit])).trim();
      if (!mb) continue;
      names = (await git(['diff', '--name-only', '--no-renames', '--diff-filter=d', mb, commit]))
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
      names = (
        await git(['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=d', '-r', commit])
      )
        .split('\n')
        .filter(Boolean);
    } catch {
      names = [];
    }
  }
  const out: ReviewArtifact[] = [];
  for (const ref of names.filter((n) => !NOT_WORK.test(n)).slice(0, MAX_CHANGED_ARTIFACTS)) {
    const blob = await blobAt(git, commit, ref);
    if (blob) out.push({ kind: artifactKindOf(ref), ref, blob });
  }
  return out;
}

/**
 * The artifacts `--artifact` names: URLs as given, paths checked against `commit` (they must be
 * in it) with their blobs. Without a commit a path needs `exists` to say it is on disk. `toTop`
 * turns a path as typed (from the folder the command runs in) into one from the workspace top.
 */
export async function namedArtifacts(
  git: GitRun,
  refs: string[],
  opts: { commit?: string; toTop: (p: string) => string; exists?: (p: string) => boolean },
): Promise<ReviewArtifact[]> {
  const out: ReviewArtifact[] = [];
  for (const raw of refs) {
    const ref = raw.trim();
    if (isWebUrl(ref)) {
      out.push({ kind: artifactKindOf(ref), ref });
      continue;
    }
    const path = workspacePath(opts.toTop(ref));
    if (opts.commit) {
      const blob = await blobAt(git, opts.commit, path);
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
 * before at another commit.
 */
export async function publishTarget(
  git: GitRun,
  id: string,
  opts: { rev?: string; path?: string } = {},
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
  await git(['tag', tag, commit]);
  return { commit, ...(path ? { path } : {}), ...(blob ? { blob } : {}), tag };
}
