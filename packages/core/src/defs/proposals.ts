/**
 * Proposals (W6): a change to the definitions written as a variant overlay, checked against the
 * store's improvement policy, and kept in `variants/<name>/` with a `proposal.json` until a person
 * promotes it onto the base files or rejects it.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import { OpsError } from '../ids.js';
import { matchGlobs } from '../rubric.js';
import { definitionHash, digestFiles, listDefFiles } from './hash.js';
import type { DefinitionSet } from './load.js';
import { loadDefinitions } from './load.js';
import type { SwarmDefs } from './swarm.js';
import {
  applyOverlay,
  checkVariantName,
  DELETE_SUFFIX,
  listVariantNames,
  overlayAgents,
  overlayTargets,
  PROPOSAL_FILE,
  readOverlay,
  splitFrontmatter,
  variantDir,
} from './variants.js';

/** Overlay paths a proposal may change when `swarm.yaml` sets no `improvement.may_change`. */
export const DEFAULT_MAY_CHANGE: readonly string[] = [
  'agents/*.md',
  'agents/*/*.md',
  'workflows/**',
];

/** Overlay paths a proposal never changes when `swarm.yaml` sets no `improvement.frozen`. */
export const DEFAULT_FROZEN: readonly string[] = [
  'scorers/**',
  'benchmarks/**',
  'rubrics/**',
  'swarm.yaml',
];

/**
 * Agent frontmatter keys no proposal changes, whatever the policy says: what an agent may run,
 * whether it writes, the work it takes, and who it is.
 */
export const ALWAYS_FROZEN_KEYS: readonly string[] = ['tools', 'writes', 'can_claim', 'id'];

/** Proposals that may wait for a person at once in one store, by default. */
export const DEFAULT_MAX_OPEN_PROPOSALS = 2;

/** The agent that writes proposals, by default. */
export const DEFAULT_IMPROVER = 'claude:improver';

export interface ImprovementPolicy {
  agent: string;
  may_change: string[];
  frozen: string[];
  max_open_proposals: number;
}

/** The improvement policy of a store's `swarm.yaml`, with the defaults for what it leaves out. */
export function improvementPolicy(swarm: SwarmDefs | null | undefined): ImprovementPolicy {
  const i = swarm?.improvement ?? {};
  return {
    agent: i.agent ?? DEFAULT_IMPROVER,
    may_change: i.may_change ?? [...DEFAULT_MAY_CHANGE],
    frozen: i.frozen ?? [...DEFAULT_FROZEN],
    max_open_proposals: i.max_open_proposals ?? DEFAULT_MAX_OPEN_PROPOSALS,
  };
}

