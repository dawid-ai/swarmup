// Typed success criteria (`done_when`) and their results: parsing, folding and the deterministic
// check runner. A plain string stays a `prose` criterion, so tasks filed before the types read as
// before.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import { doneWhenLines, OpsError } from './ids.js';
import type { OpsEvent, TaskMeta } from './model.js';

/**
 * What kind of check a criterion is:
 *
 * - `prose`: free text a reviewer judges by reading the work (every plain string).
 * - `command`: a command swarmupd runs at merge in its worktree; a reviewer never runs it.
 * - `check`: a deterministic built-in check (`CHECK_NAMES`), no model.
 * - `rubric`: a model judges the work against a rubric file (`rubric.ts`, the supervisor's
 *   `judge.ts`): `swarmup criteria judge`, a bench run with `--judge`, or the merge when
 *   `swarmupd.judge.at_merge` is on; otherwise the reviewer gives it a score.
 * - `human`: a person answers this specific question.
 * - `map`: the project map covers the change (`swarmup map check`, where the build has it).
 */
export const CRITERION_KINDS = ['prose', 'command', 'check', 'rubric', 'human', 'map'] as const;
export type CriterionKind = (typeof CRITERION_KINDS)[number];

/** The built-in deterministic checks of a `check` criterion. */
export const CHECK_NAMES = [
  'file-exists',
  'regex',
  'word-count',
  'links-resolve',
  'url-ok',
  'char-count',
  'contains',
  'heading-structure',
  'front-matter',
  'image-alt',
  'image-size',
] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

/** The kinds the merge and `swarmup criteria check` run; a reviewer leaves them alone. */
export const RUN_KINDS: ReadonlySet<CriterionKind> = new Set(['command', 'check']);

/** The kinds a reviewer judges by reading the work. */
export const JUDGED_KINDS: ReadonlySet<CriterionKind> = new Set(['prose', 'rubric', 'human']);

/** One `done_when` entry as written in `task.md`: plain text, or a typed object. */
export type DoneWhenEntry = string | CriterionSpec;

/** A typed `done_when` entry. `id` defaults to `c<position>`, as for plain text. */
export interface CriterionSpec {
  id?: string;
  kind: CriterionKind;
  /** prose: the check. Any other kind: an optional description. */
  text?: string;
  /** command: the command line. */
  run?: string;
  /** check: the built-in check, and its arguments. */
  check?: CheckName;
  args?: Record<string, unknown>;
  /** rubric: the rubric file, and the score that passes (0 to 1). */
  rubric?: string;
  pass?: number;
  /** human: the question a person answers. */
  ask?: string;
  /**
   * `publish`: the criterion holds after the work is published, not at merge. `swarmup published`
   * runs it (with `{url}` in check arguments read as the published URL); the merge and
   * `swarmup criteria check` leave it out.
   */
  when?: CriterionWhen;
}

/** When a criterion is checked: by default at merge; `publish` after `swarmup published`. */
export const CRITERION_WHENS = ['publish'] as const;
export type CriterionWhen = (typeof CRITERION_WHENS)[number];

/** A criterion with its id settled. */
export interface Criterion extends CriterionSpec {
  id: string;
}

export const CRITERION_RESULTS = ['pass', 'fail', 'na'] as const;
export type CriterionResult = (typeof CRITERION_RESULTS)[number];

/** One criterion's result, as a verdict, a check run or a merge records it. */
export interface CriterionVerdict {
  result: CriterionResult;
  score?: number;
  evidence?: string;
  note?: string;
}

/** Results by criterion id. */
export type CriteriaResults = Record<string, CriterionVerdict>;

/** The latest result of one criterion, with the event that recorded it. */
export interface CriterionLast extends CriterionVerdict {
  event: string;
  actor: string;
  at: string;
  /** The type of the event: `verdict`, `criteria-check` or `merge`. */
  type: string;
  /** `judge` when an LLM judge recorded it (a `criteria-check` event's `by`). */
  by?: string;
}

const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

function bad(message: string): never {
  throw new OpsError(message, 2);
}

function textField(raw: Record<string, unknown>, field: string, where: string): string {
  const v = raw[field];
  if (typeof v !== 'string' && typeof v !== 'number') bad(`${where}: ${field} must be text`);
  const s = String(v).trim();
  if (!s) bad(`${where}: ${field} must not be empty`);
  return s;
}

function optionalText(
  raw: Record<string, unknown>,
  field: string,
  where: string,
): string | undefined {
  const v = raw[field];
  if (v === undefined || v === null) return undefined;
  return textField(raw, field, where);
}

