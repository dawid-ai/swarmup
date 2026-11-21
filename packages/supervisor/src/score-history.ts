// Score trends (W4) for the desktop Agents and Reports views: each agent's scores over a window,
// one point per hour or day. Pure: `score-keeper.ts` hands it the kept scores and the agent-score
// rows of `state.db`, and `GET /api/scores/history` serves the result.
import type { ScoreResult, ScorerInfo } from './scores.js';

/** One point of a trend: the bucket's start, its value, and what the value is over. */
export interface ScorePoint {
  at: string;
  value: number;
  n: number;
}

/** One scorer's trend for one agent. */
export interface ScoreSeries {
  agent: string;
  scorer: string;
  level: ScorerInfo['level'];
  unit: string;
  better: 'higher' | 'lower';
  pass?: number;
  points: ScorePoint[];
}

/** A row of an agent-level score from `state.db`: its value when it changed. */
export interface AgentScoreRow {
  agent: string;
  scorer: string;
  computed_at: string;
  value: number;
  n: number;
}

export type HistoryBucket = 'hour' | 'day';

export interface HistoryOptions {
  /** The window, ms: `from` inclusive, `to` exclusive. */
  from: number;
  to: number;
  agent?: string;
  scorer?: string;
  /** Minutes the reader's clock is behind UTC (`Date.getTimezoneOffset`), for local days. */
  tz?: number;
  /** Hours for a window of two days or less, else days, without one. */
  bucket?: HistoryBucket;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Hours for a window of two days or less, days for a longer one. */
export function historyBucket(from: number, to: number): HistoryBucket {
  return to - from <= 2 * DAY ? 'hour' : 'day';
}

/** The start of the reader's local hour or day that holds `ms`, as UTC ms. */
export function bucketStart(ms: number, bucket: HistoryBucket, tz = 0): number {
  const size = bucket === 'hour' ? HOUR : DAY;
  const local = ms - tz * 60_000;
  return Math.floor(local / size) * size + tz * 60_000;
}

const round = (x: number): number => Math.round(x * 1000) / 1000;

/**
 * Each agent's trend per scorer in the window. A task or run score counts in the bucket of its
 * subject's time (`at`), and a point is the mean of the bucket. An agent score is a running
 * figure, so a point is its last value in the bucket; `agentRows` should hold the last row before
 * the window too, which opens the trend at the window's start. Series come by agent, then in the
 * order of `scorers`; scorers left out of it are left out.
 */
export function scoreHistory(
  results: ScoreResult[],
  agentRows: AgentScoreRow[],
  scorers: ScorerInfo[],
  opts: HistoryOptions,
): ScoreSeries[] {
  const bucket = opts.bucket ?? historyBucket(opts.from, opts.to);
  const info = new Map(scorers.map((s) => [s.id, s]));
  const want = (agent: string, scorer: string): boolean =>
    info.has(scorer) &&
    (!opts.agent || agent === opts.agent) &&
    (!opts.scorer || scorer === opts.scorer);
  /** Per agent and scorer, per bucket start: values summed and counted, or the last value. */
  const acc = new Map<string, Map<number, { sum: number; count: number; n: number }>>();
  const slot = (agent: string, scorer: string, at: number) => {
    const key = `${agent}\n${scorer}`;
    let m = acc.get(key);
    if (!m) {
      m = new Map();
      acc.set(key, m);
    }
    let b = m.get(at);
    if (!b) {
      b = { sum: 0, count: 0, n: 0 };
      m.set(at, b);
    }
    return b;
  };
  for (const r of results) {
    if (r.level === 'agent' || !r.agent || !want(r.agent, r.scorer)) continue;
    const at = Date.parse(r.at);
    if (!(at >= opts.from && at < opts.to)) continue;
    const b = slot(r.agent, r.scorer, bucketStart(at, bucket, opts.tz));
    b.sum += r.value;
    b.count++;
    b.n++;
  }
  // Oldest first, so the last row of a bucket wins.
  const rows = [...agentRows].sort((a, b) => a.computed_at.localeCompare(b.computed_at));
  for (const r of rows) {
    if (info.get(r.scorer)?.level !== 'agent' || !want(r.agent, r.scorer)) continue;
    const at = Date.parse(r.computed_at);
    if (Number.isNaN(at) || at >= opts.to) continue;
    const b = slot(r.agent, r.scorer, bucketStart(Math.max(at, opts.from), bucket, opts.tz));
    b.sum = r.value;
    b.count = 1;
    b.n = r.n;
  }
  const order = scorers.map((s) => s.id);
  return [...acc]
    .map(([key, m]) => {
      const [agent, scorer] = key.split('\n') as [string, string];
      const s = info.get(scorer)!;
      const series: ScoreSeries = {
        agent,
        scorer,
        level: s.level,
        unit: s.unit,
        better: s.better,
        ...(s.pass !== undefined ? { pass: s.pass } : {}),
        points: [...m]
          .sort(([a], [b]) => a - b)
          .map(([at, b]) => ({
            at: new Date(at).toISOString(),
            value: round(b.sum / b.count),
            n: b.n,
          })),
      };
      return series;
    })
    .sort(
      (a, b) => a.agent.localeCompare(b.agent) || order.indexOf(a.scorer) - order.indexOf(b.scorer),
    );
}
