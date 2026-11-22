import { lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import YAML from 'yaml';
import { mergeValues } from './defs/variants.js';
import { parseDoc, stringifyDoc } from './frontmatter.js';
import { actorSlug, isActorId, isHuman, OpsError, slugToActor } from './ids.js';
import { MILESTONE_TYPE } from './model.js';
import type { Root } from './root.js';

/**
 * Where a folder agent's providers came from (W5): its own `providers`, the role's `providers`
 * in `swarm.yaml`, the runtimes `swarm.yaml` names, or the default providers.
 */
export type ProvidersFrom = 'agent' | 'swarm-role' | 'swarm-runtimes' | 'default';

/** How an agent of an agent folder (`agents/<role>/agent.md`) was put together (W5). */
export interface AgentFolderInfo {
  role: string;
  providersFrom: ProvidersFrom;
  /** The runtime addendum `agents/<role>/<runtime>.md`, when the agent has one. */
  addendum?: string;
  /** How the addendum's body applies: after the role's body, or instead of it. */
  bodyMode?: 'append' | 'replace';
}

/** Frontmatter of `agents/<runtime>-<role>.md`, or one agent of `agents/<role>/agent.md`. */
export interface AgentDef {
  id: string;
  name?: string;
  description?: string;
  status: 'active' | 'paused' | 'proposed';
  /** Task types this role takes from the queue; `*` for any. Empty or missing means any. */
  can_claim?: string[];
  projects?: string[];
  model?: string;
  /** Reasoning effort for the role's runs, such as `medium`; see swarmupd's `effort`. */
  effort?: string;
  budget_min?: number;
  /** Tool permissions for the role, for the phase 2 supervisor's permission profiles. */
  tools?: string[];
  /** MCP server names the role may use. */
  mcp?: string[];
  /** Learn-note topics (`kb/<topic>/`) the agent reads before it works. */
  kb?: string[];
  /** Files or folders the agent reads before it works, relative to the project. */
  files?: string[];
  /** How the agent writes: tone, format, words to use and avoid. */
  style?: string;
  /**
   * Model and effort per runtime; the entry of the agent's runtime wins over `model` and
   * `effort` (W5). See `agentRuntimeValues`.
   */
  runtimes?: Record<string, { model?: string; effort?: string } | null>;
  /** The role, the part of the id after the colon (W5). A folder agent gets its folder's name. */
  role?: string;
  /** A folder agent: the runtimes its folder expands into, in order (W5). */
  providers?: string[];
  /** The role changes files; swarmupd's role limits take it under a machine value (W5). */
  writes?: boolean;
  /** Scorers that judge the agent's work (W4, W5). */
  scorers?: string[];
  /** Set for an agent of an agent folder; `file` is then the folder's `agent.md`. */
  folder?: AgentFolderInfo;
  file: string;
  body: string;
}

/** True for a real folder or file, never a link: links in a synced repo could point anywhere. */
function plain(path: string, kind: 'dir' | 'file'): boolean {
  try {
    const s = lstatSync(path);
    return kind === 'dir' ? s.isDirectory() : s.isFile();
  } catch {
    return false;
  }
}

/** True when anything is at `path`, a dangling link included. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** A role file that `readAgentFiles` skipped, with the reason. */
export interface AgentFileProblem {
  file: string;
  message: string;
}

/** A folder agent that a legacy file of the same id hides (W5). */
export interface ShadowedAgent {
  id: string;
  /** The folder's `agent.md`. */
  file: string;
  /** The legacy file that wins. */
  by: string;
}

/** Role files in one root: the ones that read, and the ones skipped because they did not. */
export interface AgentFiles {
  agents: AgentDef[];
  problems: AgentFileProblem[];
  /** Folder agents a legacy file of the same id hides. */
  shadowed?: ShadowedAgent[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `obj` without `keys`. */
function omit(obj: object, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
}

/** Throws on a role file the queue cannot use: frontmatter that is not a map, or a bad `can_claim`. */
function parseAgentFile(text: string): { data: Partial<AgentDef>; body: string } {
  const doc = parseDoc<unknown>(text);
  if (!isRecord(doc.data)) throw new Error('frontmatter is not a set of `key: value` fields');
  const claim = doc.data.can_claim;
  if (claim !== undefined && claim !== null) {
    if (!Array.isArray(claim) || claim.some((s) => typeof s !== 'string')) {
      throw new Error('can_claim: use a list of task types');
    }
  }
  return { data: doc.data as Partial<AgentDef>, body: doc.body };
}

/** The file name of a folder's role definition: `agents/<role>/agent.md`. */
export const AGENT_FOLDER_FILE = 'agent.md';

/** The providers a folder agent expands into when nothing names any; `DEFAULT_PROVIDERS`. */
const FALLBACK_PROVIDERS: readonly string[] = ['claude', 'codex'];

const ROLE_RE = /^[a-z][a-z0-9-]*$/;
const RUNTIME_RE = /^[a-z][a-z0-9]*$/;

/** The parts of `swarm.yaml` a folder's expansion reads; empty when it is missing or bad. */
function swarmProviders(text: string | undefined): {
  roles: Record<string, string[]>;
  runtimes: string[];
} {
  const out = { roles: {} as Record<string, string[]>, runtimes: [] as string[] };
  if (!text) return out;
  let v: unknown;
  try {
    v = YAML.parse(text);
  } catch {
    return out;
  }
  if (!isRecord(v)) return out;
  if (isRecord(v.roles)) {
    for (const [role, r] of Object.entries(v.roles)) {
      const p = isRecord(r) ? r.providers : undefined;
      if (Array.isArray(p) && p.every((x) => typeof x === 'string')) out.roles[role] = p;
    }
  }
  if (isRecord(v.runtimes)) {
    out.runtimes = Object.keys(v.runtimes).filter((k) => RUNTIME_RE.test(k));
  }
  return out;
}

/**
 * The runtimes a folder agent expands into, and where they came from: its own `providers`, then
 * the role's `providers` in `swarm.yaml`, then the runtimes `swarm.yaml` names, then the
 * default providers.
 */
export function folderProviders(
  own: unknown,
  role: string,
  swarmText: string | undefined,
): { providers: string[]; from: ProvidersFrom } {
  const clean = (list: readonly string[]): string[] =>
    [...new Set(list)].filter((p) => RUNTIME_RE.test(p));
  if (Array.isArray(own) && own.every((p) => typeof p === 'string')) {
    return { providers: clean(own as string[]), from: 'agent' };
  }
  const swarm = swarmProviders(swarmText);
  const byRole = swarm.roles[role];
  if (byRole) return { providers: clean(byRole), from: 'swarm-role' };
  if (swarm.runtimes.length > 0) {
    return { providers: clean(swarm.runtimes), from: 'swarm-runtimes' };
  }
  return { providers: [...FALLBACK_PROVIDERS], from: 'default' };
}

/** The role's body with a runtime addendum's body: after it, or instead of it with `replace`. */
export function joinAgentBodies(base: string, add: string, mode: 'append' | 'replace'): string {
  if (mode === 'replace') return add;
  const a = base.trim();
  const b = add.trim();
  if (!b) return base;
  if (!a) return add;
  return `${a}\n\n${b}\n`;
}

/**
 * The agents among `texts` (path in the store to text): legacy files `agents/<name>.md`, not
 * starting with `_`, and agent folders `agents/<role>/agent.md` with optional runtime addenda
 * `agents/<role>/<runtime>.md` (W5). A folder expands into one agent per provider (see
 * {@link folderProviders}). An addendum overlays the role's frontmatter (maps merge, lists
 * replace, `null` deletes) and adds its body after the role's, or instead of it with
 * `body: replace`. A legacy file wins over a folder for the same id, and the folder's agent is
 * named in `shadowed`. `id` is refused in folder files. A file that does not parse is skipped and
 * named in `problems`, so one hand-edited role file never stops the queue for every other agent.
 * `fileOf` names each agent's file; by default the path under `rootDir`.
 */
export function agentFilesFromTexts(
  rootDir: string,
  texts: ReadonlyMap<string, string>,
  fileOf: (path: string) => string = (path) => join(rootDir, path),
): AgentFiles {
  const out: AgentFiles = { agents: [], problems: [], shadowed: [] };
  const folders = new Map<string, { agent?: string; addenda: Map<string, string> }>();
  const read = (path: string): { data: Partial<AgentDef>; body: string } | null => {
    try {
      return parseAgentFile(texts.get(path) ?? '');
    } catch (err) {
      // YAML errors carry a multi-line code frame; the first line names the problem and place.
      const message = (err as Error).message.split('\n')[0] ?? 'unreadable';
      out.problems.push({ file: fileOf(path), message });
      return null;
    }
  };
  for (const path of [...texts.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const legacy = /^agents\/([^/]+\.md)$/.exec(path);
    if (legacy) {
      const name = legacy[1]!;
      if (name.startsWith('_')) continue;
      const doc = read(path);
      if (!doc) continue;
      const id = doc.data.id ?? slugToActor(name.slice(0, -3));
      if (!isActorId(id)) continue;
      out.agents.push({
        ...doc.data,
        id,
        status: doc.data.status ?? 'active',
        file: fileOf(path),
        body: doc.body,
      });
      continue;
    }
    const nested = /^agents\/([^/]+)\/([^/]+)\.md$/.exec(path);
    if (!nested || nested[1]!.startsWith('_') || nested[2]!.startsWith('_')) continue;
    const f = folders.get(nested[1]!) ?? { addenda: new Map<string, string>() };
    if (`${nested[2]}.md` === AGENT_FOLDER_FILE) f.agent = path;
    else if (RUNTIME_RE.test(nested[2]!)) f.addenda.set(nested[2]!, path);
    folders.set(nested[1]!, f);
  }
  const legacyIds = new Map(out.agents.map((a) => [a.id, a.file] as const));
  const swarmText = texts.get('swarm.yaml');
  for (const [role, f] of folders) {
    if (!f.agent || !ROLE_RE.test(role)) continue;
    const doc = read(f.agent);
    if (!doc) continue;
    if (doc.data.id !== undefined) {
      out.problems.push({
        file: fileOf(f.agent),
        message: `id is refused in an agent folder: the folder agents/${role}/ names the role`,
      });
      continue;
    }
    const { providers, from } = folderProviders(doc.data.providers, role, swarmText);
    const base = omit(doc.data, ['providers', 'role']);
    for (const rt of providers) {
      const id = `${rt}:${role}`;
      if (!isActorId(id)) continue;
      let data: Record<string, unknown> = { ...base };
      let body = doc.body;
      let info: AgentFolderInfo = { role, providersFrom: from };
      const addPath = f.addenda.get(rt);
      if (addPath) {
        const add = read(addPath);
        if (!add) continue;
        if (add.data.id !== undefined) {
          out.problems.push({
            file: fileOf(addPath),
            message: `id is refused in an agent folder: agents/${role}/${rt}.md is ${id}`,
          });
          continue;
        }
        const over = omit(add.data, ['body', 'providers', 'role']);
        const bodyMode = (add.data as { body?: unknown }).body === 'replace' ? 'replace' : 'append';
        data = (mergeValues(data, over) as Record<string, unknown> | undefined) ?? {};
        body = joinAgentBodies(doc.body, add.body, bodyMode);
        info = { ...info, addendum: fileOf(addPath), bodyMode };
      }
      const def: AgentDef = {
        ...(data as Partial<AgentDef>),
        id,
        role,
        providers,
        status: (data.status as AgentDef['status'] | undefined) ?? 'active',
        folder: info,
        file: fileOf(f.agent),
        body,
      };
      const by = legacyIds.get(id);
      if (by) {
        out.shadowed!.push({ id, file: def.file, by });
        continue;
      }
      out.agents.push(def);
    }
  }
  return out;
}

/** The plain files of `agents/` (and `swarm.yaml`) a store reads agents from, by path. */
function agentTexts(rootDir: string): Map<string, string> {
  const texts = new Map<string, string>();
  const add = (rel: string): void => {
    try {
      texts.set(rel, readFileSync(join(rootDir, rel), 'utf8'));
    } catch {
      // Gone between the listing and the read.
    }
  };
  if (plain(join(rootDir, 'swarm.yaml'), 'file')) add('swarm.yaml');
  const dir = join(rootDir, 'agents');
  if (!plain(dir, 'dir')) return texts;
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (name.endsWith('.md') && plain(abs, 'file')) add(`agents/${name}`);
    else if (plain(abs, 'dir')) {
      for (const sub of readdirSync(abs)) {
        if (sub.endsWith('.md') && plain(join(abs, sub), 'file')) add(`agents/${name}/${sub}`);
      }
    }
  }
  return texts;
}

/**
 * Reads the agents of a root: `agents/*.md` and agent folders `agents/<role>/` (W5), as
 * {@link agentFilesFromTexts} reads them.
 */
export function readAgentFiles(rootDir: string): AgentFiles {
  return agentFilesFromTexts(rootDir, agentTexts(rootDir));
}

/**
 * An agent as one role file: its frontmatter with its id, then its body. For a folder agent, the
 * role and its runtime addendum put together, which a run reads instead of the folder (W5).
 */
export function agentText(def: AgentDef): string {
  return stringifyDoc(omit(def, ['file', 'body', 'folder', 'providers', 'role']), def.body);
}

/** One file of an agent folder as the app edits it: its frontmatter fields and its body. */
export interface AgentLayer {
  file: string;
  data: Record<string, unknown>;
  instructions: string;
}

/**
 * The two files of a folder agent (W5): the role's `agent.md`, which every runtime reads, and the
 * runtime addendum when there is one. For the app's role editor, which edits either.
 */
export function readAgentLayers(def: AgentDef): { role: AgentLayer; runtime: AgentLayer | null } {
  const read = (file: string): AgentLayer => {
    let data: Record<string, unknown> = {};
    let body = '';
    try {
      const doc = parseAgentFile(readFileSync(file, 'utf8'));
      data = doc.data as Record<string, unknown>;
      body = doc.body;
    } catch {
      // A file that does not read shows as empty; saving refuses it with the reason.
    }
    return { file, data, instructions: body.trim() };
  };
  return {
    role: read(def.file),
    runtime: def.folder?.addendum ? read(def.folder.addendum) : null,
  };
}

/** True when `file` is inside the `agents/` folder of the store `rootDir`. */
export function inAgentsDir(rootDir: string, file: string): boolean {
  const dir = join(rootDir, 'agents') + sep;
  return file.startsWith(dir) || file.replace(/\\/g, '/').startsWith(dir.replace(/\\/g, '/'));
}

/**
 * Why the role may not run or take work, or null when it is active or has no role file. A
 * proposed role waits for a person to approve it; a paused one for a person to resume it.
 */
export function roleInactive(agent: AgentDef | undefined): string | null {
  if (!agent || agent.status === 'active') return null;
  return `${agent.id} is ${agent.status} in its role file; a person sets status: active to let it work`;
}

/** The role files in a root that read; see `readAgentFiles` for the ones skipped. */
export function readAgents(rootDir: string): AgentDef[] {
  return readAgentFiles(rootDir).agents;
}

/**
 * Roles that only read code and post to SwarmUp: they review and answer, and never take work
 * that changes files (AO-0136). swarmupd gives their runs no `Edit` or `Write` by default.
 */
export const READ_ONLY_ROLES: readonly string[] = [
  'qa',
  'reviewer',
  'pm',
  'orchestrator',
  'improver',
  // The content editor (W8): reviews drafts against the voice, the claims and the channel.
  'editor',
];

/**
 * Read-only roles whose runs may still write in their own scratch folder, and nowhere else: the
 * improver (W6) drafts a definition overlay there before `swarmup defs propose`.
 */
export const SCRATCH_WRITER_ROLES: readonly string[] = ['improver'];

/** Task types a read-only role takes from the queue when its role file sets no `can_claim`. */
export const READ_ONLY_CAN_CLAIM: readonly string[] = ['question'];

/** True when the agent id's role (the part after the colon) is one of `READ_ONLY_ROLES`. */
export function isReadOnlyRole(id: string): boolean {
  return READ_ONLY_ROLES.includes(id.slice(id.indexOf(':') + 1));
}

/**
 * True when the role's `can_claim` list allows the task type. A role with no list takes any type,
 * except a read-only role (`READ_ONLY_ROLES`, named by `id`), which takes only questions: a qa or
 * reviewer run that claims unowned work writes it with nobody to commit it (AO-0136). A milestone
 * goes only to a role whose list names `milestone` (AO-0110, "The milestone"): engineers never
 * claim one, and `*` does not cover it.
 */
export function canClaimType(agent: AgentDef | undefined, type: string, id?: string): boolean {
  if (type === MILESTONE_TYPE) return agent?.can_claim?.includes(MILESTONE_TYPE) ?? false;
  if (!agent?.can_claim || agent.can_claim.length === 0) {
    const who = agent?.id ?? id;
    return who !== undefined && isReadOnlyRole(who) ? READ_ONLY_CAN_CLAIM.includes(type) : true;
  }
  return agent.can_claim.includes('*') || agent.can_claim.includes(type);
}

/**
 * The role group that takes a task of each type when it has no owner (AO-0140). `task` and types
 * not listed here go by the task's labels, then to engineers.
 */
export const ROLE_BY_TYPE: Readonly<Record<string, string>> = {
  bug: 'engineer',
  feature: 'engineer',
  task: 'engineer',
  test: 'qa',
  qa: 'qa',
  review: 'reviewer',
  question: 'pm',
  content: 'writer',
};

/**
 * The role group (`*:<role>`) that owns an ownerless task: from its type when the type names one
 * (`bug`, `test`, `review`), else from its first label that names one (`qa`), else `*:engineer`.
 */
export function roleGroupFor(type: string, labels: readonly string[] = []): string {
  const byType = type !== 'task' ? ROLE_BY_TYPE[type] : undefined;
  const byLabel = labels.map((l) => ROLE_BY_TYPE[l.toLowerCase()]).find(Boolean);
  return `*:${byType ?? byLabel ?? 'engineer'}`;
}

/**
 * Providers swarmupd knows before its config lists its own (`swarmupd.seeded`); the keys of the
 * supervisor's `DEFAULT_RUNTIMES`, which a test keeps equal.
 */
export const DEFAULT_PROVIDERS: readonly string[] = ['claude', 'codex'];

/** Which providers take work owned by `*:<role>` or by nobody: `swarmupd.roles.<role>`. */
export interface GroupProviders {
  /** In order of preference. */
  providers: readonly string[];
  /** False: only the first provider takes it. */
  overflow: boolean;
}

/**
 * True when `agent` may take a task owned by `*:<role>` or by nobody: its runtime is one of the
 * role's providers, and the first one unless overflow is on. swarmupd's wake planner, routing and the
 * owner check share it, so a group a task is given to has an agent swarmupd starts (AO-0140).
 */
export function takesGroupWork(agent: string, lim: GroupProviders): boolean {
  const runtime = agent.slice(0, agent.indexOf(':'));
  if (!lim.providers.includes(runtime)) return false;
  return lim.overflow || runtime === lim.providers[0];
}

/** The parts of a role file a person edits from the app. */
export interface RoleInput {
  id: string;
  name?: string;
  description?: string;
  status?: AgentDef['status'];
  /** The instructions: the role file's body. */
  instructions?: string;
  kb?: string[];
  files?: string[];
  style?: string;
  budget_min?: number;
  can_claim?: string[];
}

const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const STATUSES: AgentDef['status'][] = ['active', 'paused', 'proposed'];

function list(
  v: unknown,
  what: string,
  max: number,
  check?: (s: string) => boolean,
): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
    throw new OpsError(`${what}: use a list of names`, 2);
  }
  if (v.length > max) throw new OpsError(`${what}: at most ${max} entries`, 2);
  const out = [...new Set((v as string[]).map((s) => s.trim()).filter(Boolean))];
  for (const s of out) {
    if (check && !check(s)) throw new OpsError(`${what}: bad entry '${s}'`, 2);
  }
  return out.length > 0 ? out : undefined;
}

function text(v: unknown, what: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new OpsError(`${what}: use text`, 2);
  if (v.length > max) throw new OpsError(`${what}: at most ${max} characters`, 2);
  return v.trim() || undefined;
}

/** A role input after `checkRole`: every field is the right type and size, or left out. */
export interface CheckedRole {
  id: string;
  status?: AgentDef['status'];
  /** Fields to set; `undefined` clears a field the input sent as `null`. */
  set: Record<string, unknown>;
  /** The body, when the input sent instructions. */
  instructions?: string;
}

const FIELDS = ['name', 'description', 'kb', 'files', 'style', 'budget_min', 'can_claim'] as const;

/**
 * Checks a role input from the app before anything reads or writes a file: the id, the status,
 * the budget, and each list and text field with its size. Throws an OpsError (code 2) otherwise.
 */
export function checkRole(input: unknown): CheckedRole {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new OpsError('role: expected an object', 2);
  }
  const i = input as Record<string, unknown>;
  const id = typeof i.id === 'string' ? i.id.trim() : '';
  if (!isActorId(id) || isHuman(id) || id.split(':')[1] === '*') {
    throw new OpsError(`bad role id '${id}': use <runtime>:<role>, such as claude:writer`, 2);
  }
  let status: AgentDef['status'] | undefined;
  if (i.status !== undefined && i.status !== null) {
    if (!STATUSES.includes(i.status as AgentDef['status'])) {
      throw new OpsError(`status: use ${STATUSES.join(', ')}`, 2);
    }
    status = i.status as AgentDef['status'];
  }
  let budget: number | undefined;
  if (i.budget_min !== undefined && i.budget_min !== null) {
    budget = i.budget_min as number;
    if (typeof budget !== 'number' || !Number.isInteger(budget) || budget < 1) {
      throw new OpsError('budget_min: use a whole number of minutes', 2);
    }
  }
  const values: Record<(typeof FIELDS)[number], unknown> = {
    name: text(i.name, 'name', 80),
    description: text(i.description, 'description', 300),
    kb: list(i.kb, 'kb', 20, (s) => TOPIC_RE.test(s)),
    files: list(i.files, 'files', 40, (s) => s.length <= 200 && !s.includes('\0')),
    style: text(i.style, 'style', 4000),
    budget_min: budget,
    can_claim: list(i.can_claim, 'can_claim', 20, (s) => s === '*' || TOPIC_RE.test(s)),
  };
  // Only the fields the input sent change; the rest keep the file's value.
  const set: Record<string, unknown> = {};
  for (const k of FIELDS) if (i[k] !== undefined) set[k] = values[k];
  const instructions =
    i.instructions === undefined ? undefined : (text(i.instructions, 'instructions', 20000) ?? '');
  return { id, status, set, instructions };
}

