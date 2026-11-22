// Benchmark runner (W7 v1): replays the entries of a benchmark set (`core/src/bench.ts`) against an
// agent configuration and scores the results, standalone, without swarmupd. Each attempt gets a
// detached worktree of the repo at the entry's base, a non-interactive agent run with the same
// command line swarmupd builds, and an evaluation of the entry's criteria: visible checks first,
// then hidden commands with the hidden files copied in for each one. W5 phase 5 moves this into
// swarmupd (a bench root, a `bench_results` table); the result files are meant to carry over.
import type { ChildProcess } from 'node:child_process';
import { execFile, execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  BenchCriterion,
  BenchEntry,
  BenchSet,
  CheckDeps,
  CriterionVerdict,
  Rubric,
} from '@swarmup/core';
import {
  BENCH_BASE_TOKEN,
  benchCheckable,
  benchJudged,
  benchPrompt,
  checkBenchAgent,
  criterionWhat,
  deleteEnvVars,
  envVar,
  OpsError,
  parseRubric,
  readBenchSet,
  readRubric,
  runCriteria,
  runtimeOf,
} from '@swarmup/core';
import type { JudgeConfig, RuntimeConfig } from './config.js';
import { DEFAULT_RUNTIMES } from './config.js';
import type { JudgeRunner } from './judge.js';
import {
  costText,
  judgeCost,
  judgeCriteria,
  judgeFailed,
  judgeModel,
  judgeVerdict,
} from './judge.js';
import { logOrientation } from './orientation.js';
import { killTree, quoteBatch, resolveCommand } from './proc.js';
import { dropEnv, runEnv } from './runenv.js';
import { CLI_TOOLS, DEFAULT_CLAUDE_TOOLS, invocation } from './runtimes.js';

const WIN = process.platform === 'win32';

/** Minutes an attempt's agent may run when neither the CLI nor the set gives a budget. */
export const DEFAULT_BENCH_BUDGET_MIN = 30;

/**
 * Tools of a Claude bench run: swarmupd's defaults without the GitHub commands, plus the usual
 * commands of a coding task in Python or Node. `swarmup` itself is denied: a bench run works one
 * repo and no task store.
 */
export const BENCH_CLAUDE_TOOLS = [
  ...DEFAULT_CLAUDE_TOOLS.filter((t) => !t.startsWith('Bash(gh ')),
  'MultiEdit',
  'Bash(python *)',
  'Bash(python3 *)',
  'Bash(py *)',
  'Bash(pytest *)',
  'Bash(ls *)',
  'Bash(cat *)',
  'Bash(head *)',
  'Bash(tail *)',
  'Bash(wc *)',
  'Bash(mkdir *)',
  'Bash(diff *)',
];

/** How an attempt changes the worktree. */
export type BenchMode = 'agent' | 'none' | 'reference';

/** A criterion's result in a bench run: a checked result, or `pending` for a judge or a person. */
export type BenchResult = 'pass' | 'fail' | 'na' | 'pending';

export interface BenchCriterionResult {
  id: string;
  kind: string;
  hidden?: boolean;
  what: string;
  result: BenchResult;
  /** A judged `rubric` criterion: the weighted score as 0..1. */
  score?: number;
  /** A `rubric` criterion: its rubric file and the score that passes. */
  rubric?: string;
  pass?: number;
  evidence?: string;
  note?: string;
}

export interface BenchTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface AttemptMetrics {
  /** What the run's log reports: Claude's `total_cost_usd`; Codex reports none. */
  costUsd: number | null;
  tokens: BenchTokens | null;
  turns: number | null;
  toolCalls: number | null;
  /** Tool calls before the first edit (`orientation.ts`); all of them for a run with no edit. */
  toolCallsBeforeEdit: number | null;
  edited: boolean | null;
}

export interface AttemptScore {
  /** `command` and `check` criteria, hidden ones included, and judged `rubric` criteria. */
  checkable: number;
  passed: number;
  /** passed / checkable, or null without checkable criteria. */
  passRate: number | null;
  hidden: { total: number; passed: number };
  /** Prose, rubric and human criteria still left for a judge or a person. */
  pending: number;
  /** `rubric` criteria a judge scored (`--judge`, `swarmup bench judge`). */
  judged?: number;
}

/** What judging an attempt's `rubric` criteria cost, and who judged them. */
export interface AttemptJudge {
  runtime: string;
  model: string | null;
  /** Every judgment of the attempt so far; null when the runtime reports no cost. */
  costUsd: number | null;
  at: string;
}

/** One attempt's `results.json`. */
export interface AttemptResult {
  set: string;
  entry: string;
  attempt: number;
  mode: BenchMode;
  agent: string;
  model?: string;
  effort?: string;
  base: { ref: string; sha: string };
  budgetMin?: number;
  startedAt: string;
  run: {
    command?: string[];
    exitCode: number | null;
    timedOut: boolean;
    wallMs: number;
    error?: string;
  };
  metrics: AttemptMetrics;
  diff: { files: number; insertions: number; deletions: number };
  criteria: BenchCriterionResult[];
  score: AttemptScore;
  /** Set once a judge scored its `rubric` criteria. */
  judge?: AttemptJudge;
  /** The attempt's folder: `agent.log`, `diff.patch`, `results.json`, and the worktree when kept. */
  dir: string;
}

export interface EntrySummary {
  entry: string;
  attempts: number;
  /** Mean pass rate of checkable criteria over attempts. */
  passRate: number | null;
  /** Attempts whose hidden criteria all passed, of attempts; null for an entry with none. */
  hiddenPass: { passed: number; attempts: number } | null;
  pending: number;
  /** Judged `rubric` results over the entry's attempts. */
  judged?: number;
  /** What judging the entry's attempts cost in all; null when nothing reported a cost. */
  judgeCostUsd?: number | null;
  /** Mean per attempt. */
  costUsd: number | null;
  wallMs: number | null;
  toolCallsBeforeEdit: number | null;
  timedOut: number;
  errors: number;
}

export interface SummaryOverall {
  attempts: number;
  /** Mean of the entries' pass rates: each entry weighs the same. */
  passRate: number | null;
  /** Attempts with every hidden criterion passing, of attempts with hidden criteria. */
  hiddenPassRate: number | null;
  costUsd: number | null;
  costPerAttempt: number | null;
  wallMs: number | null;
  toolCallsBeforeEdit: number | null;
  /** Judged `rubric` results in the run. */
  judged?: number | null;
  /** What judging cost in all, apart from `costUsd`, the agents' cost. */
  judgeCostUsd?: number | null;
}

/** A run's `summary.json`. */
export interface BenchSummary {
  set: string;
  /** The set file, so `swarmup bench judge` finds the entries again. */
  setFile?: string;
  mode: BenchMode;
  agent: string;
  model?: string;
  effort?: string;
  repo: string;
  out: string;
  startedAt: string;
  finishedAt: string;
  /** The judge of the run's `rubric` criteria, and when it last judged. */
  judge?: { runtime: string; model: string | null; at: string };
  entries: EntrySummary[];
  overall: SummaryOverall;
}

// ---- Agent invocation ---------------------------------------------------------------------------

export interface BenchCommand {
  file: string;
  args: string[];
  unsetEnv: string[];
}

