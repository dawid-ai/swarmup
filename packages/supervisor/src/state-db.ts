import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

/**
 * `node:sqlite`, loaded when `state.db` first opens. Loading it prints Node's experimental-feature
 * warning, so a module that only imports this one, such as the CLI, must not load it.
 */
let sqlite: typeof import('node:sqlite') | undefined;
function openDb(path: string): DatabaseSync {
  sqlite ??= createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  return new sqlite.DatabaseSync(path);
}

/** What a merge attempt ended in, for `merge_attempts.outcome`. */
export type MergeOutcome =
  | 'merged'
  | 'nothing'
  | 'conflict'
  | 'check-failed'
  | 'timeout'
  | 'sent-back'
  | 'note'
  | 'again'
  | 'stopped';

/** One row of `merge_attempts`: a merge of one task, or of one task of a batch. */
export interface MergeAttempt {
  id: number;
  ref: string;
  root: string;
  what: string;
  commit: string | null;
  branch: string | null;
  started_at: string;
  ended_at: string | null;
  outcome: MergeOutcome | null;
  reason: string | null;
  head: string | null;
}

/** How many merge attempts ended in each outcome. */
export interface MergeCount {
  outcome: MergeOutcome | 'running';
  count: number;
}

/** A run record as `state.db` keeps it: the fields it sorts and filters by, and the whole record. */
export interface RunRow {
  id: string;
  agent: string;
  task?: string;
  root?: string;
  status: string;
  started_at: string;
  ended_at?: string;
}

/**
 * Each schema step, in order. `PRAGMA user_version` holds how many have run, so a newer swarmupd
 * adds tables to an older `state.db` and never changes one in place.
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE runs (
     id TEXT PRIMARY KEY,
     agent TEXT NOT NULL,
     task TEXT,
     root TEXT,
     status TEXT NOT NULL,
     started_at TEXT NOT NULL,
     ended_at TEXT,
     record TEXT NOT NULL
   );
   CREATE INDEX runs_task ON runs (root, task);
   CREATE TABLE merge_attempts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ref TEXT NOT NULL,
     root TEXT NOT NULL,
     what TEXT NOT NULL,
     "commit" TEXT,
     branch TEXT,
     started_at TEXT NOT NULL,
     ended_at TEXT,
     outcome TEXT,
     reason TEXT,
     head TEXT
   );
   CREATE INDEX merge_attempts_ref ON merge_attempts (ref);`,
  `CREATE TABLE merge_state (
     kind TEXT NOT NULL,
     ref TEXT NOT NULL,
     value TEXT NOT NULL,
     PRIMARY KEY (kind, ref)
   );`,
  // One row per change of a score (scores.ts); `result` NULL: the subject lost the score.
  `CREATE TABLE scores (
     scorer TEXT NOT NULL,
     level TEXT NOT NULL,
     subject TEXT NOT NULL,
     agent TEXT NOT NULL,
     computed_at TEXT NOT NULL,
     value REAL,
     pass INTEGER,
     result TEXT,
     PRIMARY KEY (scorer, subject, agent, computed_at)
   );
   CREATE INDEX scores_agent ON scores (agent, scorer);`,
  // Definitions as code (W5): one snapshot per definition hash, and the hash each run started with.
  `CREATE TABLE definitions (
     hash TEXT PRIMARY KEY,
     root TEXT NOT NULL,
     "commit" TEXT,
     created_at TEXT NOT NULL,
     files TEXT NOT NULL
   );
   CREATE TABLE run_defs (
     run TEXT PRIMARY KEY,
     root TEXT NOT NULL,
     hash TEXT NOT NULL
   );
   CREATE INDEX run_defs_hash ON run_defs (hash);`,
  // Benchmarks (W5 phase 5): one row per attempt of a finished bench run, for `bench history`.
  // `summary_at` is when its summary last changed (finished, or judged again).
  `CREATE TABLE bench_results (
     run TEXT NOT NULL,
     "set" TEXT NOT NULL,
     entry TEXT NOT NULL,
     attempt INTEGER NOT NULL,
     mode TEXT NOT NULL,
     agent TEXT NOT NULL,
     model TEXT,
     variant TEXT,
     defs_hash TEXT,
     defs_ref TEXT,
     pass_rate REAL,
     hidden_total INTEGER NOT NULL,
     hidden_passed INTEGER NOT NULL,
     cost_usd REAL,
     cost_estimated INTEGER NOT NULL,
     wall_ms INTEGER,
     started_at TEXT NOT NULL,
     summary_at TEXT NOT NULL,
     PRIMARY KEY (run, entry, attempt)
   );
   CREATE INDEX bench_results_set ON bench_results ("set", started_at);`,
];

/** One row of `bench_results`: one attempt of a finished bench run (W5 phase 5). */
export interface BenchResultRow {
  /** The bench run's id: its folder name. */
  run: string;
  set: string;
  entry: string;
  attempt: number;
  /** `agent`, `none` or `reference`. */
  mode: string;
  agent: string;
  model: string | null;
  variant: string | null;
  /** The definition hash of the role file the prompts carried; null without one. */
  defs_hash: string | null;
  /** The git ref those definitions were read at (`--defs-ref`). */
  defs_ref: string | null;
  /** Checkable criteria passed, as a share; null without checkable criteria. */
  pass_rate: number | null;
  hidden_total: number;
  hidden_passed: number;
  /** The agent's cost in USD; null when unknown. */
  cost_usd: number | null;
  /** `cost_usd` is an estimate from the tokens. */
  cost_estimated: boolean;
  wall_ms: number | null;
  started_at: string;
  summary_at: string;
}