const frontmatterValue = (text: string | undefined): Record<string, unknown> => {
  if (text === undefined) return {};
  const yaml = splitFrontmatter(text).yaml;
  if (!yaml) return {};
  try {
    const v = YAML.parse(yaml) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/**
 * Why the policy refuses an overlay, one line per problem; empty when it passes. Each changed path
 * must match `may_change` and no `frozen` glob, and no agent file may change an
 * {@link ALWAYS_FROZEN_KEYS} key or be removed.
 */
export function policyProblems(
  base: ReadonlyMap<string, string>,
  overlay: ReadonlyMap<string, string>,
  policy: Pick<ImprovementPolicy, 'may_change' | 'frozen'>,
): string[] {
  const out: string[] = [];
  if (overlay.size === 0) out.push('the overlay holds no files');
  const targets = overlayTargets(overlay);
  for (const path of targets) {
    if (matchGlobs([path], policy.frozen).length > 0) {
      out.push(`${path}: frozen by the improvement policy (${policy.frozen.join(', ')})`);
    } else if (matchGlobs([path], policy.may_change).length === 0) {
      out.push(`${path}: outside what a proposal may change (${policy.may_change.join(', ')})`);
    }
  }
  const resolved = applyOverlay(base, overlay);
  for (const path of targets) {
    if (!/^agents\/.+\.md$/.test(path)) continue;
    if (overlay.has(`${path}${DELETE_SUFFIX}`) && base.has(path)) {
      out.push(`${path}: a proposal does not remove an agent file`);
      continue;
    }
    const was = frontmatterValue(base.get(path));
    const now = frontmatterValue(resolved.get(path));
    for (const key of ALWAYS_FROZEN_KEYS) {
      if (JSON.stringify(was[key] ?? null) !== JSON.stringify(now[key] ?? null)) {
        out.push(`${path}: ${key} is always frozen; a person changes it by hand`);
      }
    }
  }
  return out;
}

/** What `proposal.json` in a variant's folder records. */
export interface ProposalMeta {
  /** The task the proposal is linked to, as `root/ID`. */
  task: string;
  /** The agents the overlay changes. */
  agents: string[];
  /** The scorers whose failures it addresses. */
  scorers: string[];
  /** Why: the proposer's message. */
  message: string;
  /** Who proposed it, and when (ISO). */
  by: string;
  at: string;
  /** The base hash it was proposed against, and the variant's hash then. */
  base: string;
  hash: string;
  /** The `defs-propose` event on the task. */
  event?: string;
}

/** Reads a variant's `proposal.json`; undefined when it has none or it does not read. */
export function readProposal(rootDir: string, name: string): ProposalMeta | undefined {
  const file = join(variantDir(rootDir, name), PROPOSAL_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as ProposalMeta;
    return v && typeof v.task === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

export function writeProposal(rootDir: string, name: string, meta: ProposalMeta): void {
  writeFileSync(
    join(variantDir(rootDir, name), PROPOSAL_FILE),
    `${JSON.stringify(meta, null, 2)}\n`,
  );
}

/** One changed file of a variant: the base text and the result, for a diff. */
export interface VariantFile {
  path: string;
  kind: 'added' | 'changed' | 'removed';
  before: string;
  after: string;
}

/** A variant as `swarmup defs variants` and the app list it. */
export interface VariantInfo {
  name: string;
  dir: string;
  /** The variant's hash (base and overlay) and the base hash now. */
  hash: string;
  base: string;
  /** `proposed` with a `proposal.json`, else `draft` (a folder made by hand). */
  status: 'proposed' | 'draft';
  /** The base moved since the proposal: its base hash is no longer the store's. */
  stale: boolean;
  agents: string[];
  files: VariantFile[];
  ok: boolean;
  /** Error lines: the definitions' own problems, then the policy's. */
  problems: string[];
  proposal?: ProposalMeta;
}

/** A variant of a store, read and checked against the base and the policy. */
export function variantInfo(rootDir: string, name: string): VariantInfo {
  const dir = variantDir(rootDir, name);
  let set: DefinitionSet | undefined;
  const problems: string[] = [];
  try {
    set = loadDefinitions(rootDir, { variant: name });
  } catch (err) {
    problems.push((err as Error).message);
  }
  const base = loadDefinitions(rootDir);
  const baseTexts = new Map(Object.entries(base.texts));
  const overlay = set?.overlay ? new Map(Object.entries(set.overlay)) : new Map<string, string>();
  const after = set ? new Map(Object.entries(set.texts)) : baseTexts;
  for (const p of set?.problems ?? []) {
    if (p.severity === 'error') problems.push(`${p.file}:${p.line}: ${p.path}: ${p.message}`);
  }
  const proposal = readProposal(rootDir, name);
  if (proposal) problems.push(...policyProblems(baseTexts, overlay, improvementPolicy(base.swarm)));
  const files: VariantFile[] = overlayTargets(overlay).map((path) => {
    const before = baseTexts.get(path);
    const now = after.get(path);
    return {
      path,
      kind: before === undefined ? 'added' : now === undefined ? 'removed' : 'changed',
      before: before ?? '',
      after: now ?? '',
    };
  });
  return {
    name,
    dir,
    hash: set?.hash ?? '',
    base: base.hash,
    status: proposal ? 'proposed' : 'draft',
    stale: proposal ? proposal.base !== base.hash : false,
    agents: proposal?.agents.length ? proposal.agents : overlayAgents(overlay),
    files,
    ok: problems.length === 0,
    problems,
    ...(proposal ? { proposal } : {}),
  };
}

/** Every variant of a store. */
export function listVariants(rootDir: string): VariantInfo[] {
  return listVariantNames(rootDir).map((n) => variantInfo(rootDir, n));
}

/** Writes an overlay into `variants/<name>/`, which must not exist yet. */
export function writeVariantFiles(
  rootDir: string,
  name: string,
  overlay: ReadonlyMap<string, string>,
): string {
  const dir = variantDir(rootDir, checkVariantName(name));
  if (existsSync(dir)) throw new OpsError(`variant '${name}' exists; pick another name`, 2);
  for (const path of overlay.keys()) {
    if (path.split('/').some((seg) => seg === '..' || seg === '' || seg === '.')) {
      throw new OpsError(`bad overlay path '${path}'`, 2);
    }
  }
  mkdirSync(dir, { recursive: true });
  for (const [path, text] of overlay) {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return dir;
}

/** Removes a variant's folder. */
export function removeVariant(rootDir: string, name: string): void {
  rmSync(variantDir(rootDir, name), { recursive: true, force: true });
}

/**
 * Writes a variant's result onto the base files: each overlay path gets the merged text, and a
 * `.delete` removes its file. Returns the hashes before and after, and the paths it changed. The
 * variant's folder stays; the caller removes it.
 */
export function applyVariantToBase(
  rootDir: string,
  name: string,
): { from: string; to: string; written: string[]; removed: string[] } {
  const set = loadDefinitions(rootDir, { variant: name });
  if (!set.ok) {
    const first = set.problems.find((p) => p.severity === 'error');
    throw new OpsError(
      `variant '${name}' does not check: ${first ? `${first.path}: ${first.message}` : 'errors'}; fix or reject it`,
    );
  }
  const overlay = readOverlay(variantDir(rootDir, name));
  const written: string[] = [];
  const removed: string[] = [];
  for (const path of overlayTargets(overlay)) {
    const file = join(rootDir, path);
    const text = set.texts[path];
    if (text === undefined) {
      if (existsSync(file)) {
        unlinkSync(file);
        removed.push(path);
      }
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    written.push(path);
  }
  // The hash of the base files as they are now on disk.
  const to = definitionHash(digestFiles(rootDir, listDefFiles(rootDir)).files);
  return { from: set.baseHash ?? '', to, written, removed };
}

/** The overlay in folder `dir`, checked: files only, and at least one. */
export function overlayFrom(dir: string): Map<string, string> {
  const overlay = readOverlay(dir);
  if (overlay.size === 0) throw new OpsError(`${dir} holds no overlay files`, 2);
  return overlay;
}
