import type { Workspace } from '@swarmup/core';
import { OpsError, runtimeOf } from '@swarmup/core';
import type { RunRecord } from './runs.js';

export interface ProjectReport {
  project: string;
  opened: number;
  closed: number;
  parked: number;
  /** Open now. */
  open: number;
  /** Blocked now. */
  blocked: number;
}

export interface UsageLine {
  /** An agent id, or a provider such as `claude`. */
  key: string;
  runs: number;
  minutes: number;
  tokens: number;
}

/** One answer, unblock or approving verdict, and the tasks it let move (AO-0068). */
export interface AnswerLine {
  task: string;
  event: string;
  type: string;
  actor: string;
  at: string;
  /** Tasks freed, direct and indirect. */
  unblocked: number;
  waitedMinutes?: number;
  accepted?: boolean;
}

/** Answers, unblocks and approving verdicts in the window, and what they unblocked (AO-0068). */
export interface AnswersReport {
  given: number;
  /** Those that recorded what they freed; older events did not. */
  measured: number;
  /** Tasks freed by the measured ones, direct and indirect. */
  unblocked: number;
  /** Tasks freed per measured answer, the median. */
  medianUnblocked: number;
  /** Minutes from the ask, block or review request to the answer, the median. */
  medianWaitMinutes: number | null;
  /**
   * Replies to a request that carried a recommendation, and those that took it. Replies include
   * changes verdicts, which reject a review's recommendation without unblocking anything.
   */
  recommended: number;
  accepted: number;
  /** Up to 5 measured answers that freed the most tasks. */
  top: AnswerLine[];
}

export interface Report {
  from: string;
  to: string;
  /** The project the report covers; null for every project. */
  project: string | null;
  projects: ProjectReport[];
  agents: UsageLine[];
  providers: UsageLine[];
  decisions: Array<{ id: string; question: string; choice: string; at: string }>;
  channels: Array<{ channel: string; posts: number }>;
  answers: AnswersReport;
  totals: { opened: number; closed: number; runs: number; minutes: number; tokens: number };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round(((s[mid - 1]! + s[mid]!) / 2) * 10) / 10;
}

