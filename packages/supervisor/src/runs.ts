import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, join } from 'node:path';
import type { LeftoverCommit } from './checkout.js';
import type { ProcLedger } from './procs.js';

/** Renames into place, retrying while Windows holds the target open for a reader. */
function replaceFile(tmp: string, file: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== 'EPERM' && code !== 'EBUSY')) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

/** One supervised agent run, kept in `<state>/runs/<id>.json`. */
export interface RunRecord {
  id: string;
  agent: string;
  task?: string;
  /** The task's root name. */
  root?: string;
  /** The project the run counts against: the task's project, else its root's name. */
  project?: string;
  /** A review run: it gives a verdict on the task and holds no claim. */
  review?: boolean;
  /**
   * A question run (AO-0063): it answers a question task and writes nothing in the checkout, so
   * role limits per project and the one-writer-per-checkout rule neither stop nor count it.
   */
  question?: boolean;
  /** A helper run (`swarmup spawn`): the run that started it. It works under that run's claim. */
  parent?: string;
  schedule?: string;
  /** A plan check (AO-0109): a PM run that compares new plans with the decisions in force. */
  plan_check?: boolean;
  /**
   * A run with no task on the standard prompt: it reads the agent's whole inbox (AO-0128).
   * Missing for runs with their own prompt, such as a schedule's or a helper's.
   */
  inbox?: boolean;
  /** A turn of the desktop chat with the orchestrator. */
  chat?: boolean;
  pid: number;
  /** Executable name of the PID, checked before an adopted run is killed. */
  image: string;
  /** The process creation time, so a later process that reuses the PID is never taken for it. */
  proc_start?: string;
  /**
   * Windows: the hidden `cmd.exe` swarmupd started the run through. `pid`, `image` and `proc_start`
   * name it until the run's launcher reports in, then the launcher, which outlives swarmupd and runs
   * the command.
   */
  shim_pid?: number;
  command: string;
  cwd: string;
  log: string;
  started_at: string;
  ended_at?: string;
  status: 'running' | 'ended';
  exit?: number | null;
  /** `exit`, `budget`, `tokens`, `killed`, `lost` or `shutdown`. */
  reason?: string;
  budget_minutes: number;
  token_budget?: number;
  tokens: number;
  /** Processes of the run still alive after it ended and swarmupd tried to kill them. */
  procs_left?: number;
  /**
   * SHA-256 of the run's API token (`SWARMUP_RUN_TOKEN`). The token itself lives only in the run's
   * environment; the hash lets a swarmupd that adopts the run still recognize it.
   */
  token_sha256?: string;
  /**
   * A top-level run of a role that writes: the commit checked out in its git checkout when it
   * started. What the run leaves there is committed on a branch from it.
   */
  base?: string;
  /**
   * How far the wrap-up after the run's end got, so a restarted swarmupd resumes it: `pending` from
   * the end, `committed` once what the run left is dealt with (`leftovers`, `not_committed`),
   * `recorded` once the run-end event is on the task, `settled` once the task is freed or sent
   * for review, `done` after the sync. Absent on runs ended before swarmupd kept it.
   */
  wrap_up?: 'pending' | 'committed' | 'recorded' | 'settled' | 'done';
  /** What swarmupd committed of what the run left. */
  leftovers?: Leftovers;
  /** Why swarmupd left the run's changes uncommitted. */
  not_committed?: string;
  /**
   * The run's own folder for scratch files (`SWARMUP_SCRATCH`, also `TEMP`, `TMP` and `TMPDIR`),
   * under swarmupd's state folder. Removed `scratch_days` after the run ends (AO-0230).
   */
  scratch?: string;
  /**
   * The names in each folder next to a writing run's checkout when it started, by folder. New
   * names there at its end are named in its `run-end` event (AO-0230).
   */
  around?: Record<string, string[]>;
}

/** A commit of what a run left, in the checkout `top`; `into` is the branch to merge it into. */
export type Leftovers = LeftoverCommit & { top: string; into: string | null };

/** Which runs a page lists: every run, running ones, ended ones, or failed ones. */
export type RunFilter = 'all' | 'live' | 'ended' | 'errors';

export const RUN_FILTERS: readonly RunFilter[] = ['all', 'live', 'ended', 'errors'];

/** One page of runs for the desktop Runs view, from `GET /api/runs?limit=`. */
export interface RunPage {
  /**
   * The newest runs that match the filter, older than `before` and not older than `from`, at
   * most `limit` of them.
   */
  runs: RunRecord[];
  /** More matching runs follow the last one; ask again with `before` set to its id. */
  more: boolean;
  /** Runs in each filter, over every run. */
  counts: Record<RunFilter, number>;
  /** Runs started at or after `since`, their tokens, and how many of them failed. */
  today: { runs: number; tokens: number; errors: number };
  /** The run `pick` names, by id or by the end of its id, wherever it is in the list. */
  pick: RunRecord | null;
}

