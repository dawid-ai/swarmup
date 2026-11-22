/**
 * `swarmup defs migrate` (W5 phase 2): legacy agent files `agents/<runtime>-<role>.md` become
 * agent folders `agents/<role>/agent.md` with runtime addenda `agents/<role>/<runtime>.md`. Values
 * every runtime of a role shares go to `agent.md`; the rest, and a body that differs, to the
 * runtime's addendum. The plan is checked before anything is written: the folders, read the way
 * swarmupd reads them, must give every agent the same fields as its legacy file.
 */
import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentDef } from '../agents.js';
import { AGENT_FOLDER_FILE, agentFilesFromTexts, agentFoldersOn } from '../agents.js';
import { parseDoc, stringifyDoc } from '../frontmatter.js';
import { OpsError } from '../ids.js';
import { loadDefinitions } from './load.js';

/** What a migration of one store writes and removes, and why it may refuse. */
export interface MigrationPlan {
  root: string;
  /** New folder files: path in the store to text. */
  writes: Record<string, string>;
  /** The legacy files the folders replace, by path in the store; `--prune` removes them. */
  legacy: string[];
  /** The agents the migration moves, by id. */
  agents: string[];
  /** Roles left as they are, each with the reason. */
  skipped: string[];
  /**
   * Why the migration refuses, one line per difference; empty when it may apply. It refuses when
   * the folders would not give every agent the same fields as its legacy file.
   */
  refused: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const roleOf = (id: string): string => id.slice(id.indexOf(':') + 1);
const runtimeOf = (id: string): string => id.slice(0, id.indexOf(':'));

/** A value as compared: unset, `null` and empty text are all absent. */
function norm(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return JSON.stringify(v);
}

/** The path of a file in the store, with `/`. */
function storePath(rootDir: string, file: string): string {
  return file.slice(rootDir.length + 1).replace(/\\/g, '/');
}

/** Fields compared between an agent's legacy file and its folder; not where it lives. */
const NOT_COMPARED = new Set(['file', 'folder', 'providers', 'role', 'body']);

/**
 * How the folder agent `after` differs from the legacy agent `before`, one line per field; empty
 * when every field is the same. `role` and `providers` describe the folder, so they are skipped;
 * bodies compare without leading and trailing blank space.
 */
export function agentDifferences(before: AgentDef, after: AgentDef | undefined): string[] {
  if (!after) return [`${before.id}: the folders define no such agent`];
  const out: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of [...keys].sort()) {
    if (NOT_COMPARED.has(k)) continue;
    const a = norm((before as unknown as Record<string, unknown>)[k]);
    const b = norm((after as unknown as Record<string, unknown>)[k]);
    if (a !== b)
      out.push(
        `${before.id}: ${k} is ${a ?? 'unset'} in the legacy file, ${b ?? 'unset'} from the folder`,
      );
  }
  if (before.body.trim() !== after.body.trim()) out.push(`${before.id}: the body differs`);
  return out;
}

/** The most common value of `values`, the first one on a tie. */
function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0]!;
  for (const v of values) if ((counts.get(v) ?? 0) > (counts.get(best) ?? 0)) best = v;
  return best;
}

/**
 * Plans the migration of the store in `rootDir`: one folder per role that has legacy files and
 * no folder yet. Nothing is written. A role whose legacy files do not all read, or that has two
 * files for one id, refuses the whole migration.
 */
