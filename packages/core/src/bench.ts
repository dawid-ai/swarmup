// Benchmark sets (W7, the file format of W5's `benchmarks/<set>.yaml`): real tasks to replay
// against an agent configuration, each with a base to start from and typed `done_when` criteria to
// score the result. This file reads and checks a set; the runner is in the supervisor package.
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import YAML from 'yaml';
import type { Criterion, DoneWhenEntry } from './criteria.js';
import { criteriaOf, parseDoneWhen } from './criteria.js';
import { OpsError } from './ids.js';

/**
 * Where an entry starts. v1 runs `ref` only (a commit, tag or branch of the repo under test);
 * `snapshot` (a fixture folder under `benchmarks/fixtures/`) and `empty` parse, for W5's later
 * runner, and a run refuses them.
 */
export type BenchBase = { ref: string } | { snapshot: string } | { empty: true };

/** An entry's work as a task, the way SwarmUp files one. */
export interface BenchTask {
  type: string;
  title: string;
  body: string;
}

/**
 * A criterion of a benchmark entry. `hidden` marks a `command` criterion whose files the agent
 * never sees: the harness copies the set's hidden folder into the worktree right before the
 * command runs and removes it after.
 */
export interface BenchCriterion extends Criterion {
  hidden?: boolean;
}

/** One entry of a set, with the set's defaults applied. */
export interface BenchEntry {
  id: string;
  base: BenchBase;
  /** Exactly one of `task` and `prompt` is set. */
  task?: BenchTask;
  prompt?: string;
  criteria: BenchCriterion[];
  /** `<runtime>:<role>`, or `none` for a run that changes nothing. */
  agent?: string;
  /** Minutes the agent may run before the harness stops it. */
  budget?: number;
  repeat: number;
}

/** A benchmark set file, checked. */
export interface BenchSet {
  id: string;
  description?: string;
  /** The set file, absolute. */
  file: string;
  /** The hidden files' folder, absolute (from `hidden_dir`, relative to the set file). */
  hiddenDir?: string;
  /** Where hidden files go in the worktree, relative to its top. Default `hidden`. */
  hiddenTo: string;
  defaults: { agent?: string; budget?: number; repeat: number };
  entries: BenchEntry[];
}

/** The placeholder a command criterion may use for the entry's resolved base commit. */
export const BENCH_BASE_TOKEN = '{{base}}';

/** Default folder for hidden files inside an attempt's worktree. */
export const DEFAULT_HIDDEN_TO = 'hidden';

/** Most repeats of one entry: a guard against a typo that would spend tokens for hours. */
export const MAX_REPEAT = 50;

const SET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENTRY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AGENT_RE = /^(none|[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*)$/;

function bad(message: string): never {
  throw new OpsError(message, 2);
}

function isMap(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function text(v: unknown, where: string): string {
  if (typeof v !== 'string' && typeof v !== 'number') bad(`${where} must be text`);
  const s = String(v).trim();
  if (!s) bad(`${where} must not be empty`);
  return s;
}

function unknownKeys(raw: Record<string, unknown>, known: readonly string[], where: string): void {
  const extra = Object.keys(raw).filter((k) => !known.includes(k));
  if (extra.length > 0) bad(`${where}: unknown key ${extra.map((k) => `'${k}'`).join(', ')}`);
}

/** `<runtime>:<role>` or `none`, checked. */
export function checkBenchAgent(v: unknown, where: string): string {
  const s = text(v, where);
  if (!AGENT_RE.test(s))
    bad(`${where}: '${s}' is not <runtime>:<role> (such as claude:engineer) or none`);
  return s;
}

function budget(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 24 * 60) {
    bad(`${where} must be a number of minutes from 0 to 1440`);
  }
  return v;
}

function repeat(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_REPEAT) {
    bad(`${where} must be a whole number from 1 to ${MAX_REPEAT}`);
  }
  return v;
}

function readBase(v: unknown, where: string): BenchBase {
  if (!isMap(v)) bad(`${where} must be a mapping with ref, snapshot or empty`);
  const keys = ['ref', 'snapshot', 'empty'].filter((k) => v[k] !== undefined && v[k] !== null);
  unknownKeys(v, ['ref', 'snapshot', 'empty'], where);
  if (keys.length !== 1) bad(`${where} needs exactly one of ref, snapshot and empty`);
  if (keys[0] === 'ref') return { ref: text(v.ref, `${where}.ref`) };
  if (keys[0] === 'snapshot') return { snapshot: text(v.snapshot, `${where}.snapshot`) };
  if (v.empty !== true) bad(`${where}.empty must be true`);
  return { empty: true };
}

