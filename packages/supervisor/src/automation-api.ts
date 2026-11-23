/**
 * The desktop app's Automation view: each root's git triggers and merge checks with where this
 * machine's consent and trust stand, the inbound webhook listener, and the person-only changes
 * behind them. The changes write the same user-config keys as `swarmup triggers on|off`,
 * `swarmup defs trust [--revoke]` and the `swarmupd.hooks` settings, with the same hash
 * functions, so a trust from the app and one from the CLI are the same value.
 */
import type { ChecksTrust, TriggerDef, UserConfig } from '@swarmup/core';
import {
  checksHash,
  checksTrust,
  daemonKeyIn,
  editUserConfig,
  loadDefinitions,
  OpsError,
  TRIGGER_NAME_RE,
  triggersHash,
  triggersTrust,
  triggerTarget,
  triggerWhen,
} from '@swarmup/core';
import type { OpsdConfig } from './config.js';
import { opsdConfig } from './config.js';
import type { HookListenerState, HookLogEntry } from './hooks.js';
import { hookConfig, hookRoots, hookSecret, HOOKS_LISTENER } from './hooks.js';
import type { Supervisor } from './supervisor.js';
import type { TriggerView } from './triggers.js';
import { TRIGGERS_STATE, triggersView } from './triggers.js';

type Document = Parameters<Parameters<typeof editUserConfig>[1]>[0];

/** Lines of `hooks.log` the view shows. */
export const AUTOMATION_LOG_LINES = 20;

// ---- Shared with the CLI -----------------------------------------------------------------------

/** A change to one root's trust: a hash to keep, null to drop it; unset keys stay. */
export interface TrustChange {
  root: string;
  checks?: string | null;
  triggers?: string | null;
}

/** Writes trust changes into a user config document (`swarmupd.trusted_defs.<root>`). */
export function applyTrust(doc: Document, changes: readonly TrustChange[]): void {
  const key = daemonKeyIn(doc);
  for (const c of changes) {
    for (const kind of ['checks', 'triggers'] as const) {
      const v = c[kind];
      const path = [key, 'trusted_defs', c.root, kind];
      if (typeof v === 'string') doc.setIn(path, v);
      else if (v === null && doc.hasIn(path)) doc.deleteIn(path);
    }
    const entry = doc.getIn([key, 'trusted_defs', c.root]) as { items?: unknown[] } | undefined;
    if (entry?.items?.length === 0) doc.deleteIn([key, 'trusted_defs', c.root]);
  }
}

/** Turns a root's git triggers on or off for this machine (`swarmupd.triggers.<root>`). */
export function applyTriggersOn(doc: Document, root: string, on: boolean): void {
  doc.setIn([daemonKeyIn(doc), 'triggers', root], on);
}

/** Refuses a user config whose swarmupd section does not check. */
export const checkUserConfig = (next: UserConfig): void => void opsdConfig(next);

/** One line per trigger: what a person trusts when they trust the set. */
export function triggerLines(defs: readonly TriggerDef[]): string[] {
  return byName(defs).map((d) => {
    const where = d.runs_on ? `  runs_on ${d.runs_on.join(', ')}` : '';
    const off = d.enabled ? '' : '  (enabled: false)';
    const prompt = d.prompt ? `  prompt ${JSON.stringify(d.prompt)}` : '';
    const params = d.params ? `  params ${JSON.stringify(d.params)}` : '';
    return `  ${d.name}  ${triggerWhen(d)}  ${triggerTarget(d)}${prompt}${params}${where}${off}`;
  });
}

const byName = <T extends { name: string }>(xs: readonly T[]): T[] =>
  [...xs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/**
 * The fields of a trigger that {@link triggersHash} covers, as `[key, value]` in the order it
 * reads them; unset ones are left out. A description is not one of them. `webhook.secret` is the
 * name of the value in `secrets.yml`, never the value.
 */
export function triggerHashedFields(def: TriggerDef): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const put = (k: string, v: unknown): void => {
    if (v === undefined || v === null) return;
    out.push([k, typeof v === 'string' ? v : JSON.stringify(v)]);
  };
  put('every', def.every);
  put('at', def.at);
  put('cron', def.cron);
  put('action', def.action);
  put('agent', def.agent);
  put('prompt', def.prompt);
  put('task', def.task);
  put('workflow', def.workflow);
  put('params', def.params);
  put('title', def.title);
  put('repeat', def.repeat);
  put('runs_on', def.runs_on);
  put('enabled', def.enabled);
  if (def.webhook) {
    put('webhook.verify', def.webhook.verify);
    put('webhook.secret', def.webhook.secret);
    put('webhook.header', def.webhook.header);
    put('webhook.delivery_header', def.webhook.delivery_header);
    put('webhook.rate', def.webhook.rate);
  }
  return out;
}

