/**
 * Writes a store's `swarm.yaml` from outside an editor: `swarmup defs import-config` and the
 * desktop app's Settings > Definitions start one from the user config or from the template. Each
 * write checks the result first and never changes the user config.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DefProblem, SwarmImport, UserConfig } from '@swarmup/core';
import {
  assertNoSecret,
  checkDefinitionText,
  daemonSection,
  normalText,
  OpsError,
  setSwarmValues,
  SWARM_FILE,
  TEMPLATES_DIR,
} from '@swarmup/core';

const ROLE_KEYS = ['providers', 'overflow', 'writes', 'per_project', 'burst', 'max_children'];

/** The git-able part of the user config: runtime model and effort, and role settings. */
export function importableConfig(user: UserConfig): SwarmImport {
  const section = daemonSection(user) ?? {};
  const runtimes: SwarmImport['runtimes'] = {};
  const rts = section.runtimes;
  if (rts && typeof rts === 'object') {
    for (const [name, rc] of Object.entries(rts as Record<string, unknown>)) {
      if (!rc || typeof rc !== 'object') continue;
      const r = rc as { model?: unknown; effort?: unknown };
      const out: { model?: string; effort?: string } = {};
      if (typeof r.model === 'string') out.model = r.model;
      if (typeof r.effort === 'string') out.effort = r.effort;
      if (Object.keys(out).length > 0) runtimes[name] = out;
    }
  }
  const roles: SwarmImport['roles'] = {};
  const rs = section.roles;
  if (rs && typeof rs === 'object') {
    for (const [name, rc] of Object.entries(rs as Record<string, unknown>)) {
      if (!rc || typeof rc !== 'object') continue;
      const out: Record<string, unknown> = {};
      for (const k of ROLE_KEYS) {
        const v = (rc as Record<string, unknown>)[k];
        if (v !== undefined && v !== null) out[k] = v;
      }
      if (Object.keys(out).length > 0) roles[name] = out;
    }
  }
  return { runtimes, roles };
}

/** A line diff of two texts: the lines `old` lacks with `+`, the ones `next` lacks with `-`. */
export function lineDiff(old: string, next: string): string[] {
  const a = old.split('\n');
  const b = next.split('\n');
  // Longest common subsequence: the files are small.
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) out.push(`+${b[j++]}`);
    else out.push(`-${a[i++]}`);
  }
  return out.filter((l) => l !== '+' && l !== '-');
}

/** What `import-config` would do to one store's `swarm.yaml`. */
export interface DefsImportPlan {
  file: string;
  /** The file exists now. */
  exists: boolean;
  before: string;
  after: string;
  /** `+` and `-` lines, as `swarmup defs import-config` prints them. */
  diff: string[];
  /** Keys it sets, such as `runtimes.claude.model`. */
  keys: string[];
  /** The user config sets nothing to import. */
  empty: boolean;
  /** Errors the result would have; a plan with any is never written. */
  problems: DefProblem[];
}

function readSwarm(file: string): string {
  return existsSync(file) ? normalText(readFileSync(file, 'utf8')) : '';
}

/**
 * The `swarm.yaml` of the store in `storeDir` with the user config's runtime models and efforts
 * and role settings set in it, comments kept. Writes nothing.
 */
export function planDefsImport(storeDir: string, user: UserConfig): DefsImportPlan {
  const file = join(storeDir, SWARM_FILE);
  const before = readSwarm(file);
  const values = importableConfig(user);
  const empty = Object.keys(values.runtimes).length === 0 && Object.keys(values.roles).length === 0;
  const { text: after, keys } = empty ? { text: before, keys: [] } : setSwarmValues(before, values);
  const problems = empty
    ? []
    : checkDefinitionText(file, after).filter((p) => p.severity === 'error');
  return {
    file,
    exists: existsSync(file),
    before,
    after,
    diff: lineDiff(before, after),
    keys,
    empty,
    problems,
  };
}

/**
 * Writes `text` to `file` whole, through a temporary file, after it checks with no error and holds
 * no secret. `expect` is the text the caller last read: when the file changed since, nothing is
 * written, so a preview never overwrites an edit made after it.
 */
export function writeSwarmFile(file: string, text: string, expect?: string): void {
  if (expect !== undefined && readSwarm(file) !== normalText(expect)) {
    throw new OpsError(`${SWARM_FILE} changed since you opened it; look again before you save`, 1);
  }
  const errors = checkDefinitionText(file, text).filter((p) => p.severity === 'error');
  if (errors.length > 0) {
    const p = errors[0]!;
    throw new OpsError(
      `${SWARM_FILE} would not check (line ${p.line}: ${p.message}); nothing was written`,
      1,
    );
  }
  assertNoSecret(text);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Text of a new `swarm.yaml`: the commented template, or the format line alone without it. */
export function swarmTemplate(): string {
  try {
    return normalText(readFileSync(join(TEMPLATES_DIR, SWARM_FILE), 'utf8'));
  } catch {
    // The installed app may ship without the templates folder.
    return '# Team settings for this project; see docs/definitions.md.\nswarmup_defs: 1\n';
  }
}

/** Writes the template as the store's `swarm.yaml`. Refuses a store that has one. */
export function createSwarmFile(storeDir: string): string {
  const file = join(storeDir, SWARM_FILE);
  if (existsSync(file)) throw new OpsError(`${file} exists already`, 1);
  writeSwarmFile(file, swarmTemplate());
  return file;
}
