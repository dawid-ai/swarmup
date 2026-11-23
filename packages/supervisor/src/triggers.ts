/**
 * Git triggers (W5 phase 4): which of each root's `triggers/*.yaml` this machine runs, which are
 * due, and the view `swarmup triggers list` prints. swarmupd fires them in `runSchedules`, next to
 * the machine's own `swarmupd.schedules`; `triggers.json` in the state folder records when each
 * last fired here, so a restart never fires one fire time twice.
 */
import type { TriggerDef } from '@swarmup/core';
import {
  loadDefinitions,
  nextTriggerFire,
  triggerDue,
  triggerRunsOn,
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

/** The key of a trigger in {@link TRIGGERS_STATE}: `<root>/<name>`. */
export const triggerKey = (root: string, name: string): string => `${root}/${name}`;

/** Why a trigger does not fire on this machine, or null when it does. */
function notHere(
  root: string,
  def: TriggerDef | null,
  cfg: Pick<OpsdConfig, 'triggers'>,
  machine: string | undefined,
): string | null {
  if (!def) return 'has errors (swarmup validate)';
  if (cfg.triggers[root] !== true) return `off here (swarmupd.triggers.${root} is not true)`;
  if (!def.enabled) return 'enabled: false';
  if (!def.every && !def.at && !def.cron) return 'webhook triggers are not active yet';
  if (!triggerRunsOn(def, machine)) {
    return machine
      ? `runs_on does not name ${machine}`
      : 'runs_on names machines, and this machine sets no `machine` name in the user config';
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
  /** It fires on this machine. */
  here: boolean;
  /** Why it does not fire here. */
  why?: string;
  last_fire: string | null;
  /** When it fires next here (ISO); null when it does not fire here. */
  next_fire: string | null;
}

/** Every trigger of `roots`, with whether and when it fires on this machine. */
export function triggersView(
  roots: readonly TriggerRoot[],
  cfg: Pick<OpsdConfig, 'triggers'>,
  machine: string | undefined,
  state: Record<string, number>,
  now: number,
): TriggerView[] {
  const out: TriggerView[] = [];
  for (const r of roots) {
    for (const t of loadDefinitions(r.dir).triggers) {
      const why = notHere(r.name, t.def, cfg, machine);
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
        here: !why,
        ...(why ? { why } : {}),
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

/**
 * The triggers of `roots` that fire on this machine now, and the keys of `at` and `cron` triggers
 * seen here for the first time: the caller records `now` for those, and they fire at their next
 * time after it. Only roots this machine turned triggers on for are read.
 */
export function dueTriggers(
  roots: readonly TriggerRoot[],
  cfg: Pick<OpsdConfig, 'triggers'>,
  machine: string | undefined,
  state: Record<string, number>,
  now: number,
): { due: DueTrigger[]; baselines: string[] } {
  const due: DueTrigger[] = [];
  const baselines: string[] = [];
  for (const r of roots) {
    if (cfg.triggers[r.name] !== true) continue;
    for (const t of loadDefinitions(r.dir).triggers) {
      if (notHere(r.name, t.def, cfg, machine) || !t.def) continue;
      const key = triggerKey(r.name, t.name);
      const when = triggerDue(t.def, state[key], now);
      if (when === 'baseline') baselines.push(key);
      else if (when === 'fire') due.push({ root: r.name, key, def: t.def });
    }
  }
  return { due, baselines };
}