// ---- The view ----------------------------------------------------------------------------------

/** One trigger in the view: {@link TriggerView} and what a person reviews before trusting it. */
export interface AutomationTrigger extends TriggerView {
  /** The fields the set's hash covers; empty when the file has errors. */
  fields: Array<[string, string]>;
  /** The file's errors, when it has any: it is not in the trusted set and never fires. */
  errors: string[];
  /** For a trigger with a `webhook` section. */
  webhook?: {
    verify: string;
    /** The name of the value in `secrets.yml`; the value never leaves swarmupd. */
    secret: string;
    /** `secrets.yml` holds a value of at least 16 characters for it. */
    secret_ok: boolean;
    /** Why the listener cannot use the secret; names the secret, never its value. */
    secret_why?: string;
    /** A person approved direct actions for it here (`swarmupd.hooks.direct.<root>.<name>`). */
    direct: boolean;
  };
}

/** A root's merge checks in `swarm.yaml`, as a person reviews them. */
export interface AutomationChecks {
  trust: ChecksTrust;
  hash: string;
  checks: Array<{ name: string; run: string; paths: string[] }>;
}

/** Where a root's triggers stand on this machine. */
export type AutomationStatus = 'off' | 'none' | 'untrusted' | 'changed' | 'trusted';

/** One root in the view. */
export interface AutomationRoot {
  root: string;
  /** This machine turned the root's triggers on (`swarmupd.triggers.<root>`). */
  on: boolean;
  /** `off` while not turned on here, else where trust of the trigger set stands. */
  status: AutomationStatus;
  /** Trust of the trigger set, whether or not the triggers are on. */
  trust: 'none' | 'trusted' | 'untrusted' | 'changed';
  /** The hash of the triggers that read; null for none. */
  hash: string | null;
  /** Trigger files with errors: never trusted, never fired. */
  broken: number;
  /** `swarm.yaml` has errors, so its merge checks cannot be read or trusted. */
  swarm_error?: string;
  triggers: AutomationTrigger[];
  /** Null when `swarm.yaml` names no merge checks. */
  checks: AutomationChecks | null;
}

/** The inbound listener as the view shows it. */
export interface AutomationHooks {
  /** `swarmupd.hooks.enabled` in the user config. */
  enabled: boolean;
  host: string;
  port: number;
  /** What the running swarmupd's listener does: `off`, `listening` or `failed` to listen. */
  listener: 'off' | 'listening' | 'failed';
  /** Where it listens, while `listening`. */
  at?: { host: string; port: number };
  error?: string;
  /** The config and the running listener differ: a swarmupd restart applies the config. */
  restart: boolean;
  /** The last lines of `hooks.log`, oldest first. */
  log: HookLogEntry[];
}

export interface AutomationView {
  /** This machine's `machine` name, which `runs_on` names; null when unset. */
  machine: string | null;
  roots: AutomationRoot[];
  hooks: AutomationHooks;
}

/** The last {@link AUTOMATION_LOG_LINES} entries of `hooks.log` text; unreadable lines skipped. */
export function hookLogEntries(text: string, n = AUTOMATION_LOG_LINES): HookLogEntry[] {
  const out: HookLogEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as HookLogEntry;
      if (e && typeof e === 'object' && typeof e.at === 'string') out.push(e);
    } catch {
      // A line cut by a rotation or a crash.
    }
  }
  return out.slice(-n);
}

