// Scores (W4): deterministic scorers over the task events and run records SwarmUp already keeps.
// This file is pure: it reads no file. `score-keeper.ts` reads the tasks and keeps the scores.
// Each scorer measures one narrow failure mode, at the level of a run, a task or an agent, and
// names the definition to change when it fails (`lever`). `swarmup scores`, `swarmup report`,
// `GET /api/scores` and swarmupd's `state.db` read them from here.
import type { OpsEvent, TaskMeta, UserConfig } from '@swarmup/core';
import {
  ASK_REASONS,
  daemonSection,
  isHuman,
  MERGE_ACTOR,
  needsHumanReview,
  OpsError,
} from '@swarmup/core';
import type { OrientationStats } from './orientation.js';
import type { RunRecord } from './runs.js';
import { stuckRun } from './stuck.js';

export type ScoreLevel = 'run' | 'task' | 'agent';

/** One score of one subject. */
export interface ScoreResult {
  scorer: string;
  level: ScoreLevel;
  /** `root/ID` for a task, the run id for a run, the agent id for an agent. */
  subject: string;
  /** The agent the score counts for: a task's author, a run's agent, the agent itself. */
  agent: string;
  /** A share from 0 to 1 when `unit` is `ratio`, else a raw number in `unit`. */
  value: number;
  unit: string;
  /** Whether the value meets the scorer's threshold; absent for a scorer without one. */
  pass?: boolean;
  /** What the value is over: criteria, asks, runs, recommendations; 1 for a plain count. */
  n: number;
  /** The task events and runs the value comes from, worst first. */
  evidence: string[];
  /** When the subject happened (approval, merge, run start): what `--since` filters on. */
  at: string;
  /** More figures, such as the minutes next to a merged task's tokens. */
  extra?: Record<string, number>;
  note?: string;
}

/** A task as the scorers read it. */
export interface ScoreTask {
  root: string;
  id: string;
  title: string;
  meta: Pick<TaskMeta, 'type' | 'labels' | 'owner'>;
  status: string;
  events: OpsEvent[];
}

/** Orientation figures for a run, or null when there are none. See `orientation.ts`. */
export type OrientationProvider = (run: RunRecord) => OrientationStats | null | undefined;

export interface ScoreInput {
  tasks: ScoreTask[];
  /** Every run record in scope, whatever its start. */
  runs: RunRecord[];
  orientation?: OrientationProvider;
}

/** What a scorer reads: the input, the window, and per-task facts computed once. */
export interface ScoreContext extends ScoreInput {
  /** Whether an ISO time lies in the window; always true without one. */
  inWindow: (iso: string | undefined) => boolean;
  facts: (t: ScoreTask) => TaskFacts;
}

export interface Scorer {
  id: string;
  description: string;
  level: ScoreLevel;
  unit: string;
  better: 'higher' | 'lower';
  /** The default threshold: `value <= pass` when lower is better, `>=` when higher. */
  pass?: number;
  /** The definition to change when the score is bad. */
  lever: string;
  /**
   * Pure: the scores from `ctx`, with `pass` as the threshold. Task and run scores give every
   * subject; the caller keeps those whose `at` is in the window. Agent scores count only what
   * `ctx.inWindow` lets through.
   */
  score: (ctx: ScoreContext, pass: number | undefined) => ScoreResult[];
}

/** One scorer's settings in `swarmupd.scorers.<id>` of the user config. */
export interface ScorerSetting {
  pass?: number;
  enabled?: boolean;
}

// ---- Task facts ---------------------------------------------------------------------------------

/** What several scorers read of one task. */
export interface TaskFacts {
  /** The agent whose work the task is: the last agent to ask for review, else the last claimer. */
  author: string;
  /** The last approving verdict of a reviewer (not swarmupd's merge). */
  approval: OpsEvent | null;
  /** swarmupd's last `merge` event. */
  merge: OpsEvent | null;
  /** Reviewers' `changes` verdicts before `approval`. */
  changes: OpsEvent[];
  /** swarmupd's `changes` verdicts: merges that failed and sent the task back. */
  mergeFailures: OpsEvent[];
  /** The event that closed the task last, when it is done. */
  closed: OpsEvent | null;
}