/** One file of a definition snapshot. */
export interface DefinitionFile {
  path: string;
  sha256: string;
  text: string;
}

/** A row of `definitions`: the files behind one definition hash. */
export interface DefinitionSnapshot {
  hash: string;
  root: string;
  commit: string | null;
  created_at: string;
  files: DefinitionFile[];
}

/**
 * swarmupd's own state on this PC, for every project it runs: `state.db` in the state folder
 * (`~/.swarmup/swarmupd`, or `SWARMUP_STATE_DIR`). Tasks, events and decisions stay files in git;
 * this holds what only this PC's swarmupd needs, such as its runs and its merge attempts. It is
 * never in a project repo.
 */
export class StateDb {
  /** The file: `state.db` in the state folder. */
  readonly path: string;

  constructor(readonly dir: string) {
    this.path = join(dir, 'state.db');
    // Opens it once to make or update its tables; a file that cannot open throws here.
    this.use(() => undefined);
  }

  /**
   * Runs `fn` on a connection of its own, closed when `fn` returns. Nothing holds the file open
   * between calls, so another process reads it, and its folder can go, whenever swarmupd is idle.
   */
  private use<T>(fn: (db: DatabaseSync) => T): T {
    const db = openDb(this.path);
    try {
      // WAL lets a reader in while swarmupd writes; a writer waits up to 5 s for another.
      db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
      if (!migrated.has(this.path)) {
        migrate(db);
        migrated.add(this.path);
      }
      return fn(db);
    } finally {
      db.close();
    }
  }

  /** The schema version: how many {@link MIGRATIONS} have run. */
  get version(): number {
    return this.use(versionOf);
  }

  /** Nothing to close: each call opens and closes its own connection. */
  close(): void {}

  // ---- Runs -------------------------------------------------------------------------------------

  /** Writes a run record, replacing the one with its id. */
  saveRun(row: RunRow, record: unknown): void {
    this.use((db) => saveRunIn(db, row, record));
  }

  /** The record of run `id`, or undefined. */
  run(id: string): unknown {
    const row = this.use(
      (db) =>
        db.prepare('SELECT record FROM runs WHERE id = ?').get(id) as
          { record: string } | undefined,
    );
    return row ? JSON.parse(row.record) : undefined;
  }

