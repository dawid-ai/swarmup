// Shared pieces of the score views (W4): value text, a pass or fail chip, a trend sparkline, and
// links from a scored subject to its task or run. Agents, Reports and Runs use them.
import { CircleCheck, CircleX } from 'lucide-react';
import type { Nav } from '../App';
import { q } from '../api';
import { cx } from '../components';
import { tokens } from '../lib/format';
import type { ScoreSeries, ScorerInfo, ScorerLine } from '../types';

/** The scorers in report order, each with a short label. */
export const SCORER_LABELS: Array<[string, string]> = [
  ['review-rounds', 'Review rounds'],
  ['merge-failures', 'Merge fails'],
  ['cost-per-merged-task', 'Tokens / merge'],
  ['human-touches', 'Human touches'],
  ['escalation-correctness', 'Escalations'],
  ['recommendation-acceptance', 'Recs taken'],
  ['stuck-runs', 'Stuck runs'],
  ['criteria-pass-rate', 'Criteria'],
  ['verdict-completeness', 'Verdicts marked'],
  ['orientation', 'Calls to edit'],
];

const LABELS = new Map(SCORER_LABELS);

/** A scorer's short label; its id for one this list does not know. */
export function scorerLabel(id: string): string {
  return LABELS.get(id) ?? id;
}

/** A value for a person: a share as a percentage, tokens shortened, a count as it is. */
export function scoreValue(value: number, unit: string): string {
  if (unit === 'ratio') return `${Math.round(value * 100)}%`;
  if (unit === 'tokens') return tokens(Math.round(value));
  return String(Math.round(value * 100) / 100);
}

/** The threshold as text, such as `<= 1` or `>= 70%`; '' without one. */
export function thresholdText(s: { better: 'higher' | 'lower'; pass?: number; unit: string }) {
  if (s.pass === undefined) return '';
  return `${s.better === 'lower' ? '<=' : '>='} ${scoreValue(s.pass, s.unit)}`;
}

