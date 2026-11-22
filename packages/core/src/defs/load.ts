import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { OpsError } from '../ids.js';
import type { AgentDef, AgentFileProblem, AgentFiles } from '../agents.js';
import { agentFilesFromTexts, readAgentFiles } from '../agents.js';
import { AGENT_SCHEMA } from './agent.js';
import type { DefFile } from './hash.js';
import { definitionHash, digestFiles, fingerprintOf, listDefFiles, normalText } from './hash.js';
import type { DefProblem, Locate } from './schema.js';
import { checkYaml } from './schema.js';
import type { SwarmDefs } from './swarm.js';
import { SWARM_FILE, SWARM_SCHEMA, swarmDefs } from './swarm.js';
import { secretProblems, validateDefinitions } from './validate.js';
import {
  applyOverlay,
  checkVariantName,
  listVariantNames,
  readOverlay,
  textFiles,
  variantDir,
} from './variants.js';

/** The definitions of one task store, read and checked. */
export interface DefinitionSet {
  /** The store folder (`.swarmup`). */
  root: string;
  /** The store has a `swarm.yaml`: definitions as code are on for it. */
  present: boolean;
  /** The phase 1 part of `swarm.yaml`; null without the file or when it has an error. */
  swarm: SwarmDefs | null;
  /** The agent files, exactly as `readAgentFiles` reads them. */
  agents: AgentDef[];
  /** Agent files `readAgentFiles` skipped. */
  agentProblems: AgentFileProblem[];
  /** Every definition file, sorted by path. */
  files: DefFile[];
  /** Each file's text as hashed (no BOM, LF line ends), by path; for snapshots. */
  texts: Record<string, string>;
  /** {@link definitionHash} of `files`. */
  hash: string;
  /** {@link definitionsFingerprint} when the set was read. */
  fingerprint: string;
  /** Problems in single files and across files, errors and warnings. */
  problems: DefProblem[];
  /** No problem is an error. */
  ok: boolean;
  /** The variant these definitions are, when a variant was asked for (W5). */
  variant?: string;
  /** A variant's overlay files, path to text; `files` and `texts` are the result. */
  overlay?: Record<string, string>;
  /** A variant's base hash: the store's own definitions. */
  baseHash?: string;
}

export interface LoadOptions {
  /** Unknown keys are errors. */
  strict?: boolean;
  /** Runtimes this machine runs, to check role providers against. */
  machineRuntimes?: readonly string[];
  /** Agents this machine's config names, for the check that each role has an agent. */
  machineAgents?: readonly string[];
  /** Read variant `variants/<name>/` on top of the store's definitions (W5). */
  variant?: string;
}

const cache = new Map<string, DefinitionSet>();

/** Splits frontmatter as `parseDoc` does; null when the file has none. */
function frontmatter(text: string): string | null {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  if (end < 0) return null;
  return text.slice(4, end + 1);
}

/**
 * Reads and checks the definitions of the store in `rootDir`: `swarm.yaml` and `agents/**`. The
 * result is cached by the files' paths, sizes and change times, so a call per tick reads nothing
 * when nothing changed. A store without `swarm.yaml` gets the agents `readAgentFiles` reads, the
 * same as before.
 */
export function loadDefinitions(rootDir: string, opts: LoadOptions = {}): DefinitionSet {
  if (opts.variant !== undefined) return loadVariant(rootDir, checkVariantName(opts.variant), opts);
  const listed = listDefFiles(rootDir);
  const fingerprint = fingerprintOf(listed);
  const key = JSON.stringify([
    rootDir,
    Boolean(opts.strict),
    opts.machineRuntimes ?? null,
    opts.machineAgents ?? null,
  ]);
  const hit = cache.get(key);
  if (hit && hit.fingerprint === fingerprint) return hit;
  const { files, texts } = digestFiles(rootDir, listed);
  const set = checkSet(rootDir, files, texts, readAgentFiles(rootDir), fingerprint, opts);
  cache.set(key, set);
  return set;
}

/** Paths, sizes and change times of the files in a variant folder, for the cache. */
function overlayFingerprint(dir: string): string {
  const out: string[] = [];
  const visit = (rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(rel ? join(dir, rel) : dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const path = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = lstatSync(join(dir, path));
      } catch {
        continue;
      }
      if (st.isDirectory()) visit(path);
      else out.push(`${path}\0${st.size}\0${st.mtimeMs}`);
    }
  };
  visit('');
  return out.join('\n');
}

/**
 * The definitions of variant `name`: the store's definitions with `variants/<name>/` on top. The
 * agents are read from the resulting texts; each agent's `file` is its overlay file when the
 * overlay holds one, else its base file. Throws when the variant folder is missing.
 */
