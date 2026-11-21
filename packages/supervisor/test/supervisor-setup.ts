// Shared setup of the supervisor-*.test.ts files, split from one supervisor.test.ts that ran past
// 25 minutes in merge checks (AO-0397). Importing this module registers its hooks in the importing file.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach } from 'vitest';
import { initRoot, Workspace } from '@swarmup/core';
import type { ProcLister, RunRecord } from '../src/index.js';
import { processStart, opsdConfig, Supervisor } from '../src/index.js';
import { gitAsync } from '../src/git.js';
import { WAIT_MS } from './until.js';

export const here = dirname(fileURLToPath(import.meta.url));

export const repoTop = join(here, '..', '..', '..');

// Resolved like any import, so a worktree without its own node_modules finds the tsc of the
// checkout that holds it.
export const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

export const coreDist = join(repoTop, 'packages', 'core', 'dist', 'index.js');

export const dirs: string[] = [];

export const sups: Supervisor[] = [];

// The fake agent is a separate process, so it needs the built core: `vitest.global-setup.ts` builds
// it once before any test file starts, so the five files that import this module never build it at
// the same time.

// `close` may wait about a minute for killed runs and their wrap-up (its own limits add up to
// 65 s), so the hook gets 90 s instead of the 10 s default. It takes this test's supervisors and
// directories before it awaits anything: a hook that still runs after a timeout must never
// delete the next test's repo (AO-0182).
afterEach(async () => {
  const mine = sups.splice(0);
  const gone = dirs.splice(0);
  let failed: unknown;
  try {
    for (const s of mine) {
      s.stop({ killRuns: true });
      await s.close();
    }
  } finally {
    // Windows can hold a just-written file in a stopped swarmupd's state folder for a few seconds
    // (EPERM); retry for about 5 s, as push.test.ts and merge-setup.ts do. A folder Windows still
    // holds after that is left in the temp folder: the test itself has passed or failed already.
    for (const d of gone) {
      try {
        rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EBUSY' || code === 'ENOTEMPTY') {
          console.warn(`left ${d}: ${code}`);
        } else {
          failed ??= err;
        }
      }
    }
  }
  if (failed) throw failed;
}, 90_000);

export function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmupd-test-'));
  dirs.push(d);
  return d;
}

