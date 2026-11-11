// Learn-note reads (AO-0186): one small JSON file per read, `kb-reads/<yyyy-mm>/<ulid>-<actor>.json`,
// so the replay can show notes being reused. Reads stay out of task events: they never change task
// state. Like event files, read files are immutable and uniquely named, so two clones never
// conflict on them and the Master Repo mirror copies them as a union.
//
// Shown records (AO-0152) are the same kind of file in `kb-shown/`: one per run prompt that listed
// notes. Reads and shown records together say how much a note is used.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { actorSlug, OpsError } from './ids.js';
import type { KbNote } from './kb.js';
import type { Root } from './root.js';
import { ulid } from './ulid.js';

/** One read of a learn note. */
export interface KbRead {
  /** The root the read file is in, which is the root of the note. */
  root: string;
  /** The file's ULID. */
  id: string;
  actor: string;
  at: string;
  /** The note as `<topic>/<slug>`. */
  ref: string;
  /** The task the reader held, when there was exactly one. */
  task?: string;
  /** The root of `task`, when it is not the note's root. */
  task_root?: string;
}

const MONTH = /^\d{4}-\d{2}$/;
const FILE = /^[0-9A-HJKMNP-TV-Z]{26}-[a-z0-9-]+\.json$/;

/** True for a real folder or file, never a link: links in a synced repo could point anywhere. */
function plain(path: string, kind: 'dir' | 'file'): boolean {
  try {
    const s = lstatSync(path);
    return kind === 'dir' ? s.isDirectory() : s.isFile();
  } catch {
    return false;
  }
}

/** The notes one run prompt listed (AO-0152): `kb-shown/<yyyy-mm>/<ulid>-<actor>.json`. */
export interface KbShown {
  /** The root the record is in, which is the root of the notes. */
  root: string;
  /** The file's ULID. */
  id: string;
  /** The agent whose prompt listed the notes. */
  actor: string;
  at: string;
  /** The notes as `<topic>/<slug>`, each once. */
  refs: string[];
  /** The task the run works on. */
  task?: string;
  /** The root of `task`, when it is not the notes' root. */
  task_root?: string;
  /** The run id, when the writer has one. */
  run?: string;
}

type Folder = 'kb-reads' | 'kb-shown';

/** Writes one immutable record file in `folder` of `root`. */
function writeRecord(root: Root, folder: Folder, body: { actor: string; at: string }): string {
  const atMs = Date.parse(body.at);
  const top = join(root.dir, folder);
  const dir = join(top, body.at.slice(0, 7));
  // Check each level before creating anything in it, so nothing lands behind a link.
  for (const [path, name] of [
    [top, folder],
    [dir, `${folder}/${body.at.slice(0, 7)}`],
  ] as const) {
    if (!existsSync(path)) mkdirSync(path);
    if (!plain(path, 'dir'))
      throw new OpsError(`${name} is a link; note records go in a real folder`, 2);
  }
  const id = ulid(atMs);
  root.writeAtomic(join(dir, `${id}-${actorSlug(body.actor)}.json`), `${JSON.stringify(body)}\n`);
  return id;
}

/**
 * Records in `folder` of `root`, oldest first. With `from` and `to` (ms), month folders wholly
 * outside the window are skipped; records are not filtered by time, so callers clip them. Damaged
 * files, odd names and links are skipped.
 */
function readRecords<T>(
  root: Root,
  folder: Folder,
  parseOne: (text: string) => T | null,
  opts: { from?: number; to?: number },
): (T & { root: string; id: string })[] {
  const top = join(root.dir, folder);
  if (!plain(top, 'dir')) return [];
  const fromMonth = opts.from !== undefined && Number.isFinite(opts.from) ? month(opts.from) : '';
  const toMonth = opts.to !== undefined && Number.isFinite(opts.to) ? month(opts.to) : '9999-99';
  const out: (T & { root: string; id: string })[] = [];
  for (const m of readdirSync(top).sort()) {
    if (!MONTH.test(m) || m < fromMonth || m > toMonth) continue;
    const dir = join(top, m);
    if (!plain(dir, 'dir')) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!FILE.test(name)) continue;
      const file = join(dir, name);
      if (!plain(file, 'file')) continue;
      const rec = parseOne(readFileSync(file, 'utf8'));
      if (rec) out.push({ root: root.name, id: name.slice(0, 26), ...rec });
    }
  }
  return out;
}

/** Writes one read record in `root` and returns it. */
export function writeRead(
  root: Root,
  read: Omit<KbRead, 'root' | 'id' | 'at'>,
  atMs: number,
): KbRead {
  const body: Omit<KbRead, 'root' | 'id'> = {
    actor: read.actor,
    at: new Date(atMs).toISOString(),
    ref: read.ref,
    ...(read.task ? { task: read.task } : {}),
    ...(read.task_root ? { task_root: read.task_root } : {}),
  };
  return { root: root.name, id: writeRecord(root, 'kb-reads', body), ...body };
}

/** Read records in `root`, oldest first; `readRecords` describes the window and what is skipped. */
export function readReads(root: Root, opts: { from?: number; to?: number } = {}): KbRead[] {
  return readRecords(root, 'kb-reads', parse, opts);
}