/** Required arguments of each built-in check. */
function checkArgs(name: CheckName, args: Record<string, unknown>, where: string): void {
  const need = (field: string): void => {
    const v = args[field];
    const ok =
      (typeof v === 'string' && v.trim() !== '') ||
      (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.trim()));
    if (!ok) bad(`${where}: check ${name} needs args.${field}`);
  };
  const num = (field: string): void => {
    const v = args[field];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
      bad(`${where}: args.${field} must be a number`);
    }
  };
  const bool = (field: string): void => {
    if (args[field] !== undefined && typeof args[field] !== 'boolean') {
      bad(`${where}: args.${field} must be true or false`);
    }
  };
  switch (name) {
    case 'file-exists':
    case 'links-resolve':
      need('path');
      break;
    case 'regex': {
      need('path');
      need('pattern');
      if (args.flags !== undefined && typeof args.flags !== 'string') {
        bad(`${where}: args.flags must be text`);
      }
      if (args.expect !== undefined && typeof args.expect !== 'boolean') {
        bad(`${where}: args.expect must be true or false`);
      }
      try {
        new RegExp(String(args.pattern), typeof args.flags === 'string' ? args.flags : '');
      } catch (err) {
        bad(`${where}: bad pattern: ${(err as Error).message}`);
      }
      break;
    }
    case 'word-count':
      need('path');
      num('min');
      num('max');
      if (args.min === undefined && args.max === undefined) {
        bad(`${where}: check word-count needs args.min or args.max`);
      }
      break;
    case 'url-ok':
      need('url');
      break;
    case 'char-count':
      need('path');
      num('min');
      num('max');
      if (args.min === undefined && args.max === undefined) {
        bad(`${where}: check char-count needs args.min or args.max`);
      }
      if (args.per !== undefined && !['file', 'block', 'line'].includes(String(args.per))) {
        bad(`${where}: args.per must be file, block or line`);
      }
      if (args.separator !== undefined && typeof args.separator !== 'string') {
        bad(`${where}: args.separator must be text`);
      }
      num('urls_as');
      break;
    case 'image-alt':
      need('path');
      break;
    case 'image-size':
      need('path');
      for (const f of ['width', 'height']) {
        const v = args[f];
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
          bad(`${where}: check image-size needs args.${f}, a whole number of pixels`);
        }
      }
      num('max_kb');
      break;
    case 'contains':
      need('path');
      need('text');
      if (args.mode !== undefined && args.mode !== 'all' && args.mode !== 'any') {
        bad(`${where}: args.mode must be all or any`);
      }
      bool('expect');
      bool('case-sensitive');
      break;
    case 'heading-structure':
      need('path');
      if (args.headings !== undefined) need('headings');
      bool('single-h1');
      bool('no-skip');
      break;
    case 'front-matter': {
      need('path');
      if (args.keys !== undefined) need('keys');
      const match = args.match;
      if (match !== undefined) {
        if (!match || typeof match !== 'object' || Array.isArray(match)) {
          bad(`${where}: args.match must map keys to patterns`);
        }
        for (const [k, pattern] of Object.entries(match as Record<string, unknown>)) {
          if (typeof pattern !== 'string') bad(`${where}: args.match.${k} must be a pattern`);
          try {
            new RegExp(pattern);
          } catch (err) {
            bad(`${where}: bad pattern for ${k}: ${(err as Error).message}`);
          }
        }
      }
      if (args.keys === undefined && match === undefined) {
        bad(`${where}: check front-matter needs args.keys or args.match`);
      }
      break;
    }
  }
}

/** One typed entry, checked. Refuses a bad one with exit 2. */
function readSpec(raw: Record<string, unknown>, where: string): CriterionSpec {
  const kind = raw.kind;
  if (typeof kind !== 'string' || !(CRITERION_KINDS as readonly string[]).includes(kind)) {
    bad(`${where}: kind must be one of ${CRITERION_KINDS.join(', ')}`);
  }
  const spec: CriterionSpec = { kind: kind as CriterionKind };
  if (raw.id !== undefined && raw.id !== null) {
    const id = String(raw.id).trim();
    if (!ID_RE.test(id)) {
      bad(`${where}: bad id '${id}': a letter, then letters, digits, '-' or '_', 32 at most`);
    }
    spec.id = id;
  }
  const text = optionalText(raw, 'text', where);
  if (text) spec.text = text;
  if (raw.when !== undefined && raw.when !== null) {
    if (!(CRITERION_WHENS as readonly unknown[]).includes(raw.when)) {
      bad(`${where}: when must be ${CRITERION_WHENS.join(' or ')}`);
    }
    spec.when = raw.when as CriterionWhen;
  }
  switch (spec.kind) {
    case 'prose':
      if (!text) bad(`${where}: a prose criterion needs text`);
      break;
    case 'command':
      spec.run = textField(raw, 'run', where);
      break;
    case 'check': {
      const name = textField(raw, 'check', where);
      if (!(CHECK_NAMES as readonly string[]).includes(name)) {
        bad(`${where}: unknown check '${name}': use ${CHECK_NAMES.join(', ')}`);
      }
      spec.check = name as CheckName;
      const args = raw.args ?? {};
      if (typeof args !== 'object' || Array.isArray(args)) bad(`${where}: args must be a mapping`);
      checkArgs(spec.check, args as Record<string, unknown>, where);
      spec.args = args as Record<string, unknown>;
      break;
    }
    case 'rubric': {
      spec.rubric = textField(raw, 'rubric', where);
      if (raw.pass !== undefined) {
        const pass = raw.pass;
        if (typeof pass !== 'number' || pass < 0 || pass > 1) {
          bad(`${where}: pass must be a number from 0 to 1`);
        }
        spec.pass = pass;
      }
      break;
    }
    case 'human':
      spec.ask = textField(raw, 'ask', where);
      break;
    case 'map':
      break;
  }
  return spec;
}

/**
 * `done_when` as written, checked: text (one check per line, list markers dropped, as
 * {@link doneWhenLines} reads it) and typed objects, in order. Undefined when nothing is left.
 * Refuses a bad object, or two criteria with one id, with exit 2.
 */
export function parseDoneWhen(value: unknown): DoneWhenEntry[] | undefined {
  const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const out: DoneWhenEntry[] = [];
  for (const item of items) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      out.push(readSpec(item as Record<string, unknown>, `done_when entry ${out.length + 1}`));
    } else if (item !== undefined && item !== null) {
      out.push(...(doneWhenLines(String(item)) ?? []));
    }
  }
  if (out.length === 0) return undefined;
  criteriaOf(out);
  return out;
}

/**
 * {@link parseDoneWhen} for a `task.md` someone may have edited by hand: an entry that does not
 * parse is kept as prose text, so a read never fails on it.
 */
