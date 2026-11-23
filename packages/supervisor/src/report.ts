import type { OpsEvent, TaskView, Workspace } from '@swarmup/core';
import { MERGE_ACTOR, OpsError, runtimeOf } from '@swarmup/core';
import type { LoopsReport, LoopsTask } from './loops.js';
import { buildLoops, median } from './loops.js';
import type { RunRecord } from './runs.js';
import type { AgentScores, ScoreResult, ScoreTask } from './scores.js';
import { gitScorers } from './git-scorers.js';
import { computeScores, scorerLineText, scorerSettings, summarizeScores } from './scores.js';

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
  /** Reviews per author and reviewer, merged task cost, run stops and human answer time. */
  loops: LoopsReport;
  /** Per agent, the scores of the tasks and runs in the window (see scores.ts). */
  scores: AgentScores[];
  totals: { opened: number; closed: number; runs: number; minutes: number; tokens: number };
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
 * Task events kept between reports. Events are only ever added, so a task's last event id and
 * event count, which its folded state carries, tell whether the events read before still stand.
 * swarmupd keeps one for its API, so a report opened again reads only the tasks that changed.
 * Past `maxEvents` the tasks read least recently are dropped.
 */
export class ReportEvents {
  private readonly tasks = new Map<string, { last: string | null; events: OpsEvent[] }>();
  private size = 0;
  /** Tasks whose events were read from disk, for tests and measurements. */
  reads = 0;

  constructor(private readonly maxEvents = 20_000) {}

  /** The events of `t`, read again only when its state shows a new event. */
  get(ws: Workspace, t: TaskView): OpsEvent[] {
    return this.hit(t) ?? this.keep(t, ws.showEvents(`${t.root}/${t.meta.id}`).events);
  }

  /** Reads the events of `t` into the cache unless they are there, without blocking on I/O. */
  async load(ws: Workspace, t: TaskView): Promise<void> {
    if (this.hit(t)) return;
    const root = ws.roots.find((r) => r.name === t.root);
    if (!root) throw new OpsError(`no root named '${t.root}'`, 2);
    this.keep(t, await root.readEventsAsync(t.meta.id));
  }

  private hit(t: TaskView): OpsEvent[] | undefined {
    const key = `${t.root}/${t.meta.id}`;
    const kept = this.tasks.get(key);
    if (!kept || kept.last !== t.lastEvent || kept.events.length !== t.eventCount) return;
    // Most recently used last, so the oldest entries go first.
    this.tasks.delete(key);
    this.tasks.set(key, kept);
    return kept.events;
  }

  private keep(t: TaskView, events: OpsEvent[]): OpsEvent[] {
    const key = `${t.root}/${t.meta.id}`;
    this.reads++;
    const kept = this.tasks.get(key);
    if (kept) {
      this.tasks.delete(key);
      this.size -= kept.events.length;
    }
    // The key comes from the events read, not from the state: a state folded before an event
    // landed then misses once and reads again, instead of keeping events that do not match it.
    this.tasks.set(key, { last: events.at(-1)?.id ?? null, events });
    this.size += events.length;
    for (const [k, v] of this.tasks) {
      if (this.size <= this.maxEvents || k === key) break;
      this.tasks.delete(k);
      this.size -= v.events.length;
    }
    return events;
  }
}

export interface ReportOptions {
  project?: string;
  root?: string;
  /** Events kept from earlier reports; without it the report reads each task it needs once. */
  events?: ReportEvents;
  /**
   * The score rows rubric scorers gave (`rubric_judgments` in state.db, W5 phase 5). The report
   * keeps those of its window's tasks and lists them after the built-in scorers.
   */
  rubric?: readonly ScoreResult[];
}

/** The root and project filters of a report, and the tasks they let through. */
function reportScope(
  ws: Workspace,
  opts: ReportOptions,
): {
  names: Set<string> | null;
  inProject: (name: string | undefined) => boolean;
  tasks: () => TaskView[];
} {
  // `root` narrows tasks, runs and decisions to that data root, before any project filter.
  const root = opts.root;
  if (root && !ws.roots.some((r) => r.name === root)) {
    throw new OpsError(`no root named '${root}'`, 2);
  }
  // A project given by alias matches the name each root resolves it to.
  const only = opts.project;
  const names = only ? new Set([only, ...ws.roots.map((r) => r.projectName(only))]) : null;
  const inProject = (name: string | undefined): boolean => !names || (!!name && names.has(name));
  // Archived tasks count too.
  const tasks = (): TaskView[] =>
    ws
      .list({ all: true })
      .filter((t) => (!root || t.root === root) && inProject(t.meta.project ?? t.root));
  return { names, inProject, tasks };
}

