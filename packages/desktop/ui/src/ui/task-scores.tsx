// The task panel's **Scores**: the task's scores and its runs' orientation from
// `GET /api/scores?task=<root>/<ID>`, each with its value, pass or fail, and on hover what it
// measures and what to change when it fails.
import { Gauge } from 'lucide-react';
import { q, useData } from '../api';
import type { ScoreResult, ScorerInfo, ScoresAnswer } from '../types';
import { PassChip, scoreValue, scorerHint, scorerLabel } from './score';

/** What a score's scorer measures, its threshold and its lever, plus the score's note. */
function taskScoreHint(s: ScorerInfo | undefined, r: ScoreResult): string {
  return [s ? scorerHint(s) : '', r.note ?? ''].filter(Boolean).join(' ');
}

export function TaskScoresSection({ task }: { task: string }) {
  const { data } = useData<Partial<ScoresAnswer>>(`/api/scores?task=${q(task)}`);
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
          const hint = taskScoreHint(scorers.get(r.scorer), r);
          return (
            <li
              key={`${r.scorer}/${r.subject}`}
              data-score-row={r.scorer}
              title={hint || undefined}
              className="flex items-center gap-2 rounded-lg border border-white/7 bg-white/[0.02] px-3 py-1.5 text-sm"
            >
              <span className="min-w-0 flex-1 truncate text-fg-2">
                {scorerLabel(r.scorer)}
                {r.level === 'run' && (
                  <span className="ml-1.5 font-mono text-[11px] text-fg-4">run {r.subject}</span>
                )}
              </span>
              <span className="font-mono text-xs text-fg-2">{scoreValue(r.value, r.unit)}</span>
              {r.pass !== undefined && <PassChip pass={r.pass} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
