// Git logic written once, as generators that yield each git command they need. `runSteps` runs
// the commands synchronously, for the CLI; `runStepsAsync` runs them off the event loop, for swarmupd,
// whose API must keep answering while a sync or a mirror runs (AO-0165, AO-0169).
import { execFileSync } from 'node:child_process';
import { type ExecFailure, execOffThread } from './exec-thread.js';
import { OpsError } from './ids.js';

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function gitFailed(args: string[], stderr: string | undefined, message: string): OpsError {
  return new OpsError(`git ${args[0]} failed: ${(stderr || message).trim()}`);
}

export function git(cwd: string, args: string[], cmd = 'git'): string {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw gitFailed(args, e.stderr, e.message);
  }
}

/** Runs git from a worker thread, so even starting it never holds the event loop (AO-0171). */
export async function gitAsync(cwd: string, args: string[], cmd = 'git'): Promise<string> {
  try {
    return await execOffThread(cmd, args, { cwd, maxBuffer: GIT_MAX_BUFFER });
  } catch (err) {
    const e = err as ExecFailure;
    throw gitFailed(args, e.stderr, e.message);
  }
}

/** One git command a step needs run; the step gets its output back, or its error thrown in. */
export interface GitCall {
  cwd: string;
  args: string[];
  /** The program to run when it is not git, such as the one that lists processes. */
  cmd?: string;
}

/** A step of git work: yields each git command, gets its output back, returns `T`. */
export type GitSteps<T> = Generator<GitCall, T, string>;

export function* gitStep(cwd: string, args: string[]): GitSteps<string> {
  return yield { cwd, args };
}

/** Runs a git command; true when it exits 0. */
export function* gitOk(cwd: string, args: string[]): GitSteps<boolean> {
  try {
    yield* gitStep(cwd, args);
    return true;
  } catch {
    return false;
  }
}

/** Runs a git command; its output, or null when it fails. */
export function* gitOrNull(cwd: string, args: string[]): GitSteps<string | null> {
  try {
    return yield* gitStep(cwd, args);
  } catch {
    return null;
  }
}

export function runSteps<T>(steps: GitSteps<T>): T {
  let next = steps.next();
  while (!next.done) {
    let out: string;
    try {
      out = git(next.value.cwd, next.value.args, next.value.cmd);
    } catch (err) {
      next = steps.throw(err);
      continue;
    }
    next = steps.next(out);
  }
  return next.value;
}

export async function runStepsAsync<T>(steps: GitSteps<T>): Promise<T> {
  let next = steps.next();
  while (!next.done) {
    let out: string;
    try {
      out = await gitAsync(next.value.cwd, next.value.args, next.value.cmd);
    } catch (err) {
      next = steps.throw(err);
      continue;
    }
    next = steps.next(out);
  }
  return next.value;
}