/** A fake runtime: reads the prompt, reports token use, then finishes, crashes or hangs. */
export const FAKE_AGENT = `
if (process.argv.includes('sign-in-status')) {
  // The runtime's sign-in check (AO-0154), in the shape of \`claude auth status\`.
  const signedIn = (await import('node:fs')).readFileSync(process.env.FAKE_SIGNIN, 'utf8').trim() === 'in';
  console.log(JSON.stringify({ loggedIn: signedIn, authMethod: 'fake' }));
  process.exit(signedIn ? 0 : 1);
}
const { Workspace } = await import(${JSON.stringify(pathToFileURL(coreDist).href)});
// Before stdin: proves the process started, whether or not it ever gets a prompt.
if (process.env.FAKE_MARK) (await import('node:fs')).writeFileSync(process.env.FAKE_MARK, String(process.ppid));
if (process.env.FAKE_PID) (await import('node:fs')).writeFileSync(process.env.FAKE_PID, String(process.pid));
let prompt = '';
for await (const c of process.stdin) prompt += c;
if (process.env.FAKE_PROMPT) (await import('node:fs')).writeFileSync(process.env.FAKE_PROMPT, prompt);
const modeFile = process.env.FAKE_MODE_FILE;
const mode = (modeFile && (await import('node:fs')).existsSync(modeFile)
  ? (await import('node:fs')).readFileSync(modeFile, 'utf8').trim()
  : process.env.FAKE_MODE) ?? 'done';
if (mode === 'auth') {
  // What Claude Code prints when its OAuth session expired (AO-0150).
  const text = 'Failed to authenticate: OAuth session expired and could not be refreshed';
  console.log(JSON.stringify({ type: 'assistant', message: { id: 'm0', model: '<synthetic>', content: [{ type: 'text', text }] }, error: 'authentication_failed', is_api_error_message: true }));
  console.log(JSON.stringify({ type: 'result', is_error: true, result: text }));
  process.exit(1);
}
const task = /Work on (\\S+):/.exec(prompt)?.[1] ?? /earlier session of (\\S+) /.exec(prompt)?.[1];
const ws = new Workspace({ cwd: process.cwd(), env: process.env });
console.log(JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 100, output_tokens: 50 } } }));
// 'idle' hangs without touching the task, so it cannot see a claim swarmupd has yet to report lost.
if (task && mode !== 'idle') ws.start(task, 'fake plan');
if (mode === 'idle') setInterval(() => {}, 1000);
else if (mode === 'done') { if (task) ws.done(task, 'fake done'); }
else if (mode === 'crash') process.exit(3);
else if (mode === 'sandbox-fail') {
  // What a Codex run printed when its sandbox refused every shell call (AO-0173): exit 0.
  for (let i = 0; i < 3; i++) console.error('2026-11-10T06:54:23.908820Z ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: "refusing to run unsandboxed" }');
  if (process.env.FAKE_SECRET) console.error('Error: env GH_TOKEN=' + process.env.FAKE_SECRET);
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'Blocked before task execution: every shell invocation failed.' } }));
}
else if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'big') {
  const filler = 'x'.repeat(1023) + '\\n';
  for (let i = 0; i < 5 * 1024; i++) process.stdout.write(filler);
  console.log(JSON.stringify({ type: 'assistant', message: { id: 'm2', usage: { input_tokens: 1000, output_tokens: 1 } } }));
}
else if (mode === 'orphan') {
  // Starts B, which starts C and exits; C lives on until something kills it.
  const { spawn } = await import('node:child_process');
  spawn(process.execPath, [process.env.FAKE_B], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  await new Promise((r) => setTimeout(r, Number(process.env.FAKE_LINGER ?? 4000)));
}
else if (mode === 'limited') {
  const resetsAt = Number(process.env.FAKE_RESET);
  console.log(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt, rateLimitType: 'seven_day', unifiedWindows: { seven_day: { utilization: 0.95, resetsAt, status: 'allowed_warning' } } } }));
}
else if (mode === 'hit') {
  console.log(JSON.stringify({ type: 'result', is_error: true, result: 'Claude AI usage limit reached|' + process.env.FAKE_RESET }));
}
else if (mode === 'hit-codex') {
  console.log(JSON.stringify({ type: 'error', message: "You've hit your usage limit." }));
}
else if (mode === 'hit-both') {
  const resetsAt = Number(process.env.FAKE_RESET);
  console.log(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' } }));
  console.log(JSON.stringify({ type: 'error', message: "You've hit your usage limit." }));
}
else if ((mode === 'edit-wait' || mode === 'edit-move') && process.env.SWARMUP_PARENT_RUN) {
  // A helper: writes in the checkout until it is killed. It appends, so a kill between two
  // writes never empties a file that had content (AO-0239).
  const fs = await import('node:fs');
  for (let i = 0; ; i++) {
    fs.appendFileSync(process.env.FAKE_HELPER_GO ?? 'helper.txt', String(i) + '\\n');
    await new Promise((r) => setTimeout(r, 50));
  }
}
else if (mode === 'edit' || mode === 'edit-review' || mode === 'edit-wait' || mode === 'edit-move' || mode === 'edit-move-review') {
  // A sandboxed run: changes files, cannot commit them.
  const fs = await import('node:fs');
  fs.writeFileSync('tracked.txt', 'changed by the run\\n');
  fs.rmSync('gone.txt');
  fs.mkdirSync('src/new', { recursive: true });
  fs.writeFileSync('src/new/added.txt', 'new\\n');
  if (mode === 'edit-review' && task) ws.review(task, 'changed files are in the checkout');
  if (mode === 'edit-wait') {
    while (!fs.existsSync(process.env.FAKE_GO)) await new Promise((r) => setTimeout(r, 50));
  }
  if (mode === 'edit-move' || mode === 'edit-move-review') {
    // Moves HEAD, then leaves a change on top of it.
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['commit', '-qam', 'run commit'], { windowsHide: true });
    fs.writeFileSync('tracked.txt', 'changed after the move\\n');
  }
  if (mode === 'edit-move-review' && task) ws.review(task, 'committed; one more change is in the checkout');
}
else if (mode === 'commit') {
  const fs = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  fs.writeFileSync('tracked.txt', 'committed by the run\\n');
  execFileSync('git', ['commit', '-qam', 'run commit'], { windowsHide: true });
  if (task) ws.done(task, 'committed');
}
else if (mode === 'stray') {
  // Leaves a file next to the checkout and reports where its temp files go (AO-0230).
  const fs = await import('node:fs');
  fs.writeFileSync(process.env.FAKE_STRAY, 'left by the run\\n');
  fs.writeFileSync(process.env.FAKE_ENV_OUT, JSON.stringify({ scratch: process.env.SWARMUP_SCRATCH, temp: process.env.TEMP, tmp: process.env.TMP, tmpdir: process.env.TMPDIR }));
  // Says which Electron swarmupd named, and unpacks one as the electron package does (AO-0306).
  if (process.env.FAKE_ELECTRON_OUT) fs.writeFileSync(process.env.FAKE_ELECTRON_OUT, process.env.ELECTRON_OVERRIDE_DIST_PATH ?? '');
  if (process.env.FAKE_ELECTRON_UNPACK) {
    const exe = process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron';
    const path = await import('node:path');
    const file = path.join('node_modules', 'electron', 'dist', exe);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'binary');
    fs.writeFileSync(path.join('node_modules', 'electron', 'dist', 'version'), process.env.FAKE_ELECTRON_UNPACK);
    fs.writeFileSync(path.join('node_modules', 'electron', 'path.txt'), exe);
  }
  if (task) ws.done(task, 'left a stray file');
}
else if (mode === 'session-review') {
  // A Claude run: names its session, then asks for review.
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }));
  if (task) ws.review(task, 'ready for review');
}
else if (mode === 'tail') process.stdout.write(JSON.stringify({ type: 'result', usage: { input_tokens: 1000, output_tokens: 1 } }));
`;

