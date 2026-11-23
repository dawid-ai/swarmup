/**
 * Experiments (W5 phase 5): which variant of the definitions a task run gets when nobody named
 * one. Each experiment of `swarm.yaml` takes the task runs its `scope` matches until its `until`
 * day ends; of those, the tasks whose `sha256(experiment id + task ref)`, read as a fraction, is
 * under `share` run the variant and the rest run the base. A task that already ran under the
 * experiment keeps the side its `run-start` event records.
 */
import { createHash } from 'node:crypto';
import type { OpsEvent } from '../model.js';
import type { SwarmExperiment } from './swarm.js';

/** The task run an experiment may take. */
export interface ExperimentSubject {
  /** The agent id, such as `claude:engineer`. */
  agent: string;
  /** The task as `root/ID`. */
  ref: string;
  type?: string;
  labels?: readonly string[];
}

/** An experiment's choice for one task run: the variant, or none for the base side. */
export interface ExperimentPick {
  experiment: string;
  variant?: string;
  /** The task ran under the experiment before, and keeps the side it had. */
  sticky?: boolean;
}

/** `sha256(id + ref)` as a fraction from 0 (inclusive) to 1 (exclusive), from its first 52 bits. */
export function experimentFraction(id: string, ref: string): number {
  const hex = createHash('sha256').update(`${id}${ref}`, 'utf8').digest('hex').slice(0, 13);
  return parseInt(hex, 16) / 2 ** 52;
}

/** Whether `e` still runs at `now`: through the end of its `until` day in UTC. */
export function experimentActive(e: Pick<SwarmExperiment, 'until'>, now: Date): boolean {
  if (!e.until) return true;
  return now.toISOString().slice(0, 10) <= e.until;
}

/** Whether `e`'s scope takes the task run `s`. */
export function experimentTakes(e: Pick<SwarmExperiment, 'scope'>, s: ExperimentSubject): boolean {
  const scope = e.scope;
  if (!scope) return true;
  const role = s.agent.slice(s.agent.indexOf(':') + 1);
  if (scope.agents && !scope.agents.includes(s.agent)) return false;
  if (scope.roles && !scope.roles.includes(role)) return false;
  if (scope.types && !(s.type && scope.types.includes(s.type))) return false;
  if (scope.labels && !(s.labels ?? []).some((l) => scope.labels!.includes(l))) return false;
  return true;
}

/**
 * The side the task's earlier runs had under experiment `e`: the newest `run-start` that names
 * it, or one that ran its variant before experiments were recorded. Undefined when none did.
 */
export function priorSide(
  e: Pick<SwarmExperiment, 'id' | 'variant'>,
  events: readonly OpsEvent[],
): { variant?: string } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type !== 'run-start') continue;
    if (ev.experiment === e.id) return ev.variant ? { variant: ev.variant } : {};
    if (!ev.experiment && ev.variant === e.variant) return { variant: ev.variant };
  }
  return undefined;
}

/**
 * The first active experiment that takes `s`, with the side it puts the task on: the side of an
 * earlier run under it, else the variant when the task's fraction is under `share`, else the
 * base. Null when no experiment takes the run.
 */
export function pickExperiment(
  experiments: readonly SwarmExperiment[],
  s: ExperimentSubject,
  opts: { now: Date; events?: readonly OpsEvent[] },
): ExperimentPick | null {
  for (const e of experiments) {
    if (!experimentActive(e, opts.now) || !experimentTakes(e, s)) continue;
    const prior = opts.events ? priorSide(e, opts.events) : undefined;
    if (prior) {
      return {
        experiment: e.id,
        ...(prior.variant ? { variant: prior.variant } : {}),
        sticky: true,
      };
    }
    return experimentFraction(e.id, s.ref) < e.share
      ? { experiment: e.id, variant: e.variant }
      : { experiment: e.id };
  }
  return null;
}
