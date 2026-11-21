import { OpsError } from '../ids.js';

/** A model name: one word that cannot read as a flag, such as `opus` or `gpt-5-codex`. */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,99}$/;

export const MODEL_HINT =
  'name a model such as opus or gpt-5-codex (letters, digits and . _ : / @ - [ ])';

/** A reasoning effort: one lowercase word that cannot read as a flag, such as `medium`. */
export const EFFORT_RE = /^[a-z][a-z0-9_-]{0,19}$/;

export const EFFORT_HINT =
  'name an effort level such as low, medium or high (lowercase letters, digits, _ and -)';

/** A runtime (provider) name, such as `claude` or `codex`: the part of an agent id before the colon. */
export const RUNTIME_NAME_RE = /^[a-z][a-z0-9]*$/;

/** A role name, the part of an agent id after the colon, such as `engineer`. */
export const ROLE_NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Checks a model name: one word that cannot read as a flag, such as `opus` or `gpt-5-codex`. */
export function checkModel(v: unknown, where: string): string {
  if (typeof v !== 'string' || !MODEL_RE.test(v)) throw new OpsError(`${where}: ${MODEL_HINT}`, 2);
  return v;
}

/**
 * Checks a reasoning effort: one lowercase word that cannot read as a flag, such as `medium`.
 * Each provider names its own levels, so the provider refuses a level it does not know when the
 * run starts.
 */
export function checkEffort(v: unknown, where: string): string {
  if (typeof v !== 'string' || !EFFORT_RE.test(v)) {
    throw new OpsError(`${where}: ${EFFORT_HINT}`, 2);
  }
  return v;
}
