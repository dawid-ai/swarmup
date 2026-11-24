// From a score to its detail (W4): a scorer's breakdown for an agent or a task, every scored task
// or run worst first with its value, pass or fail, the threshold, the note and linked evidence,
// plus what the scorer reads in each (criteria, runs and tokens, a judge's scores). And "How
// scores work": what each scorer measures, what pass means and where the data comes from.
import { CircleHelp, Gauge, Wrench } from 'lucide-react';
import type { Nav } from '../App';
import { q, useData } from '../api';
import { ErrorLine, Modal, cx } from '../components';
import { ago, tokens } from '../lib/format';
import type { ScoreBreakdown, ScoreDetailRow, ScorerInfo, ScoresAnswer } from '../types';
import { PassChip, scoreValue, scorerHint, scorerLabel, SubjectLink, thresholdText } from './score';

/** What a breakdown opens on: a scorer, and the agent or task it is narrowed to. */
export interface BreakdownTarget {
  scorer: string;
  agent?: string;
  task?: string;
  /** Task and run scores from this time (ISO), as the report's window; all time without it. */
  since?: string;
}

/** The path of a breakdown: `GET /api/scores?scorer=&detail=1`. */
export function breakdownPath(t: BreakdownTarget): string {
  return (
    `/api/scores?detail=1&scorer=${q(t.scorer)}` +
    (t.agent ? `&agent=${q(t.agent)}` : '') +
    (t.task ? `&task=${q(t.task)}` : '') +
    (t.since ? `&since=${q(t.since)}` : '')
  );
}

const RUN_EVIDENCE = new Set(['cost-per-merged-task', 'stuck-runs', 'orientation']);

/**
 * Where a piece of a row's evidence leads: `ID#event` and a task score's event ids open the task
 * at that event; run ids open the run.
 */
export function evidenceRef(row: Pick<ScoreDetailRow, 'scorer' | 'level' | 'subject'>, e: string) {
  if (e.includes('#')) return { kind: 'task' as const, ref: e };
  if (RUN_EVIDENCE.has(row.scorer) || row.level === 'run') return { kind: 'run' as const, ref: e };
  if (row.level === 'task') return { kind: 'task' as const, ref: `${row.subject}#${e}` };
  return { kind: 'task' as const, ref: e };
}

function EvidenceLink({ row, e, nav }: { row: ScoreDetailRow; e: string; nav: Nav }) {
  const t = evidenceRef(row, e);
  const label =
    t.kind === 'run' ? `run …${e.slice(-6)}` : e.includes('#') ? e : `event …${e.slice(-6)}`;
  return (
    <button
      type="button"
      title={t.kind === 'run' ? `Open run ${e}` : `Open ${t.ref}`}
      onClick={() => (t.kind === 'run' ? nav.go('runs', t.ref) : nav.openTask(t.ref))}
      className="rounded-md bg-white/6 px-1.5 py-px font-mono text-[11px] text-fg-3 transition hover:bg-signal/12 hover:text-signal"
    >
      {label}
    </button>
  );
}