function readTask(v: unknown, where: string): BenchTask {
  if (!isMap(v)) bad(`${where} must be a mapping with type, title and body`);
  unknownKeys(v, ['type', 'title', 'body'], where);
  return {
    type: v.type === undefined ? 'task' : text(v.type, `${where}.type`),
    title: text(v.title, `${where}.title`),
    body: text(v.body, `${where}.body`),
  };
}

/**
 * `done_when` of an entry: {@link parseDoneWhen} for each item, so the checks match a task's, plus
 * the `hidden` flag, which only a `command` criterion may carry.
 */
export function parseBenchCriteria(value: unknown, where: string): BenchCriterion[] {
  const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const entries: DoneWhenEntry[] = [];
  const hidden: boolean[] = [];
  for (const [i, item] of items.entries()) {
    let flag = false;
    let own: unknown = item;
    if (isMap(item) && 'hidden' in item) {
      if (typeof item.hidden !== 'boolean') bad(`${where}[${i}].hidden must be true or false`);
      if (item.hidden && item.kind !== 'command') {
        bad(`${where}[${i}]: only a command criterion can be hidden`);
      }
      flag = item.hidden;
      own = Object.fromEntries(Object.entries(item).filter(([k]) => k !== 'hidden'));
    }
    let parsed: DoneWhenEntry[] | undefined;
    try {
      parsed = parseDoneWhen([own]);
    } catch (err) {
      bad(`${where}[${i}]: ${(err as Error).message.replace(/^done_when entry \d+: /, '')}`);
    }
    for (const e of parsed ?? []) {
      entries.push(e);
      hidden.push(flag);
    }
  }
  if (entries.length === 0) bad(`${where} needs at least one criterion`);
  let criteria: Criterion[];
  try {
    criteria = criteriaOf(entries);
  } catch (err) {
    bad(`${where}: ${(err as Error).message}`);
  }
  return criteria.map((c, i) => (hidden[i] ? { ...c, hidden: true } : c));
}

function readEntry(raw: unknown, i: number, defaults: BenchSet['defaults']): BenchEntry {
  const where = `entries[${i}]`;
  if (!isMap(raw)) bad(`${where} must be a mapping`);
  unknownKeys(
    raw,
    ['id', 'base', 'task', 'prompt', 'done_when', 'agent', 'budget', 'repeat'],
    where,
  );
  const id = text(raw.id, `${where}.id`);
  if (!ENTRY_ID_RE.test(id)) bad(`${where}.id '${id}': letters, digits, '.', '_' or '-'`);
  const at = `entries[${i}] (${id})`;
  const hasTask = raw.task !== undefined && raw.task !== null;
  const hasPrompt = raw.prompt !== undefined && raw.prompt !== null;
  if (hasTask === hasPrompt) bad(`${at} needs exactly one of task and prompt`);
  const entry: BenchEntry = {
    id,
    base: readBase(raw.base, `${at}.base`),
    criteria: parseBenchCriteria(raw.done_when, `${at}.done_when`),
    repeat: raw.repeat === undefined ? defaults.repeat : repeat(raw.repeat, `${at}.repeat`),
  };
  if (hasTask) entry.task = readTask(raw.task, `${at}.task`);
  else entry.prompt = text(raw.prompt, `${at}.prompt`);
  const agent =
    raw.agent === undefined ? defaults.agent : checkBenchAgent(raw.agent, `${at}.agent`);
  if (agent) entry.agent = agent;
  const b = raw.budget === undefined ? defaults.budget : budget(raw.budget, `${at}.budget`);
  if (b !== undefined) entry.budget = b;
  return entry;
}

/**
 * A parsed set document, checked. `file` is the set's path, which `hidden_dir` is relative to.
 * Refuses a bad set with exit 2, naming the key.
 */