function loadVariant(rootDir: string, name: string, opts: LoadOptions): DefinitionSet {
  const dir = variantDir(rootDir, name);
  if (!listVariantNames(rootDir).includes(name)) {
    throw new OpsError(`no variant '${name}' in ${rootDir}`, 2);
  }
  const listed = listDefFiles(rootDir);
  const fingerprint = `${fingerprintOf(listed)}\n--\n${overlayFingerprint(dir)}`;
  const key = JSON.stringify([
    rootDir,
    name,
    Boolean(opts.strict),
    opts.machineRuntimes ?? null,
    opts.machineAgents ?? null,
  ]);
  const hit = cache.get(key);
  if (hit && hit.fingerprint === fingerprint) return hit;
  const base = digestFiles(rootDir, listed);
  const overlay = readOverlay(dir);
  const texts = applyOverlay(base.texts, overlay);
  const fileOf = (path: string): string =>
    overlay.has(path) ? join(dir, path) : join(rootDir, path);
  const set = checkSet(
    rootDir,
    textFiles(texts),
    texts,
    agentFilesFromTexts(rootDir, texts, fileOf),
    fingerprint,
    opts,
    fileOf,
  );
  const out: DefinitionSet = {
    ...set,
    variant: name,
    overlay: Object.fromEntries(overlay),
    baseHash: definitionHash(base.files),
  };
  cache.set(key, out);
  return out;
}

/** Checks one set of definition texts: each file against its schema, then across files. */
function checkSet(
  rootDir: string,
  files: DefFile[],
  texts: Map<string, string>,
  read: AgentFiles,
  fingerprint: string,
  opts: LoadOptions,
  fileOf: (path: string) => string = (path) => join(rootDir, path),
): DefinitionSet {
  const problems: DefProblem[] = [];
  const present = texts.has(SWARM_FILE);
  let swarm: SwarmDefs | null = null;
  const locate = new Map<string, Locate>();
  if (present) {
    const file = fileOf(SWARM_FILE);
    const checked = checkYaml(SWARM_SCHEMA, texts.get(SWARM_FILE)!, {
      file,
      strict: opts.strict,
    });
    problems.push(...checked.problems);
    locate.set(file, checked.at);
    if (!checked.problems.some((p) => p.severity === 'error')) swarm = swarmDefs(checked.value);
  }
  const agentValues = new Map<string, unknown>();
  for (const f of files) {
    if (!f.path.startsWith('agents/') || !f.path.endsWith('.md')) continue;
    const name = f.path.slice('agents/'.length);
    const file = fileOf(f.path);
    if (name.includes('/')) {
      problems.push({
        file,
        path: '(top)',
        line: 1,
        col: 1,
        severity: 'warning',
        message:
          'agent folders (agents/<role>/agent.md) are read from phase 2 on; this file is not used yet',
      });
      continue;
    }
    if (name.startsWith('_')) continue;
    const yamlText = frontmatter(texts.get(f.path) ?? '');
    if (yamlText === null) continue;
    const checked = checkYaml(AGENT_SCHEMA, yamlText, { file, strict: opts.strict, lineOffset: 1 });
    problems.push(...checked.problems);
    locate.set(file, checked.at);
    if (checked.value !== undefined) agentValues.set(file, checked.value);
    // A file the queue skips always shows as an error, whatever the schema says of it.
    const skipped = read.problems.find((p) => p.file === file);
    if (skipped && !checked.problems.some((p) => p.severity === 'error')) {
      problems.push({
        file,
        path: '(top)',
        line: 1,
        col: 1,
        severity: 'error',
        message: `skipped: ${skipped.message}`,
      });
    }
  }
  problems.push(
    ...validateDefinitions({
      root: rootDir,
      swarm,
      agents: read.agents,
      agentValues,
      texts,
      machineRuntimes: opts.machineRuntimes,
      machineAgents: opts.machineAgents,
      locate,
      fileOf,
    }),
  );
  return {
    root: rootDir,
    present,
    swarm,
    agents: read.agents,
    agentProblems: read.problems,
    files,
    texts: Object.fromEntries(texts),
    hash: definitionHash(files),
    fingerprint,
    problems: sortProblems(problems),
    ok: !problems.some((p) => p.severity === 'error'),
  };
}

/**
 * Checks one definition file's text without its store: `swarm.yaml`, or an agent file's
 * frontmatter when `kind` is `agent` or the name ends in `.md`. For loose files and editors;
 * the checks across files need {@link loadDefinitions}.
 */
export function checkDefinitionText(
  file: string,
  text: string,
  opts: { strict?: boolean; kind?: 'swarm' | 'agent' } = {},
): DefProblem[] {
  const src = normalText(text);
  const kind = opts.kind ?? (/\.md$/i.test(file) ? 'agent' : 'swarm');
  const problems: DefProblem[] = [];
  if (kind === 'agent') {
    const yamlText = frontmatter(src);
    if (yamlText !== null) {
      problems.push(
        ...checkYaml(AGENT_SCHEMA, yamlText, { file, strict: opts.strict, lineOffset: 1 }).problems,
      );
    }
  } else problems.push(...checkYaml(SWARM_SCHEMA, src, { file, strict: opts.strict }).problems);
  problems.push(...secretProblems(file, src));
  return sortProblems(problems);
}

/** Problems by file, then line and column. */
export function sortProblems(problems: DefProblem[]): DefProblem[] {
  return [...problems].sort(
    (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line || a.col - b.col,
  );
}

/** Drops cached sets, for tests that rewrite files within one change-time tick. */
export function clearDefinitionsCache(): void {
  cache.clear();
}
