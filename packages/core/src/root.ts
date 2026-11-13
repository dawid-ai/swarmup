import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { RootConfig } from './config.js';
import { ID_BLOCK_SIZE, isMirrorDir, readRootConfig } from './config.js';
import { fold } from './fold.js';
import { parseDoc, stringifyDoc } from './frontmatter.js';
import { actorSlug, doneWhenLines, formatTaskId, OpsError, parseTaskId } from './ids.js';
import { withLock, withLockAsync } from './lock.js';
import type { OpsEvent, TaskMeta, TaskState } from './model.js';
import { ulid, ulidAfter } from './ulid.js';

// 5: task states carry waitEvent. 6: task states carry the resolved project; `p` stamps it.
// 7: task states carry lastReview.
// 8: an assign with keep_wait keeps the task blocked; older builds folded it to todo.
// 9: addressed events carry their whole body as `detail` when it is longer than the summary.
// 10: addressed events and lastReview carry the recommended decision (`recommend`).
// 11: task states carry awaitsMerge.
// 12: task metas carry done_when as a list; an older build kept a hand-written text value as text.
const INDEX_VERSION = 12;

interface IndexEntry {
  tm: number;
  em: number;
  state: TaskState;
}

interface IndexFile {
  v: number;
  /** The root's project settings the states were folded with (`Root.projectStamp`). */
  p?: string;
  tasks: Record<string, IndexEntry>;
}

/** How long after a change a file time may still hide a second change: git's racy-timestamp rule. */
const RACY_MS = 2000;

/**
 * A root's index as this process last read or wrote it, so a process that reads the tasks many
 * times (swarmupd answers each request with a fresh read) parses `index.json` once, not per read
 * (AO-0276). `stamp` is the file's time and size then: another process's write changes it, and
 * the next read takes the file again.
 */
interface MemIndex {
  stamp: string;
  p: string;
  tasks: Record<string, IndexEntry>;
  /**
   * Tasks whose events folder changed inside the racy window, with what was folded: the real
   * times and the event file names. Event files are never edited, so the same names under an
   * unchanged `task.md` mean the same fold.
   */
  racy: Map<string, RacyFold>;
}

interface RacyFold {
  tm: number;
  em: number;
  names: string;
}

const memIndexes = new Map<string, MemIndex>();
/** Roots kept in {@link memIndexes}; the one remembered longest ago goes first. */
const MEM_INDEX_ROOTS = 16;

function rememberIndex(file: string, mem: MemIndex): void {
  memIndexes.delete(file);
  memIndexes.set(file, mem);
  if (memIndexes.size > MEM_INDEX_ROOTS) memIndexes.delete(memIndexes.keys().next().value!);
}

function fileStamp(path: string): string {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '';
  }
}

