// Loop figures for `swarmup report` (AO-0292): how each author and reviewer pair fares, what a
// merged task costs over all its runs, why runs stopped, and how long people took to answer.
// Reviews, merges and answers come from task events; tokens, minutes and stop reasons from the
// run records, the same ones `swarmup runs --all` lists.
import type { OpsEvent } from '@swarmup/core';
import { isHuman, MERGE_ACTOR } from '@swarmup/core';
import type { RunRecord } from './runs.js';
import { stuckRun } from './stuck.js';

/** One task as the loop figures read it. */
export interface LoopsTask {
  root: string;
  id: string;
  title: string;
  events: OpsEvent[];
}

/** Verdicts in the window on work one agent wrote and another reviewed. */
export interface PairLine {
  author: string;
  reviewer: string;
  /** Verdicts the reviewer gave on the author's review requests. */
  reviews: number;
  approve: number;
  changes: number;
  /**
   * Review requests a task needed per approval, the mean: 1 when the first request is approved.
   * Rounds with another reviewer count too; the pair is the one of the approving round. Null
   * without an approval.
   */
  meanRounds: number | null;
}

/** What one merged task cost over all its runs up to the merge. */
export interface MergedLine {
  task: string;
  title: string;
  mergedAt: string;
  /** Runs on the task that started before the merge, review runs included. */
  runs: number;
  reviewRuns: number;
  minutes: number;
  tokens: number;
  /** `changes` verdicts on its review requests before the merge. */
  rejected: number;
}

export interface MergedReport {
  /** Tasks swarmupd merged in the window. */
  tasks: number;
  medianTokens: number | null;
  medianMinutes: number | null;
  /** Up to 5 merged tasks with the most tokens. */
  top: MergedLine[];
}

/**
 * Runs started in the window by how they ended. `stuck` is a run whose end made swarmupd stop
 * its task after too many unfinished runs in a row; `person` is a run someone stopped (`killed`
 * or `stopped`); any other reason, such as `shutdown`, keeps its name.
 */
export interface StopLine {
  reason: string;
  runs: number;
}

export interface StopsReport {
  /** Ended runs per reason, the known reasons first, without reasons that have no run. */
  reasons: StopLine[];
  /** Runs of `exit` with a non-zero exit code. */
  failedExits: number;
  /** Runs started in the window and still running. */
  running: number;
}

/** How long requests waited for the person who answered them. */
export interface HumanWaitLine {
  count: number;
  medianMinutes: number | null;
  longestMinutes: number | null;
  /** The task of the longest wait. */
  longestTask: string | null;
}

export interface LoopsReport {
  pairs: PairLine[];
  merged: MergedReport;
  stops: StopsReport;
  /** Asks a person answered and reviews a person gave a verdict on, in the window. */
  humanWaits: { asks: HumanWaitLine; reviews: HumanWaitLine };
}

/** The reasons a run stops on its own or by a limit, in the order the report lists them. */
export const STOP_REASONS = ['exit', 'budget', 'tokens', 'stuck', 'lost', 'person'] as const;

/** The median, to one decimal; null for no values. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round(((s[mid - 1]! + s[mid]!) / 2) * 10) / 10;
}

function minutesBetween(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
}

function waitLine(waits: Array<{ task: string; minutes: number }>): HumanWaitLine {
  let longest: { task: string; minutes: number } | null = null;
  for (const w of waits) if (!longest || w.minutes > longest.minutes) longest = w;
  return {
    count: waits.length,
    medianMinutes: median(waits.map((w) => w.minutes)),
    longestMinutes: longest?.minutes ?? null,
    longestTask: longest?.task ?? null,
  };
}

/** The reason a run counts under: see {@link StopLine}. */
function stopReason(r: RunRecord, stuck: Set<string>): string {
  if (stuck.has(r.id)) return 'stuck';
  if (r.reason === 'killed' || r.reason === 'stopped') return 'person';
  return r.reason ?? 'unknown';
}

/** Events that take a task out of `blocked`, or put another wait in place of an open ask. */
const WAIT_ENDS = new Set([
  'block',
  'unblock',
  'done',
  'park',
  'reopen',
  'handoff',
  'delegate',
  'review',
  'verdict',
]);

/**
 * Whether the event ends the wait an `ask` opened without answering it, as the fold in
 * `@swarmup/core` clears or replaces the wait. An `assign` that keeps the wait leaves the ask
 * open, and so does a forwarded `ask`, which restarts the wait for its new addressee.
 */
function endsWait(e: OpsEvent): boolean {
  return WAIT_ENDS.has(e.type) || (e.type === 'assign' && !e.keep_wait);
}

/**
 * The loop figures of a window (`fromIso` inclusive to `toIso` exclusive).
 *
 * `tasks` are the tasks in scope with their events, `runs` every run record in scope whatever
 * its start (a merged task counts its runs from before the window too), `windowRuns` those the
 * report counts for the window. `now` (ms) ends a run that is still going.
 */