/** The Automation view. `logTail` is the end of `hooks.log`. */
export function automationView(sup: Supervisor, logTail: string, now = Date.now()): AutomationView {
  const cfg = hookConfig(sup);
  const machineCfg = sup.machineConfig;
  const roots = hookRoots(sup.ws());
  const machine = sup.userConfig.machine;
  const state = sup.store.readJson<Record<string, number>>(TRIGGERS_STATE, {});
  const views = triggersView(roots, cfg, machine, state, now);
  const env = sup.context.env;
  const out: AutomationRoot[] = roots.map((r) => {
    const set = loadDefinitions(r.dir);
    const defs = set.triggers.flatMap((t) => (t.def ? [t.def] : []));
    const trusted = machineCfg.trusted_defs[r.name];
    const trust = triggersTrust(defs, trusted?.triggers);
    const on = machineCfg.triggers[r.name] === true;
    const triggers = views
      .filter((v) => v.root === r.name)
      .map((v): AutomationTrigger => {
        const info = set.triggers.find((t) => t.name === v.name);
        const def = info?.def ?? null;
        const errors = (info?.problems ?? [])
          .filter((p) => p.severity === 'error')
          .map((p) => `${p.line}:${p.col} ${p.message}`);
        let webhook: AutomationTrigger['webhook'];
        if (def?.webhook) {
          const secret = hookSecret(env, def.webhook.secret);
          webhook = {
            verify: def.webhook.verify,
            secret: def.webhook.secret,
            secret_ok: 'value' in secret,
            ...('why' in secret ? { secret_why: secret.why } : {}),
            direct: machineCfg.hooks.direct[r.name]?.[v.name] === true,
          };
        }
        return {
          ...v,
          fields: def ? triggerHashedFields(def) : [],
          errors,
          ...(webhook ? { webhook } : {}),
        };
      });
    const swarmChecks = set.swarm?.checks;
    const checks: AutomationChecks | null =
      swarmChecks && Object.keys(swarmChecks).length > 0
        ? {
            trust: checksTrust(swarmChecks, trusted?.checks),
            hash: checksHash(swarmChecks),
            checks: Object.keys(swarmChecks)
              .sort()
              .map((name) => ({
                name,
                run: swarmChecks[name]!.run,
                paths: [...(swarmChecks[name]!.paths ?? [])],
              })),
          }
        : null;
    return {
      root: r.name,
      on,
      status: on ? trust : 'off',
      trust,
      hash: triggersHash(defs),
      broken: set.triggers.length - defs.length,
      ...(set.present && !set.swarm
        ? { swarm_error: 'swarm.yaml has errors; fix them in Settings > Definitions' }
        : {}),
      triggers,
      checks,
    };
  });
  return { machine: machine ?? null, roots: out, hooks: hooksStatus(sup, machineCfg, logTail) };
}

function hooksStatus(sup: Supervisor, cfg: OpsdConfig, logTail: string): AutomationHooks {
  let st: HookListenerState | null = null;
  try {
    st = sup.store.readJson<HookListenerState | null>(HOOKS_LISTENER, null);
  } catch {
    st = null;
  }
  // The listener runs in swarmupd's own process; a file another pid wrote is from an earlier one.
  const mine = st && st.pid === process.pid ? st : null;
  const listener = !mine ? 'off' : mine.error ? 'failed' : 'listening';
  return {
    enabled: cfg.hooks.enabled,
    host: cfg.hooks.host,
    port: cfg.hooks.port,
    listener,
    ...(mine && !mine.error ? { at: { host: mine.host, port: mine.port } } : {}),
    ...(mine?.error ? { error: mine.error } : {}),
    restart: cfg.hooks.enabled ? listener !== 'listening' : listener !== 'off',
    log: hookLogEntries(logTail),
  };
}

// ---- The changes -------------------------------------------------------------------------------

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function rootOf(sup: Supervisor, value: unknown): { name: string; dir: string } {
  const name = str(value);
  const r = name ? hookRoots(sup.ws()).find((x) => x.name === name) : undefined;
  if (!r) throw new OpsError(name ? `no root named '${name}'` : 'root: name a root', 2);
  return r;
}

function flag(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') throw new OpsError(`${what}: use true or false`, 2);
  return v;
}

/**
 * Trusts a root's merge checks and trigger set on this machine, as `swarmup defs trust --root R`
 * does. The body names the hash of each set the person reviewed (`checks`, `triggers`); every set
 * the root has must be named with its current hash, or nothing is written: a set that changed
 * after the review is never trusted unseen.
 */