/** Freezes a cached state all the way down: every read shares it, so no caller may change it. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function eventNames(taskDir: string): string {
  try {
    return readdirSync(join(taskDir, 'events')).join('/');
  } catch {
    return '';
  }
}

/** {@link fileStamp} with the file's name, for a file that {@link Root.localFile} picks. */
function localStamp(path: string): string {
  const stamp = fileStamp(path);
  return stamp === '' ? '' : `${basename(path)}:${stamp}`;
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** One data root: a folder of tasks, events and config inside a git repo. */
export class Root {
  readonly config: RootConfig;

  constructor(readonly dir: string) {
    this.config = readRootConfig(dir);
  }

  get name(): string {
    return this.config.name;
  }

  get prefix(): string {
    return this.config.id_prefix;
  }

  get opsDir(): string {
    return join(this.dir, '.ops');
  }

  /**
   * The project a task reads as: the name it gives, else the root's default project (`project`,
   * else the root's name), then mapped once through `project_aliases`. Every task read goes
   * through this, so a checkout whose tasks were filed under two names shows one project.
   */
  projectName(given?: string): string {
    const name = (typeof given === 'string' && given.trim()) || this.defaultProject();
    const aliases = this.config.project_aliases;
    const to = aliases && Object.hasOwn(aliases, name) ? aliases[name] : undefined;
    return typeof to === 'string' && to.trim() ? to.trim() : name;
  }

  private defaultProject(): string {
    const p = this.config.project;
    return (typeof p === 'string' && p.trim()) || this.name;
  }

  /** Changes when the project settings change, so caches of resolved tasks know to refold. */
  get projectStamp(): string {
    return JSON.stringify([this.config.project ?? null, this.config.project_aliases ?? null]);
  }

  /** A Master Repo's copy of a project root (`<master>/mirrors/<name>/`). */
  get isMirror(): boolean {
    return isMirrorDir(this.dir);
  }

  /** The folder of a live task. */
  liveDir(id: string): string {
    return join(this.dir, 'tasks', id);
  }

  /** The folder of an archived task. */
  archiveDir(id: string): string {
    return join(this.dir, 'archive', 'tasks', id);
  }

  /** The task's folder: live when it exists there, else archived when it exists there. */
  taskDir(id: string): string {
    const live = this.liveDir(id);
    if (existsSync(join(live, 'task.md'))) return live;
    const archived = this.archiveDir(id);
    return existsSync(join(archived, 'task.md')) ? archived : live;
  }

  hasTask(id: string): boolean {
    return existsSync(join(this.taskDir(id), 'task.md'));
  }

  isArchived(id: string): boolean {
    return (
      !existsSync(join(this.liveDir(id), 'task.md')) &&
      existsSync(join(this.archiveDir(id), 'task.md'))
    );
  }

  /** Runs `fn` under a named lock in this root's `.ops/locks`. */
  lock<T>(name: string, fn: () => T): T {
    return withLock(join(this.opsDir, 'locks', `${name}.lock`), fn);
  }

  /** {@link lock} for async work: waits without blocking the event loop. */
  lockAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return withLockAsync(join(this.opsDir, 'locks', `${name}.lock`), fn);
  }

  /** Writes a file by renaming a finished temp file into place, so readers never see half of it. */
  writeAtomic(path: string, content: string | Uint8Array, retries = RENAME_RETRIES): void {
    const tmpDir = join(this.opsDir, 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    const tmp = join(tmpDir, `${ulid()}.tmp`);
    if (typeof content === 'string') writeFileSync(tmp, content, 'utf8');
    else writeFileSync(tmp, content);
    try {
      this.renameRetry(tmp, path, retries);
    } catch (err) {
      // A rename that never happened leaves the temp file, and nothing else removes it.
      try {
        rmSync(tmp, { force: true });
      } catch {
        // The error of the rename is the one to report.
      }
      throw err;
    }
  }

  /** Renames, retrying while Windows holds the source or target open. */
  renameRetry(from: string, to: string, retries = RENAME_RETRIES): void {
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(from, to);
        return;
      } catch (err) {
        // Windows reports EPERM or EBUSY while a scanner or editor holds the target open.
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt >= retries || (code !== 'EPERM' && code !== 'EBUSY')) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  }

  /** Ids of live tasks (not archived). */
  listTaskIds(): string[] {
    return this.idsIn(join(this.dir, 'tasks'));
  }

  listArchivedIds(): string[] {
    return this.idsIn(join(this.dir, 'archive', 'tasks'));
  }

  private idsIn(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((name) => parseTaskId(name)?.prefix === this.prefix);
  }

  /** Moves a task folder to `archive/tasks/`. Events and history move with it. */
  archiveTask(id: string): void {
    const to = this.archiveDir(id);
    mkdirSync(join(this.dir, 'archive', 'tasks'), { recursive: true });
    if (existsSync(to)) throw new OpsError(`${id} is already in the archive`);
    this.renameRetry(this.liveDir(id), to);
  }

  /** Moves an archived task folder back to `tasks/`. */
  unarchiveTask(id: string): void {
    if (existsSync(this.liveDir(id))) throw new OpsError(`${id} exists in tasks/ and archive/`);
    this.renameRetry(this.archiveDir(id), this.liveDir(id));
  }

  /** Folds every archived task. Archived tasks are read rarely, so they have no cache. */
  archivedStates(): TaskState[] {
    return this.listArchivedIds().map((id) =>
      fold(this.readTaskAt(this.archiveDir(id), id).meta, this.readEventsAt(this.archiveDir(id))),
    );
  }

  readTask(id: string): { meta: TaskMeta; body: string } {
    return this.readTaskAt(this.taskDir(id), id);
  }

  /**
   * The project a task's `task.md` names, old names mapped, or undefined when it names none. A
   * task that inherits it keeps following the root's default project when its source does.
   */
  namedProject(id: string): string | undefined {
    const p = this.parseTaskAt(this.taskDir(id), id).data.project;
    return typeof p === 'string' && p.trim() ? this.projectName(p) : undefined;
  }

  private parseTaskAt(dir: string, id: string): { data: TaskMeta; body: string } {
    const file = join(dir, 'task.md');
    if (!existsSync(file)) throw new OpsError(`no task ${id} in root '${this.name}'`, 2);
    return parseDoc<TaskMeta>(readFileSync(file, 'utf8'));
  }

  private readTaskAt(dir: string, id: string): { meta: TaskMeta; body: string } {
    const doc = this.parseTaskAt(dir, id);
    const meta: TaskMeta = {
      ...doc.data,
      id,
      priority: doc.data.priority ?? 'p2',
      type: doc.data.type ?? 'task',
      project: this.projectName(doc.data.project),
    };
    // A hand-written `done_when: one line` reads as a list of one.
    const doneWhen = doneWhenLines(doc.data.done_when);
    if (doneWhen) meta.done_when = doneWhen;
    else delete meta.done_when;
    return { meta, body: doc.body };
  }

  readEvents(id: string): OpsEvent[] {
    return this.readEventsAt(this.taskDir(id));
  }

  private readEventsAt(taskDir: string): OpsEvent[] {
    const dir = join(taskDir, 'events');
    if (!existsSync(dir)) return [];
    const events: OpsEvent[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md')) continue;
      const doc = parseDoc<Omit<OpsEvent, 'id' | 'body'>>(readFileSync(join(dir, name), 'utf8'));
      events.push({ ...doc.data, id: name.slice(0, 26), body: doc.body } as OpsEvent);
    }
    return events.sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  foldTask(id: string): TaskState {
    return fold(this.readTask(id).meta, this.readEvents(id));
  }

  /** Creates a task folder with the next free id in this machine's block. */
  createTask(meta: Omit<TaskMeta, 'id'>, body: string, idBlock = 0): TaskMeta {
    const tasksDir = join(this.dir, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    const lo = idBlock * ID_BLOCK_SIZE;
    const hi = lo + ID_BLOCK_SIZE;
    let n = lo;
    // Archived ids stay taken, so an id never names two tasks.
    for (const id of [...this.listTaskIds(), ...this.listArchivedIds()]) {
      const num = parseTaskId(id)!.n;
      if (num > n && num < hi) n = num;
    }
    for (;;) {
      n++;
      if (n >= hi) throw new OpsError(`id block ${idBlock} is full in root '${this.name}'`);
      const id = formatTaskId(this.prefix, n);
      if (existsSync(this.archiveDir(id))) continue;
      try {
        mkdirSync(this.liveDir(id));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw err;
      }
      mkdirSync(join(this.liveDir(id), 'events'));
      const full: TaskMeta = { id, ...meta };
      this.writeAtomic(join(this.liveDir(id), 'task.md'), stringifyDoc(full, body));
      return full;
    }
  }

  /** Writes one new event file. Event files are never edited after this. */
  appendEvent(taskId: string, ev: Omit<OpsEvent, 'id'>, atMs: number = Date.now()): OpsEvent {
    if (!this.hasTask(taskId)) throw new OpsError(`no task ${taskId} in root '${this.name}'`, 2);
    const dir = join(this.taskDir(taskId), 'events');
    mkdirSync(dir, { recursive: true });
    const id = ulidAfter(newestEventId(dir), atMs);
    const { body, ...front } = ev;
    this.writeAtomic(join(dir, `${id}-${actorSlug(ev.actor)}.md`), stringifyDoc(front, body));
    return { ...ev, id };
  }

  /**
   * Returns the folded state of every task. A cache in `.ops/index.json` keeps each task's fold
   * with the mtimes of its task.md and events folder; only changed tasks are folded again. The
   * process keeps the parsed cache while the file stays as it last saw it. The states are frozen
   * and shared between reads: copy one before changing it.
   */
  states(): TaskState[] {
    const indexFile = join(this.opsDir, 'index.json');
    // The cache file is `index.json`, or its spare after a refused replacement.
    const stamp = localStamp(this.localFile(indexFile));
    const kept = memIndexes.get(indexFile);
    let index: IndexFile = { v: INDEX_VERSION, tasks: {} };
    let racy: MemIndex['racy'] = new Map();
    if (kept && stamp !== '' && kept.stamp === stamp && kept.p === this.projectStamp) {
      index = { v: INDEX_VERSION, p: kept.p, tasks: kept.tasks };
      racy = kept.racy;
    } else {
      try {
        const raw = JSON.parse(this.readLocal(indexFile)) as IndexFile;
        // States folded under other project settings name the old projects: refold them all.
        if (raw.v === INDEX_VERSION && raw.p === this.projectStamp) {
          index = raw;
          for (const e of Object.values(raw.tasks)) deepFreeze(e.state);
        }
      } catch {
        // No cache yet, or a damaged one: rebuild.
      }
    }
    const nextRacy: MemIndex['racy'] = new Map();
    let dirty = false;
    const next: Record<string, IndexEntry> = {};
    const out: TaskState[] = [];
    for (const id of this.listTaskIds()) {
      const dir = this.liveDir(id);
      // Read the mtimes before the files, so a write that lands in between shows up next time.
      const tm = mtime(join(dir, 'task.md'));
      if (tm === 0) continue;
      const em = mtime(join(dir, 'events'));
      const cached = index.tasks[id];
      let entry: IndexEntry;
      const was = racy.get(id);
      if (cached && cached.tm === tm && cached.em === em) {
        entry = cached;
      } else if (cached && was && was.tm === tm && was.em === em && was.names === eventNames(dir)) {
        // Folded inside the racy window, and neither task.md nor the set of event files changed
        // since: the fold stands. After the window the entry takes its real times.
        if (Date.now() - Math.max(tm, em) < RACY_MS) {
          entry = cached;
          nextRacy.set(id, was);
        } else {
          entry = { tm, em, state: cached.state };
          dirty = true;
        }
      } else {
        // Like git's racy-timestamp rule: a folder changed in the last 2 s may change again
        // within the same mtime tick, so its entry is refolded on the next read.
        const now = Date.now();
        const fresh = now - Math.max(tm, em) < RACY_MS;
        // Only a fresh events folder can be checked by its names; a fresh task.md cannot. Read
        // the names before the files, as with the mtimes.
        const names = fresh && now - tm >= RACY_MS ? eventNames(dir) : undefined;
        entry = { tm: fresh ? -1 : tm, em, state: deepFreeze(this.foldTask(id)) };
        if (names !== undefined) nextRacy.set(id, { tm, em, names });
        dirty = true;
      }
      next[id] = entry;
      out.push(entry.state);
    }
    let written = stamp;
    if (dirty || Object.keys(index.tasks).length !== Object.keys(next).length) {
      try {
        const file: IndexFile = { v: INDEX_VERSION, p: this.projectStamp, tasks: next };
        written = localStamp(this.writeLocal(indexFile, JSON.stringify(file)));
      } catch {
        // The cache is optional; a failed write costs speed, not correctness.
        written = '';
      }
    }
    if (written === '') memIndexes.delete(indexFile);
    else {
      rememberIndex(indexFile, {
        stamp: written,
        p: this.projectStamp,
        tasks: next,
        racy: nextRacy,
      });
    }
    return out;
  }

  /**
   * The token of this clone's last claim on a task. Local state in `.ops/claims/`, never committed: it
   * tells two runs with the same agent id on different clones apart.
   */
  myClaim(task: string): string | undefined {
    return this.claimRecord(task).token;
  }

  /** This clone's record of its claim on the task: the claim token and the run that took it. */
  claimRecord(task: string): { token?: string; run?: string } {
    try {
      return JSON.parse(this.readLocal(this.claimFile(task))) as {
        token?: string;
        run?: string;
      };
    } catch {
      return {};
    }
  }

  /**
   * Called under the task's lock; each task has its own file, so claims never overwrite. `run` is
   * the supervised run that claimed, so two live runs with one agent id stay apart.
   */
  rememberClaim(task: string, token: string, run?: string): void {
    this.writeLocal(this.claimFile(task), JSON.stringify(run ? { token, run } : { token }));
  }

  private claimFile(task: string): string {
    return join(this.opsDir, 'claims', `${task}.json`);
  }

  /**
   * The newest event the actor has read: the highest `last` of its marker files. There is more
   * than one file only after a write could not replace `<actor>.json`; see {@link writeLocal}.
   */
  readMarker(actor: string): string {
    let last = '';
    for (const file of this.localFiles(this.markerFile(actor))) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as { last?: unknown };
        if (typeof raw.last === 'string' && raw.last > last) last = raw.last;
      } catch {
        // A missing or unreadable file marks nothing as read.
      }
    }
    return last;
  }

  /** Records `last` as read. Callers only move the marker forward. */
  writeMarker(actor: string, last: string): void {
    this.writeLocal(this.markerFile(actor), JSON.stringify({ last }));
  }

  private markerFile(actor: string): string {
    return join(this.opsDir, 'read', `${actorSlug(actor)}.json`);
  }

  /**
   * Writes a file of this clone's own state (under `.ops`, never committed) that each write
   * replaces, and returns the file that took the content.
   *
   * Windows can refuse to replace such a file for good: a sandboxed agent (the Codex sandbox
   * user) made it, so a later sandbox session has no right to delete or overwrite it, while it
   * may still add files to the folder (AO-0280, AO-0283). The content then goes to a spare file
   * next to it, `<name>.<ulid>.<ext>`, and {@link localFile} names the newest of them all. A
   * later write that can replace the file removes the spares.
   */
  writeLocal(path: string, content: string): string {
    mkdirSync(dirname(path), { recursive: true });
    const [main, ...spares] = this.localFiles(path) as [string, ...string[]];
    let written = main;
    try {
      // A spare says the replacement was refused before, so this try does not wait again.
      this.writeAtomic(main, content, spares.length > 0 ? 0 : RENAME_RETRIES);
    } catch (err) {
      if (!replaceRefused(err)) throw err;
      // The first rename has waited for a scanner already, so the spares get one try each.
      const spare = spares.find((file) => {
        try {
          this.writeAtomic(file, content, 0);
          return true;
        } catch (e) {
          if (!replaceRefused(e)) throw e;
          return false;
        }
      });
      written = spare ?? sparePath(path);
      if (!spare) this.writeAtomic(written, content);
    }
    // The other spares hold older content. One that cannot be removed is older than the file
    // just written, so it changes nothing.
    for (const file of spares) {
      if (file === written) continue;
      try {
        rmSync(file, { force: true });
      } catch {
        // Not ours to delete.
      }
    }
    return written;
  }

  /**
   * The file that holds what {@link writeLocal} wrote last for `path`: `path` itself, or its
   * spare when that one was written later.
   */
  localFile(path: string): string {
    const files = this.localFiles(path);
    if (files.length === 1) return path;
    let newest = path;
    let at = -1;
    // A spare is written after the file it stands in for, so it wins when the times are equal.
    for (const file of files) {
      const m = mtime(file);
      if (m > 0 && m >= at) [newest, at] = [file, m];
    }
    return newest;
  }

  /** The text {@link writeLocal} wrote last for `path`. Throws when there is none. */
  readLocal(path: string): string {
    for (let attempt = 0; ; attempt++) {
      const file = this.localFile(path);
      try {
        return readFileSync(file, 'utf8');
      } catch (err) {
        // A writer that could replace `path` again has just removed this spare: look again.
        const gone = (err as NodeJS.ErrnoException).code === 'ENOENT' && file !== path;
        if (!gone || attempt >= 2) throw err;
      }
    }
  }

  /** `path` first, then its spare files that exist, oldest first. */
  private localFiles(path: string): string[] {
    const dir = dirname(path);
    const ext = extname(path);
    const stem = basename(path, ext);
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      // Nothing written yet.
    }
    const spares = names.filter((name) => {
      if (!name.startsWith(`${stem}.`) || !name.endsWith(ext)) return false;
      return SPARE_ID.test(name.slice(stem.length + 1, name.length - ext.length));
    });
    return [path, ...spares.sort().map((name) => join(dir, name))];
  }
}

/** How often a rename is tried again while Windows holds the source or target open. */
const RENAME_RETRIES = 20;

/** The ULID in the name of a spare file, `<name>.<ulid>.<ext>`; see {@link Root.writeLocal}. */
const SPARE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function sparePath(path: string): string {
  const ext = extname(path);
  return join(dirname(path), `${basename(path, ext)}.${ulid()}${ext}`);
}

/** Whether the system refused to replace a file: it is held open, or the rights are missing. */
function replaceRefused(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

/** The newest event id in a task's events folder, from the file names. */
export function newestEventId(eventsDir: string): string | undefined {
  let newest: string | undefined;
  for (const name of readdirSync(eventsDir)) {
    if (!name.endsWith('.md')) continue;
    const id = name.slice(0, 26);
    if (!newest || id > newest) newest = id;
  }
  return newest;
}
