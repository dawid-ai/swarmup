/**
 * Git triggers (W5 phase 4): `triggers/<name>.yaml` in a task store says when swarmupd starts
 * something (`every`, `at` or `cron`) and what (`action: run | workflow | repeat`). A machine runs
 * a store's triggers only after it turns them on (`swarmupd.triggers.<root>: true`), and only the
 * ones whose `runs_on` names it. A `webhook` section (W8 phase 4) lets swarmupd's inbound listener
 * take signed deliveries for the trigger: see `packages/supervisor/src/hooks.ts`.
 */
import { createHash } from 'node:crypto';
import { OpsError } from '../ids.js';
import { parseDuration } from '../units.js';
import type { Cron } from './cron.js';
import { CRON_HINT, nextCron, parseCron } from './cron.js';
import { secretKind } from '../secrets.js';
import { bool, enumOf, int, list, map, num, obj, oneOf, str, checkYaml } from './schema.js';
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

/** How the inbound listener checks a webhook delivery (W8 phase 4). */
export const WEBHOOK_VERIFIES = ['hmac', 'bearer', 'linear', 'slack'] as const;
export type WebhookVerify = (typeof WEBHOOK_VERIFIES)[number];

/** The name of a `secrets.yml` value, as `{secret: NAME}` in the MCP config takes it. */
export const SECRET_REF_RE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;

/** Deliveries a minute a webhook trigger takes when it sets no `rate`. */
export const WEBHOOK_DEFAULT_RATE = 30;

/** A trigger's `webhook` section: how the listener checks a delivery for it. */
export interface WebhookDef {
  verify: WebhookVerify;
  /** The name of the value in `secrets.yml` that signs or authorizes deliveries; never the value. */
  secret: string;
  /** `hmac`: the header with the signature; default `X-Hub-Signature-256`. */
  header?: string;
  /** The header with a delivery id, for dedupe; default per `verify`, see `hooks.ts`. */
  delivery_header?: string;
  /** Deliveries a minute; default {@link WEBHOOK_DEFAULT_RATE}. */
  rate?: number;
}

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
  /** Deliveries to `POST /hooks/<root>/<name>` fire it (W8 phase 4). */
  webhook?: WebhookDef;
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
    webhook: obj(
      {
        verify: enumOf([...WEBHOOK_VERIFIES], {
          doc: 'hmac: an HMAC-SHA256 of the body in `header`. bearer: `Authorization: Bearer <secret>`. linear: the `Linear-Signature` header. slack: the `X-Slack-Signature` header with a timestamp at most 5 minutes old.',
        }),
        secret: str({
          pattern: SECRET_REF_RE,
          hint: 'name a value of secrets.yml, such as LINEAR_WEBHOOK_SECRET; never the secret itself',
          doc: 'The name of the value in `secrets.yml` (beside the user config) that signs deliveries. Never the secret itself: trigger files are in git.',
        }),
        header: str({
          pattern: /^[A-Za-z0-9-]{1,100}$/,
          hint: 'name an HTTP header such as X-Hub-Signature-256',
          doc: 'hmac: the header with the signature, hex, with or without `sha256=`. Default `X-Hub-Signature-256`.',
        }),
        delivery_header: str({
          pattern: /^[A-Za-z0-9-]{1,100}$/,
          hint: 'name an HTTP header such as X-GitHub-Delivery',
          doc: 'The header with a delivery id, for dedupe. Default `Linear-Delivery` for linear and `X-GitHub-Delivery` for hmac; the body hash dedupes too.',
        }),
        rate: int({
          min: 1,
          max: 600,
          doc: `Deliveries a minute the listener takes for this trigger. Default ${WEBHOOK_DEFAULT_RATE}.`,
        }),
      },
      {
        required: ['verify', 'secret'],
        doc: "Take deliveries at `POST /hooks/<root>/<name>` on swarmupd's inbound listener (`swarmupd.hooks`). A delivery files a finding for triage; it runs the action only where the machine sets `swarmupd.hooks.direct.<root>.<name>: true`.",
      },
    ),
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
      pattern: /^[A-Za-z][A-Za-z0-9]*-\d+$/,
      hint: "name a task of this store such as AO-0012; a trigger never starts another store's task",
      doc: 'run: the task of this store the run works on.',
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
      doc: 'Machines (`machine` in each user config) that run the trigger; unset: every machine that turned triggers on for this store. Required for action workflow and repeat, so one fire time starts once.',
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
  const hook = isRecord(v.webhook) ? v.webhook : undefined;
  if (hook && typeof hook.secret === 'string') {
    if (secretKind(hook.secret)) {
      at(
        'webhook',
        'error',
        'webhook.secret looks like a secret: name the secrets.yml value instead',
      );
    } else if (!/^[A-Z][A-Z0-9_]*$/.test(hook.secret)) {
      at(
        'webhook',
        'warning',
        `webhook.secret '${hook.secret}' names a secrets.yml value; write names in capitals, such as LINEAR_WEBHOOK_SECRET, and never the secret itself`,
      );
    }
  }
  if (hook && hook.header !== undefined && hook.verify !== 'hmac') {
    at(
      'webhook',
      'warning',
      `webhook.header is for verify hmac; ${String(hook.verify)} does not read it`,
    );
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
      if (nextCron(parseCron(v.cron), Date.now()) === null) {
        at('cron', 'error', `'${v.cron}' never fires: no such date comes`);
      }
    } catch (err) {
      at('cron', 'error', (err as Error).message);
    }
  }
  const action = v.action as TriggerAction;
  const needs = { run: 'agent', workflow: 'workflow', repeat: 'repeat' }[action];
  if (typeof v[needs] !== 'string') at('action', 'error', `action ${action} needs ${needs}`);
  // Each consenting machine fires a trigger without runs_on, so one fire time would start one
  // workflow or repeat task per machine.
  if (action !== 'run' && !(Array.isArray(v.runs_on) && v.runs_on.length > 0)) {
    at(
      'action',
      'error',
      `action ${action} needs runs_on: name the one machine that starts it, or each machine would`,
    );
  }
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
    ...(hook ? { webhook: webhookDef(hook) } : {}),
  };
  for (const k of ACTION_KEYS[action]) {
    if (k === 'params') {
      if (params) def.params = params;
    } else if (s(k) !== undefined) (def as unknown as Record<string, string>)[k] = s(k)!;
  }
  if (runsOn && runsOn.length > 0) def.runs_on = runsOn;
  return { name, file: opts.file, def, problems };
}

