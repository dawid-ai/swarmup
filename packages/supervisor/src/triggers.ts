/**
 * Git triggers (W5 phase 4): which of each root's `triggers/*.yaml` this machine runs, which are
 * due, and the view `swarmup triggers list` prints. swarmupd fires them in `runSchedules`, next to
 * the machine's own `swarmupd.schedules`; `triggers.json` in the state folder records when each
 * last fired here, so a restart never fires one fire time twice.
 *
 * A trigger fires only when the machine consents three times over: the root's triggers are on
 * (`swarmupd.triggers.<root>`), a person trusted the root's exact trigger set
 * (`swarmupd.trusted_defs.<root>.triggers`, Decision 7), and for `action: run` the agent may be
 * woken here (`swarmupd.agents.<id>.wake`) and has an active role file in the store.
 */
import type { AgentDef, DefinitionSet, TriggerDef } from '@swarmup/core';
import {
  loadDefinitions,
  nextTriggerFire,
  roleInactive,
  triggerDue,
  triggerRunsOn,
  triggersHash,
  triggersTrust,
  triggerTarget,
  triggerWhen,
} from '@swarmup/core';
import type { OpsdConfig } from './config.js';

/** The state file, in swarmupd's state folder: when each trigger last fired, by key. */
export const TRIGGERS_STATE = 'triggers.json';

/** A root whose triggers are read. */
export interface TriggerRoot {
  name: string;
  dir: string;
}

/** What of the machine config decides whether a trigger fires here. */
export type TriggerConfig = Pick<OpsdConfig, 'triggers'> &
  Partial<Pick<OpsdConfig, 'trusted_defs' | 'agents' | 'hooks'>>;

/** The key of a trigger in {@link TRIGGERS_STATE}: `<root>/<name>`. */
export const triggerKey = (root: string, name: string): string => `${root}/${name}`;

/** Where a root's trigger set stands on this machine. */
export interface RootTriggers {
  root: string;
  set: DefinitionSet;
  defs: TriggerDef[];
  hash: string | null;
  trust: 'none' | 'trusted' | 'untrusted' | 'changed';
}

function rootTriggers(r: TriggerRoot, cfg: TriggerConfig): RootTriggers {
  const set = loadDefinitions(r.dir);
  const defs = set.triggers.flatMap((t) => (t.def ? [t.def] : []));
  return {
    root: r.name,
    set,
    defs,
    hash: triggersHash(defs),
    trust: triggersTrust(defs, cfg.trusted_defs?.[r.name]?.triggers),
  };
}

/** Why a trigger does not fire on this machine, or null when it does. */
function notHere(
  rt: RootTriggers,
  def: TriggerDef | null,
  cfg: TriggerConfig,
  machine: string | undefined,
): string | null {
  return gateBlocker(rt, def, cfg, machine) ?? (def ? runBlocker(rt, def, cfg) : null);
}

/** Why the machine's consent, its trust, `enabled` or `runs_on` stop a trigger here, or null. */
function gateBlocker(
  rt: RootTriggers,
  def: TriggerDef | null,
  cfg: TriggerConfig,
  machine: string | undefined,
): string | null {
  const root = rt.root;
  if (!def) return 'has errors (swarmup validate)';
  if (cfg.triggers[root] !== true) return `off here (swarmupd.triggers.${root} is not true)`;
  if (rt.trust === 'changed') {
    return `the triggers changed since this machine trusted them (swarmup defs trust --root ${root})`;
  }
  if (rt.trust !== 'trusted') return `not trusted here (swarmup defs trust --root ${root})`;
  if (!def.enabled) return 'enabled: false';
  if (!triggerRunsOn(def, machine)) {
    return machine
      ? `runs_on does not name ${machine}`
      : 'runs_on names machines, and this machine sets no `machine` name in the user config';
  }
  return null;
}

/** Why a `run` trigger's run may not start here (the agent does not wake, no active role), or null. */
function runBlocker(rt: RootTriggers, def: TriggerDef, cfg: TriggerConfig): string | null {
  if (def.action === 'run' && def.agent) {
    if (cfg.agents?.[def.agent]?.wake !== true) {
      return `swarmupd.agents.${def.agent}.wake is not true on this machine`;
    }
    const role = rt.set.agents.find((a: AgentDef) => a.id === def.agent);
    if (!role) return `${def.agent} has no role file in this store`;
    const inactive = roleInactive(role);
    if (inactive) return inactive;
  }
  return null;
}

/** One trigger as `swarmup triggers list` shows it. */
export interface TriggerView {
  root: string;
  name: string;
  file: string;
  /** `every 30m`, `at 09:00`, `cron ...`; empty when the file has errors. */
  when: string;
  /** `run claude:pm`, `workflow bugfix`, `repeat weekly`; empty when the file has errors. */
  target: string;
  enabled: boolean;
  runs_on?: string[];
  /** This machine turned the root's triggers on. */
  consent: boolean;
  /** Whether a person trusted the root's trigger set here. */
  trust: RootTriggers['trust'];
  /** It fires on this machine. */
  here: boolean;
  /**
   * For a trigger with a `webhook` section that fires here: what a delivery does, `finding` (a
   * finding for triage) or `direct` (the action, as `swarmupd.hooks.direct` approves).
   */
  hook?: 'finding' | 'direct';
  /** Why it does not fire here. */
  why?: string;
  last_fire: string | null;
  /** When it fires next here (ISO); null when it does not fire here. */
  next_fire: string | null;
}