function taskFacts(t: ScoreTask): TaskFacts {
  let reviewer = '';
  let claimer = '';
  let approvalAt = -1;
  let merge: OpsEvent | null = null;
  let closed: OpsEvent | null = null;
  const mergeFailures: OpsEvent[] = [];
  t.events.forEach((e, i) => {
    const agent = isAgent(e.actor);
    if (e.type === 'review' && agent) reviewer = e.actor;
    if (e.type === 'claim' && agent) claimer = e.actor;
    if (e.type === 'verdict' && e.verdict === 'approve' && e.actor !== MERGE_ACTOR) approvalAt = i;
    if (e.type === 'verdict' && e.verdict === 'changes' && e.actor === MERGE_ACTOR) {
      mergeFailures.push(e);
    }
    if (e.type === 'merge' && e.actor === MERGE_ACTOR) merge = e;
    if (e.type === 'done' || (e.type === 'verdict' && e.verdict === 'approve')) closed = e;
    if (e.type === 'reopen') closed = null;
  });
  const owner = t.meta.owner && !t.meta.owner.includes('*') ? t.meta.owner : '';
  const approval = approvalAt >= 0 ? t.events[approvalAt]! : null;
  const changes = t.events
    .slice(0, Math.max(0, approvalAt))
    .filter((e) => e.type === 'verdict' && e.verdict === 'changes' && e.actor !== MERGE_ACTOR);
  return {
    author: reviewer || claimer || (owner && isAgent(owner) ? owner : ''),
    approval,
    merge,
    changes,
    mergeFailures,
    closed: t.status === 'done' ? closed : null,
  };
}

const ref = (t: ScoreTask): string => `${t.root}/${t.id}`;

/** An agent's id: not a person, and not swarmupd itself (`opsd:merge`, `opsd:router`). */
function isAgent(actor: string): boolean {
  return !isHuman(actor) && !actor.startsWith('opsd:');
}

/** `value <= pass` or `>= pass` by the scorer's direction; undefined without a threshold. */
function passes(s: Pick<Scorer, 'better'>, value: number, pass: number | undefined) {
  if (pass === undefined) return undefined;
  return s.better === 'lower' ? value <= pass : value >= pass;
}

function round(x: number, places = 3): number {
  const f = 10 ** places;
  return Math.round(x * f) / f;
}

function minutesOf(r: RunRecord, now: number): number {
  const end = r.ended_at ? Date.parse(r.ended_at) : now;
  return Math.max(0, Math.round((end - Date.parse(r.started_at)) / 60_000));
}

// ---- Built-in scorers ---------------------------------------------------------------------------

/** A criterion's result on a verdict, in the `criteria` map that typed `done_when` adds (W1). */
interface CriterionResult {
  result?: string;
  score?: number;
  evidence?: unknown;
  note?: string;
}

