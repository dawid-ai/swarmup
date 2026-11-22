// Benchmarks for the desktop app (W7): the sets swarmupd can find, the runs under its state folder,
// and runs it starts. A run is `swarmup bench run` in a detached child process with no window,
// writing into `<state>/bench/<run-id>/`; the runner's `status.json` says how far it got, and
// `summary.json` holds the result. swarmupd never runs an agent for a benchmark itself.
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchSet } from '@swarmup/core';
import { benchCheckable, benchJudged, envVar, OpsError, readBenchSet } from '@swarmup/core';
import type {
  AttemptResult,
  BenchMode,
  BenchStatus,
  BenchSummary,
  Comparison,
  SummaryOverall,
} from './bench.js';
import {
  compareSummaries,
  DEFAULT_BENCH_BUDGET_MIN,
  planBench,
  planLines,
  readBenchSummary,
  stopBenchTree,
  writeBenchStatus,
} from './bench.js';
import type { BenchConfig } from './config.js';

/** What the bench API needs of swarmupd. */
export interface BenchHost {
  /** swarmupd's state folder; runs go to its `bench/`. */
  stateDir: string;
  /** Each task store folder (`.swarmup`) this machine holds, by root name; no mirrors. */
  roots: Array<{ name: string; dir: string }>;
  config: BenchConfig;
  /** The user config file, which relative paths in `swarmupd.bench` are read from. */
  configPath: string;
  env: NodeJS.ProcessEnv;
}

/** One entry of a set, as the app lists it. */
export interface BenchEntryView {
  id: string;
  title: string;
  base: string;
  agent?: string;
  budget?: number;
  repeat: number;
  criteria: { visible: number; hidden: number; pending: number };
}

/** A set file the app can run, or one that does not read, with why. */
export interface BenchSetView {
  /** The set's `id`; the file name for a set that does not read. */
  id: string;
  file: string;
  /** `root:<name>` for a root's `benchmarks/` folder, `config` for `swarmupd.bench.sets`. */
  source: string;
  description?: string;
  hiddenDir?: string;
  defaults?: BenchSet['defaults'];
  entries: BenchEntryView[];
  error?: string;
}

/** What the app sends to start a run: `POST /api/bench/run`. */
export interface BenchRunRequest {
  set: string;
  repo: string;
  entries?: string[];
  agent?: string;
  model?: string;
  effort?: string;
  repeat?: number;
  budget_min?: number;
  hidden_dir?: string;
  mode: BenchMode;
  reference_dir?: string;
  dry_run?: boolean;
  /** Put the agent's role file from `root` in each prompt (W5). */
  role_file?: boolean;
  /** The variant whose role file goes in each prompt; implies `role_file`. */
  variant?: string;
  /** The store the role file comes from: a folder or a root name. */
  root?: string;
}

/** A run's plan, from a dry run: what the confirm dialog shows before tokens are spent. */
export interface BenchPlanView {
  set: string;
  file: string;
  mode: BenchMode;
  agent: string;
  model?: string;
  effort?: string;
  repo: string;
  hiddenDir?: string;
  referenceDir?: string;
  entries: string[];
  /** Attempts per entry in agent mode; reference and empty runs make one. */
  repeat: number;
  attempts: Array<{ entry: string; attempt: number; base: string; budgetMin: number }>;
  /** Entries left out for want of a reference patch. */
  skipped: string[];
  /** The most minutes the agents may run in all: the sum of the attempts' budgets. */
  maxMinutes: number;
  /** Whether the run starts an agent, which spends tokens. */
  spends: boolean;
  /** The plan as `swarmup bench run --dry-run` prints it. */
  lines: string[];
}

/** One run, as the runs list shows it. */
export interface BenchRunView {
  id: string;
  dir: string;
  state: 'running' | 'done' | 'failed';
  set?: string;
  mode?: BenchMode;
  agent?: string;
  model?: string;
  effort?: string;
  startedAt?: string;
  finishedAt?: string;
  done?: number;
  total?: number;
  current?: string;
  error?: string;
  overall?: SummaryOverall;
  /** The variant whose role file the prompts carried. */
  variant?: string;
  /** Started from the app (it has the request), not from the command line. */
  fromApp: boolean;
}

/** One run with its attempts, for the run's page. */
export interface BenchRunDetail {
  run: BenchRunView;
  summary?: BenchSummary;
  request?: BenchRunRequest;
  attempts: AttemptResult[];
  /** The end of the runner's output. */
  log?: string;
}

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENTRY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WIN = process.platform === 'win32';

