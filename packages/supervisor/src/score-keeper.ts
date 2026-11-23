// Reading tasks for the scorers and keeping their scores in `state.db` (W4). See `scores.ts`.
import type { Workspace } from '@swarmup/core';
import { gitScorers } from './git-scorers.js';
import type { OrientationStats } from './orientation.js';
import { ReportEvents } from './report.js';
import type { RunRecord } from './runs.js';
import type { AgentScoreRow, HistoryOptions, ScoreSeries } from './score-history.js';
import { scoreHistory } from './score-history.js';
import type {
  OrientationProvider,
  ScoreResult,
  ScoreTask,
  ScorerInfo,
  ScorerSetting,
} from './scores.js';
import { computeScores } from './scores.js';

/** The tasks of `ws`, archived ones too, with their events, for {@link computeScores}. */
export function scoreTasks(
  ws: Workspace,
  opts: { root?: string; events?: ReportEvents; since?: string } = {},
): ScoreTask[] {
  const events = opts.events ?? new ReportEvents(Number.MAX_SAFE_INTEGER);
  return ws
    .list({ all: true })
    .filter(
      (t) => (!opts.root || t.root === opts.root) && (!opts.since || t.updatedAt >= opts.since),
    )
    .map((t) => ({
      root: t.root,
      id: t.meta.id,
      title: t.meta.title,
      meta: t.meta,
      status: t.status,
      events: events.get(ws, t),
    }));
}

// ---- Keeping scores -----------------------------------------------------------------------------

/** One stored score: the result and when it was computed. */
export interface StoredScore {
  result: ScoreResult;
  computed_at: string;
}

/** Where scores are kept: `StateDb` (`state.db`) fits it. */
export interface ScoreDb {
  /** Adds rows; `result: null` marks a subject that no longer has the score. */
  saveScores(
    rows: Array<{
      key: Pick<ScoreResult, 'scorer' | 'level' | 'subject' | 'agent'>;
      result: ScoreResult | null;
      computed_at: string;
    }>,
  ): void;
  /** The latest row of each scorer, subject and agent that still has a score. */
  latestScores(): StoredScore[];
  /** Rows of agent-level scores in a window, with the last one before it. See `StateDb`. */
  agentScoreHistory?(opts: {
    since: string;
    until: string;
    agent?: string;
    scorer?: string;
  }): AgentScoreRow[];
}

/** A run's orientation for the Runs view: tool calls before its first edit and what it read. */
export interface RunOrientation {
  /** Tool calls before the first edit; every tool call of a run with no edit. */
  calls: number;
  /** Share of the run's tool-result bytes read before its first edit, 0 to 1. */
  share: number;
  edited: boolean;
  /** Whether `calls` meets the `orientation` threshold; absent for a run with no edit. */
  pass?: boolean;
}

const keyOf = (r: Pick<ScoreResult, 'scorer' | 'subject' | 'agent'>): string =>
  `${r.scorer}\n${r.subject}\n${r.agent}`;

/** The figures of a stored orientation score, so its log is not read again. */
function orientationOf(r: ScoreResult): OrientationStats {
  return {
    toolCalls: r.value,
    resultBytesBefore: r.extra?.bytesBefore ?? 0,
    resultBytes: r.extra?.bytes ?? 0,
    edited: true,
  };
}

/**
 * Scores computed again only when something changed, and kept in `state.db`. A refresh reads the
 * events of the tasks that changed since the last one (a task's last event and event count tell),
 * computes every score from memory, and writes a row only for a score whose value differs from the
 * one kept, so `state.db` holds each score's history. An ended run's orientation is read from its
 * log once, at most `logsPerRefresh` logs per refresh.
 */
export class ScoreKeeper {
  private readonly events = new ReportEvents(Number.MAX_SAFE_INTEGER);
  private latest = new Map<string, StoredScore>();
  private readonly orientations = new Map<string, OrientationStats | null>();
  private loaded = false;
  private fingerprint = '';
  private busy: Promise<ScoreResult[]> | null = null;

  constructor(
    private readonly db: ScoreDb | null,
    private readonly opts: {
      orientation?: OrientationProvider;
      logsPerRefresh?: number;
      now?: () => number;
    } = {},
  ) {}

  /** The scores kept now, after the last refresh. */
  results(): ScoreResult[] {
    this.load();
    return [...this.latest.values()].map((s) => s.result);
  }

  /**
   * The orientation of an ended run: its kept score, else the figures read from its log (a run
   * with no edit has no score). Null when the log was never read or held no tool call.
   */
  orientation(run: Pick<RunRecord, 'id' | 'agent'>): RunOrientation | null {
    this.load();
    const kept = this.latest.get(
      keyOf({ scorer: 'orientation', subject: run.id, agent: run.agent }),
    );
    if (kept) {
      const r = kept.result;
      return {
        calls: r.value,
        share: r.extra?.share ?? 0,
        edited: true,
        ...(r.pass !== undefined ? { pass: r.pass } : {}),
      };
    }
    const s = this.orientations.get(run.id);
    if (!s) return null;
    const share = s.resultBytes
      ? Math.round((s.resultBytesBefore / s.resultBytes) * 1000) / 1000
      : 0;
    return { calls: s.toolCalls, share, edited: s.edited };
  }