/** A scorer's explanation for a tooltip: what it measures, its threshold and what to change. */
export function scorerHint(
  s: Pick<ScorerInfo, 'description' | 'lever' | 'better' | 'unit'> & {
    pass?: number;
  },
): string {
  const pass = thresholdText(s);
  return [
    s.description ? `${s.description[0]!.toUpperCase()}${s.description.slice(1)}.` : '',
    pass ? `Passes at ${pass}.` : 'No threshold.',
    s.lever ? `When it fails, change ${s.lever}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Whether a scorer line's value (an agent score, or the mean over tasks or runs) meets its threshold. */
export function linePasses(l: ScorerLine): boolean | null {
  if (l.pass === undefined) return null;
  return l.better === 'lower' ? l.mean <= l.pass : l.mean >= l.pass;
}

/** A pass or fail chip with an icon, so the state never rests on color alone. */
export function PassChip({ pass, title }: { pass: boolean | null; title?: string }) {
  if (pass === null) {
    return (
      <span className="shrink-0 px-1.5 text-[11px] text-fg-4" title={title ?? 'No threshold'}>
        none
      </span>
    );
  }
  const Icon = pass ? CircleCheck : CircleX;
  return (
    <span
      title={title}
      className={cx(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[11px] font-medium',
        pass ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn',
      )}
    >
      <Icon size={11} strokeWidth={2.4} />
      {pass ? 'pass' : 'fail'}
    </span>
  );
}

/** A point's time for a tooltip: the hour for an hourly trend, else the day. */
function pointTime(at: string, bucket: 'hour' | 'day'): string {
  const d = new Date(at);
  return bucket === 'hour'
    ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * One scorer's trend as a small line: one point per hour or day, the threshold as a faint dashed
 * line, the last point marked. Each point has a hover target with its time, value and count.
 */
export function Sparkline({
  series,
  bucket,
  width = 72,
  height = 20,
}: {
  series: Pick<ScoreSeries, 'points' | 'unit' | 'pass' | 'better' | 'level'>;
  bucket: 'hour' | 'day';
  width?: number;
  height?: number;
}) {
  const pts = series.points;
  if (pts.length === 0) {
    return <span className="inline-block text-[10px] text-fg-4" style={{ width }} />;
  }
  const values = pts.map((p) => p.value);
  const ratio = series.unit === 'ratio';
  const lo = ratio ? 0 : Math.min(0, ...values, series.pass ?? Infinity);
  const hi = ratio ? 1 : Math.max(...values, series.pass ?? -Infinity, lo + 1);
  const pad = 3;
  const x = (i: number): number =>
    pts.length === 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (pts.length - 1);
  const y = (v: number): number => height - pad - ((v - lo) / (hi - lo)) * (height - 2 * pad);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`);
  const last = pts[pts.length - 1]!;
  const what = series.level === 'agent' ? 'of' : 'over';
  const slot = pts.length === 1 ? width : (width - 2 * pad) / (pts.length - 1);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Trend: ${pts.map((p) => scoreValue(p.value, series.unit)).join(', ')}`}
      className="shrink-0 overflow-visible text-fg-3"
      data-testid="sparkline"
    >
      {series.pass !== undefined && (
        <line
          x1={0}
          x2={width}
          y1={y(series.pass)}
          y2={y(series.pass)}
          stroke="currentColor"
          strokeOpacity={0.35}
          strokeDasharray="2 2"
          strokeWidth={1}
        />
      )}
      {pts.length > 1 && (
        <path
          d={line.join(' ')}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
      <circle cx={x(pts.length - 1)} cy={y(last.value)} r={2.5} className="fill-signal" />
      {pts.map((p, i) => (
        <rect key={p.at} x={x(i) - slot / 2} y={0} width={slot} height={height} fill="transparent">
          <title>
            {`${pointTime(p.at, bucket)}: ${scoreValue(p.value, series.unit)} ${what} ${p.n}`}
          </title>
        </rect>
      ))}
    </svg>
  );
}

/**
 * What a scored subject or a piece of evidence links to: a task (`root/ID`, `ID`, `ID#event`)
 * opens the task panel, a run id opens the Runs view on it.
 */
export function subjectTarget(subject: string): { kind: 'task' | 'run'; ref: string } {
  // Run ids are ULIDs: 26 characters of Crockford base32, no slash, dash or hash.
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(subject)) return { kind: 'run', ref: subject };
  return { kind: 'task', ref: subject };
}

/** A task or run id without its root, for a short link. */
export function shortSubject(subject: string): string {
  const t = subjectTarget(subject);
  if (t.kind === 'run') return subject.slice(-6);
  return subject.slice(subject.indexOf('/') + 1);
}

/** A link from a scored subject to its task panel or run. */
export function SubjectLink({
  subject,
  nav,
  value,
  title,
}: {
  subject: string;
  nav: Nav;
  value?: string;
  title?: string;
}) {
  const t = subjectTarget(subject);
  return (
    <button
      type="button"
      title={title ?? (t.kind === 'run' ? `Open run ${subject}` : `Open ${subject}`)}
      onClick={() => (t.kind === 'run' ? nav.go('runs', t.ref) : nav.openTask(t.ref))}
      className="inline-flex items-center gap-1 rounded-md bg-white/6 px-1.5 py-px font-mono text-[11px] text-fg-2 transition hover:bg-signal/12 hover:text-signal"
    >
      {shortSubject(subject)}
      {value && <span className="text-fg-4">{value}</span>}
    </button>
  );
}

/** The path of `GET /api/scores/history` for a window, in the reader's local days. */
export function historyPath(since: string, until?: string, agent?: string): string {
  const tz = new Date().getTimezoneOffset();
  return (
    `/api/scores/history?since=${q(since)}` +
    (until ? `&until=${q(until)}` : '') +
    (agent ? `&agent=${q(agent)}` : '') +
    `&tz=${tz}`
  );
}

/** The series of `history` for one agent and scorer. */
export function seriesOf(
  history: ScoreSeries[] | undefined,
  agent: string,
  scorer: string,
): ScoreSeries | undefined {
  return history?.find((s) => s.agent === agent && s.scorer === scorer);
}
