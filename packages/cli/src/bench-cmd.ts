import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { ParseArgsConfig } from 'node:util';
import type { Workspace } from '@swarmup/core';
import {
  agentRuntimeValues,
  daemonSection,
  envVar,
  loadDefinitions,
  loadDefinitionsAtRef,
  OpsError,
  readBenchSet,
  readDefsAtRef,
  readUserConfig,
  ROOT_DIR_NAME,
  runtimeOf,
} from '@swarmup/core';
import type { BenchJudge, BenchRole, RuntimeConfig } from '@swarmup/supervisor';
import {
  checkBenchPrices,
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
  ws?: () => Workspace;
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

/**
 * The prices of `swarmupd.bench.prices` in the user config, over the built-in ones, for the cost
 * of attempts whose log reports tokens but no cost. Refuses a bad table with exit 2.
 */
function benchPricesOf(ctx: BenchCtx): ReturnType<typeof checkBenchPrices> {
  const bench = (daemonSection(readUserConfig(ctx.io.env)) ?? {}).bench;
  if (!bench || typeof bench !== 'object' || Array.isArray(bench)) return {};
  return checkBenchPrices((bench as { prices?: unknown }).prices);
}

/**
 * The store `--root` names: a folder (a store, or one that holds `.swarmup/`), else a root of the
 * workspace by name.
 */
function storeOf(ctx: BenchCtx, root: string): { name: string; dir: string } {
  const path = resolve(ctx.io.cwd, root);
  if (existsSync(path) && statSync(path).isDirectory()) {
    const inner = join(path, ROOT_DIR_NAME);
    const dir = basename(path) !== ROOT_DIR_NAME && existsSync(inner) ? inner : path;
    return { name: dir, dir };
  }
  const r = ctx.ws?.().roots.find((x) => x.name === root);
  if (!r) throw new OpsError(`--root ${root}: no such folder or root`, 2);
  return { name: r.name, dir: r.dir };
}

/**
 * The role file `--role-file`, `--variant` or `--defs-ref` puts in each prompt: the agent's file
 * in the root's definitions, with the variant's overlay on top when one is named, or as the git
 * ref had them (read with `git show`, never checked out).
 */
function benchRole(ctx: BenchCtx): BenchRole | undefined {
  const variant = str(ctx.opts.variant);
  const ref = str(ctx.opts['defs-ref']);
  if (!variant && !ref && !ctx.opts['role-file']) return undefined;
  if (variant && ref) throw new OpsError('use --variant or --defs-ref, not both', 2);
  const agent = str(ctx.opts.agent);
  if (!agent || agent === 'none') {
    throw new OpsError('--role-file, --variant and --defs-ref need --agent RUNTIME:ROLE', 2);
  }
  const root = str(ctx.opts.root);
  if (!root) {
    throw new OpsError(
      '--role-file, --variant and --defs-ref need --root, the store the role file is in',
      2,
    );
  }
  const store = storeOf(ctx, root);
  const set = ref
    ? loadDefinitionsAtRef(store.dir, readDefsAtRef(store.dir, ref))
    : loadDefinitions(store.dir, variant ? { variant } : {});
  if (!set.ok) {
    const first = set.problems.find((p) => p.severity === 'error');
    const which = variant ? ` with variant ${variant}` : ref ? ` at ${ref}` : '';
    throw new OpsError(
      `the definitions of ${store.name}${which} do not check: ` +
        `${first ? `${first.path}: ${first.message}` : 'errors'}`,
      2,
    );
  }
  const def = set.agents.find((a) => a.id === agent);
  if (!def) throw new OpsError(`${store.name} has no role file for ${agent}`, 2);
  const norm = def.file.replace(/\\/g, '/');
  const path = Object.keys(set.texts).find((p) => norm.endsWith(`/${p}`));
  const values = agentRuntimeValues(def, runtimeOf(agent));
  return {
    agent,
    root: store.name,
    defs: set.hash,
    ...(variant ? { variant } : {}),
    ...(set.ref ? { ref: set.ref } : {}),
    ...(set.commit ? { commit: set.commit } : {}),
    text: path ? set.texts[path]! : def.body,
    body: def.body,
    ...values,
  };
}

/** `swarmup bench`: replay a benchmark set against an agent and compare two runs. */
export const benchCommand = {
  usage:
    'bench run SET.yaml --repo DIR [--entries ID,ID] [--agent RUNTIME:ROLE|none] [--model M] [--effort E] [--role-file --root ROOT] [--variant NAME --root ROOT] [--defs-ref REF --root ROOT] [--repeat N] [--max-usd X] [--budget-min N] [--hidden-dir DIR] [--reference-dir DIR] [--out DIR] [--keep] [--judge] [--judge-model M] [--dry-run] | bench judge RUN-DIR [--set SET.yaml] [--entries ID,ID] [--again] [--judge-model M] | bench compare A B [--json]',
  summary:
    "replay benchmark entries in throwaway worktrees with an agent (spends tokens), no agent, or reference patches, and score their criteria; --role-file puts the agent's role file from --root (a store folder or root name) in each prompt and takes its model and effort, --variant does the same with a variant's overlay on top, --defs-ref with the store's definitions as a git ref had them (read with git show, never checked out); --max-usd stops starting attempts once their agent and judge cost, Codex estimates from tokens included, reaches X; --judge or `bench judge` scores rubric criteria with an LLM judge (spends tokens); compare two runs' summary.json",
  options: {
    repo: { type: 'string' },
    entries: { type: 'string', multiple: true },
    agent: { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    repeat: { type: 'string' },
    'max-usd': { type: 'string' },
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
    variant: { type: 'string' },
    'role-file': { type: 'boolean' },
    'defs-ref': { type: 'string' },
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
  const maxUsd = positive(ctx.opts['max-usd'], '--max-usd', false);
  const prices = benchPricesOf(ctx);
  const role = benchRole(ctx);
  const model = str(ctx.opts.model) ?? role?.model;
  const effort = str(ctx.opts.effort) ?? role?.effort;
  const summary = await runBench({
    set,
    repo: resolve(ctx.io.cwd, repo),
    out,
    ...(entries.length > 0 ? { entries } : {}),
    ...(str(ctx.opts.agent) ? { agent: str(ctx.opts.agent) } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(role ? { role } : {}),
    ...(repeat !== undefined ? { repeat } : {}),
    ...(budgetMin !== undefined ? { budgetMin } : {}),
    ...(maxUsd !== undefined ? { maxUsd } : {}),
    ...(Object.keys(prices).length > 0 ? { prices } : {}),
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
