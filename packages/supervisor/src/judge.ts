// The LLM judge of `rubric` criteria (W7): one non-interactive, read-only model call per criterion
// that scores the work against its rubric file (`core/src/rubric.ts`). Everything the judge may
// use goes in the prompt and it gets no tools, so it is blind to who did the work and cheap. A
// bench run (`bench.ts`), `swarmup criteria judge`, the app's **Judge** and the merge (when
// `swarmupd.judge.at_merge` is on) call it.
import type { ChildProcess } from 'node:child_process';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  CriteriaResults,
  Criterion,
  CriterionVerdict,
  JudgeFile,
  JudgeInputs,
  Rubric,
} from '@swarmup/core';
import {
  DEFAULT_RUBRIC_PASS,
  deleteEnvVars,
  diffPaths,
  envVar,
  FILES_MAX,
  judgePrompt,
  matchGlobs,
  OpsError,
  parseJudgeAnswer,
  parseRubric,
  readRubric,
} from '@swarmup/core';
import type { JudgeConfig, RuntimeConfig } from './config.js';
import { DEFAULT_JUDGE_CLAUDE_MODEL, DEFAULT_RUNTIMES } from './config.js';
import { killTree, quoteBatch, resolveCommand } from './proc.js';
import { dropEnv, runEnv } from './runenv.js';
import type { CriteriaCheckJob } from './task-criteria.js';

const WIN = process.platform === 'win32';
const run = promisify(execFile);

/**
 * The judge's system prompt for Claude, in place of Claude Code's own. No double quotes, `%` or
 * `!`: a `.cmd` shim of the runtime could not pass them on unchanged (see `quoteBatch`).
 */
const CLAUDE_SYSTEM =
  'You are an impartial judge of work against a rubric. You have no tools. Answer only with the JSON object the user message asks for.';

/** Most bytes of a judge's stdout kept; a JSON answer is a few hundred. */
const STDOUT_CAP = 4 * 1024 * 1024;

// ---- The command line ---------------------------------------------------------------------------

/** The model a judge runs: `swarmupd.judge.model`, else `sonnet` for Claude, else the runtime's. */
export function judgeModel(
  cfg: JudgeConfig,
  runtimes?: Record<string, RuntimeConfig>,
): string | undefined {
  if (cfg.model) return cfg.model;
  if (cfg.runtime === 'claude') return DEFAULT_JUDGE_CLAUDE_MODEL;
  return runtimes?.[cfg.runtime]?.model;
}

export interface JudgeCommand {
  file: string;
  args: string[];
  unsetEnv: string[];
  runtime: string;
  model?: string;
}

/**
 * The judge's command line, run in an empty folder with the prompt on stdin:
 *
 * - Claude: `-p --output-format json`, the model and effort, `--tools ""` (no tools at all),
 *   `--strict-mcp-config` (no MCP servers), `--no-session-persistence` and a short system prompt
 *   in place of Claude Code's.
 * - Codex: `exec --json --sandbox read-only --skip-git-repo-check -C <cwd> -` with `-m` and
 *   `model_reasoning_effort`.
 *
 * Only the runtime's `command` and `unset_env` come from the machine's settings, so its `args`
 * cannot widen what a judge may do. Refuses another runtime, or one not on PATH, with exit 2.
 */
