// What `GET /api/tasks/:id/artifact` answers (W8): one file of a task's review, as it is at the
// reviewed commit, with the same file at its merge base for a prose diff. Git runs off the event
// loop; a path outside the workspace is refused.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitRun, OpsEvent } from '@swarmup/core';
import {
  artifactKindOf,
  commitOf,
  imageType,
  OpsError,
  reviewWithArtifacts,
  workspacePath,
} from '@swarmup/core';
import { gitAsync } from './git.js';

/** One artifact's content for the task panel's **Work** section. */
export interface TaskArtifact {
  path: string;
  /** The commit it was read at; null when read from the workspace's files. */
  commit: string | null;
  kind: 'text' | 'image';
  /** text: the file. */
  text?: string;
  /** image: a data URL. */
  data?: string;
  bytes: number;
  /** text at a commit: the file at the merge base with the root's base, or null when it is new. */
  base?: { commit: string; text: string | null } | null;
}

/** No artifact to show: the commit or the file is missing. */
export class NoArtifact extends Error {}

/** The largest image the API sends. */
export const MAX_ARTIFACT_IMAGE = 8 * 1024 * 1024;
/** How long one git call of the route may take. */
const GIT_TIMEOUT_MS = 30_000;

/** A blob's bytes, read with `git cat-file blob` off the event loop. */
function blobBytes(top: string, env: NodeJS.ProcessEnv, spec: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['cat-file', 'blob', spec],
      {
        cwd: top,
        env,
        windowsHide: true,
        encoding: 'buffer',
        maxBuffer: MAX_ARTIFACT_IMAGE + 1024,
        timeout: GIT_TIMEOUT_MS,
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

/**
 * Reads `path` of a task's work in the workspace `top`: at `commit`, else at the commit of the
 * task's latest review that names one, else from the workspace's files. A text file at a commit
 * comes with the same file at the merge base of the first of `bases` that exists.
 */
export async function readArtifact(o: {
  top: string;
  env: NodeJS.ProcessEnv;
  events: readonly OpsEvent[];
  path: string;
  commit?: string;
  bases?: string[];
}): Promise<TaskArtifact> {
  const path = workspacePath(o.path);
  const asked = o.commit?.trim() || reviewWithArtifacts(o.events)?.commit;
  if (asked && !/^[0-9a-f]{7,64}$/i.test(asked)) {
    throw new OpsError(`commit '${asked}' is no commit id`, 2);
  }
  const git: GitRun = (args) => gitAsync(o.top, args, { env: o.env, timeoutMs: GIT_TIMEOUT_MS });
  const image = artifactKindOf(path) === 'image';
  if (!asked) {
    let data: Buffer;
    try {
      data = await readFile(join(o.top, ...path.split('/')));
    } catch {
      throw new NoArtifact(`${path} is not in the workspace`);
    }
    return image
      ? { path, commit: null, kind: 'image', data: dataUrl(path, data), bytes: data.length }
      : { path, commit: null, kind: 'text', text: data.toString('utf8'), bytes: data.length };
  }
  const commit = await commitOf(git, asked);
  if (!commit) throw new NoArtifact(`the workspace has no commit ${asked}`);
  let data: Buffer;
  try {
    data = await blobBytes(o.top, o.env, `${commit}:${path}`);
  } catch {
    throw new NoArtifact(`${path} is not in ${commit.slice(0, 10)}`);
  }
  if (image) {
    return { path, commit, kind: 'image', data: dataUrl(path, data), bytes: data.length };
  }
  return {
    path,
    commit,
    kind: 'text',
    text: data.toString('utf8'),
    bytes: data.length,
    base: await baseText(git, commit, path, o.bases ?? ['main', 'master']),
  };
}

/** The file at the merge base of `commit` with the first base that exists; null when none. */
async function baseText(
  git: GitRun,
  commit: string,
  path: string,
  bases: string[],
): Promise<TaskArtifact['base']> {
  for (const b of bases) {
    if (!(await commitOf(git, b))) continue;
    let mb: string;
    try {
      mb = (await git(['merge-base', b, commit])).trim();
    } catch {
      continue;
    }
    if (!mb) continue;
    try {
      return { commit: mb, text: await git(['cat-file', 'blob', `${mb}:${path}`]) };
    } catch {
      return { commit: mb, text: null };
    }
  }
  return null;
}

function dataUrl(path: string, data: Buffer): string {
  if (data.length > MAX_ARTIFACT_IMAGE) {
    throw new NoArtifact(`${path} is over ${MAX_ARTIFACT_IMAGE / 1024 / 1024} MB`);
  }
  return `data:${imageType(path)};base64,${data.toString('base64')}`;
}