/** `45 min`, `3 h 5 min` or `2 d 4 h`. */
export function waitText(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  if (h < 24) {
    const m = Math.round(minutes - h * 60);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/**
 * What happened between `from` and `to` (ms): per project, tasks opened, closed, parked, and open
 * and blocked now; runs, minutes and tokens per agent and provider; decisions taken; channel posts;
 * answers given and the tasks they unblocked.
 *
 * With `project`, tasks, answers and runs count only for that project (a name or an alias), and
 * decisions only when they belong to one of its tasks. Channel posts have no project and stay
 * workspace-wide.
 */
export function buildReport(
  ws: Workspace,
  runs: RunRecord[],
  from: number,
  to: number,
  opts: { project?: string } = {},
): Report {
  if (!(from < to)) throw new OpsError('report: the window must end after it starts', 2);
  const fromIso = new Date(from).toISOString();
  const toIso = new Date(to).toISOString();
  const inWindow = (iso: string | undefined): boolean => !!iso && iso >= fromIso && iso < toIso;
  // A project given by alias matches the name each root resolves it to.
  const only = opts.project;
  const names = only ? new Set([only, ...ws.roots.map((r) => r.projectName(only))]) : null;
  const inProject = (name: string | undefined): boolean => !names || (!!name && names.has(name));
  const tasksIn = new Set<string>();

  const projects = new Map<string, ProjectReport>();
  const project = (name: string): ProjectReport => {
    let p = projects.get(name);
    if (!p) {
      p = { project: name, opened: 0, closed: 0, parked: 0, open: 0, blocked: 0 };
      projects.set(name, p);
    }
    return p;
  };
  const answers: AnswerLine[] = [];
  let given = 0;
  // Recommendation statistics count every reply that records `accepted`, including changes
  // verdicts, which are not answers because they unblock nothing.
  let recommended = 0;
  let accepted = 0;
  for (const t of ws.list({ all: true })) {
    if (!inProject(t.meta.project ?? t.root)) continue;
    tasksIn.add(`${t.root}/${t.meta.id}`);
    // Answers in the window: only tasks with an event since the window opened can have one.
    if (t.updatedAt >= fromIso) {
      for (const e of ws.showEvents(`${t.root}/${t.meta.id}`).events) {
        const answer =
          e.type === 'answer' ||
          e.type === 'unblock' ||
          (e.type === 'verdict' && e.verdict === 'approve');
        if (!inWindow(e.at)) continue;
        if ((answer || e.type === 'verdict') && e.accepted !== undefined) {
          recommended++;
          if (e.accepted) accepted++;
        }
        if (!answer) continue;
        given++;
        if (!e.freed) continue;
        answers.push({
          task: t.meta.id,
          event: e.id,
          type: e.type,
          actor: e.actor,
          at: e.at,
          unblocked: e.freed.length + (e.freed_indirect?.length ?? 0),
          ...(e.waited_minutes !== undefined ? { waitedMinutes: e.waited_minutes } : {}),
          ...(e.accepted !== undefined ? { accepted: e.accepted } : {}),
        });
      }
    }
    const p = project(t.meta.project ?? t.root);
    if (inWindow(t.meta.created_at)) p.opened++;
    if (!['done', 'parked'].includes(t.status)) p.open++;
    if (t.status === 'blocked' && !t.unblocked) p.blocked++;
    // Closing events in the window; a task closed, reopened and closed again counts once.
    if (t.status === 'done' || t.status === 'parked') {
      const { events } = ws.showEvents(`${t.root}/${t.meta.id}`);
      const last = [...events]
        .reverse()
        .find(
          (e) =>
            e.type === 'done' ||
            e.type === 'park' ||
            (e.type === 'verdict' && e.verdict === 'approve'),
        );
      if (last && inWindow(last.at)) {
        if (t.status === 'parked') p.parked++;
        else p.closed++;
      }
    }
  }

  const agents = new Map<string, UsageLine>();
  const providers = new Map<string, UsageLine>();
  const add = (map: Map<string, UsageLine>, key: string, r: RunRecord, minutes: number): void => {
    const line = map.get(key) ?? { key, runs: 0, minutes: 0, tokens: 0 };
    line.runs++;
    line.minutes += minutes;
    line.tokens += r.tokens;
    map.set(key, line);
  };
  for (const r of runs) {
    // Records written before `project` existed name only the root, which was the project then.
    if (!inWindow(r.started_at) || !inProject(r.project ?? r.root)) continue;
    const end = r.ended_at ? Date.parse(r.ended_at) : Math.min(Date.now(), to);
    const minutes = Math.max(0, Math.round((end - Date.parse(r.started_at)) / 60_000));
    add(agents, r.agent, r, minutes);
    add(providers, runtimeOf(r.agent), r, minutes);
  }

  const decisions = ws
    .decisions({ all: true })
    .filter(
      (d) =>
        d.outcome &&
        inWindow(d.outcome.at) &&
        (!names || (d.meta.task !== undefined && tasksIn.has(`${d.root}/${d.meta.task}`))),
    )
    .map((d) => ({
      id: d.meta.id,
      question: d.meta.question,
      choice: d.outcome!.choice,
      at: d.outcome!.at,
    }));

  const channels = ws
    .channels()
    .map((c) => ({
      channel: c.name,
      posts: ws.channel(c.name).filter((m) => inWindow(m.at)).length,
    }))
    .filter((c) => c.posts > 0);

  const list = [...projects.values()].sort((a, b) => a.project.localeCompare(b.project));
  const byUse = (a: UsageLine, b: UsageLine): number =>
    b.minutes - a.minutes || a.key.localeCompare(b.key);
  const usage = [...agents.values()];
  return {
    from: fromIso,
    to: toIso,
    project: only ?? null,
    projects: list,
    agents: usage.sort(byUse),
    providers: [...providers.values()].sort(byUse),
    decisions,
    channels,
    answers: {
      given,
      measured: answers.length,
      unblocked: answers.reduce((n, a) => n + a.unblocked, 0),
      medianUnblocked: median(answers.map((a) => a.unblocked)) ?? 0,
      medianWaitMinutes: median(
        answers.flatMap((a) => (a.waitedMinutes !== undefined ? [a.waitedMinutes] : [])),
      ),
      recommended,
      accepted,
      top: [...answers]
        .filter((a) => a.unblocked > 0)
        .sort((a, b) => b.unblocked - a.unblocked || a.at.localeCompare(b.at))
        .slice(0, 5),
    },
    totals: {
      opened: list.reduce((n, p) => n + p.opened, 0),
      closed: list.reduce((n, p) => n + p.closed, 0),
      runs: usage.reduce((n, u) => n + u.runs, 0),
      minutes: usage.reduce((n, u) => n + u.minutes, 0),
      tokens: usage.reduce((n, u) => n + u.tokens, 0),
    },
  };
}

/** The report as a short Markdown post for a channel. */
export function reportText(r: Report): string {
  const day = (iso: string): string => iso.slice(0, 10);
  const lines = [
    `Report${r.project ? ` ${r.project}` : ''} ${day(r.from)} to ${day(r.to)}: ${r.totals.closed} closed, ${r.totals.opened} opened, ` +
      `${r.totals.runs} runs, ${r.totals.minutes} min, ${r.totals.tokens} tokens.`,
  ];
  for (const p of r.projects) {
    if (p.opened + p.closed + p.parked === 0 && p.open === 0) continue;
    lines.push(
      `- ${p.project}: ${p.closed} closed, ${p.opened} opened, ${p.open} open (${p.blocked} blocked)`,
    );
  }
  if (r.providers.length) {
    lines.push(
      `Providers: ${r.providers.map((u) => `${u.key} ${u.runs} runs, ${u.minutes} min`).join('; ')}.`,
    );
  }
  if (r.decisions.length) {
    lines.push(`Decided: ${r.decisions.map((d) => `${d.id} ${d.choice}`).join('; ')}.`);
  }
  const a = r.answers;
  if (a.given > 0) {
    const parts = [`${a.given} given`];
    if (a.measured > 0) {
      parts.push(`${a.unblocked} tasks unblocked (median ${a.medianUnblocked} per answer)`);
    }
    if (a.medianWaitMinutes !== null) parts.push(`median wait ${waitText(a.medianWaitMinutes)}`);
    if (a.recommended > 0) {
      parts.push(`${a.accepted} of ${a.recommended} recommendations accepted`);
    }
    lines.push(`Answers: ${parts.join(', ')}.`);
    if (a.top.length) {
      const top = a.top.map(
        (t) =>
          `${t.task} ${t.unblocked} by ${t.actor}` +
          (t.waitedMinutes !== undefined ? ` after ${waitText(t.waitedMinutes)}` : ''),
      );
      lines.push(`Top answers by tasks unblocked: ${top.join('; ')}.`);
    }
  }
  return lines.join('\n');
}

const DAY_MS = 86_400_000;

/**
 * The report window from user input: `from` and `to` (dates or ISO times; `to` defaults to
 * now), or the last `days` whole days (1 to 366, default 7). `what` names the caller in errors.
 */
export function reportWindow(
  input: { days?: string | null; from?: string | null; to?: string | null },
  now = Date.now(),
  what = 'report',
): { from: number; to: number } {
  if (input.from || input.to) {
    if (!input.from) throw new OpsError(`${what}: give from with to`, 2);
    const from = Date.parse(input.from);
    const to = input.to ? Date.parse(input.to) : now;
    if (Number.isNaN(from) || Number.isNaN(to)) {
      throw new OpsError(`${what}: use dates such as 2026-11-01 or ISO times`, 2);
    }
    if (!(from < to)) throw new OpsError(`${what}: the window must end after it starts`, 2);
    if (to - from > 366 * DAY_MS) throw new OpsError(`${what}: at most 366 days`, 2);
    return { from, to };
  }
  const raw = input.days ?? '7';
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 366) {
    throw new OpsError('days: use a whole number from 1 to 366', 2);
  }
  return { from: now - Number(raw) * DAY_MS, to: now };
}