export function setup(
  opts: {
    mode?: string;
    opsd?: Record<string, unknown>;
    now?: () => number;
    env?: Record<string, string>;
    freeMem?: () => number;
    procs?: ProcLister;
    runsOutlive?: boolean;
    /** The task repo's folder, under a `temp()` folder; a new temp folder by default. */
    repo?: string;
    /** The caller already initialized `repo` as git; used by off-thread test setup. */
    initialized?: boolean;
    /**
     * A file holding `in` or `out`: the fake runtime gets a sign-in check that reads it
     * (AO-0154). Without it, the fake runtime has no sign-in check.
     */
    signIn?: string;
  } = {},
) {
  const repo = opts.repo ?? temp();
  mkdirSync(repo, { recursive: true });
  if (!opts.initialized) execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  initRoot(repo, { name: 'test', human: 'human:dawid' });
  const agentFile = join(temp(), 'fake-agent.mjs');
  writeFileSync(agentFile, FAKE_AGENT);
  const state = temp();
  const env = {
    ...process.env,
    SWARMUP_CONFIG: join(repo, 'none.yml'),
    SWARMUP_STATE_DIR: state,
    FAKE_MODE: opts.mode ?? 'done',
    ...(opts.signIn ? { FAKE_SIGNIN: opts.signIn } : {}),
    ...(opts.env ?? {}),
  } as NodeJS.ProcessEnv;
  delete env.SWARMUP_AGENT;
  delete env.SWARMUP_ROOTS;
  const config = opsdConfig({
    opsd: {
      sync: false,
      // The default follows the CPU count; tests that start several runs need the same room on
      // a 4-core CI runner as on a workstation.
      max_runs: 16,
      // Runs start in the store checkout, as the tests of checkout rules expect; the tests of
      // task worktrees (AO-0168) turn them on.
      task_worktrees: false,
      ...(opts.opsd ?? {}),
      runtimes: {
        fake: {
          command: process.execPath,
          args: [agentFile],
          // A wrapped runtime: the check answers only if swarmupd keeps `args` before it.
          ...(opts.signIn ? { sign_in_check: ['sign-in-status'] } : {}),
        },
        ...((opts.opsd?.runtimes as object | undefined) ?? {}),
      },
    },
  });
  /** A swarmupd on the same state, like the one a restart starts. */
  const opsd = (procs = opts.procs): Supervisor => {
    const s = new Supervisor({
      env,
      cwd: repo,
      user: {},
      config,
      now: opts.now,
      freeMem: opts.freeMem ?? (() => 64 * 2 ** 30),
      procs,
      runsOutlive: opts.runsOutlive,
    });
    sups.push(s);
    return s;
  };
  const sup = opsd();
  const as = (actor: string) => new Workspace({ cwd: repo, env, actor, user: {}, now: opts.now });
  return { repo, sup, as, state, opsd };
}

