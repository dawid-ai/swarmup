// One-time move of a repo's task store from `.agent-ops/` to `.swarmup/` (AO-0200).
import { existsSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  logMigration,
  migrationLogDir,
  OLD_ROOT_DIR_NAME,
  ROOT_DIR_NAME,
  storeDirIn,
} from './config.js';
import { git } from './git-steps.js';
import { OpsError } from './ids.js';
import { Root } from './root.js';
import { storeCommitHold } from './sync.js';

export interface StoreMove {
  from: string;
  to: string;
  /** The commit that records the move, or null when the store is not tracked in git. */
  commit: string | null;
}

/** The message of the commit that moves a store. `ops: ` marks it as a store commit for sync. */
export const STORE_MOVE_MESSAGE = `ops: move the task store from ${OLD_ROOT_DIR_NAME}/ to ${ROOT_DIR_NAME}/`;

/**
 * Moves the task store of `repo` from `.agent-ops/` to `.swarmup/` and, when git tracks it,
 * commits the move on the store branch (not pushed: the next sync pushes it). Every clone that
 * pulls the commit gets `.swarmup/` from git; its local `.ops/` state follows on first use (see
 * `adoptLocalState`).
 *
 * Returns null when the repo already uses `.swarmup/`. Refuses, changing nothing, when:
 * - both folders hold a store (`storeDirIn` explains);
 * - the repo has no store at all;
 * - a `.swarmup/` folder with other files is in the way;
 * - git has uncommitted store changes (sync first), or the checkout is not on the store branch.
 *
 * The caller makes sure no swarmupd or desktop app has the store open: on Windows an open file in
 * the folder makes the rename fail, and then nothing has changed.
 */
export function moveStore(repo: string, env: NodeJS.ProcessEnv = process.env): StoreMove | null {
  const current = storeDirIn(repo);
  const from = join(repo, OLD_ROOT_DIR_NAME);
  const to = join(repo, ROOT_DIR_NAME);
  if (!current) throw new OpsError(`${repo} has no task store to move`, 2);
  if (current === to) return null;
  if (existsSync(to)) {
    const inTheWay = readdirSync(to);
    if (inTheWay.length > 0) {
      throw new OpsError(
        `${to} exists and holds ${inTheWay.join(', ')}; move it aside, then run swarmup migrate again`,
        2,
      );
    }
    rmdirSync(to);
  }

  const top = gitTop(repo);
  const tracked = top !== null && git(top, ['ls-files', '--', rel(top, from)]).trim() !== '';
  if (top !== null && tracked) {
    const dirty = git(top, ['status', '--porcelain', '--', rel(top, from)])
      .split('\n')
      .filter((l) => l.trim() !== '');
    if (dirty.length > 0) {
      throw new OpsError(
        `${from} has ${dirty.length} uncommitted change(s); run swarmup sync first, then swarmup migrate`,
        2,
      );
    }
    const hold = storeCommitHold(new Root(from));
    if (hold) throw new OpsError(`cannot commit the move: ${hold.replace(/^not synced: /, '')}`, 2);
  }

  try {
    renameSync(from, to);
  } catch (err) {
    throw new OpsError(
      `could not rename ${from} to ${to} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}); ` +
        'stop swarmupd (swarmup daemon stop) and close the desktop app and editors that have the folder open, then try again',
    );
  }

  let commit: string | null = null;
  if (top !== null && tracked) {
    const paths = [rel(top, from), rel(top, to)];
    try {
      git(top, ['add', '-A', '--', ...paths]);
      git(top, ['commit', '-q', '-m', STORE_MOVE_MESSAGE, '--', ...paths]);
      commit = git(top, ['rev-parse', 'HEAD']).trim();
    } catch (err) {
      // Put the folder back, so the repo is as it was before.
      try {
        git(top, ['reset', '-q', '--', ...paths]);
        renameSync(to, from);
      } catch {
        // Left for a person: the message below says where things are.
      }
      throw new OpsError(
        `could not commit the move of ${from} to ${to}: ${(err as Error).message}`,
      );
    }
  }
  logMigration(
    migrationLogDir(env),
    `store: moved ${from} to ${to}${commit ? ` in commit ${commit.slice(0, 8)} (not pushed yet)` : ''}`,
  );
  return { from, to, commit };
}

function gitTop(dir: string): string | null {
  try {
    return git(dir, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    return null;
  }
}

/** `p` relative to the repo top, with forward slashes, for a git pathspec. */
function rel(top: string, p: string): string {
  return relative(top, p).split(sep).join('/') || '.';
}
