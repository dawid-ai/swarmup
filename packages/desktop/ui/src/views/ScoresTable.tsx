import { Who, cx } from '../components';
import { tokens } from '../lib/format';
import type { AgentScores, ScorerLine } from '../types';

/** The scorers the table shows, with a short column label each. */
const COLUMNS: Array<[string, string]> = [
  ['review-rounds', 'Review rounds'],
  ['merge-failures', 'Merge fails'],
  ['cost-per-merged-task', 'Tokens / merge'],
  ['human-touches', 'Human touches'],
  ['escalation-correctness', 'Escalations'],
  ['recommendation-acceptance', 'Recs taken'],
  ['stuck-runs', 'Stuck runs'],
  ['criteria-pass-rate', 'Criteria'],
  ['orientation', 'Calls to edit'],
];

function valueText(l: ScorerLine): string {
  if (l.unit === 'ratio') return `${Math.round(l.mean * 100)}%`;
  if (l.unit === 'tokens') return tokens(Math.round(l.mean));
  return String(l.mean);
}

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

/** Per agent, the scores of the report's window: one column per scorer that has any. */
export function ScoresTable({ scores }: { scores: AgentScores[] }) {
  const shown = COLUMNS.filter(([id]) =>
    scores.some((a) => a.scorers.some((l) => l.scorer === id)),
  );
  return (
    <div className="panel overflow-x-auto" data-testid="report-scores">
      <div className="label-caps border-b border-white/6 px-4 py-2.5">Scores</div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-fg-4">
          <tr>
            <th className="px-4 py-2 font-normal">Agent</th>
            {shown.map(([id, label]) => (
              <th key={id} className="px-2 py-2 text-right font-normal">
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
                return (
                  <td
                    key={id}
                    title={cellTitle(l)}
                    className={cx(
                      'px-2 py-2 text-right tabular-nums',
                      rate === null ? '' : rate >= 0.8 ? 'text-ok' : rate < 0.5 ? 'text-warn' : '',
                    )}
                  >
                    {valueText(l)}
                    <span className="ml-1 text-xs text-fg-4">{l.n}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