/** A run that ended on its own with a non-zero exit, hit a budget, or was lost; a kill is not one. */
export function runFailed(r: RunRecord): boolean {
  if (r.status === 'running') return false;
  if (r.reason === 'killed') return false;
  return r.reason !== 'exit' || r.exit !== 0;
}

function inFilter(r: RunRecord, filter: RunFilter): boolean {
  if (filter === 'live') return r.status === 'running';
  if (filter === 'ended') return r.status === 'ended';
  if (filter === 'errors') return runFailed(r);
  return true;
}

/**
 * One page of `all`, which is newest first, with the counts the Runs view shows. `since`
 * defaults to the local midnight of today.
 */
export function pageRuns(
  all: RunRecord[],
  opts: {
    limit: number;
    before?: string;
    from?: string;
    filter?: RunFilter;
    since?: string;
    pick?: string;
  },
): RunPage {
  const filter = opts.filter ?? 'all';
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const since = opts.since ? Date.parse(opts.since) : midnight.getTime();
  const counts: Record<RunFilter, number> = { all: 0, live: 0, ended: 0, errors: 0 };
  const today = { runs: 0, tokens: 0, errors: 0 };
  const runs: RunRecord[] = [];
  let more = false;
  for (const r of all) {
    const failed = runFailed(r);
    counts.all++;
    if (r.status === 'running') counts.live++;
    if (r.status === 'ended') counts.ended++;
    if (failed) counts.errors++;
    if (Date.parse(r.started_at) >= since) {
      today.runs++;
      today.tokens += r.tokens;
      if (failed) today.errors++;
    }
    if (!inFilter(r, filter)) continue;
    if (opts.before !== undefined && r.id >= opts.before) continue;
    if (opts.from !== undefined && r.id < opts.from) continue;
    if (runs.length < opts.limit) runs.push(r);
    else more = true;
  }
  const want = opts.pick?.toUpperCase();
  const pick = want
    ? (all.find((r) => r.id === want) ?? all.find((r) => r.id.endsWith(want)) ?? null)
    : null;
  return { runs, more, counts, today, pick };
}

export class RunStore {
  /** Parsed run files by file name, with the mtime and size they were read at. */
  private readonly cache = new Map<string, { mtimeMs: number; size: number; record: RunRecord }>();

  constructor(readonly dir: string) {
    mkdirSync(join(dir, 'runs'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    mkdirSync(join(dir, 'procs'), { recursive: true });
  }

  /** The run's process ledger, or null when none was kept. */
  procs(id: string): ProcLedger | null {
    return this.readJson<ProcLedger | null>(join('procs', `${id}.json`), null);
  }

  saveProcs(ledger: ProcLedger): void {
    this.writeJson(join('procs', `${ledger.run}.json`), ledger);
  }

  logPath(id: string): string {
    return join(this.dir, 'logs', `${id}.log`);
  }

  save(r: RunRecord): void {
    const file = join(this.dir, 'runs', `${r.id}.json`);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(r, null, 2));
    replaceFile(tmp, file);
    // Two saves of the same size inside one mtime tick would look unchanged to `list`.
    this.cache.delete(`${r.id}.json`);
  }

  get(id: string): RunRecord | undefined {
    const file = join(this.dir, 'runs', `${id}.json`);
    if (!existsSync(file)) return undefined;
    try {
      const record = JSON.parse(readFileSync(file, 'utf8')) as RunRecord;
      // A record written before the state folder moved (AO-0200) names the log at its old path.
      if (record.log && !record.log.startsWith(this.dir) && basename(record.log) === `${id}.log`) {
        record.log = this.logPath(id);
      }
      return record;
    } catch {
      return undefined;
    }
  }

  /** Every run, newest first. */
  list(): RunRecord[] {
    // A run file is parsed again only when its mtime or size changed: with 1,500 runs on disk a
    // stat of each takes ~11 ms, a read and parse of each ~55 ms (AO-0167). The records come back
    // as shallow copies, so a caller that sets a field never changes the cache.
    const names = readdirSync(join(this.dir, 'runs'))
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse();
    const out: RunRecord[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      seen.add(name);
      const file = join(this.dir, 'runs', name);
      let st: Stats;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      let hit = this.cache.get(name);
      if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
        const record = this.get(name.slice(0, -5));
        if (!record) {
          this.cache.delete(name);
          continue;
        }
        hit = { mtimeMs: st.mtimeMs, size: st.size, record };
        this.cache.set(name, hit);
      }
      out.push({ ...hit.record });
    }
    for (const name of this.cache.keys()) if (!seen.has(name)) this.cache.delete(name);
    return out;
  }

  readJson<T>(name: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  writeJson(name: string, data: unknown): void {
    const file = join(this.dir, name);
    writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
    replaceFile(`${file}.tmp`, file);
  }
}