/**
 * {@link buildReport} for swarmupd's API: reads the task events it needs without blocking on
 * I/O, so other API calls go on while a report builds. With `events`, a task read for an earlier
 * report is not read again until it changes, and only the counting runs in one piece.
 */
export async function buildReportAsync(
  ws: Workspace,
  runs: RunRecord[],
  from: number,
  to: number,
  opts: ReportOptions = {},
): Promise<Report> {
  if (!(from < to)) throw new OpsError('report: the window must end after it starts', 2);
  const fromIso = new Date(from).toISOString();
  const events = opts.events ?? new ReportEvents();
  for (const t of reportScope(ws, opts).tasks()) {
    if (t.updatedAt >= fromIso) await events.load(ws, t);
  }
  // Tasks that changed while the events loaded show in the list read now.
  return buildReport(ws, runs, from, to, { ...opts, events });
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
  opts: ReportOptions = {},
): Report {
  if (!(from < to)) throw new OpsError('report: the window must end after it starts', 2);
  const fromIso = new Date(from).toISOString();
  const toIso = new Date(to).toISOString();
  const inWindow = (iso: string | undefined): boolean => !!iso && iso >= fromIso && iso < toIso;
  const only = opts.project;
  const root = opts.root;
  const { names, inProject, tasks } = reportScope(ws, opts);
  const kept = opts.events ?? new ReportEvents();
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
  const loopTasks: LoopsTask[] = [];
  const scoreTasks: ScoreTask[] = [];
  let given = 0;
  // Recommendation statistics count every reply that records `accepted`, including changes
  // verdicts, which are not answers because they unblock nothing.
  let recommended = 0;
  let accepted = 0;
  for (const t of tasks()) {
    tasksIn.add(`${t.root}/${t.meta.id}`);
    // Only a task with an event since the window opened can have an answer or a closing event in
    // it, so the events of the others are never read.
    const events = t.updatedAt >= fromIso ? kept.get(ws, t) : null;
    // Answers in the window.
    if (events) {
      // The approval whose dependents wait for swarmupd's merge (AO-0228): the merge event, or
      // swarmupd's note that it merges nothing, names the tasks it frees, and they count for
      // that approval. Both events must lie in the window: a merge after its end adds nothing,
      // so the report of a past window does not change later.
      let approval: AnswerLine | undefined;
      loopTasks.push({ root: t.root, id: t.meta.id, title: t.meta.title, events });
      scoreTasks.push({ ...loopTasks.at(-1)!, meta: t.meta, status: t.status });
      for (const e of events) {
        if (e.actor === MERGE_ACTOR && (e.type === 'merge' || e.no_merge)) {
          if (approval && e.freed && inWindow(e.at)) {
            approval.unblocked += e.freed.length + (e.freed_indirect?.length ?? 0);
          }
          approval = undefined;
          continue;
        }
        if (e.type === 'verdict') approval = undefined;
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
        const line: AnswerLine = {
          task: t.meta.id,
          event: e.id,
          type: e.type,
          actor: e.actor,
          at: e.at,
          unblocked: e.freed.length + (e.freed_indirect?.length ?? 0),
          ...(e.waited_minutes !== undefined ? { waitedMinutes: e.waited_minutes } : {}),
          ...(e.accepted !== undefined ? { accepted: e.accepted } : {}),
        };
        answers.push(line);
        if (e.type === 'verdict') approval = line;
      }
    }
    const p = project(t.meta.project ?? t.root);
    if (inWindow(t.meta.created_at)) p.opened++;
    if (!['done', 'parked'].includes(t.status)) p.open++;
    if (t.status === 'blocked' && !t.unblocked) p.blocked++;
    // Closing events in the window; a task closed, reopened and closed again counts once.
    if (events && (t.status === 'done' || t.status === 'parked')) {
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
  const scopedRuns: RunRecord[] = [];
  const windowRuns: RunRecord[] = [];
  for (const r of runs) {
    // Records written before `project` existed name only the root, which was the project then.
    if (root && r.root !== root) continue;
    if (!inProject(r.project ?? r.root)) continue;
    scopedRuns.push(r);
    if (!inWindow(r.started_at)) continue;
    windowRuns.push(r);
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
        (!root || d.root === root) &&
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
    loops: buildLoops(loopTasks, scopedRuns, windowRuns, fromIso, toIso),
    scores: reportScores(
      ws,
      scoreTasks,
      scopedRuns,
      from,
      to,
      (opts.rubric ?? []).filter((r) => tasksIn.has(r.subject) && inWindow(r.at)),
    ),
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
  lines.push(...loopsLines(r.loops));
  for (const a of r.scores) {
    lines.push(`Scores of ${a.agent}: ${a.scorers.map(scorerLineText).join('; ')}.`);
  }
  return lines.join('\n');
}

/**
 * The scores of a report's window, the rubric scorers' rows after the built-in ones; a bad
 * `swarmupd.scorers` setting falls back to defaults.
 */
function reportScores(
  ws: Workspace,
  tasks: ScoreTask[],
  runs: RunRecord[],
  from: number,
  to: number,
  rubric: ScoreResult[],
): AgentScores[] {
  let settings = {};
  try {
    settings = scorerSettings(ws.user);
  } catch {
    // `swarmup scores` reports the setting's error.
  }
  return summarizeScores(
    [...computeScores({ tasks, runs }, { settings, from, to, stores: gitScorers(ws) }), ...rubric],
    { settings },
  );
}

/** The loop figures as report lines; a figure with nothing to count has no line. */
function loopsLines(l: LoopsReport): string[] {
  const lines: string[] = [];
  const n = (count: number, one: string): string => `${count} ${one}${count === 1 ? '' : 's'}`;
  if (l.pairs.length) {
    const pairs = l.pairs.map(
      (p) =>
        `${p.author} > ${p.reviewer} ${n(p.reviews, 'review')}, ${p.approve} approved, ` +
        `${p.changes} changes` +
        (p.meanRounds !== null ? `, ${p.meanRounds} rounds to approve` : ''),
    );
    lines.push(`Reviews by author > reviewer: ${pairs.join('; ')}.`);
  }
  const m = l.merged;
  if (m.tasks > 0) {
    lines.push(
      `Merged tasks: ${m.tasks}, median ${m.medianTokens} tokens and ` +
        `${waitText(m.medianMinutes ?? 0)} in runs per task.`,
    );
    const top = m.top.map(
      (t) =>
        `${t.task} ${t.tokens} tokens, ${waitText(t.minutes)}, ${n(t.runs, 'run')}` +
        (t.rejected ? `, ${n(t.rejected, 'rejected round')}` : ''),
    );
    lines.push(`Top merged tasks by tokens: ${top.join('; ')}.`);
  }
  const s = l.stops;
  if (s.reasons.length || s.running) {
    const parts = s.reasons.map(
      (x) =>
        `${x.reason === 'person' ? 'stopped by a person' : x.reason} ${x.runs}` +
        (x.reason === 'exit' && s.failedExits ? ` (${s.failedExits} failed)` : ''),
    );
    if (s.running) parts.push(`still running ${s.running}`);
    lines.push(`Run stops: ${parts.join(', ')}.`);
  }
  const wait = (what: string, w: LoopsReport['humanWaits']['asks']): string[] =>
    w.count === 0
      ? []
      : [
          `${n(w.count, what)}, median ${waitText(w.medianMinutes ?? 0)}, ` +
            `longest ${waitText(w.longestMinutes ?? 0)} (${w.longestTask})`,
        ];
  const waits = [...wait('ask', l.humanWaits.asks), ...wait('review', l.humanWaits.reviews)];
  if (waits.length) lines.push(`Human time to answer: ${waits.join('; ')}.`);
  return lines;
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
    // A window that ends now takes in now: its end is exclusive, and an event of this very
    // millisecond was left out of the report asked for right after it.
    const to = input.to ? Date.parse(input.to) : now + 1;
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
  return { from: now - Number(raw) * DAY_MS, to: now + 1 };
}