export function readDoneWhen(value: unknown): DoneWhenEntry[] | undefined {
  try {
    return parseDoneWhen(value);
  } catch {
    const items = Array.isArray(value) ? value : [value];
    const out = items.flatMap((item, i): DoneWhenEntry[] => {
      if (item && typeof item === 'object') {
        try {
          return [readSpec(item as Record<string, unknown>, `done_when entry ${i + 1}`)];
        } catch {
          return [JSON.stringify(item)];
        }
      }
      return item === undefined || item === null ? [] : (doneWhenLines(String(item)) ?? []);
    });
    return out.length > 0 ? out : undefined;
  }
}

/**
 * The criteria of a `done_when` list, ids settled: a plain string is `prose` with id `c<n>`, its
 * 1-based position; a typed entry without an id gets the same. Refuses two criteria with one id
 * with exit 2.
 */
export function criteriaOf(entries: readonly DoneWhenEntry[] | undefined): Criterion[] {
  const seen = new Set<string>();
  return (entries ?? []).map((e, i) => {
    const c: Criterion =
      typeof e === 'string'
        ? { id: `c${i + 1}`, kind: 'prose', text: e }
        : { ...e, id: e.id ?? `c${i + 1}` };
    if (seen.has(c.id)) bad(`two done_when criteria have the id '${c.id}': give each its own id`);
    seen.add(c.id);
    return c;
  });
}

/** What a criterion checks, in one line, for a table or a prompt. */
export function criterionWhat(c: CriterionSpec | string): string {
  if (typeof c === 'string') return c;
  const what = kindWhat(c);
  return c.when === 'publish' ? `${what} (after publish)` : what;
}

function kindWhat(c: CriterionSpec): string {
  const own = (s: string): string => (c.text ? `${c.text} (${s})` : s);
  switch (c.kind) {
    case 'prose':
      return c.text ?? '';
    case 'command':
      return own(`\`${c.run ?? ''}\``);
    case 'check': {
      const args = Object.entries(c.args ?? {})
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ');
      return own(`${c.check ?? ''}${args ? ` ${args}` : ''}`);
    }
    case 'rubric':
      return own(`${c.rubric ?? ''}${c.pass !== undefined ? `, passes at ${c.pass}` : ''}`);
    case 'human':
      return own(c.ask ?? '');
    case 'map':
      return c.text ?? 'the project map covers the change';
  }
}

/** Whether a list holds a criterion that is not prose: something checkable beyond reading. */
export function hasCheckable(entries: readonly DoneWhenEntry[] | undefined): boolean {
  return (entries ?? []).some((e) => typeof e !== 'string' && e.kind !== 'prose');
}

/**
 * Default criteria and a hint per task type, for `swarmup new`. No type gets a criterion forced
 * on it today: a team adds its own. The hint names a checkable criterion that fits the type.
 */
export const TYPE_CRITERIA: Readonly<
  Record<string, { defaults: readonly DoneWhenEntry[]; hint: string }>
> = {
  task: { defaults: [], hint: 'a `command` criterion, such as the tests of the files it changes' },
  bug: { defaults: [], hint: 'a `command` criterion that reproduces the bug and now passes' },
  feature: { defaults: [], hint: 'a `command` criterion, such as the tests of the feature' },
  docs: { defaults: [], hint: 'a `check` criterion, such as links-resolve or word-count' },
  content: {
    defaults: [],
    hint: 'a `check` criterion, such as char-count, contains or front-matter, or a `rubric`',
  },
  publish: {
    defaults: [],
    hint: 'a `check` criterion with `when: publish`, such as url-ok on {url}',
  },
};

/** The hint for a type, or a general one. */
export function criteriaHint(type: string): string {
  return (
    TYPE_CRITERIA[type]?.hint ??
    'a `command`, `check`, `rubric`, `human` or `map` criterion that someone can verify'
  );
}

/** The current `done_when` of a task: its `task.md`, or the latest `criteria` event's list. */
export function currentDoneWhen(
  meta: Pick<TaskMeta, 'done_when'>,
  events: readonly OpsEvent[],
): DoneWhenEntry[] | undefined {
  let current = meta.done_when;
  for (const e of events) {
    if (e.type === 'criteria' && Array.isArray(e.done_when)) current = readDoneWhen(e.done_when);
  }
  return current;
}

/**
 * The criteria of a task and the latest result of each, from `task.md` and its events in id
 * order. A `criteria` event replaces the list and drops the results of criteria it removes or
 * changes. Results come from `verdict`, `criteria-check` and `merge` events. Undefined for a task
 * with no criteria and no results.
 */
export function foldCriteria(
  meta: Pick<TaskMeta, 'done_when'>,
  sorted: readonly OpsEvent[],
): { criteria: Criterion[]; results: Record<string, CriterionLast> } | undefined {
  let criteria = safeCriteria(meta.done_when);
  const results: Record<string, CriterionLast> = {};
  for (const e of sorted) {
    if (e.type === 'criteria' && Array.isArray(e.done_when)) {
      const next = safeCriteria(readDoneWhen(e.done_when));
      const was = new Map(criteria.map((c) => [c.id, JSON.stringify(c)] as const));
      for (const id of Object.keys(results)) {
        const now = next.find((c) => c.id === id);
        if (!now || was.get(id) !== JSON.stringify(now)) delete results[id];
      }
      criteria = next;
      continue;
    }
    if (!e.criteria || typeof e.criteria !== 'object') continue;
    if (e.type !== 'verdict' && e.type !== 'criteria-check' && e.type !== 'merge') continue;
    for (const [id, r] of Object.entries(e.criteria)) {
      if (!r || !(CRITERION_RESULTS as readonly string[]).includes(r.result)) continue;
      results[id] = {
        ...r,
        event: e.id,
        actor: e.actor,
        at: e.at,
        type: e.type,
        ...(e.by ? { by: e.by } : {}),
      };
    }
  }
  if (criteria.length === 0 && Object.keys(results).length === 0) return undefined;
  return { criteria, results };
}