export function planMigration(rootDir: string): MigrationPlan {
  const set = loadDefinitions(rootDir);
  const texts = new Map(Object.entries(set.texts));
  const before = agentFilesFromTexts(rootDir, texts);
  const plan: MigrationPlan = {
    root: rootDir,
    writes: {},
    legacy: [],
    agents: [],
    skipped: [],
    refused: [],
  };
  for (const p of before.problems) {
    plan.refused.push(`${storePath(rootDir, p.file)} does not read (${p.message}); fix it first`);
  }
  const legacy = before.agents.filter((a) => !a.folder);
  const byRole = new Map<string, AgentDef[]>();
  for (const a of legacy) byRole.set(roleOf(a.id), [...(byRole.get(roleOf(a.id)) ?? []), a]);
  for (const [role, agents] of [...byRole].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (texts.has(`agents/${role}/${AGENT_FOLDER_FILE}`)) {
      plan.skipped.push(`${role}: agents/${role}/ exists; move its legacy files into it by hand`);
      continue;
    }
    const ids = agents.map((a) => a.id);
    const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (twice.length > 0) {
      plan.refused.push(`${twice[0]} is defined in more than one file; keep one first`);
      continue;
    }
    // The frontmatter of each legacy file as written, without what the folder gives.
    const data = new Map<string, Record<string, unknown>>();
    const bodies = new Map<string, string>();
    for (const a of agents) {
      const doc = parseDoc<unknown>(texts.get(storePath(rootDir, a.file)) ?? '');
      const d = isRecord(doc.data) ? { ...doc.data } : {};
      delete d.id;
      delete d.role;
      delete d.providers;
      data.set(a.id, d);
      bodies.set(a.id, doc.body.trim());
    }
    const keys = [...new Set([...data.values()].flatMap((d) => Object.keys(d)))];
    const common: Record<string, unknown> = {};
    for (const k of keys) {
      const vals = agents.map((a) => norm(data.get(a.id)![k]));
      if (vals[0] !== undefined && vals.every((v) => v === vals[0])) {
        common[k] = data.get(agents[0]!.id)![k];
      }
    }
    const body = mostCommon(agents.map((a) => bodies.get(a.id)!));
    const providers = agents.map((a) => runtimeOf(a.id)).sort();
    plan.writes[`agents/${role}/${AGENT_FOLDER_FILE}`] = stringifyDoc(
      { providers, ...common },
      body,
    );
    for (const a of agents) {
      const own: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(data.get(a.id)!)) {
        if (!(k in common) && norm(v) !== undefined) own[k] = v;
      }
      const ownBody = bodies.get(a.id)!;
      if (ownBody !== body) own.body = 'replace';
      if (Object.keys(own).length > 0 || ownBody !== body) {
        plan.writes[`agents/${role}/${runtimeOf(a.id)}.md`] = stringifyDoc(
          own,
          ownBody !== body ? ownBody : '',
        );
      }
      plan.legacy.push(storePath(rootDir, a.file));
      plan.agents.push(a.id);
    }
  }
  // The check: the store as it would read after `--prune`.
  const after = new Map(texts);
  for (const path of plan.legacy) after.delete(path);
  for (const [path, text] of Object.entries(plan.writes)) after.set(path, text);
  const read = agentFilesFromTexts(rootDir, after);
  const known = new Set(before.problems.map((p) => p.file));
  for (const p of read.problems) {
    if (known.has(p.file)) continue;
    plan.refused.push(`${storePath(rootDir, p.file)} would not read (${p.message})`);
  }
  for (const id of plan.agents) {
    const was = legacy.find((a) => a.id === id)!;
    plan.refused.push(
      ...agentDifferences(
        was,
        read.agents.find((a) => a.id === id),
      ),
    );
  }
  const moved = new Set(plan.agents.map(roleOf));
  for (const a of read.agents) {
    if (a.folder && moved.has(roleOf(a.id)) && !plan.agents.includes(a.id)) {
      plan.refused.push(`${a.id}: the folders would add an agent the legacy files do not define`);
    }
  }
  plan.legacy.sort();
  plan.agents.sort();
  return plan;
}

/**
 * The plan as a diff for a person to read: each new file with `+` lines, then each legacy file
 * with `-` lines when `prune` removes it.
 */
export function migrationDiff(
  plan: MigrationPlan,
  texts: Record<string, string>,
  prune: boolean,
): string {
  const lines: string[] = [];
  for (const [path, text] of Object.entries(plan.writes).sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(`+++ ${path}`);
    for (const l of text.replace(/\n$/, '').split('\n')) lines.push(`+${l}`);
  }
  for (const path of plan.legacy) {
    if (!prune) {
      lines.push(`  ${path} stays; the legacy file wins until --prune removes it`);
      continue;
    }
    lines.push(`--- ${path}`);
    for (const l of (texts[path] ?? '').replace(/\n$/, '').split('\n')) lines.push(`-${l}`);
  }
  return lines.join('\n');
}

/**
 * Writes the folders of `plan`, and with `prune` removes the legacy files it replaces. Refuses a
 * plan that refuses, a store whose `swarm.yaml` does not name `swarmup_defs: 1` (versions that
 * read only legacy files may still run there), and a folder file that appeared since the plan.
 * Returns the paths it wrote and removed.
 */
export function applyMigration(
  plan: MigrationPlan,
  opts: { prune?: boolean } = {},
): { wrote: string[]; removed: string[] } {
  if (plan.refused.length > 0) {
    throw new OpsError(`the migration refuses:\n- ${plan.refused.join('\n- ')}`, 1);
  }
  if (!agentFoldersOn(plan.root)) {
    throw new OpsError(
      'agent folders need swarm.yaml with swarmup_defs: 1 in the store, so every machine reads ' +
        'them: create it (swarmup defs import-config writes one) once every machine runs this ' +
        'version, then migrate',
      1,
    );
  }
  const wrote: string[] = [];
  for (const path of Object.keys(plan.writes)) {
    if (existsSync(join(plan.root, path))) {
      throw new OpsError(`${path} exists since the plan was made; run the migration again`, 1);
    }
  }
  for (const [path, text] of Object.entries(plan.writes)) {
    const file = join(plan.root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    wrote.push(path);
  }
  const removed: string[] = [];
  if (opts.prune) {
    for (const path of plan.legacy) {
      const file = join(plan.root, path);
      try {
        if (!lstatSync(file).isFile()) continue;
      } catch {
        continue;
      }
      rmSync(file);
      removed.push(path);
    }
  }
  return { wrote, removed };
}