/**
 * Where {@link writeAgent} writes for an agent of an agent folder (W5): `role` is the folder's
 * `agent.md`, which every runtime of the role reads; `runtime` is the addendum
 * `agents/<role>/<runtime>.md`, which only the agent's runtime reads.
 */
export type RoleScope = 'role' | 'runtime';

/**
 * True when the store's `swarm.yaml` names format `swarmup_defs: 1`: new roles then go to agent
 * folders (W5). Without it, a fleet may still run versions that read only `agents/*.md`.
 */
export function agentFoldersOn(rootDir: string): boolean {
  const file = join(rootDir, 'swarm.yaml');
  if (!plain(file, 'file')) return false;
  try {
    const v = YAML.parse(readFileSync(file, 'utf8')) as unknown;
    return isRecord(v) && v.swarmup_defs === 1;
  } catch {
    return false;
  }
}

/** Frontmatter and body of an agent file that exists, or empty ones; refuses a link. */
function readForWrite(
  file: string,
  label: string,
): { data: Record<string, unknown>; body: string } {
  if (!present(file)) return { data: {}, body: '' };
  if (!plain(file, 'file')) throw new OpsError(`${label} is a link; not changed`, 2);
  try {
    const doc = parseAgentFile(readFileSync(file, 'utf8'));
    return { data: doc.data as Record<string, unknown>, body: doc.body };
  } catch (err) {
    const why = (err as Error).message.split('\n')[0];
    throw new OpsError(`${label} does not parse (${why}); fix it by hand first`, 2);
  }
}

