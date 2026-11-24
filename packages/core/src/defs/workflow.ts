/**
 * Workflows (W5 phase 3): `workflows/<id>.yaml` in a task store, a repeatable milestone plan. A
 * workflow names its parameters, the milestone's title and check, whether a person who starts it
 * approves it (`approval: starter`) or it waits as a proposal, default criteria per task type, and
 * its stages. It compiles to a `PlanDoc`, which goes through the milestone plan path unchanged
 * (`validatePlan`, the `plan` and `plan-approve` events). Parameters fill `{{name}}` in any text,
 * and `{{human}}` is the store's person; there are no expressions. A stage with `when` is left out unless the parameter has the value; a
 * stage with `gate` becomes a `gate` item that a person approves or rejects.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DoneWhenEntry } from '../criteria.js';
import { parseDoneWhen } from '../criteria.js';
import { isHuman, OpsError } from '../ids.js';
import type { GateSpec, PlanItem, Priority } from '../model.js';
import { GATE_TYPE, PRIORITIES } from '../model.js';
import type { PlanDoc } from '../plan.js';
import { validatePlan } from '../plan.js';
import { normalText } from './hash.js';
import type { DefProblem, Schema } from './schema.js';
import { any, checkYaml, enumOf, int, list, map, obj, oneOf, str } from './schema.js';

/** The folder of a store that holds the workflows. */
export const WORKFLOWS_DIR = 'workflows';

/** A workflow's id, its file name without `.yaml`: lowercase letters, digits and dashes. */
export const WORKFLOW_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

const PARAM_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** A parameter a workflow takes. */
export interface WorkflowParam {
  description?: string;
  /** Start refuses without it, unless it has a default. */
  required?: boolean;
  default?: string;
  /** The values it may take. */
  options?: string[];
}

/** A stage's gate: a person approves or rejects before the stages after it start. */
export interface WorkflowGate extends GateSpec {
  /** The person; default the store's human. */
  to?: string;
}

/** One stage of a workflow: one plan item. */
export interface WorkflowStage {
  key: string;
  title?: string;
  owner?: string;
  estimate?: string;
  after?: string[];
  review?: string;
  type?: string;
  priority?: string;
  /** Labels the task gets, such as `publish:{{adapter}}`. */
  labels?: string[];
  body?: string;
  done_when?: unknown;
  gate?: WorkflowGate;
  /** Keep the stage only when parameter `param` has the value (or one of the values) `equals`. */
  when?: { param: string; equals: string | string[] };
  /** Advice for QA fix rounds: who reworks the stage, and at most how many rounds. */
  rework?: { to: string; max?: number };
}

/** A workflow file, read. */
export interface WorkflowDef {
  id: string;
  title?: string;
  description?: string;
  params?: Record<string, WorkflowParam>;
  milestone: { title: string; done_when: unknown };
  /** `proposal` (the default): the plan waits for a person; `starter`: a person who starts it approves it. */
  approval?: 'proposal' | 'starter';
  /** Default `done_when` per task type for stages that set none. */
  criteria?: Record<string, unknown>;
  stages: WorkflowStage[];
}

/** One workflow of a store: its file, and its definition when it reads. */
export interface WorkflowInfo {
  id: string;
  file: string;
  def: WorkflowDef | null;
  problems: DefProblem[];
}

const text = (doc: string, o: Parameters<typeof str>[0] = {}): Schema => str({ ...o, doc });
const keyRef = str({
  pattern: /^[a-z0-9][a-z0-9_-]{0,39}$/,
  hint: "use lowercase letters, digits, '-' and '_'",
});