/** {@link criteriaOf} that never throws: a hand-edited duplicate id gets a position id instead. */
function safeCriteria(entries: readonly DoneWhenEntry[] | undefined): Criterion[] {
  try {
    return criteriaOf(entries);
  } catch {
    return (entries ?? []).map((e, i) =>
      typeof e === 'string'
        ? { id: `c${i + 1}`, kind: 'prose', text: e }
        : { ...e, id: `c${i + 1}` },
    );
  }
}

/**
 * Reads a criteria results document (YAML or JSON, already parsed): a mapping of id to a result
 * word (`pass`) or to `{ result, score?, evidence?, note? }`; an outer `criteria:` key is
 * allowed. Refuses anything else with exit 2.
 */
export function parseCriteriaResults(data: unknown): CriteriaResults {
  let map = data;
  if (map && typeof map === 'object' && !Array.isArray(map) && 'criteria' in map) {
    map = (map as { criteria: unknown }).criteria;
  }
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    bad('criteria: expected a mapping of criterion id to pass, fail or na');
  }
  const out: CriteriaResults = {};
  for (const [id, raw] of Object.entries(map as Record<string, unknown>)) {
    const r: Record<string, unknown> =
      typeof raw === 'string'
        ? { result: raw }
        : raw && typeof raw === 'object'
          ? (raw as Record<string, unknown>)
          : {};
    const result = typeof r.result === 'string' ? r.result.trim().toLowerCase() : '';
    if (!(CRITERION_RESULTS as readonly string[]).includes(result)) {
      bad(`criteria.${id}: result must be pass, fail or na`);
    }
    const v: CriterionVerdict = { result: result as CriterionResult };
    if (r.score !== undefined && r.score !== null) {
      if (typeof r.score !== 'number' || !Number.isFinite(r.score)) {
        bad(`criteria.${id}: score must be a number`);
      }
      v.score = r.score;
    }
    for (const field of ['evidence', 'note'] as const) {
      const t = r[field];
      if (t === undefined || t === null) continue;
      if (typeof t !== 'string') bad(`criteria.${id}: ${field} must be text`);
      if (t.trim()) v[field] = t.trim();
    }
    out[id] = v;
  }
  return out;
}

/** Text a person wrote as YAML or JSON, parsed. Refuses text that does not parse with exit 2. */
export function parseCriteriaText(text: string, what: string): unknown {
  try {
    return YAML.parse(text);
  } catch (err) {
    bad(`${what} is not valid YAML or JSON: ${(err as Error).message.split('\n')[0]}`);
  }
}

/**
 * One `--done-when` or `--add` value: a typed criterion when it is a YAML mapping in braces
 * (`{id: tests, kind: command, run: pnpm test}`) or a block mapping over several lines whose
 * keys include `kind`, else the text as given. Without the block form, a script that passed
 * block YAML got one prose criterion per line.
 */
export function doneWhenArg(value: string): unknown {
  const text = value.trim();
  if (text.startsWith('{')) return parseCriteriaText(value, 'the criterion');
  if (text.includes('\n') && /^kind\s*:/m.test(text)) {
    return parseCriteriaText(value, 'the criterion');
  }
  return value;
}

/**
 * Checks results against a task's criteria: every id must name one. Returns the ids marked
 * `fail`. Refuses an unknown id with exit 2.
 */
export function checkResultIds(criteria: readonly Criterion[], results: CriteriaResults): string[] {
  const ids = new Set(criteria.map((c) => c.id));
  for (const id of Object.keys(results)) {
    if (!ids.has(id)) {
      const known = criteria.length > 0 ? criteria.map((c) => c.id).join(', ') : 'none';
      bad(`no criterion '${id}' on this task (its criteria: ${known})`);
    }
  }
  return Object.entries(results)
    .filter(([, r]) => r.result === 'fail')
    .map(([id]) => id);
}

// ---- The check runner ---------------------------------------------------------------------------

/** What a command criterion's run reports. */
export interface CommandOutcome {
  ok: boolean;
  /** The end of what it printed. */
  output: string;
  /** Why it failed, such as `exit 1` or `timed out`. */
  why?: string;
}

export interface CheckDeps {
  /** The folder the checks read and the commands run in. */
  cwd: string;
  /** The HTTP status of a GET of `url`; throws when it cannot connect or times out. */
  fetchStatus?: (url: string, timeoutMs: number) => Promise<number>;
  /** Runs one command criterion. Default: a shell in `cwd`, 10 minutes at most. */
  runCommand?: (command: string, cwd: string) => Promise<CommandOutcome>;
  /** Runs a `map` criterion; without one, a map criterion is `na`. */
  mapCheck?: (c: Criterion) => Promise<CriterionVerdict>;
  /**
   * `publish`: run only the criteria with `when: publish`, as `swarmup published` does. Default:
   * only the others, as the merge and `swarmup criteria check` do.
   */
  phase?: 'merge' | 'publish';
  /** The published URL, which `{url}` in a check's arguments stands for in the publish phase. */
  url?: string;
}

/** How long `url-ok` waits for an answer. */
export const URL_TIMEOUT_MS = 10_000;
/** How long a command criterion may run under the default runner. */
export const COMMAND_TIMEOUT_MS = 10 * 60_000;
/** How much of a command's output a result keeps as evidence. */
const EVIDENCE_LEN = 1500;

/** A GET of `url`, its status; redirects are not followed, so a 3xx counts as itself. */
export async function defaultFetchStatus(url: string, timeoutMs: number): Promise<number> {
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  await res.body?.cancel().catch(() => undefined);
  return res.status;
}

/** Runs `command` in a shell, without a window, and keeps the end of its output. */
export function defaultRunCommand(
  command: string,
  cwd: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<CommandOutcome> {
  return new Promise((done) => {
    let out = '';
    const keep = (chunk: Buffer): void => {
      out = (out + chunk.toString('utf8')).slice(-EVIDENCE_LEN * 4);
    };
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ ok: false, output: out, why: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) done({ ok: false, output: out, why: 'timed out' });
      else done({ ok: code === 0, output: out, ...(code === 0 ? {} : { why: `exit ${code}` }) });
    });
  });
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : [];
}