  /** Every run record it holds. */
  runs(): unknown[] {
    const rows = this.use(
      (db) => db.prepare('SELECT record FROM runs').all() as { record: string }[],
    );
    const out: unknown[] = [];
    for (const r of rows) {
      try {
        out.push(JSON.parse(r.record));
      } catch {
        // A record that does not parse is left out, as a run file that does not parse is.
      }
    }
    return out;
  }

  /** How many runs it holds. */
  runCount(): number {
    return this.use(
      (db) => (db.prepare('SELECT count(*) AS n FROM runs').get() as { n: number }).n,
    );
  }

  /**
   * Imports the run files in `<dir>/runs` it lacks, once per file: the runs swarmupd kept before
   * `state.db`. A file that does not parse is left out. Returns how many it imported.
   */
  importRunFiles(toRow: (record: unknown) => RunRow | null): number {
    const folder = join(this.dir, 'runs');
    if (!existsSync(folder)) return 0;
    return this.use((db) => {
      const have = new Set(
        (db.prepare('SELECT id FROM runs').all() as { id: string }[]).map((r) => r.id),
      );
      let n = 0;
      db.exec('BEGIN');
      try {
        for (const name of readdirSync(folder)) {
          if (!name.endsWith('.json') || have.has(name.slice(0, -5))) continue;
          let record: unknown;
          try {
            record = JSON.parse(readFileSync(join(folder, name), 'utf8'));
          } catch {
            continue;
          }
          const row = toRow(record);
          if (!row) continue;
          saveRunIn(db, row, record);
          n++;
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return n;
    });
  }

  // ---- Scores -----------------------------------------------------------------------------------

  /** Adds score rows in one transaction; a row with `result` null retires the score. */
  saveScores(
    rows: Array<{
      key: { scorer: string; level: string; subject: string; agent: string };
      result: { value: number; pass?: boolean } | null;
      computed_at: string;
    }>,
  ): void {
    this.use((db) => {
      const insert = db.prepare(
        `INSERT OR REPLACE INTO scores
           (scorer, level, subject, agent, computed_at, value, pass, result)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      db.exec('BEGIN');
      try {
        for (const { key, result, computed_at } of rows) {
          insert.run(
            key.scorer,
            key.level,
            key.subject,
            key.agent,
            computed_at,
            result ? result.value : null,
            result?.pass === undefined ? null : result.pass ? 1 : 0,
            result ? JSON.stringify(result) : null,
          );
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    });
  }

  /** The latest row of each scorer, subject and agent, without retired scores. */
  latestScores<T = unknown>(): Array<{ result: T; computed_at: string }> {
    const rows = this.use(
      (db) =>
        db
          .prepare(
            `SELECT s.result, s.computed_at FROM scores s
             JOIN (SELECT scorer, subject, agent, max(computed_at) AS at FROM scores
                   GROUP BY scorer, subject, agent) l
               ON s.scorer = l.scorer AND s.subject = l.subject AND s.agent = l.agent
                  AND s.computed_at = l.at
             WHERE s.result IS NOT NULL`,
          )
          .all() as Array<{ result: string; computed_at: string }>,
    );
    const out: Array<{ result: T; computed_at: string }> = [];
    for (const r of rows) {
      try {
        out.push({ result: JSON.parse(r.result) as T, computed_at: r.computed_at });
      } catch {
        // A row that does not parse is left out.
      }
    }
    return out;
  }

  /**
   * The rows of agent-level scores from `since` to `until` (ISO), oldest first, and the last row
   * of each before `since`, which opens a trend. Retired rows are left out. At most `limit` rows.
   */
  agentScoreHistory(opts: {
    since: string;
    until: string;
    agent?: string;
    scorer?: string;
    limit?: number;
  }): Array<{ agent: string; scorer: string; computed_at: string; value: number; n: number }> {
    const where: string[] = [];
    const args: string[] = [];
    if (opts.agent) {
      where.push('AND agent = ?');
      args.push(opts.agent);
    }
    if (opts.scorer) {
      where.push('AND scorer = ?');
      args.push(opts.scorer);
    }
    const filter = where.join(' ');
    type Row = { agent: string; scorer: string; computed_at: string; value: number; n: number };
    return this.use((db) => {
      const opening = db
        .prepare(
          `SELECT s.agent, s.scorer, s.computed_at, s.value, json_extract(s.result, '$.n') AS n
           FROM scores s
           JOIN (SELECT agent, scorer, max(computed_at) AS at FROM scores
                 WHERE level = 'agent' AND computed_at < ? ${filter}
                 GROUP BY agent, scorer) l
             ON s.agent = l.agent AND s.scorer = l.scorer AND s.computed_at = l.at
           WHERE s.level = 'agent' AND s.result IS NOT NULL`,
        )
        .all(opts.since, ...args) as Row[];
      const rows = db
        .prepare(
          `SELECT agent, scorer, computed_at, value, json_extract(result, '$.n') AS n FROM scores
           WHERE level = 'agent' AND result IS NOT NULL AND computed_at >= ? AND computed_at < ?
           ${filter}
           ORDER BY computed_at LIMIT ?`,
        )
        .all(opts.since, opts.until, ...args, opts.limit ?? 5000) as Row[];
      return [...opening, ...rows].map((r) => ({ ...r, n: Number(r.n) || 0 }));
    });
  }

  // ---- Definitions ----------------------------------------------------------------------------

  /** Keeps the files of a definition hash the first time it is seen; a known hash is left alone. */
  saveDefinitions(s: DefinitionSnapshot): boolean {
    return this.use((db) => {
      const r = db
        .prepare(
          `INSERT OR IGNORE INTO definitions (hash, root, "commit", created_at, files)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(s.hash, s.root, s.commit, s.created_at, JSON.stringify(s.files));
      return Number(r.changes) > 0;
    });
  }

  /** The snapshot of `hash`, or undefined. */
  definitions(hash: string): DefinitionSnapshot | undefined {
    const row = this.use(
      (db) =>
        db.prepare('SELECT * FROM definitions WHERE hash = ?').get(hash) as
          | { hash: string; root: string; commit: string | null; created_at: string; files: string }
          | undefined,
    );
    return row ? { ...row, files: JSON.parse(row.files) as DefinitionFile[] } : undefined;
  }

  /** Records the definition hash run `run` started with. */
  saveRunDefs(run: string, root: string, hash: string): void {
    this.use((db) =>
      db
        .prepare(
          `INSERT INTO run_defs (run, root, hash) VALUES (?, ?, ?)
           ON CONFLICT (run) DO UPDATE SET root = excluded.root, hash = excluded.hash`,
        )
        .run(run, root, hash),
    );
  }

  /** The runs that started with definition hash `hash`. */
  runsWithDefs(hash: string): string[] {
    return this.use(
      (db) =>
        db.prepare('SELECT run FROM run_defs WHERE hash = ? ORDER BY run').all(hash) as Array<{
          run: string;
        }>,
    ).map((r) => r.run);
  }

  // ---- Bench results ----------------------------------------------------------------------------

  /** Writes the attempts of bench runs, replacing the rows of the same run, entry and attempt. */
  saveBenchResults(rows: readonly BenchResultRow[]): void {
    if (rows.length === 0) return;
    this.use((db) => {
      const insert = db.prepare(
        `INSERT OR REPLACE INTO bench_results
           (run, "set", entry, attempt, mode, agent, model, variant, defs_hash, defs_ref,
            pass_rate, hidden_total, hidden_passed, cost_usd, cost_estimated, wall_ms,
            started_at, summary_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      db.exec('BEGIN');
      try {
        for (const r of rows) {
          insert.run(
            r.run,
            r.set,
            r.entry,
            r.attempt,
            r.mode,
            r.agent,
            r.model,
            r.variant,
            r.defs_hash,
            r.defs_ref,
            r.pass_rate,
            r.hidden_total,
            r.hidden_passed,
            r.cost_usd,
            r.cost_estimated ? 1 : 0,
            r.wall_ms,
            r.started_at,
            r.summary_at,
          );
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    });
  }

  /** Each recorded bench run with the `summary_at` of its rows, so a run is written once. */
  benchRecorded(): Map<string, string> {
    const rows = this.use(
      (db) =>
        db.prepare('SELECT run, max(summary_at) AS at FROM bench_results GROUP BY run').all() as {
          run: string;
          at: string;
        }[],
    );
    return new Map(rows.map((r) => [r.run, r.at]));
  }

  /** Bench attempts, newest first, filtered by set, agent and variant; at most `limit`. */
  benchResults(
    opts: { set?: string; agent?: string; variant?: string; limit?: number } = {},
  ): BenchResultRow[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (opts.set) {
      where.push('"set" = ?');
      args.push(opts.set);
    }
    if (opts.agent) {
      where.push('agent = ?');
      args.push(opts.agent);
    }
    if (opts.variant) {
      where.push('variant = ?');
      args.push(opts.variant);
    }
    const rows = this.use(
      (db) =>
        db
          .prepare(
            `SELECT * FROM bench_results ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
             ORDER BY started_at DESC, run DESC, entry, attempt LIMIT ?`,
          )
          .all(...args, opts.limit ?? 200) as Array<
          Omit<BenchResultRow, 'cost_estimated'> & { cost_estimated: number }
        >,
    );
    return rows.map((r) => ({ ...r, cost_estimated: r.cost_estimated === 1 }));
  }

  // ---- Merge state ------------------------------------------------------------------------------

  /** Every entry of one kind of merge state, by task. */
  mergeState(kind: string): Map<string, string> {
    const rows = this.use(
      (db) =>
        db.prepare('SELECT ref, value FROM merge_state WHERE kind = ?').all(kind) as {
          ref: string;
          value: string;
        }[],
    );
    return new Map(rows.map((r) => [r.ref, r.value]));
  }

  /** Sets one entry of merge state, or removes it with `value` undefined. */
  setMergeState(kind: string, ref: string, value: string | undefined): void {
    this.use((db) => {
      if (value === undefined) {
        db.prepare('DELETE FROM merge_state WHERE kind = ? AND ref = ?').run(kind, ref);
      } else {
        db.prepare(
          `INSERT INTO merge_state (kind, ref, value) VALUES (?, ?, ?)
           ON CONFLICT (kind, ref) DO UPDATE SET value = excluded.value`,
        ).run(kind, ref, value);
      }
    });
  }

  // ---- Merge attempts ---------------------------------------------------------------------------

  /** Records that a merge of `ref` started; returns the attempt's id. */
  mergeStarted(a: {
    ref: string;
    root: string;
    what: string;
    commit?: string;
    branch?: string;
    at: string;
  }): number {
    return this.use((db) => {
      const r = db
        .prepare(
          `INSERT INTO merge_attempts (ref, root, what, "commit", branch, started_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(a.ref, a.root, a.what, a.commit ?? null, a.branch ?? null, a.at);
      return Number(r.lastInsertRowid);
    });
  }

  /** Records how attempt `id` ended. An attempt ends once: a later call changes nothing. */
  mergeEnded(id: number, outcome: MergeOutcome, at: string, reason?: string, head?: string): void {
    this.use((db) =>
      db
        .prepare(
          `UPDATE merge_attempts SET ended_at = ?, outcome = ?, reason = ?, head = ?
           WHERE id = ? AND ended_at IS NULL`,
        )
        .run(at, outcome, reason ?? null, head ?? null, id),
    );
  }

  /** The merge attempts of `ref`, or of every task, newest first, at most `limit`. */
  mergeAttempts(ref?: string, limit = 200): MergeAttempt[] {
    const rows = this.use((db) =>
      ref
        ? db
            .prepare('SELECT * FROM merge_attempts WHERE ref = ? ORDER BY id DESC LIMIT ?')
            .all(ref, limit)
        : db.prepare('SELECT * FROM merge_attempts ORDER BY id DESC LIMIT ?').all(limit),
    );
    return rows as unknown as MergeAttempt[];
  }

  /** How many merge attempts since `since` (ISO time) ended in each outcome; open ones as `running`. */
  mergeCounts(since?: string): MergeCount[] {
    return this.use(
      (db) =>
        db
          .prepare(
            `SELECT coalesce(outcome, 'running') AS outcome, count(*) AS count FROM merge_attempts
             WHERE started_at >= ? GROUP BY 1 ORDER BY 2 DESC`,
          )
          .all(since ?? '') as unknown as MergeCount[],
    );
  }
}

/** The files whose tables this process has made or checked, so later connections skip it. */
const migrated = new Set<string>();

function versionOf(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

/**
 * Runs the {@link MIGRATIONS} the file lacks. The write lock comes first and the version is read
 * under it, so a CLI and swarmupd that open `state.db` at once never run a step twice.
 */
function migrate(db: DatabaseSync): void {
  if (versionOf(db) >= MIGRATIONS.length) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let v = versionOf(db); v < MIGRATIONS.length; v++) {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function saveRunIn(db: DatabaseSync, row: RunRow, record: unknown): void {
  db.prepare(
    `INSERT INTO runs (id, agent, task, root, status, started_at, ended_at, record)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET agent = excluded.agent, task = excluded.task,
       root = excluded.root, status = excluded.status, started_at = excluded.started_at,
       ended_at = excluded.ended_at, record = excluded.record`,
  ).run(
    row.id,
    row.agent,
    row.task ?? null,
    row.root ?? null,
    row.status,
    row.started_at,
    row.ended_at ?? null,
    JSON.stringify(record),
  );
}

/**
 * A map of merge state by task that `state.db` keeps across restarts: reads come from memory,
 * each change is written through. Without a `state.db` it is a plain map, as before.
 */
export class StoredMap<V> {
  private readonly mem: Map<string, V>;

  constructor(
    private readonly db: StateDb | null,
    private readonly kind: string,
    private readonly codec: { encode: (v: V) => string; decode: (s: string) => V },
  ) {
    this.mem = new Map();
    if (!db) return;
    try {
      for (const [ref, raw] of db.mergeState(kind)) this.mem.set(ref, codec.decode(raw));
    } catch {
      // A state.db that cannot be read starts empty, as a fresh swarmupd does.
    }
  }

  get(ref: string): V | undefined {
    return this.mem.get(ref);
  }

  has(ref: string): boolean {
    return this.mem.has(ref);
  }

  set(ref: string, value: V): this {
    this.mem.set(ref, value);
    this.write(ref, this.codec.encode(value));
    return this;
  }

  delete(ref: string): boolean {
    const had = this.mem.delete(ref);
    if (had) this.write(ref, undefined);
    return had;
  }

  private write(ref: string, value: string | undefined): void {
    try {
      this.db?.setMergeState(this.kind, ref, value);
    } catch {
      // Memory holds it until the next restart.
    }
  }
}

/** A set of tasks that `state.db` keeps across restarts; see {@link StoredMap}. */
export class StoredSet {
  private readonly map: StoredMap<true>;

  constructor(db: StateDb | null, kind: string) {
    this.map = new StoredMap(db, kind, { encode: () => '1', decode: () => true });
  }

  has(ref: string): boolean {
    return this.map.has(ref);
  }

  add(ref: string): this {
    this.map.set(ref, true);
    return this;
  }

  delete(ref: string): boolean {
    return this.map.delete(ref);
  }
}