/**
 * The command line of a bench run of `agentId` in `cwd`: swarmupd's `invocation` with the bench
 * tools, so the flags match a real run. A Claude run gets `-p --permission-mode acceptEdits
 * --output-format stream-json --verbose`; `swarmup` moves from its allow list to its deny list.
 * A Codex run gets `exec --json --sandbox danger-full-access -C cwd -`, as in a task worktree.
 * Refuses other runtimes and a runtime that is not on PATH with exit 2.
 */
export function benchCommand(
  agentId: string,
  cwd: string,
  opts: {
    model?: string;
    effort?: string;
    runtimes?: Record<string, RuntimeConfig>;
    env?: NodeJS.ProcessEnv;
    /** Skip the PATH lookup, for a plan. */
    resolve?: boolean;
  } = {},
): BenchCommand {
  const runtime = runtimeOf(agentId);
  if (runtime !== 'claude' && runtime !== 'codex') {
    throw new OpsError(`bench runs claude and codex agents, not '${agentId}'`, 2);
  }
  const rc: RuntimeConfig = {
    ...DEFAULT_RUNTIMES[runtime]!,
    ...(opts.runtimes?.[runtime] ?? {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
  };
  let inv;
  try {
    inv = invocation(
      rc,
      agentId,
      runtime === 'claude'
        ? { id: agentId, status: 'active', file: '', body: '', tools: BENCH_CLAUDE_TOOLS }
        : undefined,
      cwd,
      [],
      [],
      undefined,
      false,
      false,
      [],
      [],
      undefined,
      true,
    );
  } catch (err) {
    throw new OpsError((err as Error).message, 2);
  }
  const args = runtime === 'claude' ? withoutCli(inv.args) : inv.args;
  let file = rc.command;
  if (opts.resolve !== false) {
    const found = resolveCommand(rc.command, opts.env ?? process.env);
    if (!found) throw new OpsError(`cannot find '${rc.command}' on PATH for ${agentId}`, 2);
    file = found;
  }
  return { file, args, unsetEnv: inv.unsetEnv };
}

/** Moves `swarmup` and `ops` from a Claude command line's allow list to its deny list. */
function withoutCli(args: string[]): string[] {
  const out = [...args];
  const cli = new Set(CLI_TOOLS);
  const allow = out.indexOf('--allowedTools');
  if (allow >= 0) {
    out[allow + 1] = out[allow + 1]!.split(',')
      .filter((t) => !cli.has(t))
      .join(',');
  }
  const deny = out.indexOf('--disallowedTools');
  if (deny >= 0) out[deny + 1] = [out[deny + 1], ...CLI_TOOLS].filter(Boolean).join(',');
  return out;
}

/**
 * The environment of a bench run: swarmupd's run environment without the identity of a live
 * SwarmUp run or a Claude Code session, so a bench started from inside one acts as no agent.
 */
export function benchEnv(
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

export interface ProcessOutcome {
  exitCode: number | null;
  timedOut: boolean;
  wallMs: number;
  error?: string;
}

/**
 * Runs `file args` in `cwd` with `prompt` on stdin and its output in `logPath`, without a window.
 * After `timeoutMs`, stops it and every process under it.
 */
export function runAgentProcess(
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; prompt: string; logPath: string; timeoutMs: number },
): Promise<ProcessOutcome> {
  const started = Date.now();
  const fd = openSync(opts.logPath, 'a');
  let child: ChildProcess;
  try {
    if (WIN && /\.(cmd|bat)$/i.test(file)) {
      // A batch shim runs in cmd.exe, which reads the arguments again (see `quoteBatch`).
      const line = `"${[file, ...args].map(quoteBatch).join(' ')}"`;
      child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/v:off', '/s', '/c', line], {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', fd, fd],
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
    } else {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', fd, fd],
        windowsHide: true,
        // Off Windows, its own process group, so a timeout stops what it started too.
        detached: !WIN,
      });
    }
  } catch (err) {
    closeSync(fd);
    return Promise.resolve({
      exitCode: null,
      timedOut: false,
      wallMs: 0,
      error: (err as Error).message,
    });
  }
  return new Promise((done) => {
    let timedOut = false;
    let error: string | undefined;
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hard);
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
      done({
        exitCode: code,
        timedOut,
        wallMs: Date.now() - started,
        ...(error ? { error } : {}),
      });
    };
    let hard: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) stopBenchTree(child.pid);
      // A tree that does not end still lets the attempt finish.
      hard = setTimeout(() => finish(null), 30_000);
    }, opts.timeoutMs);
    child.on('error', (err) => {
      error = err.message;
      finish(null);
    });
    child.on('close', (code) => finish(code));
    child.stdin?.on('error', () => {});
    child.stdin?.end(opts.prompt);
  });
}

/** Stops a child this process started, and every process under it, while it still runs. */
export function stopBenchTree(pid: number): void {
  if (!WIN) {
    killTree(pid);
    return;
  }
  execFile(
    'taskkill',
    ['/T', '/F', '/PID', String(pid)],
    { windowsHide: true, timeout: 15_000 },
    () => {
      // A failure leaves the hard deadline in `runAgentProcess` to end the attempt.
    },
  );
}

// ---- Log metrics --------------------------------------------------------------------------------

/** Codex items that are a tool call, as `orientation.ts` counts them. */
const CODEX_TOOLS = new Set(['command_execution', 'mcp_tool_call', 'web_search', 'file_change']);

interface UsageFields {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cached_input_tokens?: number;
}

/**
 * Cost, tokens, turns and tool calls from a run log: Claude `stream-json` (its `result` message
 * has `total_cost_usd`, `usage` and `num_turns`) or Codex `--json` (`turn.completed` usage).
 */
export function logMetrics(path: string): AttemptMetrics {
  const out: AttemptMetrics = {
    costUsd: null,
    tokens: null,
    turns: null,
    toolCalls: null,
    toolCallsBeforeEdit: null,
    edited: null,
  };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  const messages = new Map<string, UsageFields>();
  let result: UsageFields | null = null;
  const codex: BenchTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let codexTurns = 0;
  let calls = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (ev.type === 'result') {
      if (typeof ev.total_cost_usd === 'number') out.costUsd = ev.total_cost_usd;
      if (typeof ev.num_turns === 'number') out.turns = ev.num_turns;
      if (ev.usage && typeof ev.usage === 'object') result = ev.usage as UsageFields;
    } else if (ev.type === 'assistant' && !ev.parent_tool_use_id) {
      const msg = ev.message as { id?: string; usage?: UsageFields; content?: unknown } | undefined;
      if (msg?.usage) messages.set(msg.id ?? String(messages.size), msg.usage);
      if (Array.isArray(msg?.content)) {
        for (const b of msg.content as Array<{ type?: string }>)
          if (b?.type === 'tool_use') calls++;
      }
    } else if (ev.type === 'turn.completed' && ev.usage) {
      const u = ev.usage as UsageFields;
      codexTurns++;
      codex.input += (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0);
      codex.cacheRead += u.cached_input_tokens ?? 0;
      codex.output += u.output_tokens ?? 0;
    } else if (ev.type === 'item.completed') {
      const item = ev.item as { type?: string } | undefined;
      if (item?.type && CODEX_TOOLS.has(item.type)) calls++;
    }
  }
  const claudeTokens = (u: UsageFields): BenchTokens => ({
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  });
  if (result) out.tokens = claudeTokens(result);
  else if (messages.size > 0) {
    out.tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const u of messages.values()) {
      const m = claudeTokens(u);
      out.tokens.input += m.input;
      out.tokens.output += m.output;
      out.tokens.cacheRead += m.cacheRead;
      out.tokens.cacheWrite += m.cacheWrite;
    }
  } else if (codexTurns > 0) {
    out.tokens = codex;
    out.turns = codexTurns;
  }
  out.toolCalls = calls;
  const o = logOrientation(path);
  if (o) {
    out.toolCallsBeforeEdit = o.toolCalls;
    out.edited = o.edited;
  } else if (calls === 0 && (out.tokens || out.costUsd !== null)) {
    out.toolCallsBeforeEdit = 0;
    out.edited = false;
  }
  return out;
}

