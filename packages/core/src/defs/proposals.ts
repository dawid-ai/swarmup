/**
 * Proposals (W6): a change to the definitions written as a variant overlay, checked against the
 * store's improvement policy, and kept in `variants/<name>/` with a `proposal.json` until a person
 * promotes it onto the base files or rejects it.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import { OpsError } from '../ids.js';
import { matchGlobs } from '../rubric.js';
import { definitionHash, digestFiles, listDefFiles, normalText } from './hash.js';
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
  VARIANTS_DIR,
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
  'triggers/**',
  'swarm.yaml',
];

/**
 * Agent frontmatter keys no proposal changes, whatever the policy says: what an agent may run,
 * whether it writes, the work it takes, and who it is.
 */
export const ALWAYS_FROZEN_KEYS: readonly string[] = ['tools', 'mcp', 'writes', 'can_claim', 'id'];

/** Proposals that may wait for a person at once in one store, by default. */
export const DEFAULT_MAX_OPEN_PROPOSALS = 2;

/** The agent that writes proposals, by default. */
export const DEFAULT_IMPROVER = 'claude:improver';

export interface ImprovementPolicy {
  agent: string;
  may_change: string[];
  frozen: string[];
  max_open_proposals: number;
  /** `improvement.requires`, with its defaults: no benchmark needed, and no worse than the base. */
  requires: { benchmark: boolean; min_delta: number };
}

