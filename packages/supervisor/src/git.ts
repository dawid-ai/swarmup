import { execFile, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { execOffThread } from '@swarmup/core';

/** A git command that failed, with what it printed, as `execFileSync` reports it. */
export interface GitFailure extends Error {
  stdout: string;
  stderr: string;
  /** The exit code, or `ETIMEDOUT` when the command ran past its timeout. */
  code?: number | string;
}

/**
 * Runs git off the event loop and returns its output. swarmupd's API must keep answering while git
 * runs: each call costs tens of milliseconds on Windows, more under load (AO-0165). A failure
 * rejects with a {@link GitFailure}.
 *
 * @param opts.timeoutMs Stops git after this long; 0 or unset waits for it.
 * @param opts.tree On a timeout, stops what git started too, such as a hook that never exits
 *   (AO-0172). Without it, only git itself is stopped.
 * @param opts.maxBuffer How many bytes git may print on each stream; more ends the call with
 *   `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, as `execFile`'s `maxBuffer`. Defaults to 64 MiB.
 */
export function gitAsync(
  cwd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; tree?: boolean; maxBuffer?: number } = {},
): Promise<string> {
  const tree = Boolean(opts.tree && opts.timeoutMs);
  // Started from a worker thread: on Windows, starting a process alone held the event loop for
  // 100-200 ms on a loaded machine (AO-0171). A tree timeout needs the PID here, to stop what
  // git started, so that one stays on this thread.
  if (!tree) return gitOffThread(cwd, args, opts);
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    // `spawn`, not `execFile`: `execFile` drops `detached`, so off Windows git stayed in swarmupd's
    // process group and the group kill on a timeout reached nothing (AO-0240).
    const child = spawn('git', args, {
      cwd,
      env: opts.env,
      windowsHide: true,
      // Its own process group off Windows, so a timeout reaches what git started.
      detached: process.platform !== 'win32',
    });
    // The stream that first printed more than the limit, as `execFile` reports it.
    let overflow: 'stdout' | 'stderr' | undefined;
    const onOverflow = (stream: 'stdout' | 'stderr'): void => {
      if (overflow) return;
      overflow = stream;
      // Like `execFile`: the call ends with too much output, not with a later timeout.
      if (timer) clearTimeout(timer);
      timer = undefined;
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill('SIGKILL');
    };
    const limit = opts.maxBuffer ?? MAX_BUFFER;
    const out = collect(child.stdout, limit, () => onOverflow('stdout'));
    const errOut = collect(child.stderr, limit, () => onOverflow('stderr'));
    let settled = false;
    // Like `execFile`'s callback: after git exits and its output closes, or when it cannot start.
    const finish = (startErr: NodeJS.ErrnoException | null, code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const stdout = out.text();
      const stderr = errOut.text();
      // Past the deadline, the call is a timeout even when git exited 0: a process it started held
      // its output, and only the drain ended the call.
      if (!startErr && !overflow && code === 0 && !timedOut) return resolve(stdout);
      let message = `Command failed: git ${args.join(' ')}\n${stderr}`;
      if (startErr) message = startErr.message;
      else if (overflow) message = `${overflow} maxBuffer length exceeded`;
      else if (code === 0) {
        message = `git ${args.join(' ')} exited 0, but a process it started kept its output open past the timeout`;
      }
      const failure = new Error(message) as GitFailure;
      failure.stdout = stdout;
      failure.stderr = stderr;
      // Too much output first, as `execFile` reports it, then a timeout; a string code names
      // another cause.
      if (overflow) failure.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      else if (timedOut) failure.code = 'ETIMEDOUT';
      else if (startErr) failure.code = startErr.code;
      else if (code !== null) failure.code = code;
      reject(failure);
    };
    child.once('error', (err) => finish(err, null));
    child.once('close', (code) => finish(null, code));
    child.stdin.on('error', () => {});
    child.stdin.end();
    let exited = false;
    child.once('exit', () => {
      exited = true;
    });
    if (tree && child.pid !== undefined) {
      const pid = child.pid;
      timer = setTimeout(() => {
        timedOut = true;
        const drain = () => {
          child.kill('SIGKILL');
          // A process the stop missed may keep git's output open, and the callback waits for it
          // to close: stop reading after a while, so the timeout always ends the call.
          timer = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
          }, DRAIN_MS);
        };
        // On Windows, an exited git's PID may already name another process, and `taskkill /T`
        // cannot reach what git left behind anyway. Off Windows, git's process group outlives git.
        if (exited && process.platform === 'win32') drain();
        else stopTree(pid, drain);
      }, opts.timeoutMs);
    }
  });
}

async function gitOffThread(
  cwd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number },
): Promise<string> {
  try {
    return await execOffThread('git', args, {
      cwd,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      maxBuffer: opts.maxBuffer ?? MAX_BUFFER,
    });
  } catch (err) {
    const failure = err as GitFailure & { killed?: boolean };
    // Killed for its timeout; a string code names another cause, such as too much output.
    if (failure.killed && opts.timeoutMs && typeof failure.code !== 'string') {
      failure.code = 'ETIMEDOUT';
    }
    throw failure;
  }
}

/** How much output one git call may print on each stream, as `execFile`'s `maxBuffer`. */
const MAX_BUFFER = 64 * 1024 * 1024;

/** How long a stopped git may keep its output open, through a process it started. */
const DRAIN_MS = 5_000;

/**
 * Collects a stream of git's output as UTF-8. Past `limit` bytes, it keeps the first `limit`,
 * drops the rest and calls `onOverflow` once.
 */
function collect(stream: Readable, limit: number, onOverflow: () => void): { text: () => string } {
  const chunks: Buffer[] = [];
  let size = 0;
  let full = false;
  stream.on('data', (chunk: Buffer) => {
    if (full) return;
    if (size + chunk.length > limit) {
      // Keeps the output up to the limit, as `execFile` does.
      chunks.push(chunk.subarray(0, limit - size));
      size = limit;
      full = true;
      onOverflow();
      return;
    }
    size += chunk.length;
    chunks.push(chunk);
  });
  // A stream the drain destroys may report an error; the close that follows ends the call.
  stream.on('error', () => {});
  return { text: () => Buffer.concat(chunks).toString('utf8') };
}

/**
 * Stops `pid` and every process under it, while `pid` still runs, then calls `then`. A failure is
 * ignored: `then` kills git itself in any case.
 */
function stopTree(pid: number, then: () => void): void {
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The group is already gone.
    }
    return then();
  }
  // `/T` follows parent PIDs, so it reaches a hook's shell and what that shell started. Run off
  // the event loop, like git itself.
  execFile(
    'taskkill',
    ['/T', '/F', '/PID', String(pid)],
    { windowsHide: true, timeout: 15_000 },
    () => then(),
  );
}