// ---- Evaluation ---------------------------------------------------------------------------------

export interface EvaluateOptions {
  /** The attempt's worktree. */
  cwd: string;
  /** The resolved base commit, for `{{base}}` in commands. */
  baseSha: string;
  /** The hidden files' folder; required when a criterion is hidden. */
  hiddenDir?: string;
  /** Where the hidden files go inside `cwd`. */
  hiddenTo: string;
  /** Runs one command criterion; tests replace it. */
  runCommand?: CheckDeps['runCommand'];
}

/**
 * Scores an attempt's worktree against an entry's criteria, in this order: the visible `command`
 * and `check` criteria (through `runCriteria`), then each hidden command, with `hiddenDir`
 * copied to `hiddenTo` right before it runs and removed right after, so no visible command ever
 * sees the hidden files. Prose, rubric and human criteria are `pending`; `map` is `na`. Results
 * keep the criteria's order.
 */
export async function evaluateAttempt(
  criteria: readonly BenchCriterion[],
  opts: EvaluateOptions,
): Promise<BenchCriterionResult[]> {
  const withBase = (c: BenchCriterion): BenchCriterion =>
    c.kind === 'command' && c.run
      ? { ...c, run: c.run.split(BENCH_BASE_TOKEN).join(opts.baseSha) }
      : c;
  const deps: CheckDeps = {
    cwd: opts.cwd,
    ...(opts.runCommand ? { runCommand: opts.runCommand } : {}),
  };
  const verdicts = new Map<string, CriterionVerdict | { result: 'pending'; note: string }>();
  const visible = criteria.filter((c) => !c.hidden && (benchCheckable(c) || c.kind === 'map'));
  const results = await runCriteria(visible.map(withBase), deps);
  for (const c of visible) {
    verdicts.set(c.id, results[c.id] ?? { result: 'na', note: 'no result' });
  }
  for (const c of criteria.filter((x) => x.hidden)) {
    verdicts.set(c.id, await runHidden(withBase(c), deps, opts));
  }
  return criteria.map((c) => {
    const v = verdicts.get(c.id) ?? {
      result: 'pending' as const,
      note: c.kind === 'human' ? 'waits for a person' : 'waits for a judge',
    };
    return {
      id: c.id,
      kind: c.kind,
      ...(c.hidden ? { hidden: true } : {}),
      what: criterionWhat(c),
      result: v.result,
      ...rubricOf(c),
      ...('evidence' in v && v.evidence ? { evidence: v.evidence } : {}),
      ...(v.note ? { note: v.note } : {}),
    };
  });
}

/** The rubric file and pass of a `rubric` criterion, for its result. */
function rubricOf(c: BenchCriterion): Pick<BenchCriterionResult, 'rubric' | 'pass'> {
  if (c.kind !== 'rubric') return {};
  return {
    ...(c.rubric ? { rubric: c.rubric } : {}),
    ...(c.pass !== undefined ? { pass: c.pass } : {}),
  };
}

