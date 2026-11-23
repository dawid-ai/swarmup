import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpsError } from '../ids.js';
import type { AgentDef, AgentFileProblem, AgentFiles } from '../agents.js';
import { agentFilesFromTexts, readAgentFiles } from '../agents.js';
import { AGENT_FOLDER_FILE } from '../agents.js';
import { ADDENDUM_SCHEMA, AGENT_SCHEMA, FOLDER_AGENT_SCHEMA } from './agent.js';
import { ROLE_NAME_RE, RUNTIME_NAME_RE } from './values.js';
import { parseDoneWhen } from '../criteria.js';
import { parseRubric } from '../rubric.js';
import type { ScorerFileInfo } from './scorer.js';
import { checkScorerText, SCORERS_DIR, scorerIdOf } from './scorer.js';
import type { TriggerInfo } from './trigger.js';
import { checkTriggerText, TRIGGERS_DIR, triggerNameOf } from './trigger.js';
import type { WorkflowInfo } from './workflow.js';
import { checkWorkflowText, WORKFLOWS_DIR, workflowIdOf } from './workflow.js';
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
  /** The store's workflows (W5 phase 3), each with its problems. */
  workflows: WorkflowInfo[];
  /**
   * The store's triggers (W5 phase 4), each with its problems. A trigger whose file has an error,
   * its own or across files (a workflow it names is missing), has a null `def`.
   */
  triggers: TriggerInfo[];
  /** The store's scorers (W5 phase 4), each with its problems; a null `def` on an error. */
  scorers: ScorerFileInfo[];
}

