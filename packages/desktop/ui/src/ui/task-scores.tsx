// The task panel's **Scores**: the task's scores and its runs' orientation from
// `GET /api/scores?task=<root>/<ID>`, each with its value, pass or fail, and on hover what it
// measures and what to change when it fails. The shapes and helpers mirror `ui/score.tsx` and the
// score types of the Agents and Reports views; they are local here until both land together.
import { CircleCheck, CircleX, Gauge } from 'lucide-react';
import { q, useData } from '../api';
import { cx } from '../components';
import { tokens } from '../lib/format';

/** One score of the task or one of its runs (mirrors `ScoreResult` in the supervisor). */
interface TaskScore {
  scorer: string;
  level: 'run' | 'task' | 'agent';
  subject: string;
  agent: string;
  value: number;
  unit: string;
  pass?: boolean;
  n: number;
  evidence: string[];
  at: string;
  note?: string;
}

/** A scorer as `GET /api/scores` describes it; absent from an older swarmupd. */
interface TaskScorer {
  id: string;
  description: string;
  unit: string;
  better: 'higher' | 'lower';
  pass?: number;
  lever: string;
}

interface TaskScores {
  results?: TaskScore[];
  scorers?: TaskScorer[];
}

const LABELS: Record<string, string> = {
  'review-rounds': 'Review rounds',
  'merge-failures': 'Merge fails',
  'cost-per-merged-task': 'Tokens / merge',
  'human-touches': 'Human touches',
  'escalation-correctness': 'Escalations',
  'recommendation-acceptance': 'Recs taken',
  'stuck-runs': 'Stuck runs',
  'criteria-pass-rate': 'Criteria',
  orientation: 'Calls to edit',
};

/** A value for a person: a share as a percentage, tokens shortened, a count as it is. */
export function scoreText(value: number, unit: string): string {
  if (unit === 'ratio') return `${Math.round(value * 100)}%`;
  if (unit === 'tokens') return tokens(Math.round(value));
  return String(Math.round(value * 100) / 100);
}

/** What a scorer measures, its threshold and its lever, for a tooltip. */
export function scoreHint(s: TaskScorer | undefined, r: TaskScore): string {
  const parts: string[] = [];
  if (s?.description) parts.push(`${s.description[0]!.toUpperCase()}${s.description.slice(1)}.`);
  if (s?.pass !== undefined) {
    parts.push(`Passes at ${s.better === 'lower' ? '<=' : '>='} ${scoreText(s.pass, s.unit)}.`);
  }
  if (s?.lever) parts.push(`When it fails, change ${s.lever}.`);
  if (r.note) parts.push(r.note);
  return parts.join(' ');
}

export function TaskScoresSection({ task }: { task: string }) {
  const { data } = useData<TaskScores>(`/api/scores?task=${q(task)}`);
  const results = Array.isArray(data?.results) ? data.results : [];
  if (results.length === 0) return null;
  const scorers = new Map((data?.scorers ?? []).map((s) => [s.id, s] as const));
  return (
    <section data-task-scores>
      <h3 className="label-caps mt-6 mb-2 flex items-center gap-1.5">
        <Gauge size={12} /> Scores
      </h3>
      <ul className="flex flex-col gap-1">
        {results.map((r) => {
          const hint = scoreHint(scorers.get(r.scorer), r);
          return (
            <li
              key={`${r.scorer}/${r.subject}`}
              data-score-row={r.scorer}
              title={hint || undefined}
              className="flex items-center gap-2 rounded-lg border border-white/7 bg-white/[0.02] px-3 py-1.5 text-sm"
            >
              <span className="min-w-0 flex-1 truncate text-fg-2">
                {LABELS[r.scorer] ?? r.scorer}
                {r.level === 'run' && (
                  <span className="ml-1.5 font-mono text-[11px] text-fg-4">run {r.subject}</span>
                )}
              </span>
              <span className="font-mono text-xs text-fg-2">{scoreText(r.value, r.unit)}</span>
              {r.pass !== undefined && (
                <span
                  className={cx(
                    'inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[11px] font-medium',
                    r.pass ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn',
                  )}
                >
                  {r.pass ? <CircleCheck size={11} /> : <CircleX size={11} />}
                  {r.pass ? 'pass' : 'fail'}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