function tail(text: string): string {
  const t = text.trim();
  return t.length > EVIDENCE_LEN ? `…${t.slice(-EVIDENCE_LEN)}` : t;
}

function readFile(cwd: string, path: string): string {
  return readFileSync(resolve(cwd, path), 'utf8');
}

/** The YAML front matter of a Markdown file is not prose: word counts skip it. */
function withoutFrontMatter(text: string): string {
  const src = text.replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) return src;
  const end = src.indexOf('\n---', 4);
  return end < 0 ? src : src.slice(src.indexOf('\n', end + 4) + 1);
}

/** The link targets of a Markdown or HTML file: `[x](t)`, `![x](t)`, `<a href>`, `src`. */
export function linkTargets(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g)) {
    out.push(m[1]!);
  }
  for (const m of text.matchAll(/^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm)) out.push(m[1]!);
  for (const m of text.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) out.push(m[1]!);
  return out;
}

const URL_RE = /^https?:\/\//i;
/** Targets that are no file and no web page to check: anchors, mail, data and the like. */
const SKIP_RE = /^(?:#|mailto:|tel:|data:|javascript:|\/\/)/i;

async function urlOk(url: string, deps: CheckDeps): Promise<string | null> {
  const fetchStatus = deps.fetchStatus ?? defaultFetchStatus;
  try {
    const status = await fetchStatus(url, URL_TIMEOUT_MS);
    return status >= 200 && status < 400 ? null : `${url} answered ${status}`;
  } catch (err) {
    return `${url}: ${(err as Error).message || 'no answer'}`;
  }
}

/** `{url}` in a criterion's check arguments, read as the published URL. */
function withUrl(c: Criterion, url: string): Criterion {
  if (!c.args) return c;
  const fill = (v: unknown): unknown =>
    typeof v === 'string' ? v.replaceAll('{url}', url) : Array.isArray(v) ? v.map(fill) : v;
  return {
    ...c,
    args: Object.fromEntries(Object.entries(c.args).map(([k, v]) => [k, fill(v)])),
  };
}

/** Folders a path glob never walks into. */
const GLOB_SKIP = new Set(['.git', 'node_modules']);
/** The most files a glob walk reads, so a glob over a huge folder stays fast. */
const GLOB_LIMIT = 20_000;

/** True when a path pattern holds a glob character. */
function isGlob(pattern: string): boolean {
  return /[*?[]/.test(pattern);
}

/**
 * A path glob as a regular expression over `/`-separated paths from the check's folder: `*` and
 * `?` stay inside one segment, `**` crosses folders, and `[...]` is a character class.
 */
export function globRegExp(pattern: string): RegExp {
  const src = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '*' && src[i + 1] === '*') {
      i++;
      if (src[i + 1] === '/') {
        i++;
        re += '(?:[^/]*/)*';
      } else re += '.*';
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else if (ch === '[') {
      const close = src.indexOf(']', i + 1);
      if (close < 0) re += '\\[';
      else {
        re += `[${src
          .slice(i + 1, close)
          .replace(/^!/, '^')
          .replace(/\\/g, '\\\\')}]`;
        i = close;
      }
    } else re += ch.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** The files under `cwd`, as `/`-separated paths from it, bounded by `GLOB_LIMIT`. */
function walkFiles(cwd: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (out.length >= GLOB_LIMIT) return;
      if (GLOB_SKIP.has(name)) continue;
      const abs = join(dir, name);
      const path = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs, path);
      else if (st.isFile()) out.push(path);
    }
  };
  walk(cwd, '');
  return out;
}

/**
 * The files a check's `path` names: each plain path as given, and every file each glob matches.
 * `unmatched` holds the globs that match no file, which fail the check.
 */
export function expandPaths(cwd: string, spec: unknown): { paths: string[]; unmatched: string[] } {
  const paths: string[] = [];
  const unmatched: string[] = [];
  let files: string[] | undefined;
  for (const p of strings(spec)) {
    if (!isGlob(p)) {
      paths.push(p);
      continue;
    }
    files ??= walkFiles(cwd);
    const re = globRegExp(p);
    const hits = files.filter((f) => re.test(f));
    if (hits.length === 0) unmatched.push(p);
    paths.push(...hits);
  }
  return { paths: [...new Set(paths)], unmatched };
}

/** One file's outcome of a check: whether it holds, and what was seen. */
interface FileOutcome {
  ok: boolean;
  what: string;
}

/** Counts code points, so an emoji or an accented letter is one character, as people count. */
function codePoints(text: string): number {
  return [...text].length;
}

/** An http(s) URL in text, without the punctuation that ends a sentence after it. */
const TEXT_URL_RE = /\bhttps?:\/\/[^\s<>"]*[^\s<>".,;:!?)\]'*_]/gi;

/**
 * The characters of `text`, with each http(s) URL counted as `urlsAs` when set: X counts every
 * link as 23, however long it is.
 */
export function countChars(text: string, urlsAs?: number): number {
  if (urlsAs === undefined) return codePoints(text);
  let urls = 0;
  const rest = text.replace(TEXT_URL_RE, () => {
    urls++;
    return '';
  });
  return codePoints(rest) + urls * urlsAs;
}

/** The text outside fenced code blocks, with each code line blanked so line numbers stay. */
function withoutFences(text: string): string {
  let fence: string | null = null;
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (f) {
        if (!fence) fence = f[1]![0]!;
        else if (f[1]![0] === fence) fence = null;
        return '';
      }
      return fence ? '' : line;
    })
    .join('\n');
}