/**
 * Writes one record of the notes a run prompt listed, in `root`, and returns it. One file holds
 * every note of that root in the prompt, so a run adds one file, not one per note. Shown records
 * stay out of `kb-reads/`: the replay lights every record there as a read.
 */
export function writeShown(
  root: Root,
  shown: Omit<KbShown, 'root' | 'id' | 'at'>,
  atMs: number,
): KbShown {
  const refs = [...new Set(shown.refs)];
  if (refs.length === 0) throw new OpsError('a shown record needs at least one note', 2);
  const body: Omit<KbShown, 'root' | 'id'> = {
    actor: shown.actor,
    at: new Date(atMs).toISOString(),
    refs,
    ...(shown.task ? { task: shown.task } : {}),
    ...(shown.task_root ? { task_root: shown.task_root } : {}),
    ...(shown.run ? { run: shown.run } : {}),
  };
  return { root: root.name, id: writeRecord(root, 'kb-shown', body), ...body };
}

/** Shown records in `root`, oldest first; `readRecords` describes the window and what is skipped. */
export function readShown(root: Root, opts: { from?: number; to?: number } = {}): KbShown[] {
  return readRecords(root, 'kb-shown', parseShown, opts);
}

/**
 * How much a learn note is used (AO-0152), counted from the read and shown records. A note is
 * used when an agent reads it (`kb --read` during a task) or when a run prompt lists it.
 */
export interface NoteUsage {
  note: KbNote;
  /** Every recorded read of the note. */
  reads: number;
  /** Reads at or after the window's start. */
  recent: number;
  /** ISO time of the newest read. */
  lastRead?: string;
  /** Every run prompt that listed the note. */
  shown: number;
  /** Listings at or after the window's start. */
  recentShown: number;
  /** ISO time of the newest listing. */
  lastShown?: string;
  /** The newer of `lastRead` and `lastShown`. */
  lastUsed?: string;
  /**
   * Neither read nor shown in the window, and the note is older than the window: a candidate to
   * prune.
   */
  stale: boolean;
}

interface Count {
  n: number;
  recent: number;
  last?: string;
}

function count(map: Map<string, Count>, key: string, at: string, sinceMs: number): void {
  const u = map.get(key) ?? { n: 0, recent: 0 };
  u.n += 1;
  if (Date.parse(at) >= sinceMs) u.recent += 1;
  if (!u.last || Date.parse(at) > Date.parse(u.last)) u.last = at;
  map.set(key, u);
}

/**
 * Counts `reads` and `shown` per note. A record counts for a note when both are in the same root
 * and name the same `<topic>/<slug>`. `sinceMs` starts the window that `recent`, `recentShown`
 * and `stale` use. Records of notes that no longer exist are ignored.
 */
export function noteUsage(
  notes: KbNote[],
  reads: KbRead[],
  sinceMs: number,
  shown: KbShown[] = [],
): NoteUsage[] {
  const read = new Map<string, Count>();
  for (const r of reads) count(read, `${r.root}/${r.ref}`, r.at, sinceMs);
  const listed = new Map<string, Count>();
  for (const s of shown) {
    for (const ref of new Set(s.refs)) count(listed, `${s.root}/${ref}`, s.at, sinceMs);
  }
  return notes.map((note) => {
    const r = read.get(`${note.root}/${note.ref}`);
    const s = listed.get(`${note.root}/${note.ref}`);
    const created = Date.parse(note.created_at);
    const lastUsed =
      r?.last && s?.last && Date.parse(s.last) > Date.parse(r.last) ? s.last : (r?.last ?? s?.last);
    return {
      note,
      reads: r?.n ?? 0,
      recent: r?.recent ?? 0,
      ...(r?.last ? { lastRead: r.last } : {}),
      shown: s?.n ?? 0,
      recentShown: s?.recent ?? 0,
      ...(s?.last ? { lastShown: s.last } : {}),
      ...(lastUsed ? { lastUsed } : {}),
      // A note with a damaged date counts as old: it can only be pruned by hand anyway.
      stale: (r?.recent ?? 0) === 0 && (s?.recent ?? 0) === 0 && !(created >= sinceMs),
    };
  });
}

function month(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

function parseShown(text: string): Omit<KbShown, 'root' | 'id'> | null {
  try {
    const d = JSON.parse(text) as Record<string, unknown>;
    const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
    if (!str(d.actor) || !str(d.at) || Number.isNaN(Date.parse(d.at))) return null;
    const refs = Array.isArray(d.refs) ? [...new Set(d.refs.filter(str))] : [];
    if (refs.length === 0) return null;
    return {
      actor: d.actor,
      at: d.at,
      refs,
      ...(str(d.task) ? { task: d.task } : {}),
      ...(str(d.task_root) ? { task_root: d.task_root } : {}),
      ...(str(d.run) ? { run: d.run } : {}),
    };
  } catch {
    return null;
  }
}

function parse(text: string): Omit<KbRead, 'root' | 'id'> | null {
  try {
    const d = JSON.parse(text) as Record<string, unknown>;
    const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
    if (!str(d.actor) || !str(d.at) || !str(d.ref) || Number.isNaN(Date.parse(d.at))) return null;
    return {
      actor: d.actor,
      at: d.at,
      ref: d.ref,
      ...(str(d.task) ? { task: d.task } : {}),
      ...(str(d.task_root) ? { task_root: d.task_root } : {}),
    };
  } catch {
    return null;
  }
}
