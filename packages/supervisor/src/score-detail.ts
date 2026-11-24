// A score's breakdown for the app (W4): every subject one scorer scored for one agent (or one
// task), worst first, with what the scorer reads in each. `GET /api/scores?scorer=&detail=1`
// answers with it. The criteria scorers add each criterion's result from the approving verdict,
// the token scorer the runs it summed, the stuck-runs scorer why each run failed, and a rubric
// scorer's row already holds the judge's per-criterion scores (`extra`) and reasons (`note`).
import type { OpsEvent, TaskMeta, Workspace } from '@swarmup/core';
import { criteriaOf, currentDoneWhen } from '@swarmup/core';
import type { RunRecord } from './runs.js';
import type { ScoreResult, ScorerInfo } from './scores.js';
import { rubricScorer } from './scores.js';

/** One criterion of a task, with its result on the event a score read. */
export interface DetailCriterion {
  id: string;
  kind?: string;
  text?: string;
  /** `pass`, `fail` or `na`; absent when the verdict left it unmarked. */
  result?: string;
  score?: number;
  note?: string;
  evidence?: string;
}

/** A run a score summed or counted. */
export interface DetailRun {
  id: string;
  agent: string;
  tokens: number;
  started_at: string;
  ended_at?: string;
  review?: boolean;
  status?: string;
  reason?: string;
  exit?: number | null;
}

/** One scored subject with what the scorer read in it. */
export interface ScoreDetailRow extends ScoreResult {
  /** The task's title, for a task subject. */
  title?: string;
  criteria?: DetailCriterion[];
  runs?: DetailRun[];
}

/** `GET /api/scores?scorer=&detail=1`: one scorer's subjects for an agent or a task. */
export interface ScoreDetail {
  scorer: ScorerInfo;
  agent?: string;
  task?: string;
  /** Mean value, and how many met the threshold of those that have one. */
  mean: number | null;
  passed: number;
  judged: number;
  rows: ScoreDetailRow[];
}

/** What the breakdown needs of swarmupd. */
export interface DetailHost {
  ws(): Workspace;
  runs(): RunRecord[];
}

const CRITERIA_SCORERS = new Set(['criteria-pass-rate', 'verdict-completeness']);
const RUN_SCORERS = new Set(['cost-per-merged-task', 'stuck-runs']);

/** A task's criteria in force at `event`, each with the result `event` marked. */
function criteriaAt(events: OpsEvent[], meta: TaskMeta, event: OpsEvent): DetailCriterion[] {
  const before = events.slice(0, events.indexOf(event) + 1);
  let list: ReturnType<typeof criteriaOf> = [];
  try {
    list = criteriaOf(currentDoneWhen(meta, before));
  } catch {
    list = [];
  }
  const raw = (event as { criteria?: unknown }).criteria;
  const marks =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, Record<string, unknown> | null>)
      : {};
  const out: DetailCriterion[] = list.map((c) => {
    const m = marks[c.id] ?? undefined;
    return {
      id: c.id,
      kind: c.kind,
      ...(c.text || c.ask || c.run || c.check || c.rubric
        ? { text: c.text ?? c.ask ?? c.run ?? c.check ?? c.rubric }
        : {}),
      ...markOf(m),
    };
  });
  // Marks for criteria no longer in force still show: the score counted them.
  for (const [id, m] of Object.entries(marks)) {
    if (!out.some((c) => c.id === id)) out.push({ id, ...markOf(m) });
  }
  return out;
}

function markOf(m: Record<string, unknown> | null | undefined): Partial<DetailCriterion> {
  if (!m) return {};
  const ev = m.evidence;
  return {
    ...(typeof m.result === 'string' ? { result: m.result } : {}),
    ...(typeof m.score === 'number' ? { score: m.score } : {}),
    ...(typeof m.note === 'string' && m.note ? { note: m.note } : {}),
    ...(ev === undefined || ev === null || ev === ''
      ? {}
      : { evidence: typeof ev === 'string' ? ev : JSON.stringify(ev) }),
  };
}