const STAGE_SCHEMA: Schema = obj(
  {
    key: { ...keyRef, doc: 'The stage key; `after` names it, and the plan item takes it.' },
    title: text('The task title; `{{param}}` fills in. A gate defaults to its question.'),
    owner: text('Who works on it: an agent id, a role wildcard such as `*:writer`, or a person.'),
    estimate: str({
      pattern: /^[0-9]+(m|h|d)$/,
      hint: 'use minutes, hours or days, such as 30m, 2h, 1d',
      doc: 'A planning number, never a budget. A gate defaults to 15m.',
    }),
    after: oneOf([keyRef, list(keyRef)], { doc: 'Keys of the stages this one waits for.' }),
    review: text('The reviewer: a concrete agent id or a person.'),
    type: text('The task type, such as task, bug, docs, content, publish or gate.'),
    priority: text('p0 to p3, or a parameter such as {{severity}}; default the milestone’s.'),
    labels: list(text('A label; `{{param}}` fills in.'), {
      doc: 'Labels the task gets besides `milestone:<id>`, such as `publish:blog`, which names the adapter `swarmup publish` runs.',
    }),
    body: text('The task body.'),
    done_when: any({
      doc: 'The stage’s check: one line, or one typed criterion. Default `criteria.<type>`, then the title.',
    }),
    gate: obj(
      {
        ask: text('The question the person answers.'),
        to: text('The person; default the store’s human.'),
        options: list(str(), { doc: 'Answers to pick from.' }),
        on_reject: enumOf(['park', 'revise'], {
          doc: 'park (default): a rejection parks this gate and every stage after it. revise: the stages it waits for reopen.',
        }),
      },
      {
        required: ['ask'],
        doc: 'A person approves (`swarmup done`) or rejects (`swarmup park`) here.',
      },
    ),
    when: obj(
      {
        param: str({ pattern: PARAM_RE, hint: 'name a parameter' }),
        equals: oneOf([str(), list(str())]),
      },
      {
        required: ['param', 'equals'],
        doc: 'Keep the stage only when the parameter has this value.',
      },
    ),
    rework: obj(
      {
        to: text('Who reworks the stage after a failed check.'),
        max: int({ min: 0, doc: 'At most this many rounds.' }),
      },
      { required: ['to'], doc: 'Advice for QA fix rounds; it goes in the task body.' },
    ),
  },
  { required: ['key'], doc: 'One stage: one plan item.' },
);

/** The schema of a workflow file. */
export const WORKFLOW_SCHEMA: Schema = obj(
  {
    id: str({
      pattern: WORKFLOW_ID_RE,
      hint: 'the file name without .yaml',
      doc: 'Defaults to the file name.',
    }),
    title: text('A short name for lists.'),
    description: text('When to use it.'),
    params: map(
      obj(
        {
          description: text('What it is for.'),
          required: { kind: 'bool', doc: 'Start refuses without it, unless it has a default.' },
          default: text('The value when start names none.'),
          options: list(str(), { doc: 'The values it may take.' }),
        },
        { nullable: true, doc: 'One parameter.' },
      ),
      {
        keyPattern: PARAM_RE,
        keyHint: 'name a parameter with lowercase letters, digits and _',
        nullable: true,
        doc: 'Parameters; `{{name}}` in any text takes the value.',
      },
    ),
    milestone: obj(
      {
        title: text('The milestone title.'),
        done_when: any({ doc: 'The milestone’s one check: one line, or one typed criterion.' }),
      },
      { required: ['title', 'done_when'], doc: 'The milestone the workflow runs under.' },
    ),
    approval: enumOf(['proposal', 'starter'], {
      doc: 'proposal (default): the plan waits for a person. starter: a person who starts it approves it; an agent’s start is always a proposal.',
    }),
    criteria: map(any(), {
      keyPattern: /^[a-z][a-z0-9-]*$/,
      keyHint: 'name a task type',
      nullable: true,
      doc: 'Default `done_when` per task type for stages that set none.',
    }),
    stages: list(STAGE_SCHEMA, { doc: 'The stages, in any order; `after` orders them.' }),
  },
  { required: ['milestone', 'stages'], doc: 'A workflow: a repeatable milestone plan.' },
);