const criteriaPassRate: Scorer = {
  id: 'criteria-pass-rate',
  description: "share of the task's criteria marked pass on the approving verdict",
  level: 'task',
  unit: 'ratio',
  better: 'higher',
  pass: 1,
  lever: "the task's done_when criteria and the reviewer role file",
  score(ctx, pass) {
    const out: ScoreResult[] = [];
    for (const t of ctx.tasks) {
      const f = ctx.facts(t);
      const raw = (f.approval as { criteria?: unknown } | null)?.criteria;
      if (!f.approval || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const entries = Object.entries(raw as Record<string, CriterionResult | null>);
      const judged = entries.filter(([, c]) => c?.result === 'pass' || c?.result === 'fail');
      if (judged.length === 0) continue;
      const failed = judged.filter(([, c]) => c?.result === 'fail').map(([id]) => id);
      const value = round((judged.length - failed.length) / judged.length);
      out.push({
        scorer: this.id,
        level: 'task',
        subject: ref(t),
        agent: f.author,
        value,
        unit: this.unit,
        pass: passes(this, value, pass),
        n: judged.length,
        evidence: [f.approval.id],
        at: f.approval.at,
        ...(failed.length ? { note: `failed: ${failed.join(', ')}` } : {}),
      });
    }
    return out;
  },
};

const reviewRounds: Scorer = {
  id: 'review-rounds',
  description: "reviewers' changes verdicts before the approval",
  level: 'task',
  unit: 'rounds',
  better: 'lower',
  pass: 1,
  lever: "the author's role file, the task's done_when and the review prompt",
  score(ctx, pass) {
    const out: ScoreResult[] = [];
    for (const t of ctx.tasks) {
      const f = ctx.facts(t);
      if (!f.approval) continue;
      const value = f.changes.length;
      out.push({
        scorer: this.id,
        level: 'task',
        subject: ref(t),
        agent: f.author,
        value,
        unit: this.unit,
        pass: passes(this, value, pass),
        n: 1,
        evidence: [...f.changes.map((e) => e.id), f.approval.id],
        at: f.approval.at,
      });
    }
    return out;
  },
};

const mergeFailures: Scorer = {
  id: 'merge-failures',
  description: 'merges swarmupd tried and sent back (changes verdicts of opsd:merge)',
  level: 'task',
  unit: 'failures',
  better: 'lower',
  pass: 0,
  lever: 'the merge checks in swarmupd.merge and the review checks',
  score(ctx, pass) {
    const out: ScoreResult[] = [];
    for (const t of ctx.tasks) {
      const f = ctx.facts(t);
      const last = [f.merge, f.mergeFailures.at(-1)]
        .filter((e): e is OpsEvent => !!e)
        .sort((a, b) => a.at.localeCompare(b.at))
        .at(-1);
      if (!last) continue;
      const value = f.mergeFailures.length;
      out.push({
        scorer: this.id,
        level: 'task',
        subject: ref(t),
        agent: f.author,
        value,
        unit: this.unit,
        pass: passes(this, value, pass),
        n: 1,
        evidence: f.mergeFailures.map((e) => e.id).concat(f.merge ? [f.merge.id] : []),
        at: last.at,
      });
    }
    return out;
  },
};

/** Runs by task, for the cost of a task. */
function runsByTask(runs: RunRecord[]): Map<string, RunRecord[]> {
  const out = new Map<string, RunRecord[]>();
  for (const r of runs) {
    if (!r.task) continue;
    const list = out.get(r.task) ?? [];
    list.push(r);
    out.set(r.task, list);
  }
  return out;
}

function costScorer(now: () => number): Scorer {
  return {
    id: 'cost-per-merged-task',
    description: 'tokens over every run of a merged task up to its merge, review runs included',
    level: 'task',
    unit: 'tokens',
    better: 'lower',
    lever: "the task's size and done_when, the role file's budget and the runtime's model",
    score(ctx, pass) {
      const byTask = runsByTask(ctx.runs);
      const out: ScoreResult[] = [];
      for (const t of ctx.tasks) {
        const f = ctx.facts(t);
        if (!f.merge) continue;
        const merged = f.merge.at;
        // Records from before `root` existed name no root.
        const runs = (byTask.get(t.id) ?? []).filter(
          (r) => (r.root === undefined || r.root === t.root) && r.started_at < merged,
        );
        const tokens = runs.reduce((n, r) => n + r.tokens, 0);
        const minutes = runs.reduce((n, r) => n + minutesOf(r, Date.parse(merged) || now()), 0);
        out.push({
          scorer: this.id,
          level: 'task',
          subject: ref(t),
          agent: f.author,
          value: tokens,
          unit: this.unit,
          pass: passes(this, tokens, pass),
          n: runs.length,
          evidence: [...runs].sort((a, b) => b.tokens - a.tokens).map((r) => r.id),
          at: merged,
          extra: { minutes, runs: runs.length, reviewRuns: runs.filter((r) => r.review).length },
        });
      }
      return out;
    },
  };
}

/**
 * How much the person rewrote approved work before publishing it (W8 phase 3): the share of
 * words changed between the approved blob of each published file and what was published, as the
 * `publish` event's `edits` record it. The score counts for the writer of the approved task, not
 * the person who published.
 */
const postApprovalEdits: Scorer = {
  id: 'post-approval-edits',
  description: 'share of words the person changed between the approved text and the published text',
  level: 'task',
  unit: 'ratio',
  better: 'lower',
  pass: 0.1,
  lever: "the writer's role file (the approved task's author), and the brief it worked from",
  score(ctx, pass) {
    const out: ScoreResult[] = [];
    const byId = new Map(ctx.tasks.map((t) => [`${t.root}/${t.id}`, t] as const));
    for (const t of ctx.tasks) {
      const publish = [...t.events].reverse().find((e) => e.type === 'publish' && e.edits);
      const edits = publish?.edits;
      if (!publish || !edits || edits.total <= 0) continue;
      // The writer: the author of the task whose approval the first file comes from.
      const first = edits.files[0];
      const source = first ? byId.get(`${t.root}/${first.task}`) : undefined;
      const agent = source ? ctx.facts(source).author : ctx.facts(t).author;
      const value = round(edits.changed / edits.total);
      const many = edits.files.length > 1;
      out.push({
        scorer: this.id,
        level: 'task',
        subject: ref(t),
        agent,
        value,
        unit: this.unit,
        pass: passes(this, value, pass),
        n: edits.total,
        evidence: [publish.id, ...new Set(edits.files.map((f) => f.verdict))],
        at: publish.at,
        extra: { changed: edits.changed, words: edits.total },
        ...(many
          ? {
              note: edits.files
                .map((f) => `${f.path} ${f.total > 0 ? round(f.changed / f.total) : 0}`)
                .join(', '),
            }
          : {}),
      });
    }
    return out;
  },
};

/** Event types where a person steps into a task: asks to a person count apart. */
const HUMAN_TOUCH_TYPES = new Set(['answer', 'verdict', 'comment']);

const humanTouches: Scorer = {
  id: 'human-touches',
  description: 'asks to a person, and answers, verdicts and comments by a person, on a done task',
  level: 'task',
  unit: 'touches',
  better: 'lower',
  pass: 0,
  lever: "the author's role file, the escalation list and the PM's routing",
  score(ctx, pass) {
    const out: ScoreResult[] = [];
    for (const t of ctx.tasks) {
      const f = ctx.facts(t);
      if (!f.closed) continue;
      const touches = t.events.filter(
        (e) =>
          (e.type === 'ask' && !!e.to && isHuman(e.to) && isAgent(e.actor)) ||
          (HUMAN_TOUCH_TYPES.has(e.type) && isHuman(e.actor)),
      );
      out.push({
        scorer: this.id,
        level: 'task',
        subject: ref(t),
        agent: f.author,
        value: touches.length,
        unit: this.unit,
        pass: passes(this, touches.length, pass),
        n: 1,
        evidence: touches.map((e) => e.id),
        at: f.closed.at,
      });
    }
    return out;
  },
};

const escalationCorrectness: Scorer = {
  id: 'escalation-correctness',
  description:
    "share of an agent's asks to a person on tasks whose type or labels are on the escalation list, or with a --reason only a person can answer",
  level: 'task',
  unit: 'ratio',
  better: 'higher',
  pass: 1,
  lever:
    'the escalation list (HUMAN_REVIEW_LABELS), the task labels, ask --reason and the asking role file',
  score(ctx, pass) {
    const out: ScoreResult[] = [];
    for (const t of ctx.tasks) {
      const escalates = needsHumanReview(t.meta);
      const byAsker = new Map<string, OpsEvent[]>();
      for (const e of t.events) {
        if (e.type !== 'ask' || !e.to || !isHuman(e.to) || !isAgent(e.actor)) continue;
        const list = byAsker.get(e.actor) ?? [];
        list.push(e);
        byAsker.set(e.actor, list);
      }
      for (const [agent, asks] of byAsker) {
        // On a task in the escalation list every ask to a person is right. Elsewhere an ask is right
        // when it names a reason only a person can answer (`ask --reason`), and a miss without one.
        const right = escalates
          ? asks.length
          : asks.filter((e) => (ASK_REASONS as readonly string[]).includes(e.reason ?? '')).length;
        const value = right / asks.length;
        const misses = asks.length - right;
        out.push({
          scorer: this.id,
          level: 'task',
          subject: ref(t),
          agent,
          value,
          unit: this.unit,
          pass: passes(this, value, pass),
          n: asks.length,
          evidence: asks.map((e) => e.id),
          at: asks.at(-1)!.at,
          ...(misses > 0
            ? { note: `${misses} ask(s) to a person off the escalation list, with no --reason` }
            : {}),
        });
      }
    }
    return out;
  },
};

const recommendationAcceptance: Scorer = {
  id: 'recommendation-acceptance',
  description: "share of an agent's recommendations (ask --recommend, review) the decider took",
  level: 'agent',
  unit: 'ratio',
  better: 'higher',
  pass: 0.7,
  lever: "the agent's role file: how it recommends, and what it sends for review",
  score(ctx, pass) {
    const per = new Map<string, { taken: number; total: number; refused: string[]; at: string }>();
    for (const t of ctx.tasks) {
      let asker: string | null = null;
      let author: string | null = null;
      for (const e of t.events) {
        if (e.type === 'ask') asker = e.actor;
        if (e.type === 'review') author = e.actor;
        if (e.accepted === undefined || !ctx.inWindow(e.at)) continue;
        const who = e.type === 'answer' ? asker : e.type === 'verdict' ? author : null;
        if (!who || !isAgent(who)) continue;
        const p = per.get(who) ?? { taken: 0, total: 0, refused: [], at: e.at };
        p.total++;
        if (e.accepted) p.taken++;
        else p.refused.push(`${t.id}#${e.id}`);
        if (e.at > p.at) p.at = e.at;
        per.set(who, p);
      }
    }
    return [...per].map(([agent, p]) => {
      const value = round(p.taken / p.total);
      return {
        scorer: this.id,
        level: 'agent' as const,
        subject: agent,
        agent,
        value,
        unit: this.unit,
        pass: passes(this, value, pass),
        n: p.total,
        evidence: p.refused,
        at: p.at,
      };
    });
  },
};

/** Events around a run that show no work on its task (see `stuck.ts`). */
const NO_WORK = new Set(['claim', 'run-start', 'run-end', 'release', 'start', 'renew']);
const UNFINISHED_RUN = /^run (\S+) ended \(.*\) without finishing/;
/** Stop reasons that are a failure of the run; a person's stop or a shutdown is none. */
const FAILED_REASONS = new Set(['budget', 'tokens', 'lost']);
const NOT_COUNTED = new Set(['killed', 'stopped', 'shutdown']);

/**
 * The runs that ended without progress: named by swarmupd's block of a stuck task, or freed
 * "without finishing" with no work event on the task while they ran.
 */
function noProgressRuns(tasks: ScoreTask[]): Set<string> {
  const out = new Set<string>();
  for (const t of tasks) {
    const started = new Map<string, number>();
    t.events.forEach((e, i) => {
      if (e.type === 'run-start' && e.run) started.set(e.run, i);
      if (e.type === 'block') {
        const run = stuckRun(e.body);
        if (run) out.add(run);
      }
      if (e.type !== 'release') return;
      const run = UNFINISHED_RUN.exec(e.body ?? '')?.[1];
      if (!run) return;
      const from = started.get(run) ?? i;
      if (t.events.slice(from, i).every((x) => NO_WORK.has(x.type))) out.add(run);
    });
  }
  return out;
}

const stuckRuns: Scorer = {
  id: 'stuck-runs',
  description:
    "share of an agent's ended runs that failed: no progress, a failed exit, a budget or token limit, or lost",
  level: 'agent',
  unit: 'ratio',
  better: 'lower',
  pass: 0.1,
  lever: "the role file's budget, the runtime's sandbox and model, and the task's size",
  score(ctx, pass) {
    const noProgress = noProgressRuns(ctx.tasks);
    const per = new Map<string, { failed: string[]; total: number; at: string }>();
    for (const r of ctx.runs) {
      if (r.status !== 'ended' || r.chat || NOT_COUNTED.has(r.reason ?? '')) continue;
      if (!ctx.inWindow(r.started_at)) continue;
      const p = per.get(r.agent) ?? { failed: [], total: 0, at: r.started_at };
      p.total++;
      const failed =
        noProgress.has(r.id) ||
        FAILED_REASONS.has(r.reason ?? '') ||
        (r.reason === 'exit' && r.exit !== 0);
      if (failed) p.failed.push(r.id);
      if (r.started_at > p.at) p.at = r.started_at;
      per.set(r.agent, p);
    }
    return [...per].map(([agent, p]) => {
      const value = round(p.failed.length / p.total);
      return {
        scorer: this.id,
        level: 'agent' as const,
        subject: agent,
        agent,
        value,
        unit: this.unit,
        pass: passes(this, value, pass),
        n: p.total,
        evidence: [...p.failed].reverse(),
        at: p.at,
      };
    });
  },
};

const orientation: Scorer = {
  id: 'orientation',
  description: 'tool calls of a writing run before its first edit',
  level: 'run',
  unit: 'calls',
  better: 'lower',
  pass: 30,
  lever: "the prompt's context (role file, learn notes, KB) and the task body",
  score(ctx, pass) {
    const provider = ctx.orientation;
    if (!provider) return [];
    const out: ScoreResult[] = [];
    for (const r of ctx.runs) {
      // Writing runs only: reviews, questions, chat turns, plan checks and inbox runs edit nothing.
      if (r.status !== 'ended' || !r.task || r.review || r.question || r.chat) continue;
      if (r.plan_check || r.inbox || r.parent) continue;
      const s = provider(r);
      if (!s || !s.edited) continue;
      out.push({
        scorer: this.id,
        level: 'run',
        subject: r.id,
        agent: r.agent,
        value: s.toolCalls,
        unit: this.unit,
        pass: passes(this, s.toolCalls, pass),
        n: 1,
        evidence: [r.id],
        at: r.started_at,
        extra: {
          share: s.resultBytes ? round(s.resultBytesBefore / s.resultBytes) : 0,
          bytesBefore: s.resultBytesBefore,
          bytes: s.resultBytes,
        },
      });
    }
    return out;
  },
};

/** The built-in scorers, in the order reports list them. `now` ends a run still going. */
export function builtinScorers(now: () => number = Date.now): Scorer[] {
  return [
    criteriaPassRate,
    reviewRounds,
    mergeFailures,
    costScorer(now),
    humanTouches,
    escalationCorrectness,
    recommendationAcceptance,
    stuckRuns,
    orientation,
    postApprovalEdits,
  ];
}

export const SCORER_IDS: readonly string[] = builtinScorers().map((s) => s.id);

// ---- Settings -----------------------------------------------------------------------------------

/** `swarmupd.scorers` of the user config, checked: `pass` a number, `enabled` true or false. */
export function scorerSettings(user: UserConfig): Record<string, ScorerSetting> {
  const raw = daemonSection(user)?.scorers;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpsError('swarmupd.scorers: use a map of scorer ids', 2);
  }
  const out: Record<string, ScorerSetting> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!SCORER_IDS.includes(id)) {
      throw new OpsError(`swarmupd.scorers.${id}: no such scorer; use ${SCORER_IDS.join(', ')}`, 2);
    }
    if (v === null || v === undefined) continue;
    if (typeof v !== 'object' || Array.isArray(v)) {
      throw new OpsError(`swarmupd.scorers.${id}: use pass and enabled`, 2);
    }
    const { pass, enabled, ...rest } = v as Record<string, unknown>;
    const extra = Object.keys(rest);
    if (extra.length) {
      throw new OpsError(
        `swarmupd.scorers.${id}: unknown key ${extra[0]}; use pass and enabled`,
        2,
      );
    }
    if (pass !== undefined && (typeof pass !== 'number' || !Number.isFinite(pass))) {
      throw new OpsError(`swarmupd.scorers.${id}.pass: use a number`, 2);
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      throw new OpsError(`swarmupd.scorers.${id}.enabled: use true or false`, 2);
    }
    out[id] = {
      ...(pass !== undefined ? { pass } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    };
  }
  return out;
}