/** An image of a Markdown or HTML file: its alt text (null when it has none) and its line. */
export interface ImageRef {
  src: string;
  alt: string | null;
  line: number;
}

/**
 * The images of a Markdown or HTML file, outside fenced code: `![alt](src)`, `![alt][ref]` and
 * `<img>`.
 */
export function imageRefs(text: string): ImageRef[] {
  const src = withoutFences(text);
  const lineAt = (i: number): number => src.slice(0, i).split('\n').length;
  const out: ImageRef[] = [];
  for (const m of src.matchAll(/!\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+["'][^)]*["'])?\s*\)/g)) {
    out.push({ src: m[2]!, alt: m[1]!, line: lineAt(m.index) });
  }
  for (const m of src.matchAll(/!\[([^\]]*)\]\[([^\]]*)\]/g)) {
    out.push({ src: m[2] || m[1]!, alt: m[1]!, line: lineAt(m.index) });
  }
  for (const m of src.matchAll(/<img\b([^>]*)>/gi)) {
    const attrs = m[1]!;
    const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
    const at = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
    out.push({
      src: at ? (at[1] ?? at[2] ?? at[3] ?? '') : '',
      alt: alt ? (alt[1] ?? alt[2] ?? alt[3] ?? '') : null,
      line: lineAt(m.index),
    });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** The pixel size of a PNG or JPEG, read from its header; null for any other file. */
export function imageDimensions(
  buf: Buffer,
): { type: 'png' | 'jpeg'; width: number; height: number } | null {
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    buf.length >= 24 &&
    PNG.every((b, i) => buf[i] === b) &&
    buf.toString('latin1', 12, 16) === 'IHDR'
  ) {
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1]!;
    // A fill byte, or a marker that carries no length.
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    // A start of frame: every SOFn but DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (i + 9 > buf.length) return null;
      return { type: 'jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/**
 * The parts `char-count` measures: the whole text, each non-empty line, or each block. Blocks
 * are split at lines that equal `separator` (trimmed), else at blank lines.
 */
export function textParts(text: string, per: string, separator?: string): string[] {
  const body = text.replace(/\r\n/g, '\n');
  if (per === 'line')
    return body
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  if (per !== 'block') return [body.trim()];
  const parts: string[] = [];
  let cur: string[] = [];
  const flush = (): void => {
    const t = cur.join('\n').trim();
    if (t) parts.push(t);
    cur = [];
  };
  for (const line of body.split('\n')) {
    const at = separator !== undefined ? line.trim() === separator.trim() : line.trim() === '';
    if (at) flush();
    else cur.push(line);
  }
  flush();
  return parts;
}

/** An ATX heading of a Markdown file, outside fenced code. */
export interface Heading {
  level: number;
  text: string;
  line: number;
}

export function markdownHeadings(text: string): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .forEach((line, i) => {
      const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (f) {
        if (!fence) fence = f[1]![0]!;
        else if (f[1]![0] === fence) fence = null;
        return;
      }
      if (fence) return;
      const m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (m) out.push({ level: m[1]!.length, text: m[2]!.trim(), line: i + 1 });
    });
  return out;
}

/** The YAML front matter of a Markdown file: the mapping, or why there is none. */
function frontMatterOf(text: string): { data: Record<string, unknown> } | { why: string } {
  const src = text.replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) return { why: 'no front matter' };
  const end = src.indexOf('\n---', 3);
  if (end < 0) return { why: 'front matter is not closed with ---' };
  let data: unknown;
  try {
    data = YAML.parse(src.slice(4, end));
  } catch (err) {
    return { why: `front matter is not YAML: ${(err as Error).message.split('\n')[0]}` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { why: 'front matter is not a set of `key: value` fields' };
  }
  return { data: data as Record<string, unknown> };
}

/** A front matter value as text a pattern reads: text as is, anything else as JSON. */
function valueText(v: unknown): string {
  return typeof v === 'string'
    ? v
    : typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : JSON.stringify(v);
}

/** Runs one built-in check on one file at `path`. */
async function checkFile(c: Criterion, path: string, deps: CheckDeps): Promise<FileOutcome> {
  const args = c.args ?? {};
  const cwd = deps.cwd;
  switch (c.check) {
    case 'regex': {
      const re = new RegExp(String(args.pattern), typeof args.flags === 'string' ? args.flags : '');
      const expect = args.expect !== false;
      const found = re.test(readFile(cwd, path));
      return {
        ok: found === expect,
        what: `/${String(args.pattern)}/ ${found ? 'matches' : 'does not match'} ${path}`,
      };
    }
    case 'word-count': {
      const n = withoutFrontMatter(readFile(cwd, path)).split(/\s+/).filter(Boolean).length;
      const min = typeof args.min === 'number' ? args.min : undefined;
      const max = typeof args.max === 'number' ? args.max : undefined;
      return {
        ok: !((min !== undefined && n < min) || (max !== undefined && n > max)),
        what: `${path} has ${n} words; wants ${rangeText(min, max)}`,
      };
    }
    case 'char-count': {
      const per = typeof args.per === 'string' ? args.per : 'file';
      const sep = typeof args.separator === 'string' ? args.separator : undefined;
      const min = typeof args.min === 'number' ? args.min : undefined;
      const max = typeof args.max === 'number' ? args.max : undefined;
      const urlsAs = typeof args.urls_as === 'number' ? args.urls_as : undefined;
      const parts = textParts(withoutFrontMatter(readFile(cwd, path)), per, sep);
      const counts = parts.map((p) => countChars(p, urlsAs));
      const off = counts
        .map((n, i) => ({ n, i }))
        .filter(({ n }) => (min !== undefined && n < min) || (max !== undefined && n > max));
      const wants = `wants ${rangeText(min, max)} characters`;
      if (per === 'file') {
        return { ok: off.length === 0, what: `${path} has ${counts[0] ?? 0} characters; ${wants}` };
      }
      const unit = per === 'line' ? 'line' : 'block';
      const longest = counts.length > 0 ? Math.max(...counts) : 0;
      if (off.length === 0) {
        return {
          ok: true,
          what: `${path}: ${counts.length} ${unit}s, the longest ${longest} characters; ${wants}`,
        };
      }
      const list = off
        .slice(0, 10)
        .map(({ n, i }) => `${unit} ${i + 1} has ${n}`)
        .join(', ');
      const more = off.length > 10 ? ` and ${off.length - 10} more` : '';
      return {
        ok: false,
        what: `${path}: ${off.length} of ${counts.length} ${unit}s out of range (${list}${more}); ${wants}`,
      };
    }
    case 'contains': {
      const sensitive = args['case-sensitive'] === true;
      const norm = (t: string): string => (sensitive ? t : t.toLowerCase());
      const text = norm(withoutFrontMatter(readFile(cwd, path)));
      const wanted = strings(args.text);
      const found = wanted.filter((w) => text.includes(norm(w)));
      const missing = wanted.filter((w) => !found.includes(w));
      const quote = (l: string[]): string => l.map((w) => `"${w}"`).join(', ');
      if (args.expect === false) {
        return found.length === 0
          ? { ok: true, what: `${path} has none of ${quote(wanted)}` }
          : { ok: false, what: `${path} has ${quote(found)}` };
      }
      const any = args.mode === 'any';
      const ok = any ? found.length > 0 : missing.length === 0;
      return ok
        ? { ok, what: `${path} has ${quote(found)}` }
        : {
            ok,
            what: any ? `${path} has none of ${quote(wanted)}` : `${path} lacks ${quote(missing)}`,
          };
    }
    case 'heading-structure': {
      const heads = markdownHeadings(withoutFrontMatter(readFile(cwd, path)));
      const problems: string[] = [];
      if (args['single-h1'] !== false) {
        const h1 = heads.filter((h) => h.level === 1).length;
        if (h1 !== 1) problems.push(`${h1} level-1 headings, wants exactly 1`);
      }
      if (args['no-skip'] !== false) {
        for (let i = 1; i < heads.length; i++) {
          const prev = heads[i - 1]!;
          const h = heads[i]!;
          if (h.level > prev.level + 1) {
            problems.push(`line ${h.line} "${h.text}" skips from h${prev.level} to h${h.level}`);
          }
        }
      }
      let at = 0;
      for (const want of strings(args.headings)) {
        const m = /^(#{1,6})\s+(.*)$/.exec(want.trim());
        const level = m ? m[1]!.length : undefined;
        const text = (m ? m[2]! : want).trim().toLowerCase();
        const idx = heads.findIndex(
          (h, i) =>
            i >= at && h.text.toLowerCase() === text && (level === undefined || h.level === level),
        );
        if (idx < 0) problems.push(`no heading "${want.trim()}" in order`);
        else at = idx + 1;
      }
      return problems.length > 0
        ? { ok: false, what: `${path}: ${problems.join('; ')}` }
        : { ok: true, what: `${path}: ${heads.length} headings in order` };
    }
    case 'front-matter': {
      const fm = frontMatterOf(readFile(cwd, path));
      if ('why' in fm) return { ok: false, what: `${path}: ${fm.why}` };
      const problems: string[] = [];
      for (const k of strings(args.keys)) {
        const v = fm.data[k];
        if (v === undefined || v === null || v === '') problems.push(`no ${k}`);
      }
      const match = (args.match ?? {}) as Record<string, string>;
      for (const [k, pattern] of Object.entries(match)) {
        const v = fm.data[k];
        if (v === undefined || v === null) {
          if (!problems.includes(`no ${k}`)) problems.push(`no ${k}`);
          continue;
        }
        const re = new RegExp(pattern);
        const values = Array.isArray(v) ? v : [v];
        const badOne = values.find((x) => !re.test(valueText(x)));
        if (badOne !== undefined)
          problems.push(`${k} "${valueText(badOne)}" does not match /${pattern}/`);
      }
      return problems.length > 0
        ? { ok: false, what: `${path}: ${problems.join('; ')}` }
        : { ok: true, what: `${path}: front matter holds` };
    }
    case 'image-alt': {
      const images = imageRefs(readFile(cwd, path));
      const bare = images.filter((im) => !im.alt?.trim());
      if (bare.length === 0) {
        return { ok: true, what: `${path}: ${images.length} images, each with alt text` };
      }
      const list = bare
        .slice(0, 10)
        .map((im) => `line ${im.line} ${im.src || '(no src)'}`)
        .join(', ');
      const more = bare.length > 10 ? ` and ${bare.length - 10} more` : '';
      return {
        ok: false,
        what: `${path}: ${bare.length} of ${images.length} images have no alt text (${list}${more})`,
      };
    }
    case 'image-size': {
      const buf = readFileSync(resolve(cwd, path));
      const dim = imageDimensions(buf);
      if (!dim) return { ok: false, what: `${path}: not a PNG or JPEG` };
      const problems: string[] = [];
      if (dim.width !== args.width || dim.height !== args.height) {
        problems.push(
          `${dim.width}x${dim.height}, wants ${String(args.width)}x${String(args.height)}`,
        );
      }
      const kb = Math.ceil(buf.length / 1024);
      if (typeof args.max_kb === 'number' && buf.length > args.max_kb * 1024) {
        problems.push(`${kb} KB, wants at most ${args.max_kb} KB`);
      }
      return problems.length > 0
        ? { ok: false, what: `${path}: ${problems.join('; ')}` }
        : { ok: true, what: `${path}: ${dim.type} ${dim.width}x${dim.height}, ${kb} KB` };
    }
    case 'links-resolve': {
      const file = resolve(cwd, path);
      const base = dirname(file);
      const checkUrls = args['url-ok'] === true;
      const site = typeof args.root === 'string' ? resolve(cwd, args.root) : cwd;
      const broken: string[] = [];
      let checked = 0;
      for (const raw of linkTargets(readFileSync(file, 'utf8'))) {
        if (SKIP_RE.test(raw)) continue;
        if (URL_RE.test(raw)) {
          if (!checkUrls) continue;
          checked++;
          const why = await urlOk(raw, deps);
          if (why) broken.push(why);
          continue;
        }
        if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
        const target = decodeURI(raw.replace(/[?#].*$/, ''));
        if (!target) continue;
        checked++;
        const at = target.startsWith('/') ? resolve(site, `.${target}`) : resolve(base, target);
        if (!existsSync(at)) broken.push(raw);
        else if (statSync(at).isDirectory() && /\.html?$/i.test(file)) {
          if (!existsSync(resolve(at, 'index.html'))) broken.push(raw);
        }
      }
      if (broken.length > 0) {
        const more = broken.length > 10 ? ` and ${broken.length - 10} more` : '';
        return {
          ok: false,
          what: `${path}: ${broken.length} of ${checked} links do not resolve: ${broken.slice(0, 10).join(', ')}${more}`,
        };
      }
      return { ok: true, what: `${path}: ${checked} links resolve` };
    }
    default:
      return { ok: false, what: `unknown check '${String(c.check)}'` };
  }
}

function rangeText(min: number | undefined, max: number | undefined): string {
  return [min !== undefined ? `at least ${min}` : '', max !== undefined ? `at most ${max}` : '']
    .filter(Boolean)
    .join(' and ');
}

/**
 * Runs one built-in check. A check of files runs on every file its `path` names: a glob checks
 * each file it matches, and a glob that matches none fails, as does a missing file.
 */
async function runCheck(c: Criterion, deps: CheckDeps): Promise<CriterionVerdict> {
  const args = c.args ?? {};
  const cwd = deps.cwd;
  const fail = (evidence: string): CriterionVerdict => ({ result: 'fail', evidence });
  const pass = (evidence: string): CriterionVerdict => ({ result: 'pass', evidence });
  try {
    switch (c.check) {
      case 'url-ok': {
        const urls = strings(args.url);
        const broken: string[] = [];
        for (const url of urls) {
          const why = await urlOk(url, deps);
          if (why) broken.push(why);
        }
        return broken.length > 0
          ? fail(broken.join('; '))
          : pass(`${urls.join(', ')} answered 2xx or 3xx`);
      }
      case 'file-exists': {
        const { paths, unmatched } = expandPaths(cwd, args.path);
        const missing = [...unmatched, ...paths.filter((p) => !existsSync(resolve(cwd, p)))];
        return missing.length > 0
          ? fail(`missing: ${missing.join(', ')}`)
          : pass(`exists: ${paths.join(', ')}`);
      }
      default: {
        if (!(CHECK_NAMES as readonly string[]).includes(String(c.check))) {
          return { result: 'na', note: `unknown check '${String(c.check)}'` };
        }
        const { paths, unmatched } = expandPaths(cwd, args.path);
        const seen: FileOutcome[] = unmatched.map((g) => ({
          ok: false,
          what: `no file matches ${g}`,
        }));
        for (const p of paths) {
          try {
            seen.push(await checkFile(c, p, deps));
          } catch (err) {
            const what =
              (err as NodeJS.ErrnoException).code === 'ENOENT'
                ? `no file ${p}`
                : `${p}: ${(err as Error).message}`;
            seen.push({ ok: false, what });
          }
        }
        const ok = seen.length > 0 && seen.every((s) => s.ok);
        // Failures first, and the start kept: with many files, the evidence names what to fix.
        const lines = [...seen.filter((s) => !s.ok), ...seen.filter((s) => s.ok)].map(
          (s) => s.what,
        );
        const evidence = head(lines.join('\n'));
        return ok ? pass(evidence) : fail(evidence);
      }
    }
  } catch (err) {
    return fail((err as Error).message);
  }
}

/** The start of a check's evidence, cut at the evidence length. */
function head(text: string): string {
  const t = text.trim();
  return t.length > EVIDENCE_LEN ? `${t.slice(0, EVIDENCE_LEN)}…` : t;
}

/**
 * Runs the `command` and `check` criteria of `criteria` in order, and the `map` ones when
 * `deps.mapCheck` is given (else they are `na`). Other kinds are judged by a reviewer and are
 * left out of the result.
 */
export async function runCriteria(
  criteria: readonly Criterion[],
  deps: CheckDeps,
): Promise<CriteriaResults> {
  const out: CriteriaResults = {};
  const publish = deps.phase === 'publish';
  for (const raw of criteria) {
    // Post-publish criteria run only after `swarmup published`, and only then.
    if ((raw.when === 'publish') !== publish) continue;
    const c = publish && deps.url ? withUrl(raw, deps.url) : raw;
    if (c.kind === 'command') {
      const run = deps.runCommand ?? ((cmd: string, cwd: string) => defaultRunCommand(cmd, cwd));
      const r = await run(c.run ?? '', deps.cwd);
      const evidence = tail(r.output);
      out[c.id] = {
        result: r.ok ? 'pass' : 'fail',
        ...(evidence ? { evidence } : {}),
        ...(r.ok ? {} : { note: `\`${c.run}\` failed (${r.why ?? 'failed'})` }),
      };
    } else if (c.kind === 'check') {
      out[c.id] = await runCheck(c, deps);
    } else if (c.kind === 'map') {
      out[c.id] = deps.mapCheck
        ? await deps.mapCheck(c)
        : { result: 'na', note: 'this build has no `swarmup map check`' };
    }
  }
  return out;
}