export function parseBenchSet(doc: unknown, file: string): BenchSet {
  const abs = resolve(file);
  const fail = (err: unknown): never => bad(`${abs}: ${(err as Error).message}`);
  try {
    if (!isMap(doc)) bad('a benchmark set is a mapping with id and entries');
    unknownKeys(
      doc,
      ['id', 'description', 'hidden_dir', 'hidden_to', 'defaults', 'entries'],
      'set',
    );
    const id = text(doc.id, 'id');
    if (!SET_ID_RE.test(id)) bad(`id '${id}': letters, digits, '.', '_' or '-'`);
    const rawDefaults = doc.defaults ?? {};
    if (!isMap(rawDefaults)) bad('defaults must be a mapping');
    unknownKeys(rawDefaults, ['agent', 'budget', 'repeat'], 'defaults');
    const defaults: BenchSet['defaults'] = {
      repeat: rawDefaults.repeat === undefined ? 1 : repeat(rawDefaults.repeat, 'defaults.repeat'),
    };
    if (rawDefaults.agent !== undefined) {
      defaults.agent = checkBenchAgent(rawDefaults.agent, 'defaults.agent');
    }
    if (rawDefaults.budget !== undefined) {
      defaults.budget = budget(rawDefaults.budget, 'defaults.budget');
    }
    if (!Array.isArray(doc.entries) || doc.entries.length === 0) {
      bad('entries must be a list with at least one entry');
    }
    const entries = doc.entries.map((e, i) => readEntry(e, i, defaults));
    const seen = new Set<string>();
    for (const e of entries) {
      if (seen.has(e.id)) bad(`two entries have the id '${e.id}'`);
      seen.add(e.id);
    }
    const hiddenTo =
      doc.hidden_to === undefined ? DEFAULT_HIDDEN_TO : text(doc.hidden_to, 'hidden_to');
    if (isAbsolute(hiddenTo) || hiddenTo.split(/[\\/]/).some((p) => p === '..' || p === '')) {
      bad(`hidden_to '${hiddenTo}' must be a folder inside the worktree, such as hidden`);
    }
    const set: BenchSet = { id, file: abs, hiddenTo, defaults, entries };
    if (doc.description !== undefined) set.description = text(doc.description, 'description');
    if (doc.hidden_dir !== undefined) {
      set.hiddenDir = resolve(dirname(abs), text(doc.hidden_dir, 'hidden_dir'));
    }
    return set;
  } catch (err) {
    return fail(err);
  }
}

/** Reads and checks a set file. Refuses a missing or bad one with exit 2. */
export function readBenchSet(file: string): BenchSet {
  let src: string;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    bad(`cannot read the benchmark set ${file}`);
  }
  let doc: unknown;
  try {
    doc = parseSetYaml(src.charCodeAt(0) === 0xfeff ? src.slice(1) : src);
  } catch (err) {
    bad(`${resolve(file)} is not valid YAML: ${(err as Error).message.split('\n')[0]}`);
  }
  return parseBenchSet(doc, file);
}

/**
 * A set file's YAML, with every `ref` kept as written. An unquoted commit sha such as
 * `8e1234...` (digits after one `e`) or one of digits only is a number to YAML, which turns it
 * into `Infinity` or a rounded float; the source text is the sha.
 */
export function parseSetYaml(src: string): unknown {
  const doc = YAML.parseDocument(src);
  if (doc.errors.length > 0) throw doc.errors[0];
  YAML.visit(doc, {
    Pair(_key, pair) {
      if (!YAML.isScalar(pair.key) || pair.key.value !== 'ref' || !YAML.isScalar(pair.value)) {
        return;
      }
      const v = pair.value;
      if (typeof v.value !== 'string' && v.source !== undefined) v.value = String(v.source);
    },
  });
  return doc.toJS();
}

/** The prompt an agent gets for an entry: the prompt as written, or the task's title and body. */
export function benchPrompt(entry: Pick<BenchEntry, 'task' | 'prompt'>): string {
  if (entry.prompt !== undefined) return entry.prompt;
  const t = entry.task!;
  return `# ${t.title}\n\n${t.body}`;
}

/** Whether a criterion gets a result from the harness (`command` and `check`, hidden or not). */
export function benchCheckable(c: Pick<Criterion, 'kind'>): boolean {
  return c.kind === 'command' || c.kind === 'check';
}

/** Whether a criterion waits for a judge or a person: prose, rubric and human. */
export function benchJudged(c: Pick<Criterion, 'kind'>): boolean {
  return c.kind === 'prose' || c.kind === 'rubric' || c.kind === 'human';
}
