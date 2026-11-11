// One-time move of swarmupd's state folder from its name before the rename (AO-0200):
// `~/.agent-ops/opsd` becomes `~/.swarmup/swarmupd`.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { envVar, logMigration, migrationLogDir } from '@swarmup/core';
import { newStateDir, oldStateDir } from './config.js';
import { readDaemon, stopDaemon } from './daemon.js';

export interface StateMigrationOptions {
  /** The old state folder. Default: `~/.agent-ops/opsd`. */
  from?: string;
  /** The new state folder. Default: `~/.swarmup/swarmupd`. */
  to?: string;
  /** Where the result also goes, such as swarmupd's log. */
  log?: (line: string) => void;
  /** How long the old swarmupd gets to stop. */
  stopWaitMs?: number;
}

/**
 * Moves swarmupd's state folder (run records, logs, usage, chats, merge worktrees) to its new
 * path, once. Runs before swarmupd starts, from `startDaemon` and `runDaemon`.
 *
 * - Nothing happens when `SWARMUP_STATE_DIR` names the folder, when the new folder exists
 *   (already moved), or when there is no old one.
 * - A swarmupd still running on the old folder is stopped through its own `opsd.json` (its PID
 *   and API token), never by name; its runs keep going.
 * - The folder is renamed, not copied: it holds tens of thousands of files, and a rename on one
 *   disk is atomic, so a crash never leaves half of it in each place.
 * - When the rename fails (on Windows, a live run still writes its log in the folder), nothing
 *   changes: `stateDir` keeps returning the old folder, and the next start tries again.
 * - Merge worktrees inside the folder are re-linked with `git worktree repair`.
 *
 * Returns what it did, or null when it did nothing. Each step goes to the migration log.
 */
export async function migrateStateDir(
  env: NodeJS.ProcessEnv = process.env,
  opts: StateMigrationOptions = {},
): Promise<string | null> {
  if (!opts.from && envVar(env, 'STATE_DIR')) return null;
  const from = opts.from ?? oldStateDir();
  const to = opts.to ?? newStateDir();
  if (existsSync(to) || !existsSync(from)) return null;
  const logDir = migrationLogDir(env);
  const note = (line: string): string => {
    logMigration(logDir, `swarmupd state: ${line}`);
    opts.log?.(`swarmupd: ${line}`);
    return line;
  };
  const oldEnv: NodeJS.ProcessEnv = { ...env, SWARMUP_STATE_DIR: from, OPS_STATE_DIR: from };
  const running = readDaemon(oldEnv);
  if (running) {
    try {
      await stopDaemon({ env: oldEnv, waitMs: opts.stopWaitMs });
      note(`stopped the swarmupd on ${from} (pid ${running.pid}, from its opsd.json)`);
    } catch (err) {
      note(`could not stop the swarmupd on ${from}: ${(err as Error).message}; ${from} stays`);
      return null;
    }
  }
  try {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  } catch (err) {
    note(
      `could not move ${from} to ${to} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}); ` +
        `still using ${from}, the next start tries again`,
    );
    return null;
  }
  for (const wt of mergeWorktrees(to)) {
    try {
      execFileSync('git', ['worktree', 'repair'], {
        cwd: wt,
        windowsHide: true,
        stdio: 'ignore',
        timeout: 30_000,
      });
    } catch (err) {
      note(`could not repair the merge worktree ${wt}: ${(err as Error).message}`);
    }
  }
  return note(`moved ${from} to ${to}`);
}

/** The git worktrees swarmupd keeps in `<state>/merge/<root>`. */
function mergeWorktrees(state: string): string[] {
  const base = join(state, 'merge');
  try {
    return readdirSync(base)
      .map((n) => join(base, n))
      .filter((d) => {
        try {
          return statSync(d).isDirectory() && statSync(join(d, '.git')).isFile();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}