// ---- Computing ----------------------------------------------------------------------------------

export interface ScoreOptions {
  settings?: Record<string, ScorerSetting>;
  /** The window, ms: `from` inclusive, `to` exclusive. Without them, all time. */
  from?: number;
  to?: number;
  /** Ends a run that is still going. */
  now?: () => number;
  scorers?: Scorer[];
}

/** The scorers `settings` leaves on, each with its threshold. */
export function activeScorers(opts: ScoreOptions = {}): Array<{ s: Scorer; pass?: number }> {
  return (opts.scorers ?? builtinScorers(opts.now)).flatMap((s) => {
    const set = opts.settings?.[s.id];
    if (set?.enabled === false) return [];
    const pass = set?.pass ?? s.pass;
    return [pass === undefined ? { s } : { s, pass }];
  });
}

/** Every score of `input` in the window, by scorer in report order. */
export function computeScores(input: ScoreInput, opts: ScoreOptions = {}): ScoreResult[] {
  const fromIso = opts.from !== undefined ? new Date(opts.from).toISOString() : '';
  const toIso = opts.to !== undefined ? new Date(opts.to).toISOString() : '￿';
  const inWindow = (iso: string | undefined): boolean => !!iso && iso >= fromIso && iso < toIso;
  const cache = new Map<ScoreTask, TaskFacts>();
  const ctx: ScoreContext = {
    ...input,
    inWindow,
    facts: (t) => {
      let f = cache.get(t);
      if (!f) {
        f = taskFacts(t);
        cache.set(t, f);
      }
      return f;
    },
  };
  const out: ScoreResult[] = [];
  for (const { s, pass } of activeScorers(opts)) {
    for (const r of s.score(ctx, pass)) {
      if (r.level === 'agent' || inWindow(r.at)) out.push(r);
    }
  }
  return out;
}

