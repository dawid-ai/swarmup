// Runs child processes from a worker thread. On Windows, even `execFile` creates the process on
// the calling thread, and on a loaded machine each `CreateProcess` takes 100-200 ms: opsd ran
// some 30 git commands per run launch and wrap-up, and its API waited for each one (AO-0171). A
// spawn in the worker blocks only the worker.
//
// The command's standard input, output and error are temporary files, not pipes. On Windows, a
// process the calling thread starts while the worker starts one can inherit the worker child's
// pipe ends: a long-lived agent run then held git's output pipe open, and the sync waiting for it
// hung until the run ended. An inherited file handle holds nothing up: the worker waits for the
// process to exit, then reads the files.
import { Worker } from 'node:worker_threads';

/** What `execFile` reports for a failed command, so callers read failures the same either way. */
export interface ExecFailure extends Error {
  stdout: string;
  stderr: string;
  /** The exit code, or a string such as `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`. */
  code?: number | string | null;
  killed?: boolean;
  signal?: string | null;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the command's standard input, which is then closed. */
  input?: string;
  maxBuffer?: number;
  /** Stops the command after this long, as `execFile`'s `timeout` does; 0 or unset waits. */
  timeoutMs?: number;
}

interface Request {
  id: number;
  file: string;
  args: string[];
  opts: ExecOptions;
}

interface Reply {
  id: number;
  stdout: string;
  stderr: string;
  error?: {
    message: string;
    code?: number | string | null;
    killed?: boolean;
    signal?: string | null;
  };
}

// Plain CommonJS, so the worker needs no build step and runs the same under the test runner.
const WORKER = `
const { parentPort } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let dir;
const tmp = () => (dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'opsd-exec-')));
const quiet = (f) => { try { f(); } catch {} };
const failure = (err) => ({ message: String((err && err.message) || err), code: err && err.code });
// Each command in flight has a slot whose files the next command in it truncates and reuses, so
// a call costs no file creation or deletion.
const free = [];
let slots = 0;
parentPort.on('message', ({ id, file, args, opts }) => {
  const slot = free.pop() ?? slots++;
  const base = path.join(tmp(), String(slot));
  const files = [base + '.in', base + '.out', base + '.err'];
  const fds = [];
  const closeFds = () => { for (const fd of fds.splice(0)) quiet(() => fs.closeSync(fd)); };
  const reply = (stdout, stderr, error) => {
    free.push(slot);
    parentPort.postMessage({ id, stdout, stderr, error });
  };
  let child;
  try {
    const stdio = ['ignore'];
    if (opts.input) {
      fs.writeFileSync(files[0], opts.input);
      fds.push(fs.openSync(files[0], 'r'));
      stdio[0] = fds[0];
    }
    for (const f of [files[1], files[2]]) {
      const fd = fs.openSync(f, 'w');
      fds.push(fd);
      stdio.push(fd);
    }
    child = spawn(file, args, { cwd: opts.cwd, env: opts.env, windowsHide: true, stdio });
  } catch (err) {
    closeFds();
    reply('', '', failure(err));
    return;
  }
  // The child has its own handles to the files.
  closeFds();
  let killed = false;
  let done = false;
  const timer = opts.timeoutMs
    ? setTimeout(() => { killed = true; child.kill(); }, opts.timeoutMs)
    : undefined;
  const finish = (code, signal, spawnErr) => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    let stdout = '';
    let stderr = '';
    quiet(() => { stdout = fs.readFileSync(files[1], 'utf8'); });
    quiet(() => { stderr = fs.readFileSync(files[2], 'utf8'); });
    const max = opts.maxBuffer ?? 64 * 1024 * 1024;
    let error;
    if (spawnErr) error = failure(spawnErr);
    else if (stdout.length > max || stderr.length > max) {
      error = { message: 'stdout maxBuffer length exceeded', code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' };
    } else if (code !== 0 || signal || killed) {
      const cmd = [file, ...args].join(' ');
      error = { message: 'Command failed: ' + cmd + '\\n' + stderr, code, killed, signal };
    }
    reply(stdout, stderr, error);
  };
  child.on('error', (err) => finish(null, null, err));
  child.on('exit', (code, signal) => finish(code, signal));
});
`;

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, { resolve: (s: string) => void; reject: (e: Error) => void }>();

function thread(): Worker {
  if (worker) return worker;
  const w = new Worker(WORKER, { eval: true });
  // Calls in flight keep the process alive through their promises' callers; an idle worker
  // never does.
  w.unref();
  w.on('message', (r: Reply) => {
    const p = pending.get(r.id);
    if (!p) return;
    pending.delete(r.id);
    if (!r.error) return p.resolve(r.stdout);
    const failure = Object.assign(new Error(r.error.message), {
      stdout: r.stdout,
      stderr: r.stderr,
      code: r.error.code,
      killed: r.error.killed,
      signal: r.error.signal,
    }) as ExecFailure;
    p.reject(failure);
  });
  const fail = (err: Error): void => {
    if (worker === w) worker = undefined;
    for (const [id, p] of pending) {
      pending.delete(id);
      p.reject(err);
    }
  };
  w.on('error', fail);
  w.on('exit', (code) => fail(new Error(`the process thread exited (${code})`)));
  worker = w;
  return w;
}

/**
 * Runs `file` with `args` in the worker thread and resolves to its standard output. Rejects with
 * an {@link ExecFailure} shaped like `execFile`'s error. The worker starts on the first call and
 * never keeps the process alive when idle.
 */
export function execOffThread(
  file: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const w = thread();
    const id = nextId++;
    // A call in flight holds the worker referenced, as a running `execFile` holds the process.
    const done = (): void => {
      if (pending.size === 0 && worker === w) w.unref();
    };
    pending.set(id, {
      resolve: (s) => {
        resolve(s);
        done();
      },
      reject: (e) => {
        reject(e);
        done();
      },
    });
    w.ref();
    const env = opts.env ? { ...opts.env } : undefined;
    w.postMessage({ id, file, args, opts: { ...opts, env } } satisfies Request);
  });
}