/** The improvement policy of a store's `swarm.yaml`, with the defaults for what it leaves out. */
export function improvementPolicy(swarm: SwarmDefs | null | undefined): ImprovementPolicy {
  const i = swarm?.improvement ?? {};
  return {
    agent: i.agent ?? DEFAULT_IMPROVER,
    may_change: i.may_change ?? [...DEFAULT_MAY_CHANGE],
    frozen: i.frozen ?? [...DEFAULT_FROZEN],
    max_open_proposals: i.max_open_proposals ?? DEFAULT_MAX_OPEN_PROPOSALS,
    requires: {
      benchmark: i.requires?.benchmark ?? false,
      min_delta: i.requires?.min_delta ?? 0,
    },
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
  /** The benchmark swarmupd ran of this variant, base against variant (`improvement.requires`). */
  benchmark?: ProposalBenchmark;
}

/** A finished benchmark of a proposal, as swarmupd records it in `proposal.json`. */
export interface ProposalBenchmark {
  /** The variant hash the benchmark ran; a later change to the variant makes it stale. */
  hash: string;
  state: 'done' | 'failed';
  verdict?: 'better' | 'worse' | 'same';
  /** Variant minus base, overall: pass rate and hidden pass rate, from -1 to 1. */
  pass_delta?: number | null;
  hidden_delta?: number | null;
  /** The bench run ids of the base and the variant. */
  base_run?: string;
  run?: string;
  error?: string;
  at: string;
}

/**
 * Why `requires` refuses to promote a proposal, one line per problem; empty when it may be
 * promoted. `hash` is the variant's hash now.
 */
export function requiresProblems(
  policy: Pick<ImprovementPolicy, 'requires'>,
  meta: ProposalMeta | undefined,
  hash: string,
): string[] {
  const req = policy.requires;
  if (!req.benchmark) return [];
  const b = meta?.benchmark;
  if (!b) return ['improvement.requires a benchmark, and this proposal has none yet'];
  if (b.hash !== hash) {
    return ['the variant changed after its benchmark ran; it needs a new benchmark'];
  }
  if (b.state !== 'done') return [`its benchmark failed: ${b.error ?? 'no result'}`];
  const delta = b.pass_delta ?? 0;
  if (delta < req.min_delta - 1e-9) {
    const pts = (x: number): string => `${x > 0 ? '+' : ''}${Math.round(x * 1000) / 10} pts`;
    return [
      `its pass rate moved ${pts(delta)}; improvement.requires at least ${pts(req.min_delta)}`,
    ];
  }
  return [];
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
  /** The variant's folder; for a `from_ref` variant, the folder it would have, which is not there. */
  dir: string;
  /** `variants.<name>.description` in `swarm.yaml`. */
  description?: string;
  /** A variant of the definitions at a git ref: the ref `swarm.yaml` names, and its commit. */
  from_ref?: string;
  commit?: string;
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
  // A ref variant changes what differs between the base and the ref, as an overlay would.
  const fromRef = base.swarm?.variants?.[name]?.from_ref;
  if (set && !set.overlay) {
    for (const [path, text] of after) if (baseTexts.get(path) !== text) overlay.set(path, text);
    for (const path of baseTexts.keys()) if (!after.has(path)) overlay.set(`${path}.delete`, '');
  }
  const description = base.swarm?.variants?.[name]?.description;
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
    ...(description ? { description } : {}),
    ...(fromRef && !existsSync(dir) ? { from_ref: fromRef } : {}),
    ...(set?.commit ? { commit: set.commit } : {}),
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

/** Every variant of a store: its folders, and the `from_ref` variants `swarm.yaml` names. */
export function listVariants(rootDir: string): VariantInfo[] {
  return variantNames(rootDir).map((n) => variantInfo(rootDir, n));
}

/** The names of a store's variants: its folders and its `from_ref` variants, sorted. */
export function variantNames(rootDir: string): string[] {
  const refs = Object.entries(loadDefinitions(rootDir).swarm?.variants ?? {}).flatMap(([n, v]) =>
    v.from_ref ? [n] : [],
  );
  return [...new Set([...listVariantNames(rootDir), ...refs])].sort();
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
  // The last variant gone: no empty `variants/` folder is left behind.
  const dir = join(rootDir, VARIANTS_DIR);
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    // Another variant came, or the folder is gone already.
  }
}

/**
 * Writes a variant's result onto the base files: each overlay path gets the merged text, and a
 * `.delete` removes its file. Returns the hashes before and after, and the paths it changed. The
 * variant's folder stays; the caller removes it.
 */
export function applyVariantToBase(
  rootDir: string,
  name: string,
): {
  from: string;
  to: string;
  written: string[];
  removed: string[];
  /** Each changed path's text before and after; null where the file did not or does not exist. */
  files: Record<string, PromotedFile>;
} {
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
  const files: Record<string, PromotedFile> = {};
  for (const path of overlayTargets(overlay)) {
    const file = join(rootDir, path);
    const text = set.texts[path];
    const before = currentText(rootDir, path);
    files[path] = { before, after: text ?? null };
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
  return { from: set.baseHash ?? '', to, written, removed, files };
}

/** A store file's text as hashed (no BOM, LF line ends), or null when it isn't there. */
function currentText(rootDir: string, path: string): string | null {
  try {
    return normalText(readFileSync(join(rootDir, path)));
  } catch {
    return null;
  }
}

/** Where promotes are recorded for `defs rollback`: a dot folder no variant name matches. */
export const PROMOTED_DIR = '.promoted';

/** One file a promote changed. */
export interface PromotedFile {
  before: string | null;
  after: string | null;
}

/** What `defs promote` wrote, kept in `variants/.promoted/<name>.json` for `defs rollback`. */
export interface PromotedRecord {
  variant: string;
  task?: string;
  by: string;
  at: string;
  /** The definition hashes before and after the promote. */
  from: string;
  to: string;
  files: Record<string, PromotedFile>;
  /** Set once a person rolled it back. */
  rolled_back?: { by: string; at: string };
}

function promotedFile(rootDir: string, name: string): string {
  return join(rootDir, VARIANTS_DIR, PROMOTED_DIR, `${checkVariantName(name)}.json`);
}

/** The record of the last promote of variant `name`, or undefined. */
export function readPromoted(rootDir: string, name: string): PromotedRecord | undefined {
  try {
    const v = JSON.parse(readFileSync(promotedFile(rootDir, name), 'utf8')) as PromotedRecord;
    return v && typeof v.files === 'object' && v.files ? v : undefined;
  } catch {
    return undefined;
  }
}

export function writePromoted(rootDir: string, rec: PromotedRecord): void {
  const file = promotedFile(rootDir, rec.variant);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
}

/**
 * Puts back the files the last promote of `name` changed. Refuses when there is no record, when it
 * was rolled back already, and, unless `force`, when a file changed since the promote, since the
 * rollback would drop that change. Returns what it wrote and removed, and the hashes.
 */
export function rollbackPromoted(
  rootDir: string,
  name: string,
  opts: { force?: boolean } = {},
): { rec: PromotedRecord; from: string; to: string; written: string[]; removed: string[] } {
  const rec = readPromoted(rootDir, name);
  if (!rec) throw new OpsError(`no promote of '${name}' is recorded in this store`, 1);
  if (rec.rolled_back) {
    throw new OpsError(`'${name}' was rolled back already, by ${rec.rolled_back.by}`, 1);
  }
  const changed = Object.entries(rec.files)
    .filter(([path, f]) => currentText(rootDir, path) !== f.after)
    .map(([path]) => path);
  if (changed.length > 0 && !opts.force) {
    throw new OpsError(
      `${changed.join(', ')} changed after the promote; a rollback would drop that change. ` +
        'Roll back anyway with --force',
      1,
    );
  }
  const from = definitionHash(digestFiles(rootDir, listDefFiles(rootDir)).files);
  const written: string[] = [];
  const removed: string[] = [];
  for (const [path, f] of Object.entries(rec.files)) {
    const file = join(rootDir, path);
    if (f.before === null) {
      if (existsSync(file)) {
        unlinkSync(file);
        removed.push(path);
      }
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, f.before);
    written.push(path);
  }
  const to = definitionHash(digestFiles(rootDir, listDefFiles(rootDir)).files);
  return { rec, from, to, written, removed };
}

/** The overlay in folder `dir`, checked: files only, and at least one. */
export function overlayFrom(dir: string): Map<string, string> {
  const overlay = readOverlay(dir);
  if (overlay.size === 0) throw new OpsError(`${dir} holds no overlay files`, 2);
  return overlay;
}
