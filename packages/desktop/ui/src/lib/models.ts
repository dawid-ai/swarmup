/**
 * The models each provider's CLI takes for `--model`, shipped with the app. Neither CLI lists its
 * models: `claude --help` names only the aliases, so a release updates this list. A name outside
 * it still saves, with a warning, so a model newer than the list works.
 */

/** The day the lists were last checked against each provider's docs. */
export const MODELS_CHECKED = '2026-11-15';

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
    'gpt-5.1-codex',
    'gpt-5.1-codex-max',
    'gpt-5.1-codex-mini',
    'gpt-5.1',
    'gpt-5-codex',
    'gpt-5-codex-mini',
    'gpt-5',
    'o3',
    'o4-mini',
  ],
};

/** The known models of a provider that contain the typed text, or all of them when it is empty. */
export function suggestModels(runtime: string, typed: string): string[] {
  const all = MODELS[runtime] ?? [];
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
  const all = MODELS[runtime];
  if (!n || !all || all.some((m) => m.toLowerCase() === n.toLowerCase())) return null;
  return `Not a known ${runtime} model (list of ${MODELS_CHECKED}); it saves, in case it is newer.`;
}