export function judgeCommand(
  cfg: JudgeConfig,
  cwd: string,
  opts: {
    runtimes?: Record<string, RuntimeConfig>;
    env?: NodeJS.ProcessEnv;
    resolve?: boolean;
  } = {},
): JudgeCommand {
  const runtime = cfg.runtime;
  if (runtime !== 'claude' && runtime !== 'codex') {
    throw new OpsError(`the judge runs on claude or codex, not '${runtime}'`, 2);
  }
  const rc: RuntimeConfig = { ...DEFAULT_RUNTIMES[runtime]!, ...(opts.runtimes?.[runtime] ?? {}) };
  const model = judgeModel(cfg, opts.runtimes);
  const args =
    runtime === 'claude'
      ? [
          '-p',
          '--output-format',
          'json',
          ...(model ? ['--model', model] : []),
          ...(cfg.effort ? ['--effort', cfg.effort] : []),
          '--tools',
          '',
          '--strict-mcp-config',
          '--no-session-persistence',
          '--system-prompt',
          CLAUDE_SYSTEM,
        ]
      : [
          'exec',
          ...(model ? ['-m', model] : []),
          ...(cfg.effort ? ['-c', `model_reasoning_effort=${cfg.effort}`] : []),
          '--json',
          '--sandbox',
          'read-only',
          '--skip-git-repo-check',
          '-C',
          cwd,
          '-',
        ];
  let file = rc.command;
  if (opts.resolve !== false) {
    const found = resolveCommand(rc.command, opts.env ?? process.env);
    if (!found) throw new OpsError(`cannot find '${rc.command}' on PATH for the judge`, 2);
    file = found;
  }
  return { file, args, unsetEnv: rc.unset_env ?? [], runtime, ...(model ? { model } : {}) };
}

/**
 * The judge's environment: swarmupd's run environment without the identity of a SwarmUp run or a
 * Claude Code session, as a bench run gets (`benchEnv`).
 */
export function judgeEnv(
  base: NodeJS.ProcessEnv,
  unset: readonly string[] = [],
): NodeJS.ProcessEnv {
  const env = runEnv(base, {});
  deleteEnvVars(env, [
    'AGENT',
    'RUN',
    'PARENT_RUN',
    'RUN_TOKEN',
    'RUN_STATE_DIR',
    'ROOTS',
    'ROOTS_ONLY',
    'ROOT',
  ]);
  dropEnv(env, ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', ...unset]);
  return env;
}

// ---- The process --------------------------------------------------------------------------------

/** One judge process to run. */
export interface JudgeProcess {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The prompt, written to stdin. */
  input: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface JudgeProcessOutcome {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Runs a judge process; tests pass their own. */
export type JudgeRunner = (p: JudgeProcess) => Promise<JudgeProcessOutcome>;

function stopTree(pid: number): void {
  if (!WIN) {
    killTree(pid);
    return;
  }
  execFile(
    'taskkill',
    ['/T', '/F', '/PID', String(pid)],
    { windowsHide: true, timeout: 15_000 },
    () => {
      // A tree that does not end leaves the hard deadline to end the judgment.
    },
  );
}

/**
 * Runs `file args` without a window, the prompt on stdin, and keeps what it prints. After
 * `timeoutMs`, or when `signal` aborts, stops it and every process under it.
 */
export const defaultJudgeRunner: JudgeRunner = (p) => {
  let child: ChildProcess;
  try {
    if (WIN && /\.(cmd|bat)$/i.test(p.file)) {
      // A batch shim runs in cmd.exe, which reads the arguments again (see `quoteBatch`).
      const line = `"${[p.file, ...p.args].map(quoteBatch).join(' ')}"`;
      child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/v:off', '/s', '/c', line], {
        cwd: p.cwd,
        env: p.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
    } else {
      child = spawn(p.file, p.args, {
        cwd: p.cwd,
        env: p.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !WIN,
      });
    }
  } catch (err) {
    return Promise.resolve({
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      error: (err as Error).message,
    });
  }
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let error: string | undefined;
    let settled = false;
    let hard: NodeJS.Timeout | undefined;
    const stop = (): void => {
      if (child.pid !== undefined) stopTree(child.pid);
      hard ??= setTimeout(() => finish(null), 30_000);
    };
    const onAbort = (): void => {
      error = 'stopped';
      stop();
    };
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hard);
      p.signal?.removeEventListener('abort', onAbort);
      done({ exitCode: code, timedOut, stdout, stderr, ...(error ? { error } : {}) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, p.timeoutMs);
    if (p.signal?.aborted) onAbort();
    else p.signal?.addEventListener('abort', onAbort);
    child.stdout?.on('data', (b: Buffer) => {
      if (stdout.length < STDOUT_CAP) stdout += b.toString('utf8');
    });
    child.stderr?.on('data', (b: Buffer) => {
      stderr = (stderr + b.toString('utf8')).slice(-8000);
    });
    child.on('error', (err) => {
      error = err.message;
      finish(null);
    });
    child.on('close', (code) => finish(code));
    child.stdin?.on('error', () => {});
    child.stdin?.end(p.input);
  });
};

/** What a judge's output says: its answer text, its cost when reported, and the model that ran. */
export function readJudgeOutput(
  runtime: string,
  stdout: string,
): { text: string; costUsd: number | null; model: string | null; error?: string } {
  if (runtime === 'claude') {
    // `--output-format json` prints one result object; look for it among any other lines.
    for (const line of [stdout, ...stdout.split('\n').reverse()]) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try {
        const r = JSON.parse(t) as Record<string, unknown>;
        if (r.type !== 'result') continue;
        const usage =
          r.modelUsage && typeof r.modelUsage === 'object' ? Object.keys(r.modelUsage) : [];
        const text = typeof r.result === 'string' ? r.result : '';
        return {
          text,
          costUsd: typeof r.total_cost_usd === 'number' ? r.total_cost_usd : null,
          model: usage[0] ?? null,
          ...(r.is_error === true
            ? { error: text.split('\n')[0] || String(r.subtype ?? 'error') }
            : {}),
        };
      } catch {
        // Not the result line.
      }
    }
    return { text: stdout, costUsd: null, model: null };
  }
  // Codex `--json`: the last agent message is the answer; it reports tokens, not cost.
  let text = '';
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const ev = JSON.parse(t) as { type?: string; item?: { type?: string; text?: string } };
      if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) {
        text = ev.item.text;
      }
    } catch {
      // Not an event.
    }
  }
  return { text: text || stdout, costUsd: null, model: null };
}

