import type { InboxItem, OpsEvent, RunRecord, Task } from '../types';
import { identity } from './identity';
import { shownStatus } from './transitions';

/** The four animated states of the mark, from the brand kit's `animation/status/`. */
export type LoopState = 'working' | 'needs-you' | 'done' | 'failed';

export const LOOP_STATES: readonly LoopState[] = ['working', 'needs-you', 'done', 'failed'];

/** What each state says, as the image's text. `once`: it plays one time and stops on its last frame. */
export const LOOPS: Record<LoopState, { label: string; once: boolean }> = {
  working: { label: 'Working', once: false },
  'needs-you': { label: 'Needs you', once: false },
  done: { label: 'Done', once: true },
  failed: { label: 'Failed', once: true },
};

/** The brand sheet shows the 3D mark only from this size up; under it the flat glyph stays. */
export const LOOP_MIN_PX = 48;

type RunEnd = Pick<RunRecord, 'exit' | 'reason'>;

/**
 * A run that ended on a non-zero exit, a budget, or a lost process. A kill is someone's choice,
 * not a failure. The same rule as `runFailed` in the supervisor's `runs.ts`, which counts
 * **Errors today**.
 */
export function runEndFailed(r: RunEnd): boolean {
  if (r.reason === 'killed') return false;
  return r.reason !== 'exit' || r.exit !== 0;
}

/** The loop for one run; none for a killed run, which neither finished nor failed. */
export function runLoop(r: Pick<RunRecord, 'status' | 'exit' | 'reason'>): LoopState | null {
  if (r.status === 'running') return 'working';
  if (r.reason === 'killed') return null;
  return runEndFailed(r) ? 'failed' : 'done';
}

/** Events that say someone took the task up again after a run ended. */
const RESUMES = new Set(['run-start', 'claim', 'start']);

/** True when the task's last run failed and nobody has taken the task up since. */
function lastRunFailed(events: readonly OpsEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.pending) continue;
    if (RESUMES.has(e.type)) return false;
    if (e.type === 'run-end') return runEndFailed(e);
  }
  return false;
}

/**
 * The loop for one task, from its state and its events:
 * - `done` when it closed;
 * - `needs-you` when a review (to a person, or to nobody by name) or a question waits for a person;
 * - `failed` when its last run failed and nobody has taken it up since;
 * - `working` while an agent or a person holds it.
 * A task in the queue, parked, or waiting on an agent or another task has none.
 */
export function taskLoop(
  t: Pick<
    Task,
    'status' | 'stale' | 'unblocked' | 'reviewer' | 'waitingOn' | 'blockedOn' | 'claimedBy'
  >,
  events: readonly OpsEvent[] = [],
): LoopState | null {
  if (t.status === 'done') return 'done';
  if (t.status === 'parked') return null;
  // A review without a named reviewer sits in the person's queue, as in the task panel's verdict bar.
  if (t.status === 'needs-review' && (!t.reviewer || identity(t.reviewer).human)) {
    return 'needs-you';
  }
  if (
    t.status === 'blocked' &&
    !t.unblocked &&
    !t.blockedOn?.length &&
    t.waitingOn &&
    identity(t.waitingOn).human
  ) {
    return 'needs-you';
  }
  if (lastRunFailed(events)) return 'failed';
  const shown = shownStatus(t);
  if (shown === 'in-progress' || shown === 'claimed') return 'working';
  return null;
}

/** Inbox kinds that hold work up until the person acts; mentions and messages do not. */
const WAITING_KINDS = new Set<InboxItem['kind']>([
  'ask',
  'stranded',
  'triage',
  'review',
  'decide',
  'vote',
]);

/** How many inbox items wait for the person to act. */
export function inboxWaiting(items: readonly Pick<InboxItem, 'kind'>[] | undefined): number {
  return (items ?? []).filter((it) => WAITING_KINDS.has(it.kind)).length;
}

/**
 * The loop for the whole inbox: `needs-you` while a question, a task without an agent, a finding,
 * a review or a vote waits for the person, `done` when the inbox is empty, none while it holds
 * only messages and assigned tasks or has not loaded.
 */
export function inboxLoop(items: readonly Pick<InboxItem, 'kind'>[] | undefined): LoopState | null {
  if (!items) return null;
  if (items.length === 0) return 'done';
  return items.some((it) => WAITING_KINDS.has(it.kind)) ? 'needs-you' : null;
}