function plain(path: string, kind: 'dir' | 'file'): boolean {
  try {
    const s = lstatSync(path);
    return kind === 'dir' ? s.isDirectory() : s.isFile();
  } catch {
    return false;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A workflow id from a path in the store (`workflows/<id>.yaml`), or null for another path. */
export function workflowIdOf(path: string): string | null {
  const m = /^workflows\/([^/]+)\.ya?ml$/.exec(path);
  return m && WORKFLOW_ID_RE.test(m[1]!) ? m[1]! : null;
}

/** A checked workflow value as a {@link WorkflowDef}; `after` becomes a list. */
function toDef(id: string, value: unknown): WorkflowDef {
  const v = isRecord(value) ? value : {};
  const stages = (Array.isArray(v.stages) ? v.stages : []).filter(isRecord).map((s) => {
    const after = s.after === undefined || s.after === null ? undefined : [s.after].flat();
    return { ...s, ...(after ? { after: after.map(String) } : {}) } as unknown as WorkflowStage;
  });
  return { ...(v as unknown as WorkflowDef), id, stages };
}

/**
 * Checks one workflow file's text: its schema, then a compile with each parameter's default (or
 * its first option, or `example`), which runs the plan rules. `file` is what problems carry.
 */
export function checkWorkflowText(
  id: string,
  source: string,
  opts: { file: string; strict?: boolean },
): WorkflowInfo {
  const checked = checkYaml(WORKFLOW_SCHEMA, normalText(source), opts);
  const problems = [...checked.problems];
  const errors = problems.some((p) => p.severity === 'error');
  if (errors || checked.value === undefined) return { id, file: opts.file, def: null, problems };
  const def = toDef(id, checked.value);
  const named = isRecord(checked.value) ? checked.value.id : undefined;
  if (typeof named === 'string' && named !== id) {
    const at = checked.at(['id']);
    problems.push({
      file: opts.file,
      path: 'id',
      ...at,
      severity: 'error',
      message: `the file is workflows/${id}.yaml; id ${named} must match it, or be left out`,
    });
    return { id, file: opts.file, def: null, problems };
  }
  try {
    const sample: Record<string, string> = {};
    for (const [k, p] of Object.entries(def.params ?? {})) {
      if (p?.default === undefined) sample[k] = p?.options?.[0] ?? 'example';
    }
    compileWorkflow(def, { params: sample, human: 'human:you' });
  } catch (err) {
    problems.push({
      file: opts.file,
      path: '(top)',
      line: 1,
      col: 1,
      severity: 'error',
      message: (err as Error).message,
    });
    return { id, file: opts.file, def: null, problems };
  }
  return { id, file: opts.file, def, problems };
}

/** The workflows of the store in `rootDir`, sorted by id; each with its problems. */
export function readWorkflows(rootDir: string): WorkflowInfo[] {
  const dir = join(rootDir, WORKFLOWS_DIR);
  if (!plain(dir, 'dir')) return [];
  const out: WorkflowInfo[] = [];
  for (const name of readdirSync(dir).sort()) {
    const id = workflowIdOf(`${WORKFLOWS_DIR}/${name}`);
    const file = join(dir, name);
    if (!id || !plain(file, 'file')) continue;
    out.push(checkWorkflowText(id, readFileSync(file, 'utf8'), { file }));
  }
  return out;
}

/** The text of a new blank workflow: one stage and a milestone, which checks as it is. */
export const BLANK_WORKFLOW = `# yaml-language-server: $schema=../.schemas/workflow.schema.json
title: New workflow
description: When to use it.
params:
  topic:
    description: What the milestone is about, in a few words
    required: true
milestone:
  title: '{{topic}}'
  done_when: '{{topic}} is done and checked'
approval: proposal
stages:
  - key: build
    title: 'Build {{topic}}'
    owner: '*:engineer'
    estimate: 2h
    done_when: '{{topic}} works and its tests pass'
`;

/** Parameter values to compile a workflow with for a preview: each default, else its first option, else `example`. */
export function sampleParams(def: Pick<WorkflowDef, 'params'>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, p] of Object.entries(def.params ?? {})) {
    out[k] = p?.default ?? p?.options?.[0] ?? 'example';
  }
  return out;
}