function webhookDef(h: Record<string, unknown>): WebhookDef {
  return {
    verify: h.verify as WebhookVerify,
    secret: String(h.secret),
    ...(typeof h.header === 'string' ? { header: h.header } : {}),
    ...(typeof h.delivery_header === 'string' ? { delivery_header: h.delivery_header } : {}),
    ...(typeof h.rate === 'number' ? { rate: h.rate } : {}),
  };
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

/**
 * When a trigger fires, for lists: `every 30m`, `at 09:00`, `cron 0 9 * * 1-5`, `webhook hmac`,
 * or a schedule and a webhook such as `every 1d, webhook slack`.
 */
export function triggerWhen(def: Pick<TriggerDef, 'every' | 'at' | 'cron' | 'webhook'>): string {
  const time = def.every
    ? `every ${def.every}`
    : def.at
      ? `at ${def.at}`
      : def.cron
        ? `cron ${def.cron}`
        : '';
  const hook = def.webhook ? `webhook ${def.webhook.verify}` : '';
  return [time, hook].filter(Boolean).join(', ');
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

/** Prefix of a trigger-set hash; the rest is a SHA-256 in hex. */
export const TRIGGERS_HASH_PREFIX = 't:';

/** A trusted trigger-set hash as `swarmupd.trusted_defs.<root>.triggers` keeps it. */
export const TRIGGERS_HASH_RE = /^t:[0-9a-f]{64}$/;

/**
 * The hash of a store's triggers (W5 phase 4, Decision 7): `t:` and the SHA-256 of every field
 * that changes what fires, per trigger in name order: name, schedule, action, agent, prompt,
 * task, workflow, params, title, repeat, runs_on and enabled, and the `webhook` section when it
 * has one (left out otherwise, so a set trusted before W8 phase 4 keeps its hash). A description
 * does not change it. Null when the store has no trigger that reads.
 */
export function triggersHash(defs: readonly TriggerDef[]): string | null {
  if (defs.length === 0) return null;
  const lines = [...defs]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((d) =>
      JSON.stringify([
        d.name,
        d.every ?? null,
        d.at ?? null,
        d.cron ?? null,
        d.action,
        d.agent ?? null,
        d.prompt ?? null,
        d.task ?? null,
        d.workflow ?? null,
        Object.entries(d.params ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        d.title ?? null,
        d.repeat ?? null,
        d.runs_on ?? null,
        d.enabled,
        ...(d.webhook
          ? [
              [
                d.webhook.verify,
                d.webhook.secret,
                d.webhook.header ?? null,
                d.webhook.delivery_header ?? null,
                d.webhook.rate ?? null,
              ],
            ]
          : []),
      ]),
    );
  return (
    TRIGGERS_HASH_PREFIX +
    createHash('sha256')
      .update(`swarmup-triggers/1\n${lines.join('\n')}`, 'utf8')
      .digest('hex')
  );
}

/**
 * Whether `trusted` (the hash a machine keeps for the root) trusts the store's triggers: `none`
 * (no trigger reads), `trusted`, `untrusted` (none kept) or `changed` (another set's hash).
 */
export function triggersTrust(
  defs: readonly TriggerDef[],
  trusted: string | undefined,
): 'none' | 'trusted' | 'untrusted' | 'changed' {
  const hash = triggersHash(defs);
  if (!hash) return 'none';
  if (!trusted) return 'untrusted';
  return trusted === hash ? 'trusted' : 'changed';
}

/** What swarmupd does with a store's triggers that are not trusted, in one sentence. */
export function untrustedTriggersText(root: string, trust: string, count: number): string {
  const why =
    trust === 'changed'
      ? 'changed since this machine trusted them'
      : 'are not trusted on this machine';
  return `${count} trigger(s) in ${root} ${why}; none fires until a person runs \`swarmup defs trust --root ${root}\``;
}

/**
 * The warning `swarmup validate` and `doctor` give on a machine that turned a store's triggers on
 * but does not trust its trigger set, or null.
 */
export function triggersTrustProblem(
  file: string,
  root: string,
  defs: readonly TriggerDef[],
  trusted: string | undefined,
): DefProblem | null {
  const trust = triggersTrust(defs, trusted);
  if (trust === 'none' || trust === 'trusted') return null;
  return {
    file,
    path: 'triggers',
    line: 1,
    col: 1,
    severity: 'warning',
    message: untrustedTriggersText(root, trust, defs.length),
  };
}

export { CRON_HINT };