// ---- Summaries ----------------------------------------------------------------------------------

/** What a scorer is, for a reader: what it measures, its threshold and what to change. */
export interface ScorerInfo {
  id: string;
  description: string;
  level: ScoreLevel;
  unit: string;
  better: 'higher' | 'lower';
  pass?: number;
  lever: string;
}

/** The scorers `settings` leaves on, in report order, each with its threshold. */
export function scorerCatalog(opts: ScoreOptions = {}): ScorerInfo[] {
  return activeScorers(opts).map(({ s, pass }) => ({
    id: s.id,
    description: s.description,
    level: s.level,
    unit: s.unit,
    better: s.better,
    ...(pass !== undefined ? { pass } : {}),
    lever: s.lever,
  }));
}

/** One scorer's figures for one agent. */
export interface ScorerLine {
  scorer: string;
  level: ScoreLevel;
  unit: string;
  better: 'higher' | 'lower';
  pass?: number;
  /** What the scorer measures, and the definition to change when it fails. */
  description: string;
  lever: string;
  /** Subjects scored: tasks or runs; for an agent score, what its value is over. */
  n: number;
  /** The mean value over the subjects; the value itself for an agent score. */
  mean: number;
  /** Subjects that met the threshold, and those with a threshold. */
  passed: number;
  judged: number;
  /** Up to `worst` subjects with the worst values, with their evidence. */
  worst: Array<{ subject: string; value: number; evidence: string[] }>;
}