/** What the scorer read in one subject: criteria, runs, or a judge's scores. */
function RowDetail({ row, nav }: { row: ScoreDetailRow; nav: Nav }) {
  return (
    <>
      {row.criteria && row.criteria.length > 0 && (
        <ul className="flex flex-col gap-1" data-testid="breakdown-criteria">
          {row.criteria.map((c) => (
            <li key={c.id} className="flex items-start gap-2 text-xs" data-criterion={c.id}>
              <span
                className={cx(
                  'mt-px w-12 shrink-0 rounded px-1 text-center text-[10px] font-medium uppercase',
                  c.result === 'pass'
                    ? 'bg-ok/12 text-ok'
                    : c.result === 'fail'
                      ? 'bg-bad/12 text-bad'
                      : c.result === 'na'
                        ? 'bg-white/6 text-fg-3'
                        : 'bg-warn/12 text-warn',
                )}
              >
                {c.result ?? 'unmarked'}
              </span>
              <span className="min-w-0">
                <span className="font-mono text-fg-4">{c.id}</span>{' '}
                <span className="text-fg-2">{c.text ?? ''}</span>
                {c.note && <span className="block text-fg-3">{c.note}</span>}
                {c.evidence && (
                  <span className="block font-mono text-[11px] break-all text-fg-4">
                    {c.evidence}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {row.runs && row.runs.length > 0 && (
        <table className="w-full text-xs" data-testid="breakdown-runs">
          <tbody>
            {row.runs.map((r) => (
              <tr key={r.id} className="border-t border-white/5">
                <td className="py-0.5 pr-2">
                  <button
                    type="button"
                    className="font-mono text-signal hover:underline"
                    onClick={() => nav.go('runs', r.id)}
                  >
                    …{r.id.slice(-6)}
                  </button>
                </td>
                <td className="py-0.5 pr-2 text-fg-3">{r.agent}</td>
                <td className="py-0.5 pr-2 text-fg-4">{r.review ? 'review' : ''}</td>
                <td className="py-0.5 pr-2 text-fg-4">
                  {r.reason ? `${r.reason}${r.exit ? ` (exit ${r.exit})` : ''}` : ''}
                </td>
                <td className="py-0.5 pr-2 text-fg-4">{ago(r.started_at)}</td>
                <td className="py-0.5 text-right font-mono text-fg-2 tabular-nums">
                  {tokens(r.tokens)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {row.rubric && row.extra && (
        <div className="flex flex-wrap gap-1.5 text-xs" data-testid="breakdown-judge">
          <span className="text-fg-4">Judge, rubrics/{row.rubric.id}.md</span>
          {Object.entries(row.extra).map(([k, v]) => (
            <span key={k} className="rounded-md bg-white/6 px-1.5 py-px font-mono text-[11px]">
              {k} {v}
            </span>
          ))}
        </div>
      )}
      {!row.rubric && row.extra && !row.runs && (
        <div className="flex flex-wrap gap-1.5 text-xs text-fg-4">
          {Object.entries(row.extra).map(([k, v]) => (
            <span key={k}>
              {k} {v}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

/** The scorer's description, threshold and lever, as the breakdown and the explainer show them. */
function ScorerAbout({ s }: { s: ScorerInfo }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p className="text-fg-2">
        {s.description[0]?.toUpperCase()}
        {s.description.slice(1)}.{' '}
        <span className="text-fg-3">
          {s.pass === undefined
            ? 'No threshold: it shows the figure without pass or fail.'
            : `Passes at ${thresholdText(s)} (${s.better} is better).`}
        </span>
      </p>
      <p className="flex items-start gap-1.5 text-fg-3">
        <Wrench size={13} className="mt-0.5 shrink-0" />
        <span>When it fails, change {s.lever}.</span>
      </p>
    </div>
  );
}

/** A breakdown of one scorer, opened from any score number. */
export function ScoreBreakdownDialog({
  target,
  nav,
  onClose,
}: {
  target: BreakdownTarget;
  nav: Nav;
  onClose: () => void;
}) {
  const { data, error } = useData<{ detail: ScoreBreakdown }>(breakdownPath(target));
  const d = data?.detail;
  const go = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const linkNav: Nav = {
    ...nav,
    openTask: (r) => go(() => nav.openTask(r))(),
    go: (v, a) => go(() => nav.go(v, a))(),
  };
  const who = target.task ?? target.agent;
  return (
    <Modal
      title={`${scorerLabel(target.scorer)}${who ? `: ${who}` : ''}`}
      icon={Gauge}
      onClose={onClose}
      width={860}
    >
      <div className="flex flex-col gap-4" data-score-breakdown={target.scorer}>
        <ErrorLine error={error} />
        {!d && !error && <div className="text-sm text-fg-3">Reading the scores…</div>}
        {d && (
          <>
            <ScorerAbout s={d.scorer} />
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-3">
              <span>
                <span className="text-fg-4">{d.scorer.level === 'agent' ? 'Value ' : 'Mean '}</span>
                {d.mean === null ? '–' : scoreValue(d.mean, d.scorer.unit)}
              </span>
              <span>
                <span className="text-fg-4">Scored </span>
                {d.rows.length}{' '}
                {d.scorer.level === 'run'
                  ? 'run(s)'
                  : d.scorer.level === 'task'
                    ? 'task(s)'
                    : 'agent score(s)'}
              </span>
              {d.judged > 0 && (
                <span>
                  <span className="text-fg-4">Pass </span>
                  {d.passed} of {d.judged}
                </span>
              )}
              <span className="text-fg-4">
                {target.since ? `From ${new Date(target.since).toLocaleDateString()}` : 'All time'};
                worst first
              </span>
            </div>
            {d.rows.length === 0 && (
              <p className="text-sm text-fg-3">No subject has this score in the window yet.</p>
            )}
            <ul className="flex flex-col gap-2" data-testid="breakdown-rows">
              {d.rows.map((r) => (
                <li
                  key={`${r.subject}-${r.at}`}
                  data-breakdown-row={r.subject}
                  className={cx(
                    'flex flex-col gap-1.5 rounded-lg border px-3 py-2',
                    r.pass === false
                      ? 'border-warn/25 bg-warn/4'
                      : 'border-white/7 bg-white/[0.02]',
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    {r.level === 'agent' ? (
                      <span className="font-mono text-xs text-fg-2">{r.subject}</span>
                    ) : (
                      <SubjectLink subject={r.subject} nav={linkNav} />
                    )}
                    {r.title && (
                      <span className="min-w-0 flex-1 truncate text-fg-2">{r.title}</span>
                    )}
                    {!r.title && <span className="flex-1" />}
                    <span className="text-xs text-fg-4">
                      {r.level === 'agent' ? `of ${r.n}` : r.n > 1 ? `over ${r.n}` : ''}
                    </span>
                    <span className="font-mono text-sm text-fg tabular-nums">
                      {scoreValue(r.value, r.unit)}
                    </span>
                    {r.pass !== undefined && (
                      <PassChip
                        pass={r.pass}
                        title={
                          d.scorer.pass !== undefined
                            ? `Passes at ${thresholdText(d.scorer)}`
                            : undefined
                        }
                      />
                    )}
                  </div>
                  {r.note && <div className="text-xs text-fg-3">{r.note}</div>}
                  <RowDetail row={r} nav={linkNav} />
                  {r.evidence.length > 0 && !r.runs && (
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="text-fg-4">Evidence</span>
                      {r.evidence.slice(0, 12).map((e) => (
                        <EvidenceLink key={e} row={r} e={e} nav={linkNav} />
                      ))}
                      {r.evidence.length > 12 && (
                        <span className="text-fg-4">and {r.evidence.length - 12} more</span>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}

/** "How scores work": the idea, then each scorer with what it measures, pass and its lever. */
export function ScoresHelpDialog({ onClose }: { onClose: () => void }) {
  const { data, error } = useData<Partial<ScoresAnswer>>('/api/scores');
  const scorers = data?.scorers ?? [];
  return (
    <Modal title="How scores work" icon={CircleHelp} onClose={onClose} width={760}>
      <div className="flex flex-col gap-4 text-sm" data-scores-help>
        <div className="flex flex-col gap-2 text-fg-2">
          <p>
            swarmupd scores the work from what SwarmUp already records: the task events (reviews,
            verdicts, merges, asks, answers) and the run records (tokens, how a run ended, its log).
            Nothing extra is asked of an agent. Rubric scorers in a project's <code>scorers/</code>{' '}
            folder add an LLM judge's score against a rubric file.
          </p>
          <p>
            Each scorer measures one narrow thing for a task, a run or an agent, and counts for the
            agent whose work it was: a task's author, a run's agent. A score <b>passes</b> when its
            value meets the scorer's threshold; an agent's line shows the mean over its scored tasks
            or runs against the same threshold. A scorer without a threshold only shows the figure.
          </p>
          <p>
            Click any score to see every task or run behind it, worst first, with the evidence. When
            a score fails, the lever names the definition to change; <b>Propose an improvement</b>{' '}
            on the agent's card files that change for the improver.
          </p>
        </div>
        <ErrorLine error={error} />
        <ul className="flex flex-col gap-3" data-testid="scores-help-list">
          {scorers.map((s) => (
            <li key={s.id} data-scorer={s.id} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-fg">{scorerLabel(s.id)}</span>
                <span className="font-mono text-xs text-fg-4">{s.id}</span>
                <span className="text-xs text-fg-4">per {s.level}</span>
              </div>
              <div title={scorerHint(s)}>
                <ScorerAbout s={s} />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

/** A button for the "How scores work" explainer. */
export function ScoresHelpButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 text-[11px] text-fg-4 hover:text-signal"
      title="What each scorer measures, what pass means and where the data comes from"
    >
      <CircleHelp size={12} />
      How scores work
    </button>
  );
}