/** The file of workflow `id` in the store `rootDir`, refusing a bad id. */
export function workflowFile(rootDir: string, id: string): string {
  if (!WORKFLOW_ID_RE.test(id)) {
    throw new OpsError(
      `bad workflow id '${id}': use lowercase letters, digits and dashes, such as bugfix`,
      2,
    );
  }
  return join(rootDir, WORKFLOWS_DIR, `${id}.yaml`);
}

/** The text of workflow file `file`, or undefined when it is not there. */
export function readWorkflowText(file: string): string | undefined {
  return plain(file, 'file') ? normalText(readFileSync(file)) : undefined;
}

/**
 * Checks that workflow file `file` is still the text the caller read (`expect`), or that it is not
 * there yet (`create`). Refuses with exit 1 so a stale editor never overwrites a newer change.
 */
export function assertWorkflowUnchanged(
  file: string,
  id: string,
  opts: { expect?: string; create?: boolean },
): void {
  const now = readWorkflowText(file);
  if (opts.create) {
    if (now !== undefined) throw new OpsError(`workflow ${id} exists already; open it to edit`, 1);
    return;
  }
  if (now === undefined) throw new OpsError(`no workflow '${id}'; it was moved or deleted`, 1);
  if (opts.expect !== undefined && now !== normalText(opts.expect)) {
    throw new OpsError(
      `workflows/${id}.yaml changed since you opened it; open it again before you save`,
      1,
    );
  }
}

/**
 * Writes `text` as workflow `id` of `store` through its atomic write, ending in a newline. Refuses
 * a `workflows/` folder that is a link.
 */
export function writeWorkflowFile(
  store: { dir: string; writeAtomic(path: string, content: string): void },
  id: string,
  text: string,
): string {
  const file = workflowFile(store.dir, id);
  const dir = join(store.dir, WORKFLOWS_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!plain(dir, 'dir'))
    throw new OpsError('workflows/ is a link; workflows go in a real folder', 2);
  store.writeAtomic(file, text.endsWith('\n') ? text : `${text}\n`);
  return file;
}

/** Removes a workflow file. */
export function removeWorkflowFile(file: string): void {
  rmSync(file);
}

/** Workflow `id` of the store in `rootDir`; refuses one that is missing or does not check. */
export function readWorkflow(rootDir: string, id: string): WorkflowDef {
  if (!WORKFLOW_ID_RE.test(id)) throw new OpsError(`bad workflow id '${id}'`, 2);
  const all = readWorkflows(rootDir);
  const w = all.find((x) => x.id === id);
  if (!w) {
    const ids = all.map((x) => x.id);
    throw new OpsError(
      `no workflow '${id}' in ${join(rootDir, WORKFLOWS_DIR)}` +
        (ids.length > 0 ? `; there are: ${ids.join(', ')}` : ''),
      2,
    );
  }
  if (!w.def) {
    const first = w.problems.find((p) => p.severity === 'error');
    throw new OpsError(
      `workflow ${id} does not check` +
        (first ? `: ${first.path}: ${first.message}` : '') +
        '; `swarmup validate` lists the problems',
      2,
    );
  }
  return w.def;
}

/** A workflow compiled for one start. */
export interface CompiledWorkflow {
  id: string;
  /** The parameters with defaults filled in. */
  params: Record<string, string>;
  milestone: { title: string; done_when: DoneWhenEntry };
  approval: 'proposal' | 'starter';
  /** The plan, checked with `validatePlan` as a first proposal. */
  doc: PlanDoc;
  /** Stage keys `when` left out. */
  dropped: string[];
}

export interface CompileOptions {
  /** Values by parameter name. */
  params?: Record<string, string>;
  /** The store's human: a gate's owner when it names none. */
  human: string;
  /** The milestone title instead of the workflow's. */
  title?: string;
}

/** `text` with each `{{name}}` filled in; refuses a name the workflow does not declare. */
function fill(text: string, values: Record<string, string>, where: string): string {
  return text.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (_all, name: string) => {
    if (!Object.hasOwn(values, name)) {
      throw new OpsError(`${where}: {{${name}}} names no parameter of the workflow`, 2);
    }
    return values[name]!;
  });
}