/** Every trigger of `roots`, with whether and when it fires on this machine. */
export function triggersView(
  roots: readonly TriggerRoot[],
  cfg: TriggerConfig,
  machine: string | undefined,
  state: Record<string, number>,
  now: number,
): TriggerView[] {
  const out: TriggerView[] = [];
  for (const r of roots) {
    const rt = rootTriggers(r, cfg);
    for (const t of rt.set.triggers) {
      const gate = gateBlocker(rt, t.def, cfg, machine);
      const run = !gate && t.def ? runBlocker(rt, t.def, cfg) : null;
      // A webhook-only trigger still files findings when its agent may not start here.
      const hookOnly = !!t.def?.webhook && !t.def.every && !t.def.at && !t.def.cron;
      const why = gate ?? (hookOnly ? null : run);
      const direct = !run && cfg.hooks?.direct[r.name]?.[t.name] === true;
      const last = state[triggerKey(r.name, t.name)];
      let next: number | null = null;
      if (!why && t.def) next = nextTriggerFire(t.def, last, now);
      out.push({
        root: r.name,
        name: t.name,
        file: t.file,
        when: t.def ? triggerWhen(t.def) : '',
        target: t.def ? triggerTarget(t.def) : '',
        enabled: t.def?.enabled ?? false,
        ...(t.def?.runs_on ? { runs_on: t.def.runs_on } : {}),
        consent: cfg.triggers[r.name] === true,
        trust: rt.trust,
        here: !why,
        ...(why ? { why } : {}),
        ...(!gate && t.def?.webhook ? { hook: direct ? 'direct' : 'finding' } : {}),
        last_fire: last !== undefined ? new Date(last).toISOString() : null,
        next_fire: next === null ? null : new Date(next).toISOString(),
      });
    }
  }
  return out;
}

/** A trigger that fires now. */
export interface DueTrigger {
  root: string;
  key: string;
  def: TriggerDef;
}

/** What {@link dueTriggers} found. */
export interface DueTriggers {
  due: DueTrigger[];
  /** Keys of `at` and `cron` triggers active here with no record: the caller records `now`. */
  baselines: string[];
  /**
   * Keys of every trigger that fires on this machine. A record of any other key is stale: the
   * caller drops it, so a trigger that becomes active again starts from then, never from a time
   * weeks ago.
   */
  active: string[];
  /** Roots this machine turned triggers on for whose set it does not trust. */
  untrusted: Array<{ root: string; trust: 'untrusted' | 'changed'; count: number; hash: string }>;
}

/**
 * The triggers of `roots` that fire on this machine now (see {@link DueTriggers}). Only roots
 * this machine turned triggers on for are read.
 */
export function dueTriggers(
  roots: readonly TriggerRoot[],
  cfg: TriggerConfig,
  machine: string | undefined,
  state: Record<string, number>,
  now: number,
): DueTriggers {
  const out: DueTriggers = { due: [], baselines: [], active: [], untrusted: [] };
  for (const r of roots) {
    if (cfg.triggers[r.name] !== true) continue;
    const rt = rootTriggers(r, cfg);
    if ((rt.trust === 'untrusted' || rt.trust === 'changed') && rt.hash) {
      out.untrusted.push({ root: r.name, trust: rt.trust, count: rt.defs.length, hash: rt.hash });
      continue;
    }
    for (const t of rt.set.triggers) {
      if (notHere(rt, t.def, cfg, machine) || !t.def) continue;
      const key = triggerKey(r.name, t.name);
      out.active.push(key);
      const when = triggerDue(t.def, state[key], now);
      if (when === 'baseline') out.baselines.push(key);
      else if (when === 'fire') out.due.push({ root: r.name, key, def: t.def });
    }
  }
  return out;
}

/** A trigger a webhook delivery may fire on this machine (see {@link hookTarget}). */
export interface HookTarget {
  root: string;
  dir: string;
  def: TriggerDef & { webhook: NonNullable<TriggerDef['webhook']> };
  /** A person approved direct actions for it here (`swarmupd.hooks.direct.<root>.<name>`). */
  approved: boolean;
  /**
   * Why a delivery files a finding instead of running the action, or null when the machine
   * approved direct actions for the trigger and the action may run here.
   */
  notDirect: string | null;
}

/**
 * The trigger `root`/`name` a webhook delivery fires on this machine (W8 phase 4), or why none:
 * the machine turned the root's triggers on, trusts its exact trigger set, and the trigger reads,
 * has a `webhook` section, is enabled and runs here. The listener answers 404 for every `why`,
 * so a caller learns nothing of which roots or triggers exist. Direct actions need
 * `swarmupd.hooks.direct.<root>.<name>: true` and, for `run`, an agent that wakes here.
 */
export function hookTarget(
  roots: readonly TriggerRoot[],
  cfg: TriggerConfig,
  machine: string | undefined,
  root: string,
  name: string,
): HookTarget | { why: string } {
  const r = roots.find((x) => x.name === root);
  if (!r) return { why: `no root named ${root}` };
  if (cfg.triggers[root] !== true)
    return { why: `off here (swarmupd.triggers.${root} is not true)` };
  const rt = rootTriggers(r, cfg);
  const t = rt.set.triggers.find((x) => x.name === name);
  if (!t) return { why: `${root} has no trigger named ${name}` };
  if (t.def && !t.def.webhook) return { why: `${root}/${name} has no webhook section` };
  // A finding needs no agent: the agent's wake and role decide only whether the action runs.
  const why = gateBlocker(rt, t.def, cfg, machine);
  if (why) return { why };
  const def = t.def as HookTarget['def'];
  const approved = cfg.hooks?.direct[root]?.[name] === true;
  const notDirect = approved
    ? runBlocker(rt, def, cfg)
    : `direct actions are not approved here (swarmupd.hooks.direct.${root}.${name} is not true)`;
  return { root, dir: r.dir, def, approved, notDirect };
}
