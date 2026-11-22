// Cost of a bench attempt whose log reports tokens but no dollar figure (Codex): the tokens times
// a price per million tokens of the model that ran. Claude's `result` message carries its own
// `total_cost_usd`, so its attempts need no estimate unless the run ended before that message.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OpsError } from '@swarmup/core';

/** USD per million tokens. `cached_input` prices input tokens read from the prompt cache. */
export interface ModelPrice {
  input: number;
  cached_input: number;
  output: number;
}

/**
 * Built-in prices. These are OpenAI list prices as of 2026-11-22, taken from public reports that
 * disagree with each other, so `swarmupd.bench.prices.<model>` in the user config overrides them.
 */
export const DEFAULT_BENCH_PRICES: Readonly<Record<string, ModelPrice>> = {
  'gpt-5.6-sol': { input: 5, cached_input: 0.5, output: 30 },
  'gpt-5.6-terra': { input: 2, cached_input: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cached_input: 0.02, output: 1.2 },
};

const PRICE_KEYS = ['input', 'cached_input', 'output'] as const;

/**
 * Checks `swarmupd.bench.prices`: model names, each with `input`, `cached_input` and `output` in
 * USD per million tokens, numbers of 0 or more. Refuses anything else with exit 2.
 */
export function checkBenchPrices(
  raw: unknown,
  where = 'swarmupd.bench.prices',
): Record<string, ModelPrice> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpsError(
      `${where}: use model names, each with input, cached_input and output in USD per million tokens`,
      2,
    );
  }
  const out: Record<string, ModelPrice> = {};
  for (const [model, v] of Object.entries(raw as Record<string, unknown>)) {
    const at = `${where}.${model}`;
    if (!model.trim()) throw new OpsError(`${where}: a model name is empty`, 2);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      throw new OpsError(`${at}: use input, cached_input and output in USD per million tokens`, 2);
    }
    const extra = Object.keys(v).filter((k) => !(PRICE_KEYS as readonly string[]).includes(k));
    if (extra.length > 0) {
      throw new OpsError(`${at}: unknown key ${extra[0]}; use input, cached_input and output`, 2);
    }
    const p = v as Record<string, unknown>;
    for (const k of PRICE_KEYS) {
      if (typeof p[k] !== 'number' || !Number.isFinite(p[k]) || p[k] < 0) {
        throw new OpsError(`${at}.${k}: use a number of 0 or more (USD per million tokens)`, 2);
      }
    }
    out[model] = {
      input: p.input as number,
      cached_input: p.cached_input as number,
      output: p.output as number,
    };
  }
  return out;
}

/** The built-in prices with the user's over them, model by model. */
export function benchPrices(user: Record<string, ModelPrice> = {}): Record<string, ModelPrice> {
  return { ...DEFAULT_BENCH_PRICES, ...user };
}

/** A model name, or undefined for none, an empty one or `default`. */
function named(model: string | undefined | null): string | undefined {
  const m = model?.trim();
  return m && m !== 'default' ? m : undefined;
}

/**
 * The top-level `model = "..."` of `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`),
 * the model a Codex run without `-m` uses. Lines after the first `[table]` belong to a profile or
 * a provider and are skipped.
 */
export function codexConfigModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('[')) break;
    const m = /^model\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(t);
    if (m) return named(m[1] ?? m[2]);
  }
  return undefined;
}

/**
 * The model an attempt of `runtime` ran: the bench `--model`, else the runtime config's model,
 * else, for Codex, the model of its `config.toml`. `default` or an empty name counts as unset.
 */
export function benchCostModel(
  runtime: string,
  opts: {
    model?: string;
    runtimes?: Record<string, { model?: string }>;
    env?: NodeJS.ProcessEnv;
  },
): string | undefined {
  return (
    named(opts.model) ??
    named(opts.runtimes?.[runtime]?.model) ??
    (runtime === 'codex' ? codexConfigModel(opts.env ?? process.env) : undefined)
  );
}

/**
 * The estimated cost of a run's tokens. `input` excludes cached input (`logMetrics` splits Codex's
 * `input_tokens`, which includes `cached_input_tokens`). Cache writes, which only Claude reports,
 * are priced as input.
 */
export function estimateCostUsd(
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
  price: ModelPrice,
): number {
  return (
    ((tokens.input + tokens.cacheWrite) * price.input +
      tokens.cacheRead * price.cached_input +
      tokens.output * price.output) /
    1_000_000
  );
}
