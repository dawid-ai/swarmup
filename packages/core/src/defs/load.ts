import { join } from 'node:path';
import type { AgentDef, AgentFileProblem } from '../agents.js';
import { readAgentFiles } from '../agents.js';
import { AGENT_SCHEMA } from './agent.js';
import type { DefFile } from './hash.js';
import { definitionHash, digestFiles, fingerprintOf, listDefFiles } from './hash.js';
import type { DefProblem, Locate } from './schema.js';
import { checkYaml } from './schema.js';
import type { SwarmDefs } from './swarm.js';
import { SWARM_FILE, SWARM_SCHEMA, swarmDefs } from './swarm.js';
import { validateDefinitions } from './validate.js';

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
  /** {@link definitionHash} of `files`. */
  hash: string;
  /** {@link definitionsFingerprint} when the set was read. */
  fingerprint: string;
  /** Problems in single files and across files, errors and warnings. */
  problems: DefProblem[];
  /** No problem is an error. */
  ok: boolean;
}

export interface LoadOptions {
  /** Unknown keys are errors. */
  strict?: boolean;
  /** Runtimes this machine runs, to check role providers against. */
  machineRuntimes?: readonly string[];
  /** Agents this machine's config names, for the check that each role has an agent. */
  machineAgents?: readonly string[];
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
  const problems: DefProblem[] = [];
  const present = texts.has(SWARM_FILE);
  let swarm: SwarmDefs | null = null;
  const locate = new Map<string, Locate>();
  if (present) {
    const checked = checkYaml(SWARM_SCHEMA, texts.get(SWARM_FILE)!, {
      file: join(rootDir, SWARM_FILE),
      strict: opts.strict,
    });
    problems.push(...checked.problems);
    locate.set(join(rootDir, SWARM_FILE), checked.at);
    if (!checked.problems.some((p) => p.severity === 'error')) swarm = swarmDefs(checked.value);
  }
  const read = readAgentFiles(rootDir);
  const agentValues = new Map<string, unknown>();
  for (const f of files) {
    if (!f.path.startsWith('agents/') || !f.path.endsWith('.md')) continue;
    const name = f.path.slice('agents/'.length);
    const file = join(rootDir, f.path);
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
    }),
  );
  const set: DefinitionSet = {
    root: rootDir,
    present,
    swarm,
    agents: read.agents,
    agentProblems: read.problems,
    files,
    hash: definitionHash(files),
    fingerprint,
    problems: sortProblems(problems),
    ok: !problems.some((p) => p.severity === 'error'),
  };
  cache.set(key, set);
  return set;
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
