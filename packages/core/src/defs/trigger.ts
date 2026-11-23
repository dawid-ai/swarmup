/**
 * Git triggers (W5 phase 4): `triggers/<name>.yaml` in a task store says when swarmupd starts
 * something (`every`, `at` or `cron`) and what (`action: run | workflow | repeat`). A machine runs
 * a store's triggers only after it turns them on (`swarmupd.triggers.<root>: true`), and only the
 * ones whose `runs_on` names it. `webhook` is accepted and does nothing yet (W8 phase 4).
 */
import { OpsError } from '../ids.js';
import { parseDuration } from '../units.js';
import type { Cron } from './cron.js';
import { CRON_HINT, nextCron, parseCron } from './cron.js';
import { bool, enumOf, list, map, num, obj, oneOf, str, any, checkYaml } from './schema.js';
import type { DefProblem, Schema } from './schema.js';
import { normalText } from './hash.js';
import { WORKFLOW_ID_RE } from './workflow.js';

export const TRIGGERS_DIR = 'triggers';

/** A trigger's name: its file name without `.yaml`. */
export const TRIGGER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;

/** What a trigger does when it fires. */
export const TRIGGER_ACTIONS = ['run', 'workflow', 'repeat'] as const;
export type TriggerAction = (typeof TRIGGER_ACTIONS)[number];

/**
 * Who starts a trigger's workflow or creates its repeat's task: swarmupd for the trigger, never a
 * person, so a `starter` workflow still waits for a person's approval.
 */
export const TRIGGER_ACTOR = 'opsd:trigger';

/** A checked trigger file. */
export interface TriggerDef {
  name: string;
  description?: string;
  /** Interval such as `30m` or `24h`. */
  every?: string;
  /** Daily local time such as `09:00`. */
  at?: string;
  /** Five-field cron expression in local time. */
  cron?: string;
  /** Accepted; webhook triggers come in W8 phase 4, so a trigger with only this never fires. */
  webhook?: unknown;
  action: TriggerAction;
  /** `run`: the agent to start. */
  agent?: string;
  /** `run`: instructions for the run; the standard work-the-queue prompt without it. */
  prompt?: string;
  /** `run`: the task the run works on, `ID` in this store or `root/ID`. */
  task?: string;
  /** `workflow`: the workflow (`workflows/<id>.yaml`) to start. */
  workflow?: string;
  /** `workflow`: parameter values. */
  params?: Record<string, string>;
  /** `workflow`: the milestone title instead of the workflow's. */
  title?: string;
  /** `repeat`: the repeat (`repeats/<name>.md`) whose task to create. */
  repeat?: string;
  /** Machine names (`machine` in each user config); unset: every machine that turned triggers on. */
  runs_on?: string[];
  /** Default true. */
  enabled: boolean;
}

/** One trigger file, checked: its definition, or null when it has an error. */
export interface TriggerInfo {
  name: string;
  file: string;
  def: TriggerDef | null;
  problems: DefProblem[];
}

const DAILY_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
const DURATION_RE = /^(\d+|(\d+(\.\d+)?d)?(\d+(\.\d+)?h)?(\d+(\.\d+)?m)?)$/;

/** The keys each action reads; the others warn. */
const ACTION_KEYS: Record<TriggerAction, string[]> = {
  run: ['agent', 'prompt', 'task'],
  workflow: ['workflow', 'params', 'title'],
  repeat: ['repeat'],
};

