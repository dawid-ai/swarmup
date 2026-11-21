// One agent's scores for its card in the Agents view (W4): per scorer the value, pass rate, count,
// pass or fail against the threshold, a trend, and, opened, what to change and the worst tasks.
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import { useState } from 'react';
import type { Nav } from '../App';
import { cx } from '../components';
import type { AgentScores, ScoreSeries, ScorerLine } from '../types';
import {
  linePasses,
  PassChip,
  scoreValue,
  scorerHint,
  scorerLabel,
  seriesOf,
  Sparkline,
  SubjectLink,
  thresholdText,
} from './score';

/** `5 tasks, 80% pass` or `of 12 runs`: what a line's value is over, and its pass rate. */
function overText(l: ScorerLine): string {
  if (l.level === 'agent') {
    const what = l.scorer === 'stuck-runs' ? 'runs' : 'recommendations';
    return `of ${l.n} ${what}`;
  }
  const what = l.level === 'task' ? (l.n === 1 ? 'task' : 'tasks') : l.n === 1 ? 'run' : 'runs';
  const rate = l.judged > 0 ? `, ${Math.round((l.passed / l.judged) * 100)}% pass` : '';
  return `${l.n} ${what}${rate}`;
}

function ScoreRow({
  line,
  series,
  bucket,
  nav,
}: {
  line: ScorerLine;
  series?: ScoreSeries;
  bucket: 'hour' | 'day';
  nav: Nav;
}) {
  const pass = linePasses(line);
  const [open, setOpen] = useState(pass === false);
  const hint = line.description
    ? scorerHint({ ...line, description: line.description, lever: line.lever ?? '' })
    : undefined;
  const mean = line.level === 'agent' ? '' : 'mean ';
  // Agent scores name runs or `task#event` as evidence; the others name their worst subjects.
  const worst =
    line.level === 'agent'
      ? (line.worst[0]?.evidence ?? []).slice(0, 4).map((e) => ({ subject: e, value: '' }))
      : line.worst.map((w) => ({ subject: w.subject, value: scoreValue(w.value, line.unit) }));
  return (
    <div data-testid={`agent-score-${line.scorer}`} className="rounded-md hover:bg-white/3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={hint}
        className="flex w-full items-center gap-2 px-1.5 py-1 text-left text-xs"
      >
        {open ? (
          <ChevronDown size={12} className="shrink-0 text-fg-4" />
        ) : (
          <ChevronRight size={12} className="shrink-0 text-fg-4" />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-fg-2">{scorerLabel(line.scorer)}</span>
          <span className="truncate text-[11px] text-fg-4">{overText(line)}</span>
        </span>
        {series ? (
          <Sparkline series={series} bucket={bucket} width={56} height={16} />
        ) : (
          <span className="w-14 shrink-0" />
        )}
        <span className="w-14 shrink-0 text-right font-mono text-fg tabular-nums">
          {scoreValue(line.mean, line.unit)}
        </span>
        <PassChip
          pass={pass}
          title={
            pass === null
              ? undefined
              : `${mean}${scoreValue(line.mean, line.unit)}, passes at ${thresholdText(line)}`
          }
        />
      </button>
      {open && (
        <div className="flex flex-col gap-1.5 pt-0.5 pr-1.5 pb-2 pl-6 text-xs">
          {line.description && (
            <div className="text-fg-3">
              {scorerHint({ ...line, description: line.description, lever: '' })}
            </div>
          )}
          {line.lever && (
            <div
              className={cx('flex items-start gap-1.5', pass === false ? 'text-warn' : 'text-fg-3')}
            >
              <Wrench size={12} className="mt-0.5 shrink-0" />
              <span>Change {line.lever}.</span>
            </div>
          )}
          {worst.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-fg-4">Worst</span>
              {worst.map((w) => (
                <SubjectLink key={w.subject} subject={w.subject} value={w.value} nav={nav} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The scores block of an agent card; nothing when the agent has no score. */
export function AgentScoresBlock({
  scores,
  history,
  bucket,
  nav,
}: {
  scores?: AgentScores;
  history?: ScoreSeries[];
  bucket: 'hour' | 'day';
  nav: Nav;
}) {
  if (!scores || scores.scorers.length === 0) return null;
  const failing = scores.scorers.filter((l) => linePasses(l) === false).length;
  return (
    <div className="relative mt-3 border-t border-white/6 pt-2" data-testid="agent-scores">
      <div className="mb-1 flex items-center gap-2 px-1.5">
        <span className="label-caps">Scores</span>
        {failing > 0 ? (
          <span className="text-xs text-warn">{failing} failing</span>
        ) : (
          <span className="text-xs text-fg-4">none failing</span>
        )}
        <span
          className="ml-auto text-[10px] text-fg-4"
          title="Values cover every scored task and run; the line shows the last 30 days"
        >
          30-day trend
        </span>
      </div>
      {scores.scorers.map((l) => (
        <ScoreRow
          key={l.scorer}
          line={l}
          series={seriesOf(history, scores.agent, l.scorer)}
          bucket={bucket}
          nav={nav}
        />
      ))}
    </div>
  );
}