export function trustRoot(sup: Supervisor, body: Record<string, unknown>): TrustChange {
  const r = rootOf(sup, body.root);
  const set = loadDefinitions(r.dir);
  if (set.present && !set.swarm) {
    throw new OpsError(`${r.name}: swarm.yaml has errors; fix them first`, 2);
  }
  const before = sup.machineConfig.trusted_defs[r.name] ?? {};
  const change: TrustChange = { root: r.name };
  const checks = set.swarm?.checks;
  const cHash = checks && Object.keys(checks).length > 0 ? checksHash(checks) : null;
  const tHash = triggersHash(set.triggers.flatMap((t) => (t.def ? [t.def] : [])));
  if (!cHash && !tHash) {
    throw new OpsError(`${r.name}: no merge checks and no triggers; nothing to trust`, 2);
  }
  const reviewed = (kind: 'checks' | 'triggers', hash: string | null): void => {
    const sent = body[kind] ?? null;
    if (sent === hash) return;
    throw new OpsError(
      `${r.name}: the ${kind === 'checks' ? 'merge checks' : 'triggers'} changed since you reviewed them; review them again`,
      1,
    );
  };
  reviewed('checks', cHash);
  reviewed('triggers', tHash);
  if (cHash && before.checks !== cHash) change.checks = cHash;
  if (tHash && before.triggers !== tHash) change.triggers = tHash;
  if (change.checks !== undefined || change.triggers !== undefined) {
    sup.editConfig((doc) => applyTrust(doc, [change]), checkUserConfig);
  }
  return change;
}

/** Takes back a root's trust, as `swarmup defs trust --root R --revoke` does. */
export function revokeRoot(sup: Supervisor, body: Record<string, unknown>): void {
  const r = rootOf(sup, body.root);
  sup.editConfig(
    (doc) => applyTrust(doc, [{ root: r.name, checks: null, triggers: null }]),
    checkUserConfig,
  );
}

/** Turns a root's triggers on or off here, as `swarmup triggers on|off --root R` does. */
export function turnTriggers(sup: Supervisor, body: Record<string, unknown>): void {
  const r = rootOf(sup, body.root);
  const on = flag(body.on, 'on');
  sup.editConfig((doc) => applyTriggersOn(doc, r.name, on), checkUserConfig);
}

/** Turns the inbound listener on or off in the config; it applies at swarmupd's next start. */
export function setHooksEnabled(sup: Supervisor, body: Record<string, unknown>): void {
  const on = flag(body.enabled, 'enabled');
  sup.editConfig((doc) => {
    const path = [daemonKeyIn(doc), 'hooks', 'enabled'];
    // Off is the default, so turning it off removes the key.
    if (on) doc.setIn(path, true);
    else if (doc.hasIn(path)) doc.deleteIn(path);
  }, checkUserConfig);
}

/**
 * Approves or takes back direct actions for a webhook trigger here
 * (`swarmupd.hooks.direct.<root>.<trigger>`). Approving needs a trigger with a `webhook` section;
 * taking back works for any name, so an approval outlives no deleted trigger.
 */
export function setDirect(sup: Supervisor, body: Record<string, unknown>): void {
  const r = rootOf(sup, body.root);
  const name = str(body.trigger);
  if (!name || !TRIGGER_NAME_RE.test(name)) throw new OpsError('trigger: name a trigger', 2);
  const on = flag(body.on, 'on');
  if (on) {
    const t = loadDefinitions(r.dir).triggers.find((x) => x.name === name);
    if (!t?.def?.webhook) {
      throw new OpsError(`${r.name} has no webhook trigger named ${name}`, 2);
    }
  }
  sup.editConfig((doc) => {
    const key = daemonKeyIn(doc);
    const path = [key, 'hooks', 'direct', r.name, name];
    if (on) {
      doc.setIn(path, true);
      return;
    }
    if (doc.hasIn(path)) doc.deleteIn(path);
    const entry = doc.getIn([key, 'hooks', 'direct', r.name]) as { items?: unknown[] } | undefined;
    if (entry?.items?.length === 0) doc.deleteIn([key, 'hooks', 'direct', r.name]);
  }, checkUserConfig);
}
