import type { OpsEvent } from './model.js';

/**
 * The event type of a goal brief: a short Markdown text on a milestone or any parent task with
 * its outcome, what is done, what comes next, the open questions and the decisions in force.
 * Each `swarmup brief` writes a new one; the newest wins. History only: it changes no state.
 */
export const BRIEF_TYPE = 'brief';

/** A task's current brief: the newest `brief` event. */
export interface Brief {
  /** The id of the `brief` event. */
  event: string;
  actor: string;
  at: string;
  body: string;
}

/**
 * The newest brief among a task's events, or null when it has none. Events compare in id (ULID)
 * order, as the fold applies them, so every machine picks the same one after a sync. A brief
 * with an empty body is skipped.
 */
export function foldBrief(events: readonly OpsEvent[]): Brief | null {
  let best: OpsEvent | null = null;
  for (const e of events) {
    if (e.type !== BRIEF_TYPE || !e.body.trim()) continue;
    if (!best || e.id > best.id) best = e;
  }
  return best ? { event: best.id, actor: best.actor, at: best.at, body: best.body.trim() } : null;
}