/** `value` with `{{name}}` filled in every text inside it. */
function fillDeep(value: unknown, values: Record<string, string>, where: string): unknown {
  if (typeof value === 'string') return fill(value, values, where);
  if (Array.isArray(value)) return value.map((v) => fillDeep(v, values, where));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, fillDeep(v, values, where)]),
    );
  }
  return value;
}

/** The one criterion of a `done_when` value, or undefined for none. */
function oneCriterion(value: unknown, where: string): DoneWhenEntry | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const entries = parseDoneWhen(Array.isArray(value) ? value : [value]);
  if (!entries || entries.length === 0) return undefined;
  if (entries.length > 1)
    throw new OpsError(`${where}: done_when holds one criterion, not ${entries.length}`, 2);
  return entries[0];
}

/** The parameters of a start: the values given, then defaults; refuses a missing or unknown one. */
export function workflowParams(
  def: WorkflowDef,
  given: Record<string, string> = {},
): Record<string, string> {
  const declared = def.params ?? {};
  for (const k of Object.keys(given)) {
    if (!Object.hasOwn(declared, k)) {
      const names = Object.keys(declared);
      throw new OpsError(
        `workflow ${def.id} has no parameter '${k}'` +
          (names.length > 0 ? `; it takes ${names.join(', ')}` : '; it takes none'),
        2,
      );
    }
  }
  const out: Record<string, string> = {};
  for (const [k, p] of Object.entries(declared)) {
    const v = given[k] ?? p?.default;
    if (v === undefined) {
      if (p?.required) {
        throw new OpsError(
          `workflow ${def.id} needs --param ${k}=...` +
            (p.description ? ` (${p.description})` : ''),
          2,
        );
      }
      out[k] = '';
      continue;
    }
    if (p?.options && !p.options.includes(v)) {
      throw new OpsError(`--param ${k}: use one of ${p.options.join(', ')}; got '${v}'`, 2);
    }
    out[k] = v;
  }
  return out;
}

/** The body text a gate task carries: the question, the answers, and how to answer. */
export function gateBody(gate: GateSpec): string {
  const lines = [`**Gate:** ${gate.ask}`];
  if (gate.options?.length) lines.push('', `Answers: ${gate.options.join(', ')}.`);
  lines.push(
    '',
    'Approve with `swarmup done <ID> "answer"`; the stages after this gate start then.',
    gate.on_reject === 'revise'
      ? 'Reject with `swarmup park <ID> "what to change"`: the stages this gate waits for reopen, and it asks again after them.'
      : 'Reject with `swarmup park <ID> "why"`: this gate and every stage after it are parked.',
  );
  return lines.join('\n');
}

/**
 * Compiles a workflow for one start: parameters filled in, stages whose `when` does not hold
 * left out (a stage that waited for one waits for what that one waited for), defaults applied,
 * and the plan checked with `validatePlan`. Refuses with exit 2.
 */
