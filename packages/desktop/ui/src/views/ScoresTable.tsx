import { useState } from 'react';
import type { Nav } from '../App';
import { Who, cx } from '../components';
import type { AgentScores, ScoreSeries, ScorerLine } from '../types';
import {
  SCORER_LABELS,
  scoreValue,
  scorerHint,
  seriesOf,
  Sparkline,
  SubjectLink,
} from '../ui/score';
import type { BreakdownTarget } from '../ui/score-breakdown';
import { ScoreBreakdownDialog, ScoresHelpButton, ScoresHelpDialog } from '../ui/score-breakdown';

/** A cell's tooltip: what it is over, its pass rate and its worst subjects. */
function cellTitle(l: ScorerLine): string {
  const what = l.level === 'task' ? 'tasks' : 'runs';
  const parts = [l.level === 'agent' ? `of ${l.n}` : `mean over ${l.n} ${what}`];
  if (l.judged > 0) parts.push(`${l.passed} of ${l.judged} pass`);
  const worst = l.worst.flatMap((w) =>
    l.level === 'agent' ? w.evidence.slice(0, 3) : [`${w.subject} ${w.value}`],
  );
  if (worst.length) parts.push(`worst: ${worst.join(', ')}`);
  return parts.join('; ');
}

/** The first line of `scores` with this scorer: the source of its description and lever. */
function lineOf(scores: AgentScores[], id: string): ScorerLine | undefined {
  for (const a of scores) {
    const l = a.scorers.find((x) => x.scorer === id);
    if (l) return l;
  }
  return undefined;
}

/** A column header's tooltip: what the scorer measures, its threshold and what to change. */
function headerTitle(l: ScorerLine | undefined): string | undefined {
  if (!l?.description) return undefined;
  return scorerHint({ ...l, description: l.description, lever: l.lever ?? '' });
}

/** Per scorer, the worst task or run subjects across agents, worst first. */
function worstOf(
  scores: AgentScores[],
  id: string,
): Array<{ subject: string; value: number; agent: string }> {
  const out: Array<{ subject: string; value: number; agent: string }> = [];
  let better: 'higher' | 'lower' = 'lower';
  for (const a of scores) {
    const l = a.scorers.find((x) => x.scorer === id);
    if (!l || l.level === 'agent') continue;
    better = l.better;
    for (const w of l.worst) out.push({ subject: w.subject, value: w.value, agent: a.agent });
  }
  const sign = better === 'lower' ? -1 : 1;
  return out.sort((a, b) => sign * (a.value - b.value)).slice(0, 5);
}

/**
 * Per agent, the scores of the report's window: one column per scorer that has any, each with
 * its trend over the same window. Below, the worst tasks and runs per scorer, each a link.
 */
export function ScoresTable({
  scores,
  history,
  bucket = 'day',
  nav,
  since,
}: {
  scores: AgentScores[];
  history?: ScoreSeries[];
  bucket?: 'hour' | 'day';
  nav: Nav;
  /** The report's window start: a breakdown covers the same task and run scores. */
  since?: string;
}) {
  const [breakdown, setBreakdown] = useState<BreakdownTarget | null>(null);
  const [help, setHelp] = useState(false);
  const shown = SCORER_LABELS.filter(([id]) =>
    scores.some((a) => a.scorers.some((l) => l.scorer === id)),
  );
  const worst = shown
    .map(([id, label]) => ({ id, label, line: lineOf(scores, id), list: worstOf(scores, id) }))
    .filter((w) => w.list.length > 0);
  return (
    <div className="panel overflow-x-auto" data-testid="report-scores">
      <div className="flex items-center gap-3 border-b border-white/6 px-4 py-2.5">
        <span className="label-caps">Scores</span>
        <span className="text-[11px] text-fg-4">Click a value for every task or run behind it</span>
        <span className="ml-auto">
          <ScoresHelpButton onClick={() => setHelp(true)} />
        </span>
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-fg-4">
          <tr>
            <th className="px-4 py-2 font-normal">Agent</th>
            {shown.map(([id, label]) => (
              <th
                key={id}
                title={headerTitle(lineOf(scores, id))}
                className="cursor-help px-2 py-2 text-right font-normal underline decoration-white/15 decoration-dotted underline-offset-4"
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {scores.map((a) => (
            <tr key={a.agent} className="border-t border-white/5">
              <td className="px-4 py-2">
                <Who id={a.agent} label size="xs" />
              </td>
              {shown.map(([id]) => {
                const l = a.scorers.find((x) => x.scorer === id);
                if (!l) {
                  return (
                    <td key={id} className="px-2 py-2 text-right text-fg-4">
                      –
                    </td>
                  );
                }
                const rate = l.judged > 0 ? l.passed / l.judged : null;
                const series = seriesOf(history, a.agent, id);
                return (
                  <td key={id} title={cellTitle(l)} className="px-2 py-2 text-right align-top">
                    <button
                      type="button"
                      data-score-cell={`${a.agent}/${id}`}
                      onClick={() => setBreakdown({ scorer: id, agent: a.agent, since })}
                      className={cx(
                        'tabular-nums underline decoration-white/15 decoration-dotted underline-offset-4 hover:text-signal',
                        rate === null
                          ? ''
                          : rate >= 0.8
                            ? 'text-ok'
                            : rate < 0.5
                              ? 'text-warn'
                              : '',
                      )}
                    >
                      {scoreValue(l.mean, l.unit)}
                      <span className="ml-1 text-xs text-fg-4">{l.n}</span>
                    </button>
                    {series && series.points.length > 1 && (
                      <div className="mt-1 flex justify-end">
                        <Sparkline series={series} bucket={bucket} width={64} height={16} />
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {worst.length > 0 && (
        <div className="border-t border-white/6 px-4 py-3" data-testid="report-worst">
          <div className="label-caps mb-2">Worst tasks</div>
          <div className="grid grid-cols-1 gap-x-6 gap-y-2 lg:grid-cols-2">
            {worst.map((w) => (
              <div key={w.id} className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
                <button
                  type="button"
                  className="w-28 shrink-0 text-left text-fg-3 hover:text-signal"
                  title={headerTitle(w.line)}
                  onClick={() => setBreakdown({ scorer: w.id, since })}
                >
                  {w.label}
                </button>
                {w.list.map((s) => (
                  <SubjectLink
                    key={`${s.agent}-${s.subject}`}
                    subject={s.subject}
                    value={scoreValue(s.value, w.line?.unit ?? '')}
                    title={`${s.subject}: ${scoreValue(s.value, w.line?.unit ?? '')}, by ${s.agent}`}
                    nav={nav}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
      {breakdown && (
        <ScoreBreakdownDialog target={breakdown} nav={nav} onClose={() => setBreakdown(null)} />
      )}
      {help && <ScoresHelpDialog onClose={() => setHelp(false)} />}
    </div>
  );
}