// ---- One judgment -------------------------------------------------------------------------------

interface JudgeRun {
  /** The rubric's id, or the path that did not load. */
  rubric: string;
  runtime: string;
  model: string | null;
  costUsd: number | null;
  wallMs: number;
}

/** A judgment that gave a score. */
export interface JudgeResult extends JudgeRun {
  result: 'pass' | 'fail';
  /** The weighted total as 0..1. */
  score: number;
  /** The criterion's `pass` it was held to. */
  pass: number;
  /** Per rubric criterion, on the rubric's scale. */
  scores: Record<string, number>;
  /** The weighted total on the rubric's scale, worked out from `scores`. */
  total: number;
  /** The total the model gave, when it gave one. */
  modelTotal?: number;
  scale: { min: number; max: number };
  reasons: string;
}

/** A judgment that gave no score: the runtime failed, timed out, or answered in a bad form. */
export interface JudgeFailure extends JudgeRun {
  error: string;
}

export type JudgeOutcome = JudgeResult | JudgeFailure;

export function judgeFailed(o: JudgeOutcome): o is JudgeFailure {
  return 'error' in o;
}

export interface JudgeOptions {
  config: JudgeConfig;
  runner?: JudgeRunner;
  env?: NodeJS.ProcessEnv;
  /** The machine's runtimes (`swarmupd.runtimes`): the command and `unset_env` of the judge's. */
  runtimes?: Record<string, RuntimeConfig>;
  signal?: AbortSignal;
}

/**
 * Scores one piece of work against `rubric`: builds the prompt, runs the judge in an empty folder
 * with the time budget of `config`, and reads its answer. A score at or above `pass` passes.
 * Never throws for a failed judgment: it comes back as a {@link JudgeFailure}.
 */