export function compileWorkflow(def: WorkflowDef, opts: CompileOptions): CompiledWorkflow {
  if (!isHuman(opts.human))
    throw new OpsError(`the store's human '${opts.human}' is no human:<name>`, 2);
  // `{{human}}` is the store's person, for publish stages and gates; a parameter of that name wins.
  const values: Record<string, string> = { human: opts.human, ...workflowParams(def, opts.params) };
  const where = `workflow ${def.id}`;
  const keep = (s: WorkflowStage): boolean => {
    if (!s.when) return true;
    if (!Object.hasOwn(values, s.when.param)) {
      throw new OpsError(
        `${where}: stage '${s.key}': when names no parameter '${s.when.param}'`,
        2,
      );
    }
    const want = [s.when.equals].flat();
    return want.includes(values[s.when.param]!);
  };
  const byKey = new Map(def.stages.map((s) => [s.key, s] as const));
  const dropped = def.stages.filter((s) => !keep(s)).map((s) => s.key);
  // What a kept stage waits for, through any dropped stage in between.
  const waitsFor = (keys: readonly string[], seen = new Set<string>()): string[] =>
    keys.flatMap((k) => {
      if (!dropped.includes(k)) return [k];
      if (seen.has(k)) return [];
      seen.add(k);
      return waitsFor(byKey.get(k)?.after ?? [], seen);
    });
  const criteria = (fillDeep(def.criteria ?? {}, values, where) ?? {}) as Record<string, unknown>;
  const items: PlanItem[] = [];
  for (const raw of def.stages) {
    if (dropped.includes(raw.key)) continue;
    const s = fillDeep(raw, values, `${where}, stage '${raw.key}'`) as WorkflowStage;
    const at = `${where}, stage '${s.key}'`;
    const isGate = s.gate !== undefined || s.type === GATE_TYPE;
    if (isGate && s.type !== undefined && s.type !== GATE_TYPE) {
      throw new OpsError(`${at}: a stage with a gate has type gate, not ${s.type}`, 2);
    }
    const type = isGate ? GATE_TYPE : s.type;
    const title = s.title?.trim() || (isGate ? s.gate?.ask?.trim() : undefined);
    if (!title) throw new OpsError(`${at} has no title`, 2);
    const owner = isGate ? s.gate?.to?.trim() || opts.human : s.owner?.trim();
    if (!owner) throw new OpsError(`${at} has no owner`, 2);
    const estimate = s.estimate ?? (isGate ? '15m' : undefined);
    if (!estimate) throw new OpsError(`${at} has no estimate`, 2);
    const item: PlanItem = { key: s.key, title, owner, estimate };
    const after = [...new Set(waitsFor(s.after ?? []))];
    for (const a of after) {
      if (!byKey.has(a)) throw new OpsError(`${at}: after names no stage '${a}'`, 2);
    }
    if (after.length > 0) item.after = after;
    if (type) item.type = type;
    if (s.priority) {
      if (!PRIORITIES.includes(s.priority as Priority)) {
        throw new OpsError(`${at}: bad priority '${s.priority}': use p0, p1, p2 or p3`, 2);
      }
      item.priority = s.priority as Priority;
    }
    if (s.review) item.review = s.review;
    const labels = (s.labels ?? []).map((l) => l.trim()).filter(Boolean);
    if (labels.length > 0) item.labels = [...new Set(labels)];
    const done =
      oneCriterion(s.done_when, at) ??
      oneCriterion(criteria[type ?? 'task'], `${where}, criteria.${type ?? 'task'}`) ??
      (isGate ? `A person approved: ${s.gate?.ask ?? title}` : undefined);
    if (done !== undefined) item.done_when = done;
    const body = [
      s.body?.trim(),
      s.rework
        ? `Rework: when a check fails, ${s.rework.to} reworks this stage` +
          (s.rework.max !== undefined ? `, at most ${s.rework.max} round(s)` : '') +
          '; then the milestone asks the PM.'
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    if (body) item.body = body;
    if (isGate) {
      const gate: GateSpec = { ask: s.gate?.ask?.trim() || title };
      if (s.gate?.options?.length) gate.options = s.gate.options;
      if (s.gate?.on_reject) gate.on_reject = s.gate.on_reject;
      item.gate = gate;
    }
    items.push(item);
  }
  if (items.length === 0) throw new OpsError(`${where}: no stage is left for these parameters`, 2);
  const milestone = fillDeep(
    def.milestone,
    values,
    `${where}, milestone`,
  ) as WorkflowDef['milestone'];
  const doneWhen = oneCriterion(milestone.done_when, `${where}, milestone`);
  if (doneWhen === undefined) throw new OpsError(`${where}: the milestone has no done_when`, 2);
  const shown = Object.entries(values)
    .filter(([k, v]) => v !== '' && (k !== 'human' || def.params?.human))
    .map(([k, v]) => `${k}=${v}`);
  const doc: PlanDoc = {
    notes: `From workflow ${def.id}${shown.length > 0 ? ` (${shown.join(', ')})` : ''}.`,
    items,
  };
  validatePlan(doc, 'proposal', null);
  return {
    id: def.id,
    params: values,
    milestone: { title: opts.title?.trim() || milestone.title, done_when: doneWhen },
    approval: def.approval ?? 'proposal',
    doc,
    dropped,
  };
}