/** The schema of a trigger file. */
export const TRIGGER_SCHEMA: Schema = obj(
  {
    description: str({ doc: 'What the trigger is for.' }),
    every: str({
      pattern: DURATION_RE,
      hint: 'use a duration such as 30m, 2h or 1d',
      doc: 'Fire at this interval, such as `30m` or `24h`. A new trigger fires at once.',
    }),
    at: str({
      pattern: DAILY_RE,
      hint: 'use a local time from 00:00 to 23:59',
      doc: 'Fire once a day at this local time, such as `09:00`.',
    }),
    cron: str({
      doc: 'Fire on a five-field cron expression in local time, such as `0 9 * * mon-fri`.',
    }),
    webhook: any({ inactive: 'webhook triggers come in W8 phase 4' }),
    action: enumOf([...TRIGGER_ACTIONS], {
      doc: 'run: start an agent. workflow: start a store workflow. repeat: create the task of a repeat.',
    }),
    agent: str({
      pattern: /^[a-z][a-z0-9]*:[a-z][a-z0-9-]*$/,
      hint: 'use <runtime>:<role>, such as claude:pm',
      doc: 'run: the agent to start.',
    }),
    prompt: str({ doc: 'run: instructions for the run; the standard prompt without them.' }),
    task: str({
      pattern: /^([^\s/]+\/)?[A-Za-z][A-Za-z0-9]*-\d+$/,
      hint: 'name a task such as AO-0012 or root/AO-0012',
      doc: 'run: the task the run works on.',
    }),
    workflow: str({
      pattern: WORKFLOW_ID_RE,
      hint: 'name a workflow such as bugfix',
      doc: 'workflow: the workflow (`workflows/<id>.yaml`) to start.',
    }),
    params: map(oneOf([str(), num(), bool()]), {
      keyPattern: /^[a-z][a-z0-9_]{0,39}$/,
      keyHint: 'name a parameter with lowercase letters, digits and _',
      nullable: true,
      doc: 'workflow: parameter values.',
    }),
    title: str({ doc: "workflow: the milestone title instead of the workflow's." }),
    repeat: str({
      pattern: /^[a-z0-9][a-z0-9-]{0,59}$/,
      hint: 'name a repeat such as weekly-report',
      doc: 'repeat: the repeat (`repeats/<name>.md`) whose task to create now.',
    }),
    runs_on: list(str({ pattern: /\S/, hint: 'name a machine' }), {
      doc: 'Machines (`machine` in each user config) that run the trigger; unset: every machine that turned triggers on for this store.',
    }),
    enabled: bool({ doc: 'Default true; false keeps the file and fires nothing.' }),
  },
  {
    required: ['action'],
    doc: 'A git trigger: when swarmupd starts something. A machine runs it only after `swarmupd.triggers.<root>: true`.',
  },
);