export interface AgentScores {
  agent: string;
  scorers: ScorerLine[];
}

/** Per agent, each scorer's mean, pass rate and worst subjects, agents by name. */
export function summarizeScores(
  results: ScoreResult[],
  opts: ScoreOptions & { worst?: number } = {},
): AgentScores[] {
  const scorers = activeScorers(opts);
  const byAgent = new Map<string, Map<string, ScoreResult[]>>();
  for (const r of results) {
    if (!r.agent) continue;
    const m = byAgent.get(r.agent) ?? new Map<string, ScoreResult[]>();
    const list = m.get(r.scorer) ?? [];
    list.push(r);
    m.set(r.scorer, list);
    byAgent.set(r.agent, m);
  }
  const worst = opts.worst ?? 3;
  return [...byAgent]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([agent, m]) => ({
      agent,
      scorers: scorers.flatMap(({ s, pass }) => {
        const list = m.get(s.id);
        if (!list?.length) return [];
        const sign = s.better === 'lower' ? -1 : 1;
        const sorted = [...list].sort(
          (a, b) => sign * (a.value - b.value) || b.at.localeCompare(a.at),
        );
        const judged = list.filter((r) => r.pass !== undefined);
        const agentLevel = s.level === 'agent';
        const line: ScorerLine = {
          scorer: s.id,
          level: s.level,
          unit: s.unit,
          better: s.better,
          ...(pass !== undefined ? { pass } : {}),
          description: s.description,
          lever: s.lever,
          n: agentLevel ? list[0]!.n : list.length,
          mean: round(list.reduce((n, r) => n + r.value, 0) / list.length, 2),
          passed: judged.filter((r) => r.pass).length,
          judged: judged.length,
          worst: agentLevel
            ? [{ subject: agent, value: list[0]!.value, evidence: list[0]!.evidence.slice(0, 5) }]
            : sorted
                .filter((r) => r.pass !== true)
                .slice(0, worst)
                .map((r) => ({ subject: r.subject, value: r.value, evidence: r.evidence })),
        };
        return [line];
      }),
    }));
}