export interface LoadOptions {
  /** Unknown keys are errors. */
  strict?: boolean;
  /** Runtimes this machine runs, to check role providers against. */
  machineRuntimes?: readonly string[];
  /** Agents this machine's config names, for the check that each role has an agent. */
  machineAgents?: readonly string[];
  /** MCP servers this machine defines, for the check of role `mcp` names (W8). */
  machineMcp?: readonly string[];
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
    opts.machineMcp ?? null,
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
    opts.machineMcp ?? null,
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
  const folderValues = new Map<string, unknown>();
  const warnAt = (file: string, message: string): void => {
    problems.push({ file, path: '(top)', line: 1, col: 1, severity: 'warning', message });
  };
  for (const f of files) {
    if (!f.path.startsWith('agents/') || !f.path.endsWith('.md')) continue;
    const parts = f.path.slice('agents/'.length).split('/');
    const file = fileOf(f.path);
    if (parts.some((p) => p.startsWith('_'))) continue;
    let schema = AGENT_SCHEMA;
    if (parts.length > 2) {
      warnAt(
        file,
        'an agent folder holds agents/<role>/agent.md and agents/<role>/<runtime>.md only; this file is not read',
      );
      continue;
    }
    if (parts.length === 2) {
      const [role, base] = parts as [string, string];
      if (!ROLE_NAME_RE.test(role)) {
        warnAt(file, `agents/${role}/ is no role name (lowercase letters, digits and -); not read`);
        continue;
      }
      if (base === AGENT_FOLDER_FILE) schema = FOLDER_AGENT_SCHEMA;
      else if (RUNTIME_NAME_RE.test(base.slice(0, -3))) schema = ADDENDUM_SCHEMA;
      else {
        warnAt(
          file,
          'neither agent.md nor a runtime addendum (<runtime>.md); this file is not read',
        );
        continue;
      }
    }
    const yamlText = frontmatter(texts.get(f.path) ?? '');
    if (yamlText === null) continue;
    const checked = checkYaml(schema, yamlText, { file, strict: opts.strict, lineOffset: 1 });
    problems.push(...checked.problems);
    locate.set(file, checked.at);
    if (checked.value !== undefined) {
      (parts.length === 2 ? folderValues : agentValues).set(file, checked.value);
    }
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
  // Workflows (W5 phase 3): each file against its schema, then compiled once with sample values.
  const workflows: WorkflowInfo[] = [];
  for (const [path, text] of texts) {
    if (!path.startsWith(`${WORKFLOWS_DIR}/`)) continue;
    const id = workflowIdOf(path);
    if (!id) {
      warnAt(
        fileOf(path),
        'a workflow is workflows/<id>.yaml, with an id of lowercase letters, digits and dashes; this file is not read',
      );
      continue;
    }
    const w = checkWorkflowText(id, text, { file: fileOf(path), strict: opts.strict });
    problems.push(...w.problems);
    workflows.push(w);
  }
  // Triggers (W5 phase 4): each file against its schema; their targets are checked below.
  const triggers: TriggerInfo[] = [];
  for (const [path, text] of texts) {
    if (!path.startsWith(`${TRIGGERS_DIR}/`)) continue;
    const name = triggerNameOf(path);
    if (!name) {
      warnAt(
        fileOf(path),
        'a trigger is triggers/<name>.yaml, with a name of lowercase letters, digits and dashes; this file is not read',
      );
      continue;
    }
    const t = checkTriggerText(name, text, { file: fileOf(path), strict: opts.strict });
    problems.push(...t.problems);
    triggers.push(t);
  }
  problems.push(...triggerTargetProblems(rootDir, triggers, workflows, read.agents, opts));
  // Scorers (W5 phase 4): each file against its schema, then their rubrics and overlaps.
  const scorers: ScorerFileInfo[] = [];
  for (const [path, text] of texts) {
    if (!path.startsWith(`${SCORERS_DIR}/`)) continue;
    const id = scorerIdOf(path);
    if (!id) {
      warnAt(
        fileOf(path),
        'a scorer is scorers/<id>.yaml, with an id of lowercase letters, digits and dashes; this file is not read',
      );
      continue;
    }
    const sc = checkScorerText(id, text, { file: fileOf(path), strict: opts.strict });
    problems.push(...sc.problems);
    scorers.push(sc);
  }
  problems.push(...scorerProblems(rootDir, scorers, workflows));
  // Work types name workflows that exist, and criteria that read.
  if (swarm?.work_types) {
    const swarmFile = fileOf(SWARM_FILE);
    const at = (path: string, severity: DefProblem['severity'], message: string): void => {
      const pos = locate.get(swarmFile)?.(path.split('.')) ?? { line: 1, col: 1 };
      problems.push({ file: swarmFile, path, ...pos, severity, message });
    };
    swarm.work_types.forEach((w, i) => {
      if (w.workflow && !workflows.some((x) => x.id === w.workflow)) {
        at(`work_types.${i}.workflow`, 'warning', `no workflows/${w.workflow}.yaml in this store`);
      }
      if (!w.types?.length && !w.labels?.length) {
        at(`work_types.${i}`, 'warning', 'names no types and no labels, so it matches every task');
      }
      try {
        parseDoneWhen(w.done_when);
      } catch (err) {
        at(`work_types.${i}.done_when`, 'error', (err as Error).message.split('\n')[0] ?? 'bad');
      }
    });
  }
  problems.push(
    ...validateDefinitions({
      root: rootDir,
      swarm,
      agents: read.agents,
      agentValues,
      folderValues,
      shadowed: read.shadowed ?? [],
      texts,
      machineRuntimes: opts.machineRuntimes,
      machineAgents: opts.machineAgents,
      machineMcp: opts.machineMcp,
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
    workflows,
    // A trigger with an error anywhere in its file never fires.
    triggers: triggers.map((t) =>
      t.def && problems.some((p) => p.file === t.file && p.severity === 'error')
        ? { ...t, def: null }
        : t,
    ),
    scorers: scorers.map((sc) =>
      sc.def && problems.some((p) => p.file === sc.file && p.severity === 'error')
        ? { ...sc, def: null }
        : sc,
    ),
  };
}

/**
 * Checks across scorer files: a rubric scorer's rubric exists in the store and reads (errors),
 * one file per built-in scorer (an error on each), and workflows `applies_to` names exist (a
 * warning).
 */
function scorerProblems(
  rootDir: string,
  scorers: readonly ScorerFileInfo[],
  workflows: readonly WorkflowInfo[],
): DefProblem[] {
  const out: DefProblem[] = [];
  const add = (sc: ScorerFileInfo, path: string, severity: DefProblem['severity'], m: string) =>
    out.push({ file: sc.file, path, line: 1, col: 1, severity, message: m });
  const byBuiltin = new Map<string, ScorerFileInfo[]>();
  for (const sc of scorers) {
    const d = sc.def;
    if (!d) continue;
    if (d.kind === 'builtin' && d.scorer) {
      byBuiltin.set(d.scorer, [...(byBuiltin.get(d.scorer) ?? []), sc]);
    }
    if (d.kind === 'rubric' && d.rubric) {
      const file = join(rootDir, 'rubrics', `${d.rubric}.md`);
      if (!existsSync(file)) add(sc, 'rubric', 'error', `no rubrics/${d.rubric}.md in this store`);
      else {
        try {
          parseRubric(readFileSync(file, 'utf8'), `rubrics/${d.rubric}.md`);
        } catch (err) {
          add(sc, 'rubric', 'error', (err as Error).message.split('\n')[0] ?? 'does not read');
        }
      }
    }
    for (const w of d.applies_to?.workflows ?? []) {
      if (!workflows.some((x) => x.id === w)) {
        add(sc, 'applies_to.workflows', 'warning', `no workflows/${w}.yaml in this store`);
      }
    }
  }
  for (const [builtin, files] of byBuiltin) {
    if (files.length < 2) continue;
    for (const sc of files) {
      add(
        sc,
        'scorer',
        'error',
        `${files.length} files set the built-in scorer ${builtin} (${files.map((f) => f.id).join(', ')}); keep one`,
      );
    }
  }
  return out;
}

/**
 * The targets of each trigger exist: a workflow in this store (an error), a repeat in this
 * store's `repeats/` (an error), and an agent this store or the machine defines (a warning: the
 * machine that runs the trigger may define it).
 */
function triggerTargetProblems(
  rootDir: string,
  triggers: readonly TriggerInfo[],
  workflows: readonly WorkflowInfo[],
  agents: readonly AgentDef[],
  opts: LoadOptions,
): DefProblem[] {
  const out: DefProblem[] = [];
  const add = (t: TriggerInfo, path: string, severity: DefProblem['severity'], message: string) =>
    out.push({ file: t.file, path, line: 1, col: 1, severity, message });
  for (const t of triggers) {
    const d = t.def;
    if (!d) continue;
    if (d.action === 'workflow' && d.workflow) {
      const w = workflows.find((x) => x.id === d.workflow);
      if (!w) add(t, 'workflow', 'error', `no workflows/${d.workflow}.yaml in this store`);
      else if (!w.def) add(t, 'workflow', 'error', `workflows/${d.workflow}.yaml has errors`);
    }
    if (
      d.action === 'repeat' &&
      d.repeat &&
      !existsSync(join(rootDir, 'repeats', `${d.repeat}.md`))
    ) {
      add(t, 'repeat', 'error', `no repeats/${d.repeat}.md in this store`);
    }
    if (d.action === 'run' && d.agent) {
      const known = agents.some((a) => a.id === d.agent) || opts.machineAgents?.includes(d.agent);
      if (!known) {
        add(
          t,
          'agent',
          'warning',
          `${d.agent} has no agent file in this store${opts.machineAgents ? " and is not in this machine's swarmupd.agents" : ''}`,
        );
      }
    }
  }
  return out;
}

/**
 * Checks one definition file's text without its store: `swarm.yaml`, an agent file's
 * frontmatter when `kind` is `agent` or the name ends in `.md`, or a workflow when `kind` is
 * `workflow` or the file is a `.yaml` in a `workflows` folder. For loose files and editors; the
 * checks across files need {@link loadDefinitions}.
 */
export function checkDefinitionText(
  file: string,
  text: string,
  opts: { strict?: boolean; kind?: 'swarm' | 'agent' | 'workflow' | 'trigger' | 'scorer' } = {},
): DefProblem[] {
  const src = normalText(text);
  const parts = file.replace(/\\/g, '/').split('/');
  const kind =
    opts.kind ??
    (/\.md$/i.test(file)
      ? 'agent'
      : parts.at(-2) === WORKFLOWS_DIR && /\.ya?ml$/i.test(file)
        ? 'workflow'
        : parts.at(-2) === TRIGGERS_DIR && /\.ya?ml$/i.test(file)
          ? 'trigger'
          : parts.at(-2) === SCORERS_DIR && /\.ya?ml$/i.test(file)
            ? 'scorer'
            : 'swarm');
  const problems: DefProblem[] = [];
  if (kind === 'scorer') {
    const id = (parts.at(-1) ?? '').replace(/\.ya?ml$/i, '');
    problems.push(...checkScorerText(id, src, { file, strict: opts.strict }).problems);
  } else if (kind === 'trigger') {
    const name = (parts.at(-1) ?? '').replace(/\.ya?ml$/i, '');
    problems.push(...checkTriggerText(name, src, { file, strict: opts.strict }).problems);
  } else if (kind === 'workflow') {
    const name = (parts.at(-1) ?? '').replace(/\.ya?ml$/i, '');
    problems.push(...checkWorkflowText(name, src, { file, strict: opts.strict }).problems);
  } else if (kind === 'agent') {
    const yamlText = frontmatter(src);
    if (yamlText !== null) {
      // A file named agent.md is an agent folder's; one inside a folder named after a runtime
      // is an addendum.
      const base = parts.at(-1) ?? '';
      const folder = parts.length > 2 && parts.at(-3) === 'agents';
      const schema =
        base === AGENT_FOLDER_FILE
          ? FOLDER_AGENT_SCHEMA
          : folder && RUNTIME_NAME_RE.test(base.replace(/\.md$/i, ''))
            ? ADDENDUM_SCHEMA
            : AGENT_SCHEMA;
      problems.push(
        ...checkYaml(schema, yamlText, { file, strict: opts.strict, lineOffset: 1 }).problems,
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