const bad = (message: string): never => {
  throw new OpsError(message, 2);
};

/** A path from `swarmupd.bench`: absolute as written, else relative to the user config file. */
function configPath(host: BenchHost, p: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(dirname(host.configPath), p);
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => (WIN ? resolve(p).toLowerCase() : resolve(p));
  return norm(a) === norm(b);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function yamlIn(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => /\.ya?ml$/i.test(f))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function setView(file: string, source: string): BenchSetView {
  try {
    const set = readBenchSet(file);
    return {
      id: set.id,
      file: set.file,
      source,
      ...(set.description ? { description: set.description } : {}),
      ...(set.hiddenDir ? { hiddenDir: set.hiddenDir } : {}),
      defaults: set.defaults,
      entries: set.entries.map((e) => ({
        id: e.id,
        title: e.task?.title ?? e.prompt?.split('\n')[0]?.slice(0, 120) ?? e.id,
        base: 'ref' in e.base ? e.base.ref : 'snapshot' in e.base ? e.base.snapshot : 'empty',
        ...(e.agent ? { agent: e.agent } : {}),
        ...(e.budget !== undefined ? { budget: e.budget } : {}),
        repeat: e.repeat,
        criteria: {
          visible: e.criteria.filter((c) => benchCheckable(c) && !c.hidden).length,
          hidden: e.criteria.filter((c) => c.hidden).length,
          pending: e.criteria.filter((c) => benchJudged(c)).length,
        },
      })),
    };
  } catch (err) {
    return {
      id: file.replace(/^.*[\\/]/, '').replace(/\.ya?ml$/i, ''),
      file: resolve(file),
      source,
      entries: [],
      error: (err as Error).message,
    };
  }
}

/**
 * The sets in each root's `benchmarks/` folder, then the files and folders `swarmupd.bench.sets`
 * names. A file listed twice shows once.
 */
export function listBenchSets(host: BenchHost): BenchSetView[] {
  const found: Array<[string, string]> = [];
  for (const r of host.roots) {
    for (const f of yamlIn(join(r.dir, 'benchmarks'))) found.push([f, `root:${r.name}`]);
  }
  for (const p of host.config.sets) {
    const abs = configPath(host, p);
    if (isDir(abs)) for (const f of yamlIn(abs)) found.push([f, 'config']);
    else found.push([abs, 'config']);
  }
  const out: BenchSetView[] = [];
  for (const [file, source] of found) {
    if (out.some((s) => samePath(s.file, file))) continue;
    out.push(setView(file, source));
  }
  return out;
}

/** Folders that hold runs: swarmupd's `bench/`, then `swarmupd.bench.results`. */
function runFolders(host: BenchHost): string[] {
  return [join(host.stateDir, 'bench'), ...host.config.results.map((p) => configPath(host, p))];
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists under another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The last lines of a text file, at most `bytes` of it. */
function tail(file: string, bytes = 8192): string | undefined {
  try {
    const text = readFileSync(file, 'utf8');
    return text.length > bytes ? text.slice(-bytes).replace(/^[^\n]*\n/, '') : text;
  } catch {
    return undefined;
  }
}

/** Keeps the children it started, so a run shows as running before its first `status.json`. */
export class BenchRuns {
  private readonly children = new Map<string, ChildProcess>();

  constructor(private readonly host: () => BenchHost) {}

  /** The folder of run `id`, or undefined when no run folder has it. */
  private dirOf(id: string): string | undefined {
    if (!RUN_ID_RE.test(id)) return undefined;
    for (const folder of runFolders(this.host())) {
      const dir = join(folder, id);
      if (existsSync(join(dir, 'summary.json')) || existsSync(join(dir, 'status.json'))) return dir;
      if (existsSync(join(dir, 'request.json'))) return dir;
    }
    return undefined;
  }

  private view(id: string, dir: string): BenchRunView {
    const summary = readJson<BenchSummary>(join(dir, 'summary.json'));
    const status = readJson<BenchStatus>(join(dir, 'status.json'));
    const request = readJson<BenchRunRequest & { setId?: string; agentShown?: string }>(
      join(dir, 'request.json'),
    );
    const child = this.children.get(id);
    const childLive = child !== undefined && child.exitCode === null && child.signalCode === null;
    let state: BenchRunView['state'];
    let error: string | undefined;
    if (summary && status?.state !== 'failed') state = 'done';
    else if (status?.state === 'failed') {
      state = 'failed';
      error = status.error;
    } else if (status?.state === 'running' && (alive(status.pid) || childLive)) state = 'running';
    else if (!status && childLive) state = 'running';
    else {
      state = 'failed';
      const said = tail(join(dir, 'run.log'), 600)?.trim().split('\n').slice(-3).join(' ');
      error = status
        ? 'the runner stopped before it finished'
        : said || 'the runner stopped before it started';
    }
    const mode = summary?.mode ?? (request?.mode as BenchMode | undefined);
    const agent =
      summary?.agent ??
      (request
        ? request.mode === 'reference'
          ? 'reference'
          : request.mode === 'none'
            ? 'none'
            : request.agentShown
        : undefined);
    const model = summary?.model ?? (request?.mode === 'agent' ? request.model : undefined);
    const effort = summary?.effort ?? (request?.mode === 'agent' ? request.effort : undefined);
    const set = summary?.set ?? request?.setId;
    const startedAt = summary?.startedAt ?? status?.startedAt;
    const finishedAt = summary?.finishedAt ?? status?.finishedAt;
    return {
      id,
      dir,
      state,
      ...(set ? { set } : {}),
      ...(mode ? { mode } : {}),
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(finishedAt ? { finishedAt } : {}),
      ...(status ? { done: status.done, total: status.total } : {}),
      ...(state === 'running' && status?.current ? { current: status.current } : {}),
      ...(error ? { error } : {}),
      ...(summary ? { overall: summary.overall } : {}),
      ...((summary?.role?.variant ?? request?.variant)
        ? { variant: summary?.role?.variant ?? request?.variant }
        : {}),
      fromApp: request !== undefined,
    };
  }

  /** Every run, newest first. A run folder name in two places shows the first one. */
  list(): BenchRunView[] {
    const out: BenchRunView[] = [];
    const seen = new Set<string>();
    for (const folder of runFolders(this.host())) {
      let names: string[];
      try {
        names = readdirSync(folder);
      } catch {
        continue;
      }
      for (const id of names) {
        if (seen.has(id) || !RUN_ID_RE.test(id)) continue;
        const dir = join(folder, id);
        if (
          !existsSync(join(dir, 'summary.json')) &&
          !existsSync(join(dir, 'status.json')) &&
          !existsSync(join(dir, 'request.json'))
        ) {
          continue;
        }
        seen.add(id);
        out.push(this.view(id, dir));
      }
    }
    const when = (r: BenchRunView): string => r.startedAt ?? '';
    return out.sort((a, b) => (when(a) < when(b) ? 1 : when(a) > when(b) ? -1 : 0));
  }

  /** One run's view, or undefined when no run folder has it. */
  get(id: string): BenchRunView | undefined {
    const dir = this.dirOf(id);
    return dir ? this.view(id, dir) : undefined;
  }

  /** One run with every attempt's `results.json`. */
  detail(id: string): BenchRunDetail {
    const dir = this.dirOf(id) ?? bad(`no bench run ${id}`);
    const summary = readJson<BenchSummary>(join(dir, 'summary.json'));
    const request = readJson<BenchRunRequest>(join(dir, 'request.json'));
    const attempts: AttemptResult[] = [];
    for (const entry of readdirSync(dir).sort()) {
      if (!ENTRY_ID_RE.test(entry) || !isDir(join(dir, entry))) continue;
      const ns = readdirSync(join(dir, entry))
        .filter((n) => /^\d+$/.test(n))
        .sort((a, b) => Number(a) - Number(b));
      for (const n of ns) {
        const r = readJson<AttemptResult>(join(dir, entry, n, 'results.json'));
        if (r) attempts.push(r);
      }
    }
    const log = tail(join(dir, 'run.log'));
    return {
      run: this.view(id, dir),
      ...(summary ? { summary } : {}),
      ...(request ? { request } : {}),
      attempts,
      ...(log ? { log } : {}),
    };
  }

  /** An attempt's `diff.patch` or `agent.log`, at most its last 2 MB. */
  attemptFile(id: string, entry: string, n: string, file: string): string {
    const dir = this.dirOf(id) ?? bad(`no bench run ${id}`);
    if (!ENTRY_ID_RE.test(entry) || !/^\d{1,4}$/.test(n)) bad('name an entry and an attempt');
    const name =
      file === 'diff' ? 'diff.patch' : file === 'log' ? 'agent.log' : bad('file: diff or log');
    const path = join(dir, entry, n, name);
    if (!existsSync(path)) bad(`attempt ${entry} #${n} has no ${name}`);
    return tail(path, 2 * 1024 * 1024) ?? '';
  }

  /** B minus A for two runs. */
  compare(a: string, b: string): Comparison {
    const dirA = this.dirOf(a) ?? bad(`no bench run ${a}`);
    const dirB = this.dirOf(b) ?? bad(`no bench run ${b}`);
    return compareSummaries(readBenchSummary(dirA), readBenchSummary(dirB));
  }

  /** The set file a request names, which must be one {@link listBenchSets} finds. */
  private setOf(file: string): BenchSet {
    if (!file) bad('set: name a set file from GET /api/bench/sets');
    const known = listBenchSets(this.host()).find((s) => samePath(s.file, file));
    if (!known) bad(`${file} is no set swarmupd lists; add it under swarmupd.bench.sets`);
    return readBenchSet(known!.file);
  }

  private newId(setId: string): string {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..*$/, '')
      .replace('T', '-');
    const base = join(this.host().stateDir, 'bench');
    let id = `${setId}-${stamp}`;
    for (let n = 2; existsSync(join(base, id)); n++) id = `${setId}-${stamp}-${n}`;
    return id;
  }

  /**
   * Checks a request and plans it, as `--dry-run` does. With `dry_run`, returns the plan alone;
   * otherwise starts the runner and returns the new run's id with it.
   */
  start(req: BenchRunRequest): { plan: BenchPlanView; id?: string; run?: BenchRunView } {
    const host = this.host();
    if (req.mode !== 'agent' && req.mode !== 'none' && req.mode !== 'reference') {
      bad('mode: agent, reference or none');
    }
    const set = this.setOf(req.set);
    if (!req.repo || !isDir(req.repo))
      bad(`repo: ${req.repo || 'name the repo under test'} is no folder`);
    for (const [k, v] of [
      ['hidden_dir', req.hidden_dir],
      ['reference_dir', req.reference_dir],
    ] as const) {
      if (v !== undefined && !isDir(v)) bad(`${k}: ${v} is no folder`);
    }
    if (req.mode === 'reference' && !req.reference_dir)
      bad('reference_dir: name the patches folder');
    if (req.mode === 'agent' && (req.role_file || req.variant) && !req.root) {
      bad('root: name the store the role file is in');
    }
    const agent =
      req.mode === 'none' ? 'none' : req.mode === 'reference' ? undefined : req.agent || undefined;
    const id = this.newId(set.id);
    const out = join(host.stateDir, 'bench', id);
    const opts = {
      set,
      repo: resolve(req.repo),
      out,
      ...(req.entries?.length ? { entries: req.entries } : {}),
      ...(agent ? { agent } : {}),
      ...(req.mode === 'agent' && req.model ? { model: req.model } : {}),
      ...(req.mode === 'agent' && req.effort ? { effort: req.effort } : {}),
      ...(req.repeat !== undefined ? { repeat: req.repeat } : {}),
      ...(req.budget_min !== undefined ? { budgetMin: req.budget_min } : {}),
      ...(req.hidden_dir ? { hiddenDir: resolve(req.hidden_dir) } : {}),
      ...(req.mode === 'reference' ? { referenceDir: resolve(req.reference_dir!) } : {}),
      dryRun: true,
      env: host.env,
      log: () => {},
    };
    const planned = planBench(opts);
    const first = planned.attempts[0];
    const plan: BenchPlanView = {
      set: set.id,
      file: set.file,
      mode: req.mode,
      agent: first?.agent ?? agent ?? '',
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
      repo: planned.repo,
      ...(planned.hiddenDir ? { hiddenDir: planned.hiddenDir } : {}),
      ...(opts.referenceDir ? { referenceDir: opts.referenceDir } : {}),
      entries: [...new Set(planned.attempts.map((a) => a.entry.id))],
      repeat: req.mode === 'agent' ? Math.max(...planned.attempts.map((a) => a.attempt), 1) : 1,
      attempts: planned.attempts.map((a) => ({
        entry: a.entry.id,
        attempt: a.attempt,
        base: a.baseSha,
        budgetMin: a.budgetMin,
      })),
      skipped: planned.skipped,
      maxMinutes:
        req.mode === 'agent'
          ? planned.attempts.reduce((n, a) => n + (a.budgetMin ?? DEFAULT_BENCH_BUDGET_MIN), 0)
          : 0,
      spends: req.mode === 'agent',
      lines: planLines(planned, opts),
    };
    if (req.dry_run) return { plan };
    mkdirSync(out, { recursive: true });
    writeFileSync(
      join(out, 'request.json'),
      `${JSON.stringify({ ...req, setId: set.id, agentShown: plan.agent, file: set.file }, null, 2)}\n`,
    );
    const args = [
      benchCli(host.env),
      'bench',
      'run',
      set.file,
      '--repo',
      plan.repo,
      '--out',
      out,
      ...(req.entries?.length ? ['--entries', req.entries.join(',')] : []),
      ...(agent ? ['--agent', agent] : []),
      ...(opts.model ? ['--model', opts.model] : []),
      ...(opts.effort ? ['--effort', opts.effort] : []),
      ...(req.repeat !== undefined ? ['--repeat', String(req.repeat)] : []),
      ...(req.budget_min !== undefined ? ['--budget-min', String(req.budget_min)] : []),
      ...(opts.hiddenDir ? ['--hidden-dir', opts.hiddenDir] : []),
      ...(opts.referenceDir ? ['--reference-dir', opts.referenceDir] : []),
      ...(req.mode === 'agent' && (req.role_file || req.variant) && req.root
        ? ['--role-file', '--root', req.root]
        : []),
      ...(req.mode === 'agent' && req.variant ? ['--variant', req.variant] : []),
    ];
    const fd = openSync(join(out, 'run.log'), 'a');
    // Inside Electron, execPath is the app: ELECTRON_RUN_AS_NODE makes it a plain Node process.
    const env = process.versions.electron
      ? { ...host.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' }
      : host.env;
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, args, {
        cwd: out,
        env,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
      });
    } finally {
      closeSync(fd);
    }
    child.on('error', (err) => {
      try {
        writeFileSync(join(out, 'run.log'), `could not start the runner: ${err.message}\n`, {
          flag: 'a',
        });
      } catch {
        // The run shows as failed either way.
      }
    });
    child.unref();
    this.children.set(id, child);
    child.on('exit', () => {
      // Kept until the next look: the view reads the files from then on.
      setTimeout(() => this.children.delete(id), 60_000).unref();
    });
    return { plan, id, run: this.view(id, out) };
  }

  /** Stops a run under way, with every process under it, and marks it failed. */
  stop(id: string): BenchRunView {
    const dir = this.dirOf(id) ?? bad(`no bench run ${id}`);
    const status = readJson<BenchStatus>(join(dir, 'status.json'));
    const child = this.children.get(id);
    const pid = child?.pid ?? status?.pid;
    const running = status
      ? status.state === 'running'
      : child !== undefined && child.exitCode === null && child.signalCode === null;
    if (!running) throw new OpsError(`bench run ${id} is not running`, 1);
    if (pid && alive(pid)) stopBenchTree(pid);
    const now = new Date().toISOString();
    writeBenchStatus(dir, {
      state: 'failed',
      done: status?.done ?? 0,
      total: status?.total ?? 0,
      pid: status?.pid ?? pid ?? 0,
      startedAt: status?.startedAt ?? now,
      updatedAt: now,
      finishedAt: now,
      error: 'stopped from the app',
    });
    return this.view(id, dir);
  }
}

/**
 * The `swarmup` command's entry point: `SWARMUP_BENCH_CLI` when set (tests point it at a fake
 * runner), the installed app's `swarmup.mjs` beside `swarmupd.mjs`, else the built CLI of this
 * checkout.
 */
export function benchCli(env: NodeJS.ProcessEnv): string {
  const set = envVar(env, 'BENCH_CLI');
  if (set) return set;
  return cliEntry(env);
}

/**
 * The `swarmup` command's entry file for Node: the installed app's `swarmup.mjs` beside
 * `swarmupd.mjs`, else the built CLI of this checkout.
 */
export function cliEntry(env: NodeJS.ProcessEnv): string {
  const daemon = envVar(env, 'DAEMON_ENTRY');
  if (daemon) return join(dirname(daemon), 'swarmup.mjs');
  const here = fileURLToPath(import.meta.url);
  if (extname(here) === '.mjs') return join(dirname(here), 'swarmup.mjs');
  // packages/supervisor/{src,dist}/bench-runs.* -> packages/cli/dist/main.js
  return join(dirname(here), '..', '..', 'cli', 'dist', 'main.js');
}
