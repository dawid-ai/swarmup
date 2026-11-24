// One agent's scores for its card in the Agents view (W4): per scorer the value, pass rate, count,
// pass or fail against the threshold, a trend, and, opened, what to change and the worst tasks.
import { ChevronDown, ChevronRight, ListTree, Sparkles, Wrench } from 'lucide-react';
import { useState } from 'react';
import type { Nav } from '../App';
import { cx } from '../components';
import type { AgentScores, ScoreSeries, ScorerLine } from '../types';
import type { BreakdownTarget } from './score-breakdown';
import { ScoreBreakdownDialog, ScoresHelpButton, ScoresHelpDialog } from './score-breakdown';
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
  onPropose,
  onBreakdown,
}: {
  line: ScorerLine;
  series?: ScoreSeries;
  bucket: 'hour' | 'day';
  nav: Nav;
  /** Files an improvement task for the agent now (W6); only on a failing scorer. */
  onPropose?: () => void;
  /** Opens every scored task or run behind the value. */
  onBreakdown: () => void;
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
      <div className="flex w-full items-center gap-2 px-1.5 py-1 text-xs">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title={hint}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
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
        </button>
        <button
          type="button"
          data-score-value={line.scorer}
          onClick={onBreakdown}
          title="Open the breakdown: every scored task or run, worst first"
          className="w-14 shrink-0 rounded text-right font-mono text-fg tabular-nums underline decoration-white/20 decoration-dotted underline-offset-4 hover:text-signal"
        >
          {scoreValue(line.mean, line.unit)}
        </button>
        <PassChip
          pass={pass}
          title={
            pass === null
              ? undefined
              : `${mean}${scoreValue(line.mean, line.unit)}, passes at ${thresholdText(line)}`
          }
        />
      </div>
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
          <button
            type="button"
            className="flex items-center gap-1.5 self-start text-fg-3 hover:text-signal hover:underline"
            onClick={onBreakdown}
          >
            <ListTree size={12} />
            Breakdown: every {line.level === 'agent' ? 'piece of evidence' : `scored ${line.level}`}
          </button>
          {pass === false && onPropose && (
            <button
              type="button"
              className="flex items-center gap-1.5 self-start text-signal hover:underline"
              title="File a task for the improver to propose a change to this agent's definitions"
              onClick={onPropose}
            >
              <Sparkles size={12} />
              Propose an improvement
            </button>
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
  onPropose,
}: {
  scores?: AgentScores;
  history?: ScoreSeries[];
  bucket: 'hour' | 'day';
  nav: Nav;
  onPropose?: () => void;
}) {
  const [breakdown, setBreakdown] = useState<BreakdownTarget | null>(null);
  const [help, setHelp] = useState(false);
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
        <span className="ml-auto">
          <ScoresHelpButton onClick={() => setHelp(true)} />
        </span>
        <span
          className="text-[10px] text-fg-4"
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
          onPropose={onPropose}
          onBreakdown={() => setBreakdown({ scorer: l.scorer, agent: scores.agent })}
        />
      ))}
      {breakdown && (
        <ScoreBreakdownDialog target={breakdown} nav={nav} onClose={() => setBreakdown(null)} />
      )}
      {help && <ScoresHelpDialog onClose={() => setHelp(false)} />}
    </div>
  );
}
