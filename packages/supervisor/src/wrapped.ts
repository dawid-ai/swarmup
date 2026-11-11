// Wrapped cards (AO-0084): a short card sequence for a project or a window, built from the report
// and the replay timeline of the same window. Counts that `swarmup report` also shows (tasks closed
// and opened, run minutes, the busiest agent) come from the report, so the two always agree; the
// rest comes from the timeline, which the report does not cover.
import type { Timeline } from '@swarmup/core';
import type { Report } from './report.js';
import { waitText } from './report.js';

export interface WrappedTask {
  task: string;
  title: string;
}

export interface Wrapped {
  from: string;
  to: string;
  /** The project the cards cover; null for every project. */
  project: string | null;
  /** Tasks closed and opened in the window, as in the report's totals. */
  closed: number;
  opened: number;
  /** Minutes agents spent in runs, as in the report's totals, and the same in hours. */
  agentMinutes: number;
  agentHours: number;
  /** The timeline's estimate of the minutes humans spent acting (a floor). */
  humanMinutes: number;
  /** The agent with the most run minutes: the report's first agent line. */
  busiest: { agent: string; runs: number; minutes: number; tokens: number } | null;
  /** The task with the most review rounds requested in the window. */
  rally:
    | (WrappedTask & {
        rounds: number;
        /** The verdict of its last round in the window, when one came. */
        verdict: 'approve' | 'changes' | null;
        /** Everyone who wrote or reviewed a round, in order of first appearance. */
        players: string[];
      })
    | null;
  /** The ask answered quickest in the window. */
  fastest: (WrappedTask & { minutes: number; asked: string | null; at: string }) | null;
  /** The task that waited longest (asks and blocks), clipped to the window. */
  blocked: (WrappedTask & { minutes: number; waits: number }) | null;
}

const MINUTE = 60_000;

function key(x: { root: string; task: string }): string {
  return `${x.root}/${x.task}`;
}

/** Wrapped figures from a report and a timeline of the same window and project. */
export function buildWrapped(report: Report, timeline: Timeline): Wrapped {
  const fromMs = Date.parse(report.from);
  const toMs = Date.parse(report.to);
  const inWindow = (iso: string): boolean => {
    const t = Date.parse(iso);
    return t >= fromMs && t < toMs;
  };
  const top = report.agents[0];

  // Rally: rounds whose request falls in the window, per task; most rounds, then the earliest.
  const rallies = new Map<string, Timeline['reviews']>();
  for (const r of timeline.reviews) {
    if (!inWindow(r.start)) continue;
    const list = rallies.get(key(r)) ?? [];
    list.push(r);
    rallies.set(key(r), list);
  }
  let rally: Wrapped['rally'] = null;
  let rallyStart = '';
  for (const rounds of rallies.values()) {
    const first = rounds[0]!;
    if (
      rally &&
      (rounds.length < rally.rounds ||
        (rounds.length === rally.rounds && first.start >= rallyStart))
    )
      continue;
    const players: string[] = [];
    for (const r of rounds) {
      for (const p of [r.author, r.reviewer, r.decidedBy]) {
        if (p && !players.includes(p)) players.push(p);
      }
    }
    const last = rounds[rounds.length - 1]!;
    rally = {
      task: first.task,
      title: first.title,
      rounds: rounds.length,
      verdict: last.verdict ?? null,
      players,
    };
    rallyStart = first.start;
  }

  // Fastest answer: an answered ask whose answer falls in the window; ties go to the earliest.
  let fastest: Wrapped['fastest'] = null;
  let fastestMs = Infinity;
  for (const w of timeline.waits) {
    if (w.kind !== 'ask' || !w.answered || !w.end || !inWindow(w.end)) continue;
    const ms = Date.parse(w.end) - Date.parse(w.start);
    if (ms > fastestMs || (ms === fastestMs && fastest && w.end >= fastest.at)) continue;
    fastestMs = ms;
    fastest = {
      task: w.task,
      title: w.title,
      minutes: Math.round((ms / MINUTE) * 10) / 10,
      asked: w.waitingOn,
      at: w.end,
    };
  }

  // Most blocked: total wait time inside the window per task.
  const waited = new Map<string, { task: string; title: string; ms: number; waits: number }>();
  for (const w of timeline.waits) {
    const a = Math.max(Date.parse(w.start), fromMs);
    const b = Math.min(w.end ? Date.parse(w.end) : toMs, toMs);
    if (b <= a) continue;
    const t = waited.get(key(w)) ?? { task: w.task, title: w.title, ms: 0, waits: 0 };
    t.ms += b - a;
    t.waits++;
    waited.set(key(w), t);
  }
  let blocked: Wrapped['blocked'] = null;
  let blockedMs = 0;
  for (const t of waited.values()) {
    if (t.ms <= blockedMs) continue;
    blockedMs = t.ms;
    blocked = { task: t.task, title: t.title, minutes: Math.round(t.ms / MINUTE), waits: t.waits };
  }

  return {
    from: report.from,
    to: report.to,
    project: report.project,
    closed: report.totals.closed,
    opened: report.totals.opened,
    agentMinutes: report.totals.minutes,
    agentHours: Math.round((report.totals.minutes / 60) * 10) / 10,
    humanMinutes: timeline.totals.humanMinutes,
    busiest: top
      ? { agent: top.key, runs: top.runs, minutes: top.minutes, tokens: top.tokens }
      : null,
    rally,
    fastest,
    blocked,
  };
}

/** The cards as plain text, one line each, for the terminal and channels. */
export function wrappedText(w: Wrapped): string {
  const day = (iso: string): string => iso.slice(0, 10);
  const lines = [`Wrapped${w.project ? ` ${w.project}` : ''} ${day(w.from)} to ${day(w.to)}`];
  lines.push(`Tasks closed: ${w.closed} (${w.opened} opened)`);
  lines.push(`Agent hours: ${w.agentHours} h in runs against ${w.humanMinutes} human minutes`);
  lines.push(
    w.busiest
      ? `Busiest agent: ${w.busiest.agent}, ${w.busiest.runs} runs, ${waitText(w.busiest.minutes)}`
      : 'Busiest agent: no runs',
  );
  lines.push(
    w.rally
      ? `Longest review rally: ${w.rally.task} ${w.rally.title}, ${w.rally.rounds} round${w.rally.rounds === 1 ? '' : 's'}` +
          (w.rally.verdict === 'approve'
            ? ', approved'
            : w.rally.verdict === 'changes'
              ? ', changes asked'
              : ', open')
      : 'Longest review rally: no reviews',
  );
  lines.push(
    w.fastest
      ? `Fastest answer: ${w.fastest.task} in ${w.fastest.minutes < 1 ? 'under a minute' : waitText(w.fastest.minutes)}` +
          (w.fastest.asked ? ` (asked ${w.fastest.asked})` : '')
      : 'Fastest answer: no asks answered',
  );
  lines.push(
    w.blocked
      ? `Most blocked: ${w.blocked.task} ${w.blocked.title}, ${waitText(w.blocked.minutes)} in ${w.blocked.waits} wait${w.blocked.waits === 1 ? '' : 's'}`
      : 'Most blocked: nothing waited',
  );
  return lines.join('\n');
}
