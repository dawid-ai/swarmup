import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ParseArgsConfig } from 'node:util';
import { daemonSection, envVar, OpsError, readBenchSet, readUserConfig } from '@swarmup/core';
import type { BenchJudge, RuntimeConfig } from '@swarmup/supervisor';
import {
  checkJudge,
  checkModel,
  compareMarkdown,
  compareSummaries,
  judgeBenchRun,
  readBenchSummary,
  runBench,
  summaryMarkdown,
} from '@swarmup/supervisor';

/** What `swarmup bench` needs of the CLI's context. */
interface BenchCtx {
  io: {
    out: (line: string) => void;
    err: (line: string) => void;
    cwd: string;
    env: NodeJS.ProcessEnv;
  };
  args: string[];
  opts: Record<string, string | boolean | string[] | undefined>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function positive(v: unknown, flag: string, whole: boolean): number | undefined {
  const s = str(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || (whole && !Number.isInteger(n))) {
    throw new OpsError(`${flag} must be a ${whole ? 'whole ' : ''}number above 0`, 2);
  }
  return n;
}

/** `<scratch>/swarmup-bench/<set>-<UTC stamp>`, outside every repo. */
function defaultOut(env: NodeJS.ProcessEnv, set: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..*$/, '')
    .replace('T', '-');
  return join(envVar(env, 'SCRATCH') ?? tmpdir(), 'swarmup-bench', `${set}-${stamp}`);
}

/**
 * The judge of `--judge` and `bench judge`: `swarmupd.judge` from the user config, with
 * `--judge-model` over its model, and the machine's runtimes for the judge's command.
 */
function benchJudge(ctx: BenchCtx): BenchJudge {
  const section = daemonSection(readUserConfig(ctx.io.env)) ?? {};
  const config = checkJudge(section.judge);
  const model = str(ctx.opts['judge-model']);
  if (model) config.model = checkModel(model, '--judge-model');
  const runtimes = section.runtimes;
  return {
    config,
    ...(runtimes && typeof runtimes === 'object' && !Array.isArray(runtimes)
      ? { runtimes: runtimes as Record<string, RuntimeConfig> }
      : {}),
  };
}