/**
 * The breakdown of `scorer` over `results` for `agent` (or every agent), narrowed to `task`'s own
 * scores and its runs' when given. `catalog` describes the built-in scorers; a rubric scorer is
 * described from its rows. Rows are sorted worst first, then newest.
 */
export function scoreDetail(
  host: DetailHost,
  results: ScoreResult[],
  catalog: ScorerInfo[],
  opts: { scorer: string; agent?: string; task?: string },
): ScoreDetail | null {
  let rows = results.filter(
    (r) => r.scorer === opts.scorer && (!opts.agent || r.agent === opts.agent),
  );
  const runs = host.runs();
  if (opts.task) {
    const slash = opts.task.lastIndexOf('/');
    const [root, tid] =
      slash > 0 ? [opts.task.slice(0, slash), opts.task.slice(slash + 1)] : ['', opts.task];
    const mine = new Set(
      runs.filter((r) => r.task === tid && (!root || !r.root || r.root === root)).map((r) => r.id),
    );
    rows = rows.filter(
      (r) => r.subject === opts.task || (r.level === 'run' && mine.has(r.subject)),
    );
  }
  let info = catalog.find((s) => s.id === opts.scorer);
  if (!info) {
    const rubric = rows.find((r) => r.rubric)?.rubric;
    if (!rubric) return null;
    const s = rubricScorer(opts.scorer, rubric.id);
    info = {
      id: s.id,
      description: s.description,
      level: s.level,
      unit: s.unit,
      better: s.better,
      pass: rubric.pass,
      lever: s.lever,
    };
  }
  const sign = info.better === 'lower' ? -1 : 1;
  rows = [...rows].sort((a, b) => sign * (a.value - b.value) || b.at.localeCompare(a.at));
  const byId = new Map(runs.map((r) => [r.id, r] as const));
  const ws = host.ws();
  const tasks = new Map<string, ReturnType<Workspace['showEvents']> | null>();
  const task = (ref: string) => {
    if (!tasks.has(ref)) {
      try {
        tasks.set(ref, ws.showEvents(ref));
      } catch {
        tasks.set(ref, null);
      }
    }
    return tasks.get(ref) ?? null;
  };
  const out: ScoreDetailRow[] = rows.map((r) => {
    const row: ScoreDetailRow = { ...r };
    if (r.level === 'task') {
      const t = task(r.subject);
      if (t) {
        row.title = t.meta.title;
        if (CRITERIA_SCORERS.has(r.scorer)) {
          const ev = t.events.find((e) => e.id === r.evidence[0]);
          if (ev) row.criteria = criteriaAt(t.events, t.meta, ev);
        }
      }
    }
    if (RUN_SCORERS.has(r.scorer)) {
      row.runs = r.evidence.flatMap((id) => {
        const run = byId.get(id);
        if (!run) return [];
        return [
          {
            id: run.id,
            agent: run.agent,
            tokens: run.tokens,
            started_at: run.started_at,
            ...(run.ended_at ? { ended_at: run.ended_at } : {}),
            ...(run.review ? { review: true } : {}),
            ...(run.status ? { status: run.status } : {}),
            ...(run.reason ? { reason: run.reason } : {}),
            ...(run.exit !== undefined ? { exit: run.exit } : {}),
          },
        ];
      });
    }
    return row;
  });
  const judged = rows.filter((r) => r.pass !== undefined);
  return {
    scorer: info,
    ...(opts.agent ? { agent: opts.agent } : {}),
    ...(opts.task ? { task: opts.task } : {}),
    mean:
      rows.length === 0
        ? null
        : Math.round((rows.reduce((n, r) => n + r.value, 0) / rows.length) * 100) / 100,
    passed: judged.filter((r) => r.pass).length,
    judged: judged.length,
    rows: out,
  };
}