/** {@link setup} with repository initialization off the Vitest worker's event loop. */
export async function setupAsync(opts: Parameters<typeof setup>[0] = {}) {
  const repo = opts.repo ?? temp();
  mkdirSync(repo, { recursive: true });
  await gitAsync(repo, ['init', '-q']);
  return setup({ ...opts, repo, initialized: true });
}

/** A runtime whose runs hang until stopped. */
export const HANG_RUNTIME = {
  command: process.execPath,
  args: ['-e', 'setInterval(() => {}, 1000)'],
};

/** An empty commit, so the repo has a HEAD to add worktrees from. */
export function gitCommit(repo: string): void {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'base',
    ],
    { cwd: repo, windowsHide: true },
  );
}

/**
 * The creation time of `pid`, once it can be read. `processStartSync` starts PowerShell on Windows
 * and holds the event loop while it runs, up to its 15 s limit under load; these reads come from
 * a worker thread instead, so they never add to a stall of the vitest worker (AO-0389).
 */
export async function startOf(pid: number, ms = WAIT_MS): Promise<string> {
  const end = Date.now() + ms;
  for (;;) {
    const start = await processStart(pid);
    if (start !== null) return start;
    if (Date.now() > end) throw new Error(`no creation time for pid ${pid}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export function ended(sup: Supervisor, id: string, ms = WAIT_MS): Promise<RunRecord> {
  return new Promise((resolve, reject) => {
    // A kill may end the run and its wrap-up within the tick that sent it, before this helper
    // is called: on Linux the group SIGTERM ends a run at once (AO-0240). The `run` event of an
    // ended run comes with the wrap-up done, so the record must show that too.
    const before = sup.run(id);
    if (before.status === 'ended' && before.wrap_up === 'done') return resolve(before);
    const timer = setTimeout(() => reject(new Error(`run ${id} did not end`)), ms);
    const check = (r: RunRecord): void => {
      if (r.id !== id || r.status !== 'ended') return;
      clearTimeout(timer);
      sup.off('run', check);
      resolve(r);
    };
    sup.on('run', check);
  });
}

/** B starts C and exits after 3 s; C writes its PID to FAKE_MARKER and runs until killed. */
export function orphanScripts(): { env: Record<string, string>; marker: string } {
  const dir = temp();
  const marker = join(dir, 'c.pid');
  const c = join(dir, 'c.cjs');
  const b = join(dir, 'b.cjs');
  writeFileSync(
    c,
    "require('fs').writeFileSync(process.env.FAKE_MARKER, String(process.pid)); setInterval(() => {}, 1000);\n",
  );
  writeFileSync(
    b,
    "require('child_process').spawn(process.execPath, [process.env.FAKE_C], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); setTimeout(() => {}, 3000);\n",
  );
  return { env: { FAKE_B: b, FAKE_C: c, FAKE_MARKER: marker }, marker };
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
