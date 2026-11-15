import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A provider's model list read from its installed CLI. */
export interface CliModels {
  models: string[];
  /** Where the list came from, for the warning text, such as `codex CLI 0.167.0`. */
  source: string;
  /** When the CLI fetched the list (ISO time), if it says. */
  fetchedAt?: string;
}

/**
 * The models the installed Codex CLI offers. Codex has no list command, but it fetches the
 * account's models and caches them in `$CODEX_HOME/models_cache.json`; the slugs its model
 * picker lists (`visibility: "list"`) are the names `--model` takes. Null when the file is
 * missing or unreadable.
 */
export function codexModels(env: NodeJS.ProcessEnv = process.env): CliModels | null {
  const file = join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'models_cache.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  return parseCodexCache(raw);
}

/** The listed model slugs of a Codex `models_cache.json`; null when it holds none. */
export function parseCodexCache(raw: unknown): CliModels | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { models?: unknown; client_version?: unknown; fetched_at?: unknown };
  if (!Array.isArray(o.models)) return null;
  const models: string[] = [];
  for (const m of o.models as unknown[]) {
    if (!m || typeof m !== 'object') continue;
    const { slug, visibility } = m as { slug?: unknown; visibility?: unknown };
    if (typeof slug !== 'string' || !slug || visibility === 'hide') continue;
    if (!models.includes(slug)) models.push(slug);
  }
  if (!models.length) return null;
  const version = typeof o.client_version === 'string' ? ` ${o.client_version}` : '';
  return {
    models,
    source: `codex CLI${version}`,
    ...(typeof o.fetched_at === 'string' ? { fetchedAt: o.fetched_at } : {}),
  };
}

/** The model lists of every provider whose CLI can tell, keyed by provider. */
export function cliModels(env: NodeJS.ProcessEnv = process.env): Record<string, CliModels> {
  const out: Record<string, CliModels> = {};
  const codex = codexModels(env);
  if (codex) out.codex = codex;
  return out;
}