export async function runJudge(
  rubric: Rubric,
  inputs: JudgeInputs,
  pass: number,
  opts: JudgeOptions,
): Promise<JudgeOutcome> {
  const started = Date.now();
  const env = opts.env ?? process.env;
  const base: JudgeRun = {
    rubric: rubric.id,
    runtime: opts.config.runtime,
    model: judgeModel(opts.config, opts.runtimes) ?? null,
    costUsd: null,
    wallMs: 0,
  };
  const fail = (error: string, more: Partial<JudgeRun> = {}): JudgeFailure => ({
    ...base,
    ...more,
    wallMs: Date.now() - started,
    error,
  });
  let cwd: string;
  try {
    cwd = mkdtempSync(join(envVar(env, 'SCRATCH') ?? tmpdir(), 'swarmup-judge-'));
  } catch (err) {
    return fail(`no folder to run the judge in: ${(err as Error).message}`);
  }
  try {
    let cmd: JudgeCommand;
    try {
      cmd = judgeCommand(opts.config, cwd, {
        ...(opts.runtimes ? { runtimes: opts.runtimes } : {}),
        env,
        resolve: !opts.runner,
      });
    } catch (err) {
      return fail((err as Error).message);
    }
    const out = await (opts.runner ?? defaultJudgeRunner)({
      file: cmd.file,
      args: cmd.args,
      cwd,
      env: judgeEnv(env, cmd.unsetEnv),
      input: judgePrompt(rubric, inputs),
      timeoutMs: opts.config.budget_min * 60_000,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const read = readJudgeOutput(cmd.runtime, out.stdout);
    const seen = { costUsd: read.costUsd, model: read.model ?? base.model };
    if (out.timedOut) return fail(`timed out after ${opts.config.budget_min} min`, seen);
    if (out.error) return fail(out.error, seen);
    if (read.error) return fail(read.error, seen);
    if (out.exitCode !== 0) {
      const why = (out.stderr.trim() || out.stdout.trim()).split('\n').slice(-1)[0] ?? '';
      return fail(
        `the judge exited with ${out.exitCode}${why ? `: ${why.slice(0, 300)}` : ''}`,
        seen,
      );
    }
    let answer;
    try {
      answer = parseJudgeAnswer(rubric, read.text);
    } catch (err) {
      return fail((err as Error).message, seen);
    }
    return {
      ...base,
      ...seen,
      wallMs: Date.now() - started,
      result: answer.score + 1e-9 >= pass ? 'pass' : 'fail',
      score: answer.score,
      pass,
      scores: answer.scores,
      total: answer.total,
      ...(answer.modelTotal !== undefined ? { modelTotal: answer.modelTotal } : {}),
      scale: rubric.scale,
      reasons: answer.reasons,
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}

const round = (v: number, digits = 3): number => Math.round(v * 10 ** digits) / 10 ** digits;

/** `$0.0123`, or nothing for an unknown cost. */
export function costText(usd: number | null | undefined): string {
  return typeof usd === 'number' ? `$${usd.toFixed(usd < 0.1 ? 4 : 2)}` : '';
}

/**
 * A judgment as a criterion result: the score as 0..1, the reasons as the note, and the scores,
 * total, model and cost as evidence. A failed judgment is `na` with what went wrong.
 */
export function judgeVerdict(o: JudgeOutcome): CriterionVerdict {
  const who = [o.runtime, o.model, costText(o.costUsd)].filter(Boolean).join(', ');
  if (judgeFailed(o))
    return { result: 'na', note: `the judge failed: ${o.error}`, evidence: `judge: ${who}` };
  const scores = Object.entries(o.scores)
    .map(([id, v]) => `${id} ${round(v, 2)}`)
    .join(', ');
  return {
    result: o.result,
    score: round(o.score),
    note: o.reasons || `scored ${round(o.score)} against ${o.pass}`,
    evidence: [
      `${o.rubric}: ${scores} (scale ${o.scale.min} to ${o.scale.max})`,
      `total ${round(o.total, 2)} of ${o.scale.max} = ${round(o.score)}; passes at ${o.pass}`,
      `judge: ${who}`,
    ].join('\n'),
  };
}

// ---- Inputs -------------------------------------------------------------------------------------

/** The work a judge looks at: the tree after the change, its diff, and the task's text. */
export interface JudgeSource {
  /** The tree after the change, for the `repo` and `files` inputs; without it they stay empty. */
  cwd?: string;
  diff: string;
  task: string;
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120_000,
  });
  return stdout;
}

async function readText(cwd: string, path: string): Promise<JudgeFile | null> {
  const abs = resolve(cwd, path);
  try {
    if (!statSync(abs).isFile()) return null;
    const buf = await readFile(abs);
    if (buf.subarray(0, 8000).includes(0)) return { path, text: '[binary file]' };
    return { path, text: buf.toString('utf8') };
  } catch {
    return null;
  }
}

/**
 * The inputs of one judgment: the task and the diff always, the files the diff touches when the
 * rubric asks for `repo`, and the files its globs match (from `git ls-files` in `cwd`, untracked
 * ones included) when it asks for `files`. Sizes are capped when the prompt is built.
 */
export async function judgeInputs(
  rubric: Rubric,
  src: JudgeSource,
  criterion?: Pick<Criterion, 'id' | 'text'>,
): Promise<JudgeInputs> {
  const inputs: JudgeInputs = {
    task: src.task,
    diff: src.diff,
    ...(criterion
      ? { criterion: { id: criterion.id, ...(criterion.text ? { text: criterion.text } : {}) } }
      : {}),
  };
  if (src.cwd && rubric.inputs.includes('repo')) {
    const paths = diffPaths(src.diff).slice(0, FILES_MAX + 20);
    const files = await Promise.all(paths.map((p) => readText(src.cwd!, p)));
    inputs.repo = files.filter((f): f is JudgeFile => f !== null);
  }
  if (src.cwd && rubric.inputs.includes('files')) {
    let listed: string[] = [];
    try {
      listed = (await gitText(src.cwd, ['ls-files', '-co', '--exclude-standard']))
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      // Not a git tree: no files to match.
    }
    const paths = matchGlobs(listed, rubric.files).slice(0, FILES_MAX + 20);
    const files = await Promise.all(paths.map((p) => readText(src.cwd!, p)));
    inputs.files = files.filter((f): f is JudgeFile => f !== null);
  }
  return inputs;
}

// ---- Criteria -----------------------------------------------------------------------------------

export interface JudgeCriteriaOptions extends JudgeOptions {
  /** The criteria; only the `rubric` ones are judged. */
  criteria: readonly Criterion[];
  source: JudgeSource;
  /** Reads the rubric a criterion names; throws when it cannot. */
  loadRubric: (path: string) => Rubric | Promise<Rubric>;
  /** Called as each judgment ends. */
  onResult?: (id: string, outcome: JudgeOutcome) => void;
  /** Called before each judgment starts. */
  onStart?: (id: string) => void;
}

/** Judges each `rubric` criterion of `criteria` in turn. A rubric that does not load fails it. */
export async function judgeCriteria(
  o: JudgeCriteriaOptions,
): Promise<Record<string, JudgeOutcome>> {
  const out: Record<string, JudgeOutcome> = {};
  for (const c of o.criteria) {
    if (c.kind !== 'rubric') continue;
    if (o.signal?.aborted) break;
    o.onStart?.(c.id);
    let outcome: JudgeOutcome;
    try {
      const rubric = await o.loadRubric(c.rubric ?? '');
      const inputs = await judgeInputs(rubric, o.source, c);
      outcome = await runJudge(rubric, inputs, c.pass ?? DEFAULT_RUBRIC_PASS, o);
    } catch (err) {
      outcome = {
        rubric: c.rubric ?? '',
        runtime: o.config.runtime,
        model: null,
        costUsd: null,
        wallMs: 0,
        error: (err as Error).message,
      };
    }
    out[c.id] = outcome;
    o.onResult?.(c.id, outcome);
  }
  return out;
}

/** The total cost of judgments, or null when none reported one. */
export function judgeCost(outcomes: Iterable<JudgeOutcome>): number | null {
  let sum: number | null = null;
  for (const o of outcomes) if (typeof o.costUsd === 'number') sum = (sum ?? 0) + o.costUsd;
  return sum;
}

/**
 * Reads a task's rubric: an absolute path as it is; else the file at `base` in the code repo
 * (`git show`), so work on the branch cannot change the rubric it is judged by; else the file in
 * the task store's folder. Throws when none has it.
 */
export function taskRubricLoader(cwd: string, base: string, storeDir?: string) {
  return async (path: string): Promise<Rubric> => {
    if (!path) throw new OpsError('the criterion names no rubric file', 2);
    if (isAbsolute(path)) return readRubric(path);
    const rel = path.replace(/\\/g, '/').replace(/^\.\//, '');
    try {
      const text = await gitText(cwd, ['show', `${base}:${rel}`]);
      return parseRubric(text, `${rel} at ${base.slice(0, 12)}`);
    } catch (err) {
      if (err instanceof OpsError) throw err;
    }
    if (storeDir && existsSync(join(storeDir, rel))) return readRubric(join(storeDir, rel));
    throw new OpsError(
      `no rubric ${rel} at ${base.slice(0, 12)}${storeDir ? ' or in the task store' : ''}`,
      2,
    );
  };
}

export interface TaskJudgeOptions extends JudgeOptions {
  criteria: readonly Criterion[];
  /** The task's code: its worktree, or swarmupd's merge worktree. */
  cwd: string;
  /** The branch or commit the work goes into, such as `main`; the diff starts at its merge base. */
  base: string;
  /** The work's tip; default `HEAD`. */
  head?: string;
  /** The task store's folder, where a rubric may live too. */
  storeDir?: string;
  /** The task's title as a heading, then its body. */
  task: string;
  onResult?: (id: string, outcome: JudgeOutcome) => void;
  onStart?: (id: string) => void;
}

export interface TaskJudgement {
  outcomes: Record<string, JudgeOutcome>;
  /** The results to record: judgments that gave a score. */
  results: CriteriaResults;
  failed: string[];
  /** Criteria whose judgment gave no score, with why. */
  errors: Record<string, string>;
  costUsd: number | null;
  mergeBase: string;
}

/**
 * Judges a task's `rubric` criteria against its diff from the merge base of `base` and `head`,
 * with the tree in `cwd` for the `repo` and `files` inputs. Refuses a `base` git cannot find with
 * exit 2.
 */
export async function judgeTask(o: TaskJudgeOptions): Promise<TaskJudgement> {
  const head = o.head ?? 'HEAD';
  let mergeBase: string;
  try {
    mergeBase = (await gitText(o.cwd, ['merge-base', o.base, head])).trim();
  } catch {
    throw new OpsError(`no merge base of ${o.base} and ${head} in ${o.cwd}`, 2);
  }
  const diff = await gitText(o.cwd, ['diff', mergeBase, head]);
  const outcomes = await judgeCriteria({
    ...o,
    source: { cwd: o.cwd, diff, task: o.task },
    loadRubric: taskRubricLoader(o.cwd, mergeBase, o.storeDir),
  });
  const results: CriteriaResults = {};
  const errors: Record<string, string> = {};
  for (const [id, r] of Object.entries(outcomes)) {
    if (judgeFailed(r)) errors[id] = r.error;
    else results[id] = judgeVerdict(r);
  }
  return {
    outcomes,
    results,
    failed: Object.keys(results).filter((id) => results[id]!.result === 'fail'),
    errors,
    costUsd: judgeCost(Object.values(outcomes)),
    mergeBase,
  };
}

/** The event text of a task judgment: what was judged against what, the results, and the cost. */
export function judgeMessage(j: TaskJudgement, base: string, cfg: JudgeConfig): string {
  const parts = Object.entries(j.outcomes).map(([id, o]) =>
    judgeFailed(o) ? `${id} gave no score (${o.error})` : `${id} ${o.result} at ${round(o.score)}`,
  );
  const first = Object.values(j.outcomes)[0];
  const who = [cfg.runtime, first?.model ?? cfg.model].filter(Boolean).join(' ');
  const cost = costText(j.costUsd);
  return `Judged ${parts.length} rubric criteria against ${base} (${j.mergeBase.slice(0, 12)}) with ${who}: ${parts.join('; ')}.${cost ? ` Cost ${cost}.` : ''}`;
}

// ---- The app's Judge ----------------------------------------------------------------------------

/** A judge run on one task, as the app reads it: a check run's shape with the cost. */
export interface CriteriaJudgeJob extends CriteriaCheckJob {
  costUsd?: number | null;
}

export interface CriteriaJudgeDeps {
  /** Judges the task's rubric criteria in `cwd`, calling back as each starts and ends. */
  judge: (
    job: CriteriaJudgeJob,
    criteria: readonly Criterion[],
    on: { start: (id: string) => void; result: (id: string, o: JudgeOutcome) => void },
  ) => Promise<TaskJudgement & { message: string }>;
  /** Records the results as a `criteria-check` event by the judge; returns its id. */
  record: (task: string, by: string, results: CriteriaResults, message: string) => string;
  now?: () => number;
}

/**
 * `swarmup criteria judge` for the app: judges a task's `rubric` criteria in the background, one
 * at a time, keeps each result as it lands, and records those that gave a score in one
 * `criteria-check` event with `by: judge`. One run per task at a time; the last stays readable.
 */
export class CriteriaJudges {
  private readonly jobs = new Map<string, CriteriaJudgeJob>();
  private readonly now: () => number;

  constructor(private readonly deps: CriteriaJudgeDeps) {
    this.now = deps.now ?? Date.now;
  }

  get(task: string): CriteriaJudgeJob | null {
    return this.jobs.get(task) ?? null;
  }

  /** Starts judging; throws when a run is under way or the task has no rubric criteria. */
  start(
    task: string,
    by: string,
    cwd: string,
    criteria: readonly Criterion[],
  ): { job: CriteriaJudgeJob; done: Promise<void> } {
    const running = this.jobs.get(task);
    if (running && !running.endedAt) throw new Error(`the judge of ${task} is running already`);
    const rubrics = criteria.filter((c) => c.kind === 'rubric');
    if (rubrics.length === 0) throw new Error(`${task} has no rubric criteria to judge`);
    const job: CriteriaJudgeJob = {
      task,
      by,
      cwd,
      startedAt: new Date(this.now()).toISOString(),
      ids: rubrics.map((c) => c.id),
      results: {},
    };
    this.jobs.set(task, job);
    return { job, done: this.run(job, rubrics) };
  }

  private async run(job: CriteriaJudgeJob, rubrics: readonly Criterion[]): Promise<void> {
    try {
      const j = await this.deps.judge(job, rubrics, {
        start: (id) => {
          job.current = id;
        },
        result: (id, o) => {
          job.results[id] = judgeVerdict(o);
        },
      });
      job.current = undefined;
      job.costUsd = j.costUsd;
      if (Object.keys(j.results).length > 0) {
        job.event = this.deps.record(job.task, job.by, j.results, j.message);
      } else {
        job.error = `the judge gave no score: ${Object.values(j.errors).join('; ')}`;
      }
    } catch (err) {
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      job.current = undefined;
      job.endedAt = new Date(this.now()).toISOString();
    }
  }
}