/** A value for text: a share as a percentage, a count as a number. */
function valueText(value: number, unit: string): string {
  if (unit === 'ratio') return `${Math.round(value * 100)}%`;
  if (unit === 'tokens') {
    return value >= 1_000_000
      ? `${round(value / 1_000_000, 1)}M tokens`
      : value >= 1000
        ? `${Math.round(value / 1000)}k tokens`
        : `${value} tokens`;
  }
  return `${value} ${unit}`;
}

/** A task's id without its root, for short lines. */
const shortRef = (subject: string): string => subject.slice(subject.indexOf('/') + 1);

/** One scorer line of an agent as text. */
export function scorerLineText(l: ScorerLine): string {
  const what = l.level === 'task' ? 'tasks' : 'runs';
  const parts =
    l.level === 'agent'
      ? [`${valueText(l.mean, l.unit)} of ${l.n}`]
      : [`mean ${valueText(l.mean, l.unit)} over ${l.n} ${what}`];
  if (l.judged > 0 && l.level !== 'agent') {
    parts.push(
      `${Math.round((l.passed / l.judged) * 100)}% pass (${l.better === 'lower' ? '<=' : '>='} ${valueText(l.pass ?? 0, l.unit)})`,
    );
  } else if (l.judged > 0) {
    parts.push(
      l.passed
        ? 'pass'
        : `fail (${l.better === 'lower' ? '<=' : '>='} ${valueText(l.pass ?? 0, l.unit)})`,
    );
  }
  const worst =
    l.level === 'agent'
      ? l.worst[0]!.evidence.length
        ? `; e.g. ${l.worst[0]!.evidence.slice(0, 3).join(', ')}`
        : ''
      : l.worst.length
        ? `; worst ${l.worst.map((w) => `${shortRef(w.subject)} ${valueText(w.value, l.unit)}`).join(', ')}`
        : '';
  return `${l.scorer}: ${parts.join(', ')}${worst}`;
}

/** Per-agent scores as text: one block per agent. */
export function scoresText(summary: AgentScores[]): string {
  if (summary.length === 0) return 'no scores: no task or run in the window has anything to score';
  const lines: string[] = [];
  for (const a of summary) {
    lines.push(a.agent);
    for (const l of a.scorers) lines.push(`  ${scorerLineText(l)}`);
  }
  return lines.join('\n');
}

/** The scores of one task, or of one run, with their evidence. */
export function subjectScoresText(subject: string, results: ScoreResult[]): string {
  if (results.length === 0) return `${subject}: no scores`;
  const lines = [subject];
  for (const r of results) {
    const extra = r.extra
      ? ` (${Object.entries(r.extra)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ')})`
      : '';
    const pass = r.pass === undefined ? '' : r.pass ? ' pass' : ' FAIL';
    lines.push(
      `  ${r.scorer}: ${valueText(r.value, r.unit)}${pass}${extra}${r.agent ? ` [${r.agent}]` : ''}` +
        (r.note ? ` - ${r.note}` : ''),
    );
    if (r.evidence.length) lines.push(`    evidence: ${r.evidence.slice(0, 12).join(', ')}`);
  }
  return lines.join('\n');
}