export function buildLoops(
  tasks: LoopsTask[],
  runs: RunRecord[],
  windowRuns: RunRecord[],
  fromIso: string,
  toIso: string,
  now = Date.now(),
): LoopsReport {
  const inWindow = (iso: string | undefined): boolean => !!iso && iso >= fromIso && iso < toIso;
  const toMs = Date.parse(toIso);

  const pairs = new Map<string, PairLine & { rounds: number[] }>();
  const merges: Array<{ t: LoopsTask; at: string; rejected: number }> = [];
  const stuck = new Set<string>();
  const asks: Array<{ task: string; minutes: number }> = [];
  const reviews: Array<{ task: string; minutes: number }> = [];

  for (const t of tasks) {
    // The open review request, the open ask, and the requests since the last approval.
    let request: { author: string; at: string } | null = null;
    let ask: string | null = null;
    let rounds = 0;
    let rejected = 0;
    let merge: { at: string; rejected: number } | null = null;
    for (const e of t.events) {
      // The wait the ask opened is over or replaced: a later answer is not to this ask.
      if (endsWait(e)) ask = null;
      if (e.type === 'review') {
        request = { author: e.actor, at: e.at };
        rounds++;
      } else if (e.type === 'verdict' && request && e.verdict) {
        // A verdict with no open request is swarmupd reopening a task whose merge failed.
        if (e.verdict === 'changes') rejected++;
        if (inWindow(e.at)) {
          const key = `${request.author}\n${e.actor}`;
          let p = pairs.get(key);
          if (!p) {
            p = {
              author: request.author,
              reviewer: e.actor,
              reviews: 0,
              approve: 0,
              changes: 0,
              meanRounds: null,
              rounds: [],
            };
            pairs.set(key, p);
          }
          p.reviews++;
          p[e.verdict]++;
          if (e.verdict === 'approve') p.rounds.push(rounds);
          if (isHuman(e.actor)) {
            reviews.push({ task: t.id, minutes: minutesBetween(request.at, e.at) });
          }
        }
        if (e.verdict === 'approve') rounds = 0;
        request = null;
      } else if (e.type === 'ask') {
        ask = e.at;
      } else if (e.type === 'answer') {
        if (ask && isHuman(e.actor) && inWindow(e.at)) {
          asks.push({ task: t.id, minutes: minutesBetween(ask, e.at) });
        }
        ask = null;
      } else if (e.type === 'merge' && e.actor === MERGE_ACTOR && inWindow(e.at)) {
        merge = { at: e.at, rejected };
      } else if (e.type === 'block' && inWindow(e.at)) {
        const run = stuckRun(e.body);
        if (run) stuck.add(run);
      }
    }
    if (merge) merges.push({ t, ...merge });
  }

  const byTask = new Map<string, RunRecord[]>();
  for (const r of runs) {
    if (!r.task) continue;
    const list = byTask.get(r.task) ?? [];
    list.push(r);
    byTask.set(r.task, list);
  }
  const merged: MergedLine[] = merges.map(({ t, at, rejected }) => {
    const line: MergedLine = {
      task: t.id,
      title: t.title,
      mergedAt: at,
      runs: 0,
      reviewRuns: 0,
      minutes: 0,
      tokens: 0,
      rejected,
    };
    for (const r of byTask.get(t.id) ?? []) {
      // Records from before `root` existed name no root.
      if ((r.root !== undefined && r.root !== t.root) || r.started_at >= at) continue;
      const end = r.ended_at ? Date.parse(r.ended_at) : Math.min(now, toMs);
      line.runs++;
      if (r.review) line.reviewRuns++;
      line.minutes += Math.max(0, Math.round((end - Date.parse(r.started_at)) / 60_000));
      line.tokens += r.tokens;
    }
    return line;
  });

  const counts = new Map<string, number>();
  let failedExits = 0;
  let running = 0;
  for (const r of windowRuns) {
    if (r.status === 'running') {
      running++;
      continue;
    }
    const reason = stopReason(r, stuck);
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
    if (reason === 'exit' && r.exit !== 0) failedExits++;
  }
  const known: readonly string[] = STOP_REASONS;
  const reasons = [
    ...known.filter((k) => counts.has(k)),
    ...[...counts.keys()].filter((k) => !known.includes(k)).sort(),
  ].map((reason) => ({ reason, runs: counts.get(reason)! }));

  return {
    pairs: [...pairs.values()]
      .map(({ rounds, ...p }) => ({
        ...p,
        meanRounds: rounds.length
          ? Math.round((rounds.reduce((n, x) => n + x, 0) / rounds.length) * 10) / 10
          : null,
      }))
      .sort(
        (a, b) =>
          b.reviews - a.reviews ||
          a.author.localeCompare(b.author) ||
          a.reviewer.localeCompare(b.reviewer),
      ),
    merged: {
      tasks: merged.length,
      medianTokens: median(merged.map((m) => m.tokens)),
      medianMinutes: median(merged.map((m) => m.minutes)),
      top: [...merged]
        .sort((a, b) => b.tokens - a.tokens || a.mergedAt.localeCompare(b.mergedAt))
        .slice(0, 5),
    },
    stops: { reasons, failedExits, running },
    humanWaits: { asks: waitLine(asks), reviews: waitLine(reviews) },
  };
}