async function runHidden(
  c: BenchCriterion,
  deps: CheckDeps,
  opts: EvaluateOptions,
): Promise<CriterionVerdict> {
  if (!opts.hiddenDir) return { result: 'na', note: 'no hidden folder given' };
  const target = resolve(opts.cwd, opts.hiddenTo);
  if (existsSync(target)) {
    // The agent made a folder of that name: leave its work alone and fail the check.
    return {
      result: 'fail',
      note: `the worktree already has ${opts.hiddenTo}/, so the hidden files were not copied`,
    };
  }
  cpSync(opts.hiddenDir, target, {
    recursive: true,
    filter: (src) => basename(src) !== '__pycache__',
  });
  try {
    const r = await runCriteria([c], deps);
    return r[c.id] ?? { result: 'na', note: 'no result' };
  } finally {
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/** Whether a result is a `rubric` criterion a judge scored. */
function judgedRubric(r: BenchCriterionResult): boolean {
  return r.kind === 'rubric' && (r.result === 'pass' || r.result === 'fail');
}

/**
 * The score of an attempt's criteria. The pass rate counts `command` and `check` criteria, hidden
 * ones included, and the `rubric` criteria a judge scored; pending ones stay out of it.
 */
export function scoreAttempt(results: readonly BenchCriterionResult[]): AttemptScore {
  const checkable = results.filter(
    (r) => benchCheckable(r as { kind: BenchCriterion['kind'] }) || judgedRubric(r),
  );
  const hidden = checkable.filter((r) => r.hidden);
  const passed = checkable.filter((r) => r.result === 'pass').length;
  return {
    checkable: checkable.length,
    passed,
    passRate: checkable.length > 0 ? passed / checkable.length : null,
    hidden: { total: hidden.length, passed: hidden.filter((r) => r.result === 'pass').length },
    pending: results.filter((r) => r.result === 'pending').length,
    judged: results.filter(judgedRubric).length,
  };
}

// ---- Summary and compare -----------------------------------------------------------------------

function mean(values: Array<number | null | undefined>): number | null {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return v.length > 0 ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function sum(values: Array<number | null | undefined>): number | null {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return v.length > 0 ? v.reduce((a, b) => a + b, 0) : null;
}

/** Per-entry figures of a run's attempts, in the order entries first appear. */
export function summarizeEntries(attempts: readonly AttemptResult[]): EntrySummary[] {
  const byEntry = new Map<string, AttemptResult[]>();
  for (const a of attempts) byEntry.set(a.entry, [...(byEntry.get(a.entry) ?? []), a]);
  return [...byEntry].map(([entry, list]) => {
    const withHidden = list.filter((a) => a.score.hidden.total > 0);
    return {
      entry,
      attempts: list.length,
      passRate: mean(list.map((a) => a.score.passRate)),
      hiddenPass:
        withHidden.length > 0
          ? {
              passed: withHidden.filter((a) => a.score.hidden.passed === a.score.hidden.total)
                .length,
              attempts: withHidden.length,
            }
          : null,
      pending: list[0]!.score.pending,
      judged: list.reduce((n, a) => n + (a.score.judged ?? 0), 0),
      judgeCostUsd: sum(list.map((a) => a.judge?.costUsd)),
      costUsd: mean(list.map((a) => a.metrics.costUsd)),
      wallMs: mean(list.map((a) => a.run.wallMs)),
      toolCallsBeforeEdit: mean(list.map((a) => a.metrics.toolCallsBeforeEdit)),
      timedOut: list.filter((a) => a.run.timedOut).length,
      errors: list.filter((a) => a.run.error).length,
    };
  });
}

/** Figures over entries: pass rate weighs each entry the same; the rest count attempts. */
export function overallOf(entries: readonly EntrySummary[]): SummaryOverall {
  const attempts = entries.reduce((n, e) => n + e.attempts, 0);
  const hidden = entries.filter((e) => e.hiddenPass);
  const hiddenAttempts = hidden.reduce((n, e) => n + e.hiddenPass!.attempts, 0);
  const costUsd = sum(entries.map((e) => (e.costUsd === null ? null : e.costUsd * e.attempts)));
  const weighted = (pick: (e: EntrySummary) => number | null): number | null => {
    const parts = entries.filter((e) => pick(e) !== null);
    const n = parts.reduce((k, e) => k + e.attempts, 0);
    return n > 0 ? parts.reduce((s, e) => s + pick(e)! * e.attempts, 0) / n : null;
  };
  return {
    attempts,
    passRate: mean(entries.map((e) => e.passRate)),
    hiddenPassRate:
      hiddenAttempts > 0
        ? hidden.reduce((n, e) => n + e.hiddenPass!.passed, 0) / hiddenAttempts
        : null,
    costUsd,
    costPerAttempt: weighted((e) => e.costUsd),
    wallMs: weighted((e) => e.wallMs),
    toolCallsBeforeEdit: weighted((e) => e.toolCallsBeforeEdit),
    judged: entries.reduce((n, e) => n + (e.judged ?? 0), 0),
    judgeCostUsd: sum(entries.map((e) => e.judgeCostUsd)),
  };
}

const pct = (v: number | null): string => (v === null ? '-' : `${Math.round(v * 100)}%`);
const usd = (v: number | null): string => (v === null ? '-' : `$${v.toFixed(2)}`);
const num = (v: number | null): string => (v === null ? '-' : String(Math.round(v * 10) / 10));

function dur(ms: number | null): string {
  if (ms === null) return '-';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** `summary.md`: the run's table. */
export function summaryMarkdown(s: BenchSummary): string {
  const who = [s.agent, s.model, s.effort].filter(Boolean).join(', ');
  const lines = [
    `# Benchmark ${s.set}: ${who}`,
    '',
    `- Mode: ${s.mode}`,
    `- Repo: \`${s.repo}\``,
    `- Started: ${s.startedAt}; finished: ${s.finishedAt}`,
    ...(s.judge
      ? [`- Judge: ${[s.judge.runtime, s.judge.model].filter(Boolean).join(', ')}; ${s.judge.at}`]
      : []),
    '',
    '| Entry | Attempts | Pass rate | Hidden pass | Pending | Judged | Cost | Judge cost | Time | Tools before edit |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const e of s.entries) {
    const flags = [
      e.timedOut ? `${e.timedOut} timed out` : '',
      e.errors ? `${e.errors} errors` : '',
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(
      `| ${e.entry}${flags ? ` (${flags})` : ''} | ${e.attempts} | ${pct(e.passRate)} | ${
        e.hiddenPass ? `${e.hiddenPass.passed}/${e.hiddenPass.attempts}` : '-'
      } | ${e.pending} | ${e.judged ?? 0} | ${usd(e.costUsd)} | ${usd(e.judgeCostUsd ?? null)} | ${dur(e.wallMs)} | ${num(e.toolCallsBeforeEdit)} |`,
    );
  }
  const o = s.overall;
  lines.push(
    `| **All** | ${o.attempts} | ${pct(o.passRate)} | ${pct(o.hiddenPassRate)} | | ${o.judged ?? 0} | ${usd(o.costUsd)} total, ${usd(o.costPerAttempt)} each | ${usd(o.judgeCostUsd ?? null)} | ${dur(o.wallMs)} | ${num(o.toolCallsBeforeEdit)} |`,
    '',
    'Pass rate counts `command` and `check` criteria, hidden ones included, and the `rubric`',
    'criteria a judge scored. Pending criteria (prose, human, and rubric not judged yet) wait for',
    'a judge or a person. Judged counts rubric results over all attempts, and judge cost is their',
    'total. Cost, time and tools before the first edit are means per attempt.',
    '',
  );
  return lines.join('\n');
}

export interface CompareRow {
  entry: string;
  a: EntrySummary | null;
  b: EntrySummary | null;
}

export interface Comparison {
  a: { set: string; agent: string; model?: string; effort?: string; out: string };
  b: { set: string; agent: string; model?: string; effort?: string; out: string };
  rows: CompareRow[];
  /** Over the entries both runs have, so the deltas compare like with like. */
  overall: {
    a: SummaryOverall;
    b: SummaryOverall;
    delta: Record<keyof SummaryOverall, number | null>;
  };
}

function delta(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : b - a;
}

/** Per entry and overall figures of two runs, with B minus A. */
export function compareSummaries(a: BenchSummary, b: BenchSummary): Comparison {
  const ids = [...new Set([...a.entries.map((e) => e.entry), ...b.entries.map((e) => e.entry)])];
  const rows = ids.map((entry) => ({
    entry,
    a: a.entries.find((e) => e.entry === entry) ?? null,
    b: b.entries.find((e) => e.entry === entry) ?? null,
  }));
  const both = rows.filter((r) => r.a && r.b);
  const oa = overallOf(both.map((r) => r.a!));
  const ob = overallOf(both.map((r) => r.b!));
  const keys = Object.keys(oa) as Array<keyof SummaryOverall>;
  const head = (s: BenchSummary) => ({
    set: s.set,
    agent: s.agent,
    ...(s.model ? { model: s.model } : {}),
    ...(s.effort ? { effort: s.effort } : {}),
    out: s.out,
  });
  return {
    a: head(a),
    b: head(b),
    rows,
    overall: {
      a: oa,
      b: ob,
      delta: Object.fromEntries(
        keys.map((k) => [k, delta(oa[k] ?? null, ob[k] ?? null)]),
      ) as Record<keyof SummaryOverall, number | null>,
    },
  };
}

function signed(v: number | null, f: (x: number) => string): string {
  if (v === null) return '';
  if (Math.abs(v) < 1e-9) return ' (±0)';
  return ` (${v > 0 ? '+' : '-'}${f(Math.abs(v))})`;
}

/** A comparison as a Markdown table. */
export function compareMarkdown(c: Comparison): string {
  const who = (x: Comparison['a']): string =>
    [x.agent, x.model, x.effort].filter(Boolean).join(', ');
  const hidden = (e: EntrySummary | null): string =>
    e?.hiddenPass ? `${e.hiddenPass.passed}/${e.hiddenPass.attempts}` : '-';
  const cell = (
    a: number | null,
    b: number | null,
    f: (x: number | null) => string,
    fd: (x: number) => string,
  ): string => `${f(a)} → ${f(b)}${signed(delta(a, b), fd)}`;
  const pp = (x: number): string => `${Math.round(x * 100)} pts`;
  const lines = [
    `# Compare ${c.a.set}: A ${who(c.a)} → B ${who(c.b)}`,
    '',
    '| Entry | Pass rate | Hidden pass | Cost | Time | Tools before edit |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of c.rows) {
    lines.push(
      `| ${r.entry} | ${cell(r.a?.passRate ?? null, r.b?.passRate ?? null, pct, pp)} | ${hidden(r.a)} → ${hidden(r.b)} | ${cell(
        r.a?.costUsd ?? null,
        r.b?.costUsd ?? null,
        usd,
        (x) => `$${x.toFixed(2)}`,
      )} | ${cell(r.a?.wallMs ?? null, r.b?.wallMs ?? null, dur, (x) => dur(x))} | ${cell(
        r.a?.toolCallsBeforeEdit ?? null,
        r.b?.toolCallsBeforeEdit ?? null,
        num,
        (x) => num(x),
      )} |`,
    );
  }
  const { a, b } = c.overall;
  lines.push(
    `| **All (shared entries)** | ${cell(a.passRate, b.passRate, pct, pp)} | ${cell(
      a.hiddenPassRate,
      b.hiddenPassRate,
      pct,
      pp,
    )} | ${cell(a.costPerAttempt, b.costPerAttempt, usd, (x) => `$${x.toFixed(2)}`)} | ${cell(
      a.wallMs,
      b.wallMs,
      dur,
      (x) => dur(x),
    )} | ${cell(a.toolCallsBeforeEdit, b.toolCallsBeforeEdit, num, (x) => num(x))} |`,
    '',
    'Cost, time and tools before edit are means per attempt; the overall row covers the entries',
    'both runs have.',
    '',
  );
  return lines.join('\n');
}

/** Reads a `summary.json`, or the one in a run's out folder. Refuses anything else with exit 2. */
export function readBenchSummary(path: string): BenchSummary {
  const file = existsSync(join(path, 'summary.json')) ? join(path, 'summary.json') : path;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new OpsError(`cannot read a bench summary from ${path}`, 2);
  }
  const s = data as Partial<BenchSummary>;
  if (!s || typeof s.set !== 'string' || !Array.isArray(s.entries) || !s.overall) {
    throw new OpsError(`${file} is not a bench summary.json`, 2);
  }
  return s as BenchSummary;
}

// ---- The run ------------------------------------------------------------------------------------

export interface BenchRunOptions {
  set: BenchSet;
  /** The repo under test; each attempt gets a detached worktree of it. */
  repo: string;
  /** Where attempts and the summary go; must not exist yet or be empty, and lie outside `repo`. */
  out: string;
  entries?: string[];
  /** Overrides the set's agents: `<runtime>:<role>` or `none`. */
  agent?: string;
  model?: string;
  effort?: string;
  repeat?: number;
  budgetMin?: number;
  /** Overrides the set's `hidden_dir`. */
  hiddenDir?: string;
  /** Applies `<dir>/<entry>.patch` instead of running an agent. */
  referenceDir?: string;
  dryRun?: boolean;
  /** Keep each attempt's worktree; by default it is removed after its diff is saved. */
  keep?: boolean;
  env?: NodeJS.ProcessEnv;
  runtimes?: Record<string, RuntimeConfig>;
  log: (line: string) => void;
  /** Runs one command criterion; tests replace it. */
  runCommand?: CheckDeps['runCommand'];
  /** Judges each attempt's `rubric` criteria after its checks (`--judge`). */
  judge?: BenchJudge;
  /** The clock, for tests. */
  now?: () => Date;
}

/** The judge of a bench run's `rubric` criteria. */
export interface BenchJudge {
  config: JudgeConfig;
  /** Runs one judge process; tests replace it. */
  runner?: JudgeRunner;
  /** The machine's runtimes, for the judge's command and `unset_env`. */
  runtimes?: Record<string, RuntimeConfig>;
}

/** One attempt of the plan. */
export interface PlannedAttempt {
  entry: BenchEntry;
  attempt: number;
  mode: BenchMode;
  agent: string;
  baseSha: string;
  budgetMin: number;
  patch?: string;
  command?: BenchCommand;
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function inside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !/^[A-Za-z]:/.test(rel) && !rel.startsWith('/'));
}

/** Checks the options and lays out every attempt. Refuses bad input with exit 2. */
export function planBench(opts: BenchRunOptions): {
  attempts: PlannedAttempt[];
  repo: string;
  hiddenDir?: string;
  skipped: string[];
} {
  const set = opts.set;
  let repo: string;
  try {
    repo = resolve(git(opts.repo, ['rev-parse', '--show-toplevel']).trim());
  } catch {
    throw new OpsError(`${opts.repo} is not a git repo`, 2);
  }
  if (inside(repo, opts.out))
    throw new OpsError(`--out ${opts.out} is inside the repo under test`, 2);
  if (opts.agent) checkBenchAgent(opts.agent, '--agent');
  if (opts.referenceDir && opts.agent && opts.agent !== 'none') {
    throw new OpsError('--reference-dir applies patches instead of an agent: drop --agent', 2);
  }
  let entries = set.entries;
  if (opts.entries && opts.entries.length > 0) {
    const unknown = opts.entries.filter((id) => !set.entries.some((e) => e.id === id));
    if (unknown.length > 0) {
      throw new OpsError(
        `no entry ${unknown.join(', ')} in ${set.id} (it has ${set.entries.map((e) => e.id).join(', ')})`,
        2,
      );
    }
    entries = opts.entries.map((id) => set.entries.find((e) => e.id === id)!);
  }
  const skipped: string[] = [];
  if (opts.referenceDir) {
    const dir = resolve(opts.referenceDir);
    const has = (id: string): boolean => existsSync(join(dir, `${id}.patch`));
    if (opts.entries?.length) {
      const missing = entries.filter((e) => !has(e.id)).map((e) => e.id);
      if (missing.length > 0)
        throw new OpsError(`no reference patch for ${missing.join(', ')} in ${dir}`, 2);
    } else {
      skipped.push(...entries.filter((e) => !has(e.id)).map((e) => e.id));
      entries = entries.filter((e) => has(e.id));
    }
    if (entries.length === 0) throw new OpsError(`no reference patches for this set in ${dir}`, 2);
  }
  const hiddenDir = opts.hiddenDir ? resolve(opts.hiddenDir) : set.hiddenDir;
  if (entries.some((e) => e.criteria.some((c) => c.hidden))) {
    if (!hiddenDir) {
      throw new OpsError(
        'the entries have hidden criteria: pass --hidden-dir or set hidden_dir',
        2,
      );
    }
    if (!existsSync(hiddenDir) || readdirSync(hiddenDir).length === 0) {
      throw new OpsError(`the hidden folder ${hiddenDir} is missing or empty`, 2);
    }
    if (inside(repo, hiddenDir)) {
      throw new OpsError(
        `the hidden folder ${hiddenDir} is inside the repo under test: an agent could read it`,
        2,
      );
    }
  }
  const shas = new Map<string, string>();
  const attempts: PlannedAttempt[] = [];
  for (const entry of entries) {
    if (!('ref' in entry.base)) {
      throw new OpsError(
        `${entry.id}: this version runs base.ref entries only, not snapshot or empty bases`,
        2,
      );
    }
    const ref = entry.base.ref;
    let sha = shas.get(ref);
    if (!sha) {
      try {
        sha = git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
      } catch {
        throw new OpsError(`${entry.id}: ${repo} has no commit '${ref}'`, 2);
      }
      shas.set(ref, sha);
    }
    const mode: BenchMode = opts.referenceDir
      ? 'reference'
      : (opts.agent ?? entry.agent) === 'none'
        ? 'none'
        : 'agent';
    const agent = mode === 'reference' ? 'reference' : (opts.agent ?? entry.agent);
    if (!agent)
      throw new OpsError(`${entry.id} names no agent: pass --agent or set defaults.agent`, 2);
    const budgetMin = opts.budgetMin ?? entry.budget ?? DEFAULT_BENCH_BUDGET_MIN;
    const command =
      mode === 'agent'
        ? benchCommand(agent, '<worktree>', {
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.effort ? { effort: opts.effort } : {}),
            ...(opts.runtimes ? { runtimes: opts.runtimes } : {}),
            env: opts.env ?? process.env,
            resolve: !opts.dryRun,
          })
        : undefined;
    // A run that changes nothing, or applies a fixed patch, gives the same result every time.
    const repeat = mode === 'agent' ? (opts.repeat ?? entry.repeat) : 1;
    for (let n = 1; n <= repeat; n++) {
      attempts.push({
        entry,
        attempt: n,
        mode,
        agent,
        baseSha: sha,
        budgetMin,
        ...(mode === 'reference'
          ? { patch: join(resolve(opts.referenceDir!), `${entry.id}.patch`) }
          : {}),
        ...(command ? { command } : {}),
      });
    }
  }
  return { attempts, repo, ...(hiddenDir ? { hiddenDir } : {}), skipped };
}

/** The plan as lines, for `--dry-run` and the start of a run. */
export function planLines(plan: ReturnType<typeof planBench>, opts: BenchRunOptions): string[] {
  const lines = [
    `set ${opts.set.id}: ${plan.attempts.length} attempts in ${resolve(opts.out)}`,
    `repo ${plan.repo}${plan.hiddenDir ? `; hidden files from ${plan.hiddenDir}` : ''}`,
  ];
  if (plan.skipped.length > 0)
    lines.push(`skipped (no reference patch): ${plan.skipped.join(', ')}`);
  for (const a of plan.attempts) {
    const c = a.entry.criteria;
    const counts = `${c.filter((x) => benchCheckable(x) && !x.hidden).length} visible, ${
      c.filter((x) => x.hidden).length
    } hidden, ${c.filter((x) => benchJudged(x)).length} pending`;
    const how =
      a.mode === 'reference'
        ? `apply ${a.patch}`
        : a.mode === 'none'
          ? 'no agent'
          : `${a.agent}${opts.model ? ` --model ${opts.model}` : ''}${opts.effort ? ` --effort ${opts.effort}` : ''}, ${a.budgetMin} min`;
    lines.push(
      `  ${a.entry.id} #${a.attempt}: base ${a.baseSha.slice(0, 12)}, ${how}; criteria ${counts}`,
    );
  }
  if (opts.judge) lines.push(judgeLine(opts.judge, opts.runtimes));
  const cmd = plan.attempts.find((a) => a.command)?.command;
  if (cmd)
    lines.push(
      `command: ${cmd.file} ${cmd.args.map((x) => (/[\s,*()]/.test(x) ? JSON.stringify(x) : x)).join(' ')}`,
    );
  return lines;
}

function diffStats(wt: string, sha: string): AttemptResult['diff'] {
  git(wt, ['add', '-A']);
  const s = git(wt, ['diff', '--cached', '--shortstat', sha]);
  const n = (re: RegExp): number => Number(re.exec(s)?.[1] ?? 0);
  return {
    files: n(/(\d+) files? changed/),
    insertions: n(/(\d+) insertions?/),
    deletions: n(/(\d+) deletions?/),
  };
}

function removeWorktree(repo: string, wt: string, log: (line: string) => void): void {
  try {
    git(repo, ['worktree', 'remove', '--force', wt]);
  } catch {
    try {
      rmSync(wt, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      git(repo, ['worktree', 'prune']);
    } catch (err) {
      log(`could not remove the worktree ${wt}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
}

/** Runs one planned attempt and writes its `results.json`. */
export async function runAttempt(
  a: PlannedAttempt,
  ctx: { opts: BenchRunOptions; repo: string; hiddenDir?: string; out: string },
): Promise<AttemptResult> {
  const { opts } = ctx;
  const now = opts.now ?? (() => new Date());
  const dir = join(ctx.out, a.entry.id, String(a.attempt));
  const wt = join(dir, 'worktree');
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, 'agent.log');
  const startedAt = now().toISOString();
  const result: AttemptResult = {
    set: opts.set.id,
    entry: a.entry.id,
    attempt: a.attempt,
    mode: a.mode,
    agent: a.agent,
    ...(a.mode === 'agent' && opts.model ? { model: opts.model } : {}),
    ...(a.mode === 'agent' && opts.effort ? { effort: opts.effort } : {}),
    base: { ref: 'ref' in a.entry.base ? a.entry.base.ref : '', sha: a.baseSha },
    ...(a.mode === 'agent' ? { budgetMin: a.budgetMin } : {}),
    startedAt,
    run: { exitCode: null, timedOut: false, wallMs: 0 },
    metrics: {
      costUsd: null,
      tokens: null,
      turns: null,
      toolCalls: null,
      toolCallsBeforeEdit: null,
      edited: null,
    },
    diff: { files: 0, insertions: 0, deletions: 0 },
    criteria: [],
    score: { checkable: 0, passed: 0, passRate: null, hidden: { total: 0, passed: 0 }, pending: 0 },
    dir,
  };
  try {
    git(ctx.repo, ['worktree', 'add', '--detach', wt, a.baseSha]);
  } catch (err) {
    result.run.error = `could not make the worktree: ${(err as Error).message.split('\n')[0]}`;
    result.criteria = a.entry.criteria.map((c) => ({
      id: c.id,
      kind: c.kind,
      ...(c.hidden ? { hidden: true } : {}),
      what: criterionWhat(c),
      result: benchJudged(c) ? 'pending' : 'na',
      note: 'not evaluated: no worktree',
    }));
    result.score = scoreAttempt(result.criteria);
    writeFileSync(join(dir, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  try {
    if (a.mode === 'agent' && a.command) {
      const cmd = benchCommand(a.agent, wt, {
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.effort ? { effort: opts.effort } : {}),
        ...(opts.runtimes ? { runtimes: opts.runtimes } : {}),
        env: opts.env ?? process.env,
      });
      result.run.command = [cmd.file, ...cmd.args];
      const outcome = await runAgentProcess(cmd.file, cmd.args, {
        cwd: wt,
        env: benchEnv(opts.env ?? process.env, cmd.unsetEnv),
        prompt: benchPrompt(a.entry),
        logPath,
        timeoutMs: a.budgetMin * 60_000,
      });
      result.run = { ...result.run, ...outcome };
      result.metrics = logMetrics(logPath);
    } else if (a.mode === 'reference' && a.patch) {
      const t0 = Date.now();
      try {
        git(wt, ['apply', '--whitespace=nowarn', a.patch]);
        result.run.exitCode = 0;
      } catch (err) {
        result.run.exitCode = 1;
        result.run.error = `the patch did not apply: ${(err as Error).message.split('\n')[0]}`;
      }
      result.run.wallMs = Date.now() - t0;
    } else {
      result.run.exitCode = 0;
    }
    result.diff = diffStats(wt, a.baseSha);
    writeFileSync(join(dir, 'diff.patch'), git(wt, ['diff', '--cached', '--binary', a.baseSha]));
    result.criteria = await evaluateAttempt(a.entry.criteria, {
      cwd: wt,
      baseSha: a.baseSha,
      hiddenTo: opts.set.hiddenTo,
      ...(ctx.hiddenDir ? { hiddenDir: ctx.hiddenDir } : {}),
      ...(opts.runCommand ? { runCommand: opts.runCommand } : {}),
    });
    if (opts.judge) {
      try {
        await judgeAttempt(result, a.entry, {
          set: opts.set,
          repo: ctx.repo,
          cwd: wt,
          judge: opts.judge,
          env: opts.env ?? process.env,
          now,
        });
      } catch (err) {
        opts.log(`${a.entry.id} #${a.attempt}: the judge failed: ${(err as Error).message}`);
      }
    }
    result.score = scoreAttempt(result.criteria);
  } finally {
    writeFileSync(join(dir, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
    if (!opts.keep) removeWorktree(ctx.repo, wt, opts.log);
  }
  return result;
}

/** A run's `status.json`: where a run that is under way stands, for the desktop app. */
export interface BenchStatus {
  state: 'running' | 'done' | 'failed';
  /** Attempts finished, of `total`. */
  done: number;
  total: number;
  /** The attempt under way, such as `TB-02 #1`. */
  current?: string;
  /** The runner's process id. */
  pid: number;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  error?: string;
}

/**
 * Files of an out folder that do not make it "already holds files": what the desktop app writes
 * before the runner starts (its request and the runner's output), and the runner's status.
 */
export const BENCH_RUN_FILES = ['request.json', 'run.log', 'status.json'] as const;

/** Writes `status.json` whole, through a temporary file, so a reader never sees half of it. */
export function writeBenchStatus(out: string, status: BenchStatus): void {
  const file = join(out, 'status.json');
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`);
  renameSync(tmp, file);
}

/**
 * Runs a benchmark: every planned attempt in turn, then `summary.json` and `summary.md` in the
 * out folder. With `dryRun`, prints the plan and touches nothing. Returns the summary, or null
 * for a dry run. While it runs, `status.json` in the out folder says how far it got.
 */
export async function runBench(opts: BenchRunOptions): Promise<BenchSummary | null> {
  const plan = planBench(opts);
  const out = resolve(opts.out);
  for (const line of planLines(plan, opts)) opts.log(line);
  if (opts.dryRun) return null;
  if (
    existsSync(out) &&
    readdirSync(out).some((f) => !(BENCH_RUN_FILES as readonly string[]).includes(f))
  ) {
    throw new OpsError(`${out} already holds files: pick a new --out`, 2);
  }
  mkdirSync(out, { recursive: true });
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const status: BenchStatus = {
    state: 'running',
    done: 0,
    total: plan.attempts.length,
    pid: process.pid,
    startedAt,
    updatedAt: startedAt,
  };
  const report = (patch: Partial<BenchStatus>): void => {
    Object.assign(status, patch, { updatedAt: now().toISOString() });
    try {
      writeBenchStatus(out, status);
    } catch (err) {
      opts.log(`could not write status.json: ${(err as Error).message.split('\n')[0]}`);
    }
  };
  report({});
  const results: AttemptResult[] = [];
  try {
    for (const a of plan.attempts) {
      opts.log(
        `${a.entry.id} #${a.attempt}: ${a.mode === 'agent' ? `running ${a.agent}` : a.mode}`,
      );
      report({ current: `${a.entry.id} #${a.attempt}` });
      const r = await runAttempt(a, {
        opts,
        repo: plan.repo,
        out,
        ...(plan.hiddenDir ? { hiddenDir: plan.hiddenDir } : {}),
      });
      results.push(r);
      report({ done: results.length });
      const fails = r.criteria.filter((c) => c.result === 'fail').map((c) => c.id);
      opts.log(
        `${a.entry.id} #${a.attempt}: ${r.score.passed}/${r.score.checkable} checkable pass` +
          (r.score.hidden.total
            ? `, hidden ${r.score.hidden.passed}/${r.score.hidden.total}`
            : '') +
          (r.score.judged ? `, ${r.score.judged} judged` : '') +
          (fails.length ? `; failed ${fails.join(', ')}` : '') +
          (r.run.timedOut ? '; timed out' : '') +
          (r.run.error ? `; ${r.run.error}` : ''),
      );
    }
    const first = plan.attempts[0]!;
    const entries = summarizeEntries(results);
    const judged = results.filter((r) => r.judge);
    const summary: BenchSummary = {
      set: opts.set.id,
      setFile: opts.set.file,
      mode: first.mode,
      agent: opts.referenceDir ? 'reference' : (opts.agent ?? first.agent),
      ...(first.mode === 'agent' && opts.model ? { model: opts.model } : {}),
      ...(first.mode === 'agent' && opts.effort ? { effort: opts.effort } : {}),
      repo: plan.repo,
      out,
      startedAt,
      finishedAt: now().toISOString(),
      ...(judged.length > 0
        ? {
            judge: {
              runtime: judged[0]!.judge!.runtime,
              model: judged[0]!.judge!.model,
              at: judged.at(-1)!.judge!.at,
            },
          }
        : {}),
      entries,
      overall: overallOf(entries),
    };
    writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    writeFileSync(join(out, 'summary.md'), summaryMarkdown(summary));
    delete status.current;
    report({ state: 'done', finishedAt: summary.finishedAt });
    return summary;
  } catch (err) {
    report({ state: 'failed', finishedAt: now().toISOString(), error: (err as Error).message });
    throw err;
  }
}

// ---- The judge ----------------------------------------------------------------------------------

/** The plan's line about the judge. */
function judgeLine(j: BenchJudge, runtimes?: Record<string, RuntimeConfig>): string {
  const c = j.config;
  const model = judgeModel(c, j.runtimes ?? runtimes);
  return `judge: ${[c.runtime, model, c.effort].filter(Boolean).join(', ')}, ${c.budget_min} min per rubric criterion (spends tokens)`;
}

/**
 * Reads a bench entry's rubric: an absolute path as it is; else relative to the set file; else the
 * file at the entry's base commit in the repo under test (`git show`), never the attempt's
 * worktree, which the agent may have changed. Throws when none has it.
 */
export function benchRubricLoader(
  set: Pick<BenchSet, 'file'>,
  repo: string,
  sha: string,
): (path: string) => Rubric {
  const cache = new Map<string, Rubric>();
  return (path: string): Rubric => {
    const hit = cache.get(path);
    if (hit) return hit;
    if (!path) throw new OpsError('the criterion names no rubric file', 2);
    let rubric: Rubric;
    const besideSet = resolve(dirname(set.file), path);
    if (isAbsolute(path)) rubric = readRubric(path);
    else if (existsSync(besideSet)) rubric = readRubric(besideSet);
    else {
      const rel = path.replace(/\\/g, '/').replace(/^\.\//, '');
      let text: string;
      try {
        text = git(repo, ['show', `${sha}:${rel}`]);
      } catch {
        throw new OpsError(
          `no rubric ${path} beside the set or at ${sha.slice(0, 12)} in ${repo}`,
          2,
        );
      }
      rubric = parseRubric(text, `${rel} at ${sha.slice(0, 12)}`);
    }
    cache.set(path, rubric);
    return rubric;
  };
}

/**
 * Judges an attempt's pending `rubric` criteria (all of them with `again`) and writes the results
 * into `r`: pass or fail with the score, the reasons as the note and the scores as evidence. A
 * judgment that gives no score leaves its criterion pending with what went wrong, so a later
 * `swarmup bench judge` tries again. `cwd` is the tree after the change, for the `repo` and
 * `files` inputs. Returns how many it judged.
 */
export async function judgeAttempt(
  r: AttemptResult,
  entry: BenchEntry,
  ctx: {
    set: Pick<BenchSet, 'file'>;
    repo: string;
    cwd?: string;
    judge: BenchJudge;
    env: NodeJS.ProcessEnv;
    again?: boolean;
    now?: () => Date;
  },
): Promise<number> {
  const want = new Set(
    r.criteria
      .filter((c) => c.kind === 'rubric' && (ctx.again || c.result === 'pending'))
      .map((c) => c.id),
  );
  const targets = entry.criteria.filter((c) => c.kind === 'rubric' && want.has(c.id));
  if (targets.length === 0) return 0;
  let diff = '';
  try {
    diff = readFileSync(join(r.dir, 'diff.patch'), 'utf8');
  } catch {
    // No diff saved: the attempt changed nothing, or never got a worktree.
  }
  const outcomes = await judgeCriteria({
    criteria: targets,
    source: { ...(ctx.cwd ? { cwd: ctx.cwd } : {}), diff, task: benchPrompt(entry) },
    loadRubric: benchRubricLoader(ctx.set, ctx.repo, r.base.sha),
    config: ctx.judge.config,
    env: ctx.env,
    ...(ctx.judge.runner ? { runner: ctx.judge.runner } : {}),
    ...(ctx.judge.runtimes ? { runtimes: ctx.judge.runtimes } : {}),
  });
  let judged = 0;
  r.criteria = r.criteria.map((c): BenchCriterionResult => {
    const o = outcomes[c.id];
    if (!o) return c;
    const v = judgeVerdict(o);
    const rest: BenchCriterionResult = {
      id: c.id,
      kind: c.kind,
      ...(c.hidden ? { hidden: true } : {}),
      what: c.what,
      result: c.result,
      ...(c.rubric ? { rubric: c.rubric } : {}),
      ...(c.pass !== undefined ? { pass: c.pass } : {}),
    };
    if (judgeFailed(o)) {
      return { ...rest, result: 'pending', note: v.note ?? '', evidence: v.evidence ?? '' };
    }
    judged++;
    return {
      ...rest,
      result: v.result,
      ...(v.score !== undefined ? { score: v.score } : {}),
      ...(v.note ? { note: v.note } : {}),
      ...(v.evidence ? { evidence: v.evidence } : {}),
    };
  });
  const list = Object.values(outcomes);
  const cost = judgeCost(list);
  const prev = r.judge?.costUsd ?? null;
  r.judge = {
    runtime: ctx.judge.config.runtime,
    model:
      list.find((o) => o.model)?.model ?? judgeModel(ctx.judge.config, ctx.judge.runtimes) ?? null,
    costUsd: prev === null && cost === null ? null : (prev ?? 0) + (cost ?? 0),
    at: (ctx.now ?? (() => new Date()))().toISOString(),
  };
  r.score = scoreAttempt(r.criteria);
  return judged;
}

/** The attempts' `results.json` files of a run's out folder, by entry and attempt number. */
function attemptFiles(out: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(out, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(out, entry.name);
    const attempts = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
      .map((d) => Number(d.name))
      .sort((a, b) => a - b);
    for (const n of attempts) {
      const file = join(dir, String(n), 'results.json');
      if (existsSync(file)) files.push(file);
    }
  }
  return files;
}

export interface BenchJudgeRunOptions {
  /** The run's out folder. */
  out: string;
  /** The set; default the `setFile` its summary names. */
  set?: BenchSet;
  judge: BenchJudge;
  /** Judges rubric criteria that already have a result too. */
  again?: boolean;
  /** Only these entries. */
  entries?: string[];
  env?: NodeJS.ProcessEnv;
  log: (line: string) => void;
  now?: () => Date;
}

/**
 * `swarmup bench judge`: judges the pending `rubric` criteria of a finished run's attempts, writes
 * each `results.json` again, and `summary.json` and `summary.md` with the new pass rates, judged
 * counts and judge cost. An attempt whose worktree is gone gets a temporary one at its base with
 * its `diff.patch` applied, when a rubric needs the `repo` or `files` input. Refuses a folder
 * with no summary, or a run whose set file it cannot find, with exit 2.
 */
export async function judgeBenchRun(opts: BenchJudgeRunOptions): Promise<BenchSummary> {
  const out = resolve(opts.out);
  const summary = readBenchSummary(out);
  const setFile = opts.set?.file ?? summary.setFile;
  if (!opts.set && !setFile) {
    throw new OpsError(`${out}: its summary names no set file; pass --set SET.yaml`, 2);
  }
  const set = opts.set ?? readBenchSet(setFile!);
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const results: AttemptResult[] = [];
  let judgedAll = 0;
  for (const file of attemptFiles(out)) {
    const r = JSON.parse(readFileSync(file, 'utf8')) as AttemptResult;
    r.dir = dirname(file);
    results.push(r);
    if (opts.entries?.length && !opts.entries.includes(r.entry)) continue;
    const entry = set.entries.find((e) => e.id === r.entry);
    if (!entry) {
      opts.log(`${r.entry} #${r.attempt}: no such entry in ${set.file}; skipped`);
      continue;
    }
    const pending = r.criteria.some(
      (c) => c.kind === 'rubric' && (opts.again || c.result === 'pending'),
    );
    if (!pending) continue;
    const loader = benchRubricLoader(set, summary.repo, r.base.sha);
    const needsTree = entry.criteria.some((c) => {
      if (c.kind !== 'rubric') return false;
      try {
        const rubric = loader(c.rubric ?? '');
        return rubric.inputs.includes('repo') || rubric.inputs.includes('files');
      } catch {
        return false;
      }
    });
    const kept = join(r.dir, 'worktree');
    let cwd: string | undefined = existsSync(kept) ? kept : undefined;
    let temp: string | undefined;
    if (!cwd && needsTree) {
      temp = join(
        envVar(env, 'SCRATCH') ?? tmpdir(),
        `swarmup-judge-wt-${process.pid}-${Date.now()}`,
      );
      try {
        git(summary.repo, ['worktree', 'add', '--detach', temp, r.base.sha]);
        const patch = join(r.dir, 'diff.patch');
        if (existsSync(patch) && readFileSync(patch, 'utf8').trim()) {
          git(temp, ['apply', '--whitespace=nowarn', '--binary', patch]);
        }
        cwd = temp;
      } catch (err) {
        opts.log(
          `${r.entry} #${r.attempt}: no tree to show the judge (${(err as Error).message.split('\n')[0]}); it sees the diff only`,
        );
      }
    }
    opts.log(`${r.entry} #${r.attempt}: judging`);
    try {
      judgedAll += await judgeAttempt(r, entry, {
        set,
        repo: summary.repo,
        ...(cwd ? { cwd } : {}),
        judge: opts.judge,
        env,
        ...(opts.again ? { again: true } : {}),
        now,
      });
      const line = r.criteria
        .filter((c) => c.kind === 'rubric')
        .map((c) => `${c.id} ${c.result}${c.score !== undefined ? ` ${c.score}` : ''}`)
        .join(', ');
      const cost = costText(r.judge?.costUsd);
      opts.log(`${r.entry} #${r.attempt}: ${line}${cost ? `; judge cost ${cost} so far` : ''}`);
    } finally {
      if (temp) removeWorktree(summary.repo, temp, opts.log);
    }
    writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
  }
  const entries = summarizeEntries(results);
  const judged = results.filter((r) => r.judge);
  const next: BenchSummary = {
    ...summary,
    out,
    setFile: set.file,
    ...(judged.length > 0
      ? {
          judge: {
            runtime: judged[0]!.judge!.runtime,
            model: judged[0]!.judge!.model,
            at: now().toISOString(),
          },
        }
      : {}),
    entries,
    overall: overallOf(entries),
  };
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify(next, null, 2)}\n`);
  writeFileSync(join(out, 'summary.md'), summaryMarkdown(next));
  opts.log(`judged ${judgedAll} rubric criteria in ${out}`);
  return next;
}
