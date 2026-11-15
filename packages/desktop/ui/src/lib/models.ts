/**
 * The models each provider's CLI takes for `--model`. Where the installed CLI keeps a list (Codex
 * caches the account's models in `~/.codex/models_cache.json`), the main process reads it and that
 * list wins. Otherwise the list shipped here applies, and a release updates it: `claude` has no
 * list command, `claude --help` names only the aliases. A name outside the list still saves, with
 * a warning, so a model newer than the list works.
 */
import { useEffect, useState } from 'react';

/** The day the shipped lists were last checked. */
export const MODELS_CHECKED = '2026-11-15';

/**
 * The shipped lists. Claude: the aliases and model ids of the Claude docs. Codex: the listed slugs
 * of the Codex CLI 0.167.0 model cache, fetched 2026-11-15.
 */
export const MODELS: Readonly<Record<string, readonly string[]>> = {
  claude: [
    'fable',
    'opus',
    'sonnet',
    'haiku',
    'claude-fable-5-2',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-opus-4-5',
    'claude-opus-4-1',
    'claude-sonnet-4-5',
    'claude-haiku-4-5',
  ],
  codex: [
    'gpt-6.1-sol',
    'gpt-6.1-terra',
    'gpt-6-sol',
    'gpt-6-astra',
    'gpt-6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
  ],
};

/** A provider's list as read from its installed CLI. */
export interface CliModelList {
  models: string[];
  /** Such as `codex CLI 0.167.0`. */
  source: string;
  fetchedAt?: string;
}

let cli: Record<string, CliModelList> = {};
let loading: Promise<void> | null = null;

/** Forgets the lists read from the CLIs, so the next `useModelLists` loads them again. */
export function resetCliModels(): void {
  cli = {};
  loading = null;
}

/** The list that applies to a provider and where it comes from. */
function listOf(runtime: string): { models: readonly string[]; source: string } | null {
  const c = cli[runtime];
  if (c?.models.length) {
    const day = c.fetchedAt?.slice(0, 10);
    return { models: c.models, source: day ? `${c.source}, ${day}` : c.source };
  }
  const shipped = MODELS[runtime];
  return shipped ? { models: shipped, source: `list of ${MODELS_CHECKED}` } : null;
}

/**
 * Loads the CLIs' lists once per app session and re-renders the caller when they arrive. Outside
 * the desktop app, the shipped lists apply.
 */
export function useModelLists(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const b = typeof window === 'undefined' ? undefined : window.swarmup;
    if (!b?.models) return;
    loading ??= b
      .models()
      .then((res) => {
        if (res.ok && res.data) cli = res.data;
      })
      .catch(() => {});
    void loading.then(() => live && setTick((t) => t + 1));
    return () => {
      live = false;
    };
  }, []);
}

/** The known models of a provider that contain the typed text, or all of them when it is empty. */
export function suggestModels(runtime: string, typed: string): string[] {
  const all = listOf(runtime)?.models ?? [];
  const t = typed.trim().toLowerCase();
  if (!t) return [...all];
  return all.filter((m) => m.toLowerCase().includes(t));
}

/**
 * A warning for a model name the provider's list does not have; null for an empty name, a known
 * one, or a provider without a list.
 */
export function modelWarning(runtime: string, name: string): string | null {
  const n = name.trim();
  const list = listOf(runtime);
  if (!n || !list || list.models.some((m) => m.toLowerCase() === n.toLowerCase())) return null;
  return `Not a known ${runtime} model (${list.source}); it saves, in case it is newer.`;
}