  /**
   * Each agent's trend per scorer in a window: task and run scores from the kept scores, agent
   * scores from their rows in `state.db` (only the kept value without one). See `scoreHistory`.
   */
  history(scorers: ScorerInfo[], opts: HistoryOptions): ScoreSeries[] {
    this.load();
    const results = [...this.latest.values()].map((s) => s.result);
    let rows: AgentScoreRow[] | null = null;
    if (this.db?.agentScoreHistory) {
      try {
        rows = this.db.agentScoreHistory({
          since: new Date(opts.from).toISOString(),
          until: new Date(opts.to).toISOString(),
          ...(opts.agent ? { agent: opts.agent } : {}),
          ...(opts.scorer ? { scorer: opts.scorer } : {}),
        });
      } catch {
        // An unreadable table falls back to the kept values.
      }
    }
    rows ??= [...this.latest.values()]
      .filter((s) => s.result.level === 'agent')
      .map((s) => ({
        agent: s.result.agent,
        scorer: s.result.scorer,
        computed_at: s.computed_at,
        value: s.result.value,
        n: s.result.n,
      }));
    return scoreHistory(results, rows, scorers, opts);
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.db) return;
    try {
      for (const s of this.db.latestScores()) {
        this.latest.set(keyOf(s.result), s);
        if (s.result.scorer === 'orientation') {
          this.orientations.set(s.result.subject, orientationOf(s.result));
        }
      }
    } catch {
      // An unreadable table starts empty; the next refresh writes every score again.
    }
  }

  /**
   * Computes the scores again when a task or run changed since the last refresh, or always with
   * `force`. Returns the scores kept. Calls while one runs wait for it.
   */
  refresh(
    ws: Workspace,
    runs: RunRecord[],
    settings: Record<string, ScorerSetting> = {},
    force = false,
  ): Promise<ScoreResult[]> {
    this.busy ??= this.run(ws, runs, settings, force).finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  private async run(
    ws: Workspace,
    runs: RunRecord[],
    settings: Record<string, ScorerSetting>,
    force: boolean,
  ): Promise<ScoreResult[]> {
    this.load();
    const views = ws.list({ all: true });
    const ended = runs.filter((r) => r.status === 'ended');
    const stores = gitScorers(ws);
    const fingerprint = [
      JSON.stringify(settings),
      JSON.stringify(stores),
      ended.length,
      ended[0]?.id ?? '',
      ...views.map((t) => `${t.root}/${t.meta.id}@${t.lastEvent}:${t.eventCount}`),
    ].join('|');
    if (!force && fingerprint === this.fingerprint) return this.results();
    for (const t of views) await this.events.load(ws, t);
    const tasks: ScoreTask[] = views.map((t) => ({
      root: t.root,
      id: t.meta.id,
      title: t.meta.title,
      meta: t.meta,
      status: t.status,
      events: this.events.get(ws, t),
    }));
    await this.readOrientations(ended);
    const results = computeScores(
      { tasks, runs, orientation: (r) => this.orientations.get(r.id) },
      { settings, now: this.opts.now, stores },
    );
    this.save(results);
    this.fingerprint = fingerprint;
    return this.results();
  }

  /**
   * Reads the orientation of ended runs not read yet, newest first, up to the limit. A log read is
   * synchronous and a run log can run to megabytes, so the loop yields to the event loop between
   * logs: swarmupd's tick and API never wait for more than one log.
   */
  private async readOrientations(ended: RunRecord[]): Promise<void> {
    const provider = this.opts.orientation;
    if (!provider) return;
    let budget = this.opts.logsPerRefresh ?? 20;
    for (const r of ended) {
      if (budget <= 0) break;
      if (this.orientations.has(r.id)) continue;
      if (!r.task || r.review || r.question || r.chat || r.plan_check || r.inbox || r.parent) {
        continue;
      }
      budget--;
      await new Promise<void>((resolve) => setImmediate(resolve));
      this.orientations.set(r.id, provider(r) ?? null);
    }
  }

  private save(results: ScoreResult[]): void {
    const now = new Date((this.opts.now ?? Date.now)()).toISOString();
    const rows: Parameters<ScoreDb['saveScores']>[0] = [];
    const seen = new Set<string>();
    for (const r of results) {
      const key = keyOf(r);
      seen.add(key);
      const kept = this.latest.get(key);
      if (kept && JSON.stringify(kept.result) === JSON.stringify(r)) continue;
      rows.push({ key: r, result: r, computed_at: now });
      this.latest.set(key, { result: r, computed_at: now });
    }
    for (const [key, kept] of this.latest) {
      if (seen.has(key)) continue;
      // An orientation whose log is gone keeps its score.
      if (kept.result.scorer === 'orientation' && this.orientations.get(kept.result.subject)) {
        continue;
      }
      rows.push({ key: kept.result, result: null, computed_at: now });
      this.latest.delete(key);
    }
    if (rows.length === 0 || !this.db) return;
    try {
      this.db.saveScores(rows);
    } catch {
      // Memory holds them; the next refresh after a restart writes them again.
    }
  }
}