/** Makes `dir` when it is missing; refuses a link. */
function realDir(dir: string, label: string): void {
  if (!present(dir)) mkdirSync(dir);
  if (!plain(dir, 'dir'))
    throw new OpsError(`${label} is a link; role files go in a real folder`, 2);
}

/**
 * Creates or updates the role file of `input.id` in a root. Only the fields in `RoleInput`
 * change; the rest of an existing file's frontmatter (`tools`, `mcp`, `model`, `projects`,
 * `providers`) is kept, so the app can never widen what a role may run. `create` refuses an
 * agent that exists.
 *
 * Where it writes (W5): a legacy agent's own file; for a folder agent, the folder's `agent.md`
 * (`scope: 'role'`, the default) or the runtime addendum (`scope: 'runtime'`, whose body adds to
 * the role's). A new agent whose role has a folder joins it: its runtime is added to the folder's
 * `providers`, and what it sets goes to its addendum. Any other new agent gets a folder when the
 * store's `swarm.yaml` names `swarmup_defs: 1`, else a legacy file `agents/<runtime>-<role>.md`.
 */
export function writeAgent(
  root: Root,
  input: RoleInput | CheckedRole,
  opts: { create?: boolean; scope?: RoleScope } = {},
): AgentDef {
  const role = 'set' in input ? input : checkRole(input);
  const { id } = role;
  const runtime = id.slice(0, id.indexOf(':'));
  const name = id.slice(id.indexOf(':') + 1);
  const dir = join(root.dir, 'agents');
  realDir(dir, 'agents/');
  const existing = readAgentFiles(root.dir).agents.find((a) => a.id === id);
  if (existing && opts.create)
    throw new OpsError(`${id} already has a role file in ${root.name}`, 2);
  const folderDir = join(dir, name);
  const roleFile = join(folderDir, AGENT_FOLDER_FILE);
  const addFile = join(folderDir, `${runtime}.md`);
  const fields = (data: Record<string, unknown>): Record<string, unknown> => ({
    ...data,
    ...role.set,
  });
  const write = (file: string, data: Record<string, unknown>, body: string): void => {
    root.writeAtomic(file, stringifyDoc(data, body));
  };

  if (existing && !existing.folder) {
    // A legacy file, wherever it is and whatever it is named.
    const label = existing.file.slice(dir.length + 1);
    const { data, body } = readForWrite(existing.file, label);
    write(
      existing.file,
      {
        ...fields(data),
        id,
        status: role.status ?? (data.status as AgentDef['status'] | undefined) ?? 'active',
      },
      role.instructions ?? body,
    );
  } else if (existing?.folder && opts.scope === 'runtime') {
    const { data, body } = readForWrite(addFile, `agents/${name}/${runtime}.md`);
    const next = fields(data);
    if (role.status) next.status = role.status;
    write(addFile, next, role.instructions ?? body);
  } else if (existing?.folder) {
    const { data, body } = readForWrite(roleFile, `agents/${name}/${AGENT_FOLDER_FILE}`);
    const next = fields(data);
    if (role.status) next.status = role.status;
    write(roleFile, next, role.instructions ?? body);
  } else if (plain(roleFile, 'file')) {
    // The role has a folder: the new runtime joins it, and its own values go to its addendum.
    const label = `agents/${name}/${AGENT_FOLDER_FILE}`;
    const { data, body } = readForWrite(roleFile, label);
    const swarm = plain(join(root.dir, 'swarm.yaml'), 'file')
      ? readFileSync(join(root.dir, 'swarm.yaml'), 'utf8')
      : undefined;
    const { providers } = folderProviders(data.providers, name, swarm);
    if (!providers.includes(runtime)) {
      write(roleFile, { ...data, providers: [...providers, runtime] }, body);
    }
    const add = readForWrite(addFile, `agents/${name}/${runtime}.md`);
    const next: Record<string, unknown> = { ...add.data };
    for (const [k, v] of Object.entries(role.set)) {
      if (JSON.stringify(v ?? null) !== JSON.stringify(data[k] ?? null)) next[k] = v;
    }
    if (role.status && role.status !== (data.status ?? 'active')) next.status = role.status;
    let addBody = add.body;
    const text = role.instructions?.trim();
    if (text && text !== body.trim()) {
      next.body = 'replace';
      addBody = role.instructions!;
    }
    if (Object.keys(next).length > 0 || addBody.trim()) write(addFile, next, addBody);
  } else if (agentFoldersOn(root.dir)) {
    realDir(folderDir, `agents/${name}/`);
    write(
      roleFile,
      { providers: [runtime], status: role.status ?? 'active', ...role.set },
      role.instructions ?? '',
    );
  } else {
    const file = join(dir, `${actorSlug(id)}.md`);
    const { data, body } = readForWrite(file, `${actorSlug(id)}.md`);
    write(
      file,
      {
        ...fields(data),
        id,
        status: role.status ?? (data.status as AgentDef['status'] | undefined) ?? 'active',
      },
      role.instructions ?? body,
    );
  }
  const def = readAgents(root.dir).find((a) => a.id === id);
  if (!def) throw new OpsError(`could not read ${id} back`, 1);
  return def;
}
