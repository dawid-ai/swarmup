import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
];

/**
 * swarmupd's own state on this PC, for every project it runs: `state.db` in the state folder
 * (`~/.swarmup/swarmupd`, or `SWARMUP_STATE_DIR`). Tasks, events and decisions stay files in git;
 * this holds what only this PC's swarmupd needs, such as its runs and its merge attempts. It is
 * never in a project repo.
 */
export class StateDb {
  private readonly db: DatabaseSync;

  constructor(readonly dir: string) {
    this.db = new DatabaseSync(join(dir, 'state.db'));
    // WAL lets a CLI read while swarmupd writes; a writer waits up to 5 s for another.
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  /** The schema version: how many {@link MIGRATIONS} have run. */
  get version(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    return row.user_version;
  }

  /**
   * Runs the {@link MIGRATIONS} this file lacks. The write lock comes first and the version is
   * read under it, so a CLI and swarmupd that open `state.db` at once never run a step twice.
   */
  private migrate(): void {
    if (this.version >= MIGRATIONS.length) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (let v = this.version; v < MIGRATIONS.length; v++) {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- Runs -------------------------------------------------------------------------------------

  /** Writes a run record, replacing the one with its id. */
  saveRun(row: RunRow, record: unknown): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, agent, task, root, status, started_at, ended_at, record)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET agent = excluded.agent, task = excluded.task,
           root = excluded.root, status = excluded.status, started_at = excluded.started_at,
           ended_at = excluded.ended_at, record = excluded.record`,
      )
      .run(
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

  /** The record of run `id`, or undefined. */
  run(id: string): unknown {
    const row = this.db.prepare('SELECT record FROM runs WHERE id = ?').get(id) as
      { record: string } | undefined;
    return row ? JSON.parse(row.record) : undefined;
  }

  /** How many runs it holds. */
  runCount(): number {
    return (this.db.prepare('SELECT count(*) AS n FROM runs').get() as { n: number }).n;
  }

  /**
   * Imports the run files in `<dir>/runs` it lacks, once per file: the runs swarmupd kept before
   * `state.db`. A file that does not parse is left out. Returns how many it imported.
   */
  importRunFiles(toRow: (record: unknown) => RunRow | null): number {
    const folder = join(this.dir, 'runs');
    if (!existsSync(folder)) return 0;
    const have = new Set(
      (this.db.prepare('SELECT id FROM runs').all() as { id: string }[]).map((r) => r.id),
    );
    let n = 0;
    this.db.exec('BEGIN');
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
        this.saveRun(row, record);
        n++;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return n;
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
    const r = this.db
      .prepare(
        `INSERT INTO merge_attempts (ref, root, what, "commit", branch, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(a.ref, a.root, a.what, a.commit ?? null, a.branch ?? null, a.at);
    return Number(r.lastInsertRowid);
  }

  /** Records how attempt `id` ended. An attempt ends once: a later call changes nothing. */
  mergeEnded(id: number, outcome: MergeOutcome, at: string, reason?: string, head?: string): void {
    this.db
      .prepare(
        `UPDATE merge_attempts SET ended_at = ?, outcome = ?, reason = ?, head = ?
         WHERE id = ? AND ended_at IS NULL`,
      )
      .run(at, outcome, reason ?? null, head ?? null, id);
  }

  /** The merge attempts of `ref`, or of every task, newest first, at most `limit`. */
  mergeAttempts(ref?: string, limit = 200): MergeAttempt[] {
    const rows = ref
      ? this.db
          .prepare('SELECT * FROM merge_attempts WHERE ref = ? ORDER BY id DESC LIMIT ?')
          .all(ref, limit)
      : this.db.prepare('SELECT * FROM merge_attempts ORDER BY id DESC LIMIT ?').all(limit);
    return rows as unknown as MergeAttempt[];
  }

  /** How many merge attempts since `since` (ISO time) ended in each outcome; open ones as `running`. */
  mergeCounts(since?: string): MergeCount[] {
    return this.db
      .prepare(
        `SELECT coalesce(outcome, 'running') AS outcome, count(*) AS count FROM merge_attempts
         WHERE started_at >= ? GROUP BY 1 ORDER BY 2 DESC`,
      )
      .all(since ?? '') as unknown as MergeCount[];
  }
}