/** A trigger name from a path in the store (`triggers/<name>.yaml`), or null for another path. */
export function triggerNameOf(path: string): string | null {
  const m = /^triggers\/([^/]+)\.ya?ml$/.exec(path);
  return m && TRIGGER_NAME_RE.test(m[1]!) ? m[1]! : null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Checks one trigger file's text: its schema, then the rules across its keys. */
export function checkTriggerText(
  name: string,
  source: string,
  opts: { file: string; strict?: boolean },
): TriggerInfo {
  const checked = checkYaml(TRIGGER_SCHEMA, normalText(source), opts);
  const problems = [...checked.problems];
  const fail = (): TriggerInfo => ({ name, file: opts.file, def: null, problems });
  if (problems.some((p) => p.severity === 'error') || !isRecord(checked.value)) return fail();
  const v = checked.value;
  const at = (path: string, severity: DefProblem['severity'], message: string): void => {
    problems.push({
      file: opts.file,
      path,
      ...checked.at(path === '(top)' ? [] : [path]),
      severity,
      message,
    });
  };
  const times = (['every', 'at', 'cron'] as const).filter((k) => typeof v[k] === 'string');
  if (times.length > 1)
    at(times[1]!, 'error', `set one of every, at and cron; got ${times.join(' and ')}`);
  if (times.length === 0 && v.webhook === undefined) {
    at('(top)', 'error', 'set when it fires: every, at or cron');
  }
  if (typeof v.every === 'string') {
    try {
      if (parseDuration(v.every) < 1) at('every', 'error', 'use at least 1m');
    } catch (err) {
      at('every', 'error', (err as Error).message);
    }
  }
  if (typeof v.cron === 'string') {
    try {
      parseCron(v.cron);
    } catch (err) {
      at('cron', 'error', (err as Error).message);
    }
  }
  const action = v.action as TriggerAction;
  const needs = { run: 'agent', workflow: 'workflow', repeat: 'repeat' }[action];
  if (typeof v[needs] !== 'string') at('action', 'error', `action ${action} needs ${needs}`);
  for (const [other, keys] of Object.entries(ACTION_KEYS)) {
    if (other === action) continue;
    for (const k of keys) {
      if (v[k] !== undefined && v[k] !== null) {
        at(k, 'warning', `${k} is for action ${other}; action ${action} does not read it`);
      }
    }
  }
  if (problems.some((p) => p.severity === 'error')) return fail();
  const s = (k: string): string | undefined =>
    typeof v[k] === 'string' ? (v[k] as string) : undefined;
  const params = isRecord(v.params)
    ? Object.fromEntries(Object.entries(v.params).map(([k, x]) => [k, String(x)]))
    : undefined;
  const runsOn = Array.isArray(v.runs_on) ? v.runs_on.map((m) => String(m).trim()) : undefined;
  const def: TriggerDef = {
    name,
    action,
    enabled: v.enabled !== false,
    ...(s('description') ? { description: s('description') } : {}),
    ...(s('every') ? { every: s('every') } : {}),
    ...(s('at') ? { at: s('at') } : {}),
    ...(s('cron') ? { cron: s('cron') } : {}),
    ...(v.webhook !== undefined ? { webhook: v.webhook } : {}),
  };
  for (const k of ACTION_KEYS[action]) {
    if (k === 'params') {
      if (params) def.params = params;
    } else if (s(k) !== undefined) (def as unknown as Record<string, string>)[k] = s(k)!;
  }
  if (runsOn && runsOn.length > 0) def.runs_on = runsOn;
  return { name, file: opts.file, def, problems };
}

/** The time rule of a trigger as a cron, or null for `every` and webhook-only triggers. */
export function triggerCron(def: Pick<TriggerDef, 'at' | 'cron'>): Cron | null {
  if (def.cron) return parseCron(def.cron);
  if (def.at) {
    const [h, m] = def.at.split(':').map(Number);
    return parseCron(`${m} ${h} * * *`);
  }
  return null;
}

/** When a trigger fires, for lists: `every 30m`, `at 09:00`, `cron 0 9 * * 1-5` or `webhook`. */
export function triggerWhen(def: Pick<TriggerDef, 'every' | 'at' | 'cron' | 'webhook'>): string {
  if (def.every) return `every ${def.every}`;
  if (def.at) return `at ${def.at}`;
  if (def.cron) return `cron ${def.cron}`;
  return 'webhook (not active yet)';
}

/** What a trigger does, for lists: `run claude:pm`, `workflow bugfix`, `repeat weekly`. */
export function triggerTarget(def: TriggerDef): string {
  if (def.action === 'run') return `run ${def.agent}${def.task ? ` on ${def.task}` : ''}`;
  if (def.action === 'workflow') return `workflow ${def.workflow}`;
  return `repeat ${def.repeat}`;
}

/** Whether `machine` (this machine's `machine` name) is one a trigger runs on. */
export function triggerRunsOn(
  def: Pick<TriggerDef, 'runs_on'>,
  machine: string | undefined,
): boolean {
  if (!def.runs_on || def.runs_on.length === 0) return true;
  const me = machine?.trim().toLowerCase();
  return !!me && def.runs_on.some((m) => m.toLowerCase() === me);
}

/**
 * What a trigger does at `now`, given `last`: when it last fired on this machine, or when this
 * machine first saw it. `baseline` for an `at` or `cron` trigger seen for the first time: the
 * caller records `now`, and it fires at its next time after that, never for a time before it.
 * `fire` when a time came since `last` (once, however many passed), `wait` otherwise. An `every`
 * trigger fires at once the first time.
 */
export function triggerDue(
  def: Pick<TriggerDef, 'every' | 'at' | 'cron'>,
  last: number | undefined,
  now: number,
): 'fire' | 'baseline' | 'wait' {
  if (def.every) {
    return last === undefined || now - last >= parseDuration(def.every) * 60_000 ? 'fire' : 'wait';
  }
  const cron = triggerCron(def);
  if (!cron) return 'wait';
  if (last === undefined) return 'baseline';
  const next = nextCron(cron, last);
  return next !== null && next <= now ? 'fire' : 'wait';
}

/** When a trigger fires next on this machine (now when it is due), or null for none. */
export function nextTriggerFire(
  def: Pick<TriggerDef, 'every' | 'at' | 'cron'>,
  last: number | undefined,
  now: number,
): number | null {
  if (def.every) {
    return last === undefined ? now : Math.max(now, last + parseDuration(def.every) * 60_000);
  }
  const cron = triggerCron(def);
  if (!cron) return null;
  if (last === undefined) return nextCron(cron, now);
  const next = nextCron(cron, last);
  return next === null ? null : Math.max(now, next);
}

/** A trigger file's text for a machine schedule (`swarmup defs import-schedules`). */
export function scheduleTriggerText(s: {
  every?: string;
  at?: string;
  agent: string;
  prompt?: string;
  task?: string;
  paused?: boolean;
  machine?: string;
}): string {
  if (!s.every === !s.at) throw new OpsError('a schedule sets exactly one of every and at', 2);
  const lines = [
    `# yaml-language-server: $schema=../.schemas/trigger.schema.json`,
    'action: run',
    ...(s.every ? [`every: ${JSON.stringify(s.every)}`] : []),
    ...(s.at ? [`at: ${JSON.stringify(s.at)}`] : []),
    `agent: ${s.agent}`,
    ...(s.task ? [`task: ${s.task}`] : []),
    ...(s.prompt ? [`prompt: ${JSON.stringify(s.prompt)}`] : []),
    ...(s.machine ? [`runs_on: [${JSON.stringify(s.machine)}]`] : []),
    ...(s.paused ? ['enabled: false'] : []),
  ];
  return `${lines.join('\n')}\n`;
}

export { CRON_HINT };