/** `swarmup bench`: replay a benchmark set against an agent and compare two runs. */
export const benchCommand = {
  usage:
    'bench run SET.yaml --repo DIR [--entries ID,ID] [--agent RUNTIME:ROLE|none] [--model M] [--effort E] [--repeat N] [--budget-min N] [--hidden-dir DIR] [--reference-dir DIR] [--out DIR] [--keep] [--judge] [--judge-model M] [--dry-run] | bench judge RUN-DIR [--set SET.yaml] [--entries ID,ID] [--again] [--judge-model M] | bench compare A B [--json]',
  summary:
    "replay benchmark entries in throwaway worktrees with an agent (spends tokens), no agent, or reference patches, and score their criteria; --judge or `bench judge` scores rubric criteria with an LLM judge (spends tokens); compare two runs' summary.json",
  options: {
    repo: { type: 'string' },
    entries: { type: 'string', multiple: true },
    agent: { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    repeat: { type: 'string' },
    'budget-min': { type: 'string' },
    'hidden-dir': { type: 'string' },
    'reference-dir': { type: 'string' },
    out: { type: 'string' },
    keep: { type: 'boolean' },
    judge: { type: 'boolean' },
    'judge-model': { type: 'string' },
    set: { type: 'string' },
    again: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
  } satisfies NonNullable<ParseArgsConfig['options']>,
  run: (ctx: BenchCtx): Promise<number> => runBenchCmd(ctx),
};

async function runBenchCmd(ctx: BenchCtx): Promise<number> {
  const [sub, ...rest] = ctx.args;
  if (sub === 'compare') return compare(ctx, rest);
  if (sub === 'judge') return judge(ctx, rest);
  if (sub !== 'run')
    throw new OpsError(
      'use `swarmup bench run SET.yaml`, `swarmup bench judge RUN-DIR` or `swarmup bench compare A B`',
      2,
    );
  const file = rest[0];
  if (!file || rest.length > 1)
    throw new OpsError('name one set file: swarmup bench run SET.yaml --repo DIR', 2);
  const repo = str(ctx.opts.repo);
  if (!repo) throw new OpsError('name the repo under test with --repo DIR', 2);
  const set = readBenchSet(resolve(ctx.io.cwd, file));
  const entries = entryIds(ctx);
  const at = (v: unknown): string | undefined => {
    const s = str(v);
    return s === undefined ? undefined : resolve(ctx.io.cwd, s);
  };
  const out = at(ctx.opts.out) ?? defaultOut(ctx.io.env, set.id);
  const repeat = positive(ctx.opts.repeat, '--repeat', true);
  const budgetMin = positive(ctx.opts['budget-min'], '--budget-min', false);
  const summary = await runBench({
    set,
    repo: resolve(ctx.io.cwd, repo),
    out,
    ...(entries.length > 0 ? { entries } : {}),
    ...(str(ctx.opts.agent) ? { agent: str(ctx.opts.agent) } : {}),
    ...(str(ctx.opts.model) ? { model: str(ctx.opts.model) } : {}),
    ...(str(ctx.opts.effort) ? { effort: str(ctx.opts.effort) } : {}),
    ...(repeat !== undefined ? { repeat } : {}),
    ...(budgetMin !== undefined ? { budgetMin } : {}),
    ...(at(ctx.opts['hidden-dir']) ? { hiddenDir: at(ctx.opts['hidden-dir']) } : {}),
    ...(at(ctx.opts['reference-dir']) ? { referenceDir: at(ctx.opts['reference-dir']) } : {}),
    dryRun: Boolean(ctx.opts['dry-run']),
    keep: Boolean(ctx.opts.keep),
    ...(ctx.opts.judge ? { judge: benchJudge(ctx) } : {}),
    env: ctx.io.env,
    log: (line) => ctx.io.err(line),
  });
  if (!summary) return 0;
  if (ctx.opts.json) ctx.io.out(JSON.stringify(summary, null, 2));
  else {
    ctx.io.out(summaryMarkdown(summary));
    ctx.io.out(`wrote ${join(summary.out, 'summary.json')} and summary.md`);
  }
  return 0;
}

function entryIds(ctx: BenchCtx): string[] {
  const raw = ctx.opts.entries;
  return (Array.isArray(raw) ? raw : raw ? [String(raw)] : [])
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);
}

/** `swarmup bench judge RUN-DIR`: judges the pending rubric criteria of a finished run. */
async function judge(ctx: BenchCtx, args: string[]): Promise<number> {
  if (args.length !== 1) throw new OpsError('name one run folder: swarmup bench judge RUN-DIR', 2);
  const setFile = str(ctx.opts.set);
  const entries = entryIds(ctx);
  const summary = await judgeBenchRun({
    out: resolve(ctx.io.cwd, args[0]!),
    ...(setFile ? { set: readBenchSet(resolve(ctx.io.cwd, setFile)) } : {}),
    judge: benchJudge(ctx),
    ...(ctx.opts.again ? { again: true } : {}),
    ...(entries.length > 0 ? { entries } : {}),
    env: ctx.io.env,
    log: (line) => ctx.io.err(line),
  });
  if (ctx.opts.json) ctx.io.out(JSON.stringify(summary, null, 2));
  else {
    ctx.io.out(summaryMarkdown(summary));
    ctx.io.out(`wrote ${join(summary.out, 'summary.json')} and summary.md`);
  }
  return 0;
}

function compare(ctx: BenchCtx, args: string[]): number {
  if (args.length !== 2) throw new OpsError('name two runs: swarmup bench compare A B', 2);
  const [a, b] = args.map((p) => readBenchSummary(resolve(ctx.io.cwd, p)));
  const c = compareSummaries(a!, b!);
  ctx.io.out(ctx.opts.json ? JSON.stringify(c, null, 2) : compareMarkdown(c));
  return 0;
}
