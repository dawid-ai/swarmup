import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ID_BLOCK_SIZE } from './config.js';
import { parseDoc, stringifyDoc } from './frontmatter.js';
import { actorSlug, isHuman, OpsError, ownerMatches } from './ids.js';
import type { Root } from './root.js';
import { isUlid, ulidAfter } from './ulid.js';
import { localTime } from './units.js';

const DECISION_RE = /^D-(\d+)$/i;

/** What a decision applies to: every task of a project (or of the root), or one task tree. */
export type DecisionScope = 'project' | 'tree';

/** Longest one line of a recorded decision, in characters. */
export const DECISION_TEXT_MAX = 200;

/** Frontmatter of `decisions/<id>/decision.md`. */
export interface DecisionMeta {
  id: string;
  /** `record`: a decision a person made, written down (AO-0109). Absent: a vote. */
  kind?: 'record';
  /** A vote's question, or the one line of a recorded decision. */
  question: string;
  options: string[];
  /** Who may vote: actor ids or runtime wildcards. Empty means anyone. */
  voters?: string[];
  /** Ballots needed before the vote can decide. */
  quorum: number;
  /** When voting closes (ISO). */
  deadline?: string;
  /** Records: `project` applies to every task of `project`, `tree` to `task` and below. */
  scope?: DecisionScope;
  /** Records: the project of a `project` scope; absent, the scope is the whole root. */
  project?: string;
  /** A task the decision belongs to. Records: the top of a `tree` scope, or where it came from. */
  task?: string;
  /** Records: where the decider's words are: `ID#<event id>`, a file, or `chat:<message id>`. */
  source?: string;
  /** Records: decisions this one replaces for the tasks in its scope. */
  supersedes?: string[];
  /** Records: decisions this one is an exception to, inside its smaller scope. */
  narrows?: string[];
  /** Records: who wrote it down, when that is not the decider in `created_by`. */
  recorded_by?: string;
  created_by: string;
  created_at: string;
}

/** `decisions/<id>/ballots/<actor>.md`. One per voter, final once cast. */
export interface Ballot {
  actor: string;
  at: string;
  choice: string;
  body: string;
}

/**
 * One outcome of a vote: `decisions/<id>/outcomes/<ULID>.md`, written by `swarmup decide` and
 * never edited. A vote decided before outcomes were append-only has one `outcome.md`, which
 * reads as older than every file in `outcomes/`.
 */
export interface Outcome {
  /** The ULID in the file name; absent for a legacy `outcome.md`. */
  id?: string;
  choice: string;
  decided_by: string;
  at: string;
  /** A redecision: an outcome existed when a human decided again with `--force`. */
  forced?: boolean;
  /** `swarmup decide --scope`: the scope the log gives this vote, in place of the derived one. */
  scope?: DecisionScope;
  project?: string;
  body: string;
}

/**
 * - `open`: voting goes on.
 * - `ready`: quorum is met and one option leads in a way the missing ballots cannot change
 *   (ballots are final), or voting closed with one leader.
 * - `tie`, `no-quorum`: voting closed without a result; the human decides.
 * - `decided`: an outcome exists.
 * - `recorded`: a recorded decision. `superseded`: a recorded decision that other records
 *   replace for every task in its scope.
 */
export type DecisionState =
  'open' | 'ready' | 'tie' | 'no-quorum' | 'decided' | 'recorded' | 'superseded';

export interface Tally {
  counts: Record<string, number>;
  votes: number;
  leaders: string[];
  state: DecisionState;
  /** Listed voters who have not voted yet. */
  missing: string[];
  closed: boolean;
}

export interface Decision {
  root: string;
  meta: DecisionMeta;
  body: string;
  ballots: Ballot[];
  /** The current outcome: the newest one. */
  outcome: Outcome | null;
  /** Every outcome, oldest first. */
  outcomes: Outcome[];
  tally: Tally;
}

export function formatDecisionId(n: number): string {
  return `D-${String(n).padStart(4, '0')}`;
}

export function parseDecisionId(s: string): string | null {
  const m = DECISION_RE.exec(s.trim());
  return m ? formatDecisionId(Number(m[1])) : null;
}

/** Default quorum: a majority of the listed voters, or 2 when anyone may vote. */
export function defaultQuorum(voters: string[] | undefined): number {
  return voters && voters.length > 0 ? Math.floor(voters.length / 2) + 1 : 2;
}

/** Matches a choice by option text (case-insensitive) or 1-based number. */
export function matchOption(options: string[], choice: string): string {
  const c = choice.trim();
  if (/^\d+$/.test(c)) {
    const opt = options[Number(c) - 1];
    if (opt !== undefined) return opt;
  }
  const opt = options.find((o) => o.toLowerCase() === c.toLowerCase());
  if (opt === undefined) {
    const list = options.map((o, i) => `${i + 1}. ${o}`).join(', ');
    throw new OpsError(`'${choice}' is not an option: ${list}`, 2);
  }
  return opt;
}

export function mayVote(meta: DecisionMeta, actor: string): boolean {
  if (!meta.voters || meta.voters.length === 0) return true;
  return meta.voters.some((v) => ownerMatches(v, actor));
}

export function tally(
  meta: DecisionMeta,
  ballots: Ballot[],
  outcome: Outcome | null,
  nowMs: number,
): Tally {
  const counts: Record<string, number> = Object.fromEntries(meta.options.map((o) => [o, 0]));
  const valid = ballots.filter((b) => mayVote(meta, b.actor) && b.choice in counts);
  for (const b of valid) counts[b.choice]!++;
  const votes = valid.length;
  const top = Math.max(0, ...Object.values(counts));
  const leaders = top === 0 ? [] : meta.options.filter((o) => counts[o] === top);
  const listed = (meta.voters ?? []).filter((v) => !v.endsWith(':*'));
  const voted = new Set(valid.map((b) => b.actor));
  const missing = listed.filter((v) => !voted.has(v));
  const fixedList = listed.length > 0 && listed.length === (meta.voters ?? []).length;
  const deadlinePassed = meta.deadline ? Date.parse(meta.deadline) <= nowMs : false;
  const closed = deadlinePassed || (fixedList && missing.length === 0);

  let state: DecisionState = 'open';
  if (meta.kind === 'record') {
    state = 'recorded';
  } else if (outcome) {
    state = 'decided';
  } else {
    const second = [...Object.values(counts)].sort((a, b) => b - a)[1] ?? 0;
    // Ballots are final, so with a fixed voter list a lead larger than the missing ballots
    // cannot change. Open votes (anyone, or a runtime wildcard) are ready only once closed.
    const settled = fixedList && top - second > missing.length;
    if (votes >= meta.quorum && leaders.length === 1 && (closed || settled)) {
      state = 'ready';
    } else if (closed) {
      state = votes < meta.quorum ? 'no-quorum' : 'tie';
    }
  }
  return { counts, votes, leaders, state, missing, closed };
}

function decisionDir(root: Root, id: string): string {
  return join(root.dir, 'decisions', id);
}

export function hasDecision(root: Root, id: string): boolean {
  return existsSync(join(decisionDir(root, id), 'decision.md'));
}

export function listDecisionIds(root: Root): string[] {
  const dir = join(root.dir, 'decisions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => parseDecisionId(n) === n);
}

/**
 * Creates `decisions/<id>/decision.md` with the next free id in this machine's block. `partners`
 * are the root's mirror copies on this machine: a root and its copy are one id space, so an id
 * used in either is taken.
 */
export function createDecision(
  root: Root,
  meta: Omit<DecisionMeta, 'id' | 'quorum'> & { quorum?: number },
  body: string,
  idBlock = 0,
  partners: Root[] = [],
): DecisionMeta {
  const dir = join(root.dir, 'decisions');
  mkdirSync(dir, { recursive: true });
  const lo = idBlock * ID_BLOCK_SIZE;
  const hi = lo + ID_BLOCK_SIZE;
  let n = lo;
  for (const id of [root, ...partners].flatMap((r) => listDecisionIds(r))) {
    const num = Number(id.slice(2));
    if (num > n && num < hi) n = num;
  }
  for (;;) {
    n++;
    if (n >= hi) throw new OpsError(`decision id block ${idBlock} is full`);
    const id = formatDecisionId(n);
    if (partners.some((p) => existsSync(decisionDir(p, id)))) continue;
    try {
      mkdirSync(decisionDir(root, id));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    // A record has no ballots and no outcomes.
    if (meta.kind !== 'record') mkdirSync(join(decisionDir(root, id), 'ballots'));
    const full = { id, ...meta };
    root.writeAtomic(join(decisionDir(root, id), 'decision.md'), stringifyDoc(full, body));
    return { ...full, quorum: meta.quorum ?? defaultQuorum(meta.voters) };
  }
}

/** A vote's outcomes, oldest first: a legacy `outcome.md`, then `outcomes/` by ULID. */
function readOutcomes(dir: string): Outcome[] {
  const out: Outcome[] = [];
  const read = (file: string, id?: string): void => {
    const o = parseDoc<Omit<Outcome, 'body' | 'id'>>(readFileSync(file, 'utf8'));
    if (!o.data.choice) return;
    out.push({ ...(id ? { id } : {}), ...o.data, body: o.body.trim() });
  };
  const legacy = join(dir, 'outcome.md');
  if (existsSync(legacy)) read(legacy);
  const odir = join(dir, 'outcomes');
  if (existsSync(odir)) {
    const names = readdirSync(odir).filter((n) => n.endsWith('.md') && isUlid(n.slice(0, -3)));
    for (const name of names.sort()) read(join(odir, name), name.slice(0, -3));
  }
  return out;
}

/**
 * One decision as its own files say it. A record reads `recorded` here: whether other records
 * supersede it depends on the root's other decisions and its tasks, which {@link readDecision}
 * looks at.
 */
export function readDecisionFiles(root: Root, id: string, nowMs: number): Decision {
  const dir = decisionDir(root, id);
  const file = join(dir, 'decision.md');
  if (!existsSync(file)) throw new OpsError(`no decision ${id} in root '${root.name}'`, 2);
  const doc = parseDoc<DecisionMeta>(readFileSync(file, 'utf8'));
  const meta: DecisionMeta = {
    ...doc.data,
    id,
    options: doc.data.options ?? [],
    quorum: doc.data.quorum ?? defaultQuorum(doc.data.voters),
  };
  const ballots: Ballot[] = [];
  const bdir = join(dir, 'ballots');
  if (existsSync(bdir)) {
    for (const name of readdirSync(bdir)) {
      if (!name.endsWith('.md')) continue;
      const b = parseDoc<Omit<Ballot, 'body'>>(readFileSync(join(bdir, name), 'utf8'));
      if (b.data.actor && b.data.choice) ballots.push({ ...b.data, body: b.body.trim() });
    }
  }
  const outcomes = meta.kind === 'record' ? [] : readOutcomes(dir);
  const outcome = outcomes[outcomes.length - 1] ?? null;
  return {
    root: root.name,
    meta,
    body: doc.body.trim(),
    ballots,
    outcome,
    outcomes,
    tally: tally(meta, ballots, outcome, nowMs),
  };
}

/** Every decision of a root; records carry their state, `recorded` or `superseded`. */
export function readDecisions(root: Root, nowMs: number): Decision[] {
  const all = listDecisionIds(root).map((id) => readDecisionFiles(root, id, nowMs));
  if (!all.some((d) => d.meta.kind === 'record')) return all;
  const state = new Map(logEntries(root, all, rootTasks(root)).map((e) => [e.id, e.state]));
  return all.map((d) =>
    d.meta.kind === 'record' && state.get(d.meta.id) === 'superseded'
      ? { ...d, tally: { ...d.tally, state: 'superseded' as const } }
      : d,
  );
}

/**
 * One decision. A record reads `recorded`, or `superseded` when other records replace it for
 * every task in its scope; that reads the root's other decisions and its tasks.
 */
export function readDecision(root: Root, id: string, nowMs: number): Decision {
  const d = readDecisionFiles(root, id, nowMs);
  if (d.meta.kind !== 'record') return d;
  return readDecisions(root, nowMs).find((x) => x.meta.id === id) ?? d;
}

export function writeBallot(root: Root, id: string, ballot: Ballot): void {
  const bdir = join(decisionDir(root, id), 'ballots');
  mkdirSync(bdir, { recursive: true });
  const { body, ...front } = ballot;
  root.writeAtomic(join(bdir, `${actorSlug(ballot.actor)}.md`), stringifyDoc(front, body));
}

/**
 * Adds an outcome file, `outcomes/<ULID>.md`. Outcomes are never edited or deleted: a redecision
 * is one more file, and the newest by ULID is the current one. `atMs` is the clock that writes
 * events, so the ids order outcomes across machines.
 */
export function writeOutcome(
  root: Root,
  id: string,
  outcome: Omit<Outcome, 'id'>,
  atMs: number = Date.now(),
): Outcome {
  const dir = join(decisionDir(root, id), 'outcomes');
  mkdirSync(dir, { recursive: true });
  const newest = readdirSync(dir)
    .map((n) => n.slice(0, -3))
    .filter(isUlid)
    .sort()
    .pop();
  const oid = ulidAfter(newest, atMs);
  const { body, ...front } = outcome;
  root.writeAtomic(join(dir, `${oid}.md`), stringifyDoc(front, body));
  return { id: oid, ...outcome };
}

/**
 * True for a vote with more than one outcome whose current one is not a forced redecision: two
 * machines, or the two sides of a mirror, each decided before they synced. The newest stands; a
 * person confirms it with `swarmup decide --force`.
 */
export function unforcedOutcomes(d: Decision): boolean {
  return d.outcomes.length > 1 && d.outcome?.forced !== true;
}

// ---- The decision log (AO-0109) --------------------------------------------------------------

/** A task as the log needs it. `project` is the name the task reads as; `parent` a bare id. */
export interface ScopeTask {
  id: string;
  project?: string;
  parent?: string;
}

/** A task as scope matching sees it: its project, and the ids of itself and every task above it. */
export interface TaskScope {
  id: string;
  project?: string;
  chain: string[];
}

/** What a decision covers. Without `project`, a `project` scope is the whole root. */
export interface ScopeOf {
  scope: DecisionScope;
  project?: string;
  task?: string;
}

/** A record that replaces a decision inside its own scope. */
export interface Replacement {
  by: string;
  how: 'superseded' | 'narrowed';
  /** `in project v2`, `in the whole root` or `under AO-0110`. */
  where: string;
}

/** One line of the decision log: a recorded decision or a decided vote. */
export interface LogEntry extends ScopeOf {
  root: string;
  id: string;
  kind: 'record' | 'vote';
  /** The one line: a record's text, or `question → choice` for a vote. */
  text: string;
  source?: string;
  /** Who decided. */
  by: string;
  recorded_by?: string;
  /** The effective date: a record's `created_at`, a vote's current outcome. */
  at: string;
  supersedes: string[];
  narrows: string[];
  /** `superseded`: no task in its scope is outside the scopes of the records that replace it. */
  state: 'recorded' | 'superseded';
  /** The records that name it in `supersedes` or `narrows`. */
  replaced: Replacement[];
  /** A `tree` decision replaced in part: the tasks of its tree still under it. */
  in_force_for?: string[];
  /** A vote decided more than once: the earlier outcomes, newest first. */
  revised?: Array<{ choice: string; at: string; by: string }>;
}

/** The tasks of a root, live and archived, by id. */
export function rootTasks(root: Root): Map<string, ScopeTask> {
  const out = new Map<string, ScopeTask>();
  const add = (m: { id: string; project?: string; parent?: string }): void => {
    out.set(m.id, { id: m.id, project: m.project, parent: m.parent });
  };
  for (const s of root.states()) add(s.meta);
  // Only task.md is read: an archived task's events say nothing about its project or parent.
  for (const id of root.listArchivedIds()) add(root.readTask(id).meta);
  return out;
}

/** A task with its `parent` chain. A task the root does not hold is a chain of its own id. */
export function taskScope(tasks: Map<string, ScopeTask>, id: string): TaskScope {
  const chain: string[] = [];
  let cur: string | undefined = id;
  while (cur && !chain.includes(cur)) {
    chain.push(cur);
    cur = tasks.get(cur)?.parent;
  }
  return { id, project: tasks.get(id)?.project, chain };
}

/** True when a decision with scope `s` applies to `task`. */
export function covers(s: ScopeOf, task: TaskScope): boolean {
  if (s.scope === 'tree') return s.task !== undefined && task.chain.includes(s.task);
  return s.project === undefined || s.project === task.project;
}

function newestFirst(a: LogEntry, b: LogEntry): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * The decisions in force for one task, newest first: those whose scope holds the task, less
 * every decision that a record whose scope also holds the task names in `supersedes` or
 * `narrows`. Every reader of the log goes through this one function, so the log, the prompts and
 * the checks cannot disagree. The rule is per task, not per scope: a tree can cross projects
 * and grow after a decision, so a task outside the new scope stays under the old decision.
 */
export function inForce(decisions: LogEntry[], task: TaskScope): LogEntry[] {
  const applying = decisions.filter((d) => covers(d, task));
  const hidden = new Set(applying.flatMap((d) => [...d.supersedes, ...d.narrows]));
  return applying.filter((d) => !hidden.has(d.id)).sort(newestFirst);
}

/**
 * How scope `a` lies to scope `b`:
 * - `same`: the same tasks. `covers`: `a` holds every task `b` can hold, and more.
 * - `inside`: `a` is strictly inside `b`. A tree is inside every project scope: it never covers
 *   a project.
 * - `overlap`: a project against a tree. They share a task whenever the tree has one in the
 *   project, now or later.
 * - `disjoint`: they can never share a task.
 */
export type ScopeRelation = 'same' | 'covers' | 'inside' | 'overlap' | 'disjoint';

export function scopeRelation(
  a: ScopeOf,
  b: ScopeOf,
  tasks: Map<string, ScopeTask>,
): ScopeRelation {
  if (a.scope === 'project' && b.scope === 'project') {
    if (a.project === b.project) return 'same';
    if (a.project === undefined) return 'covers';
    return b.project === undefined ? 'inside' : 'disjoint';
  }
  if (a.scope === 'tree' && b.scope === 'project') return 'inside';
  if (a.scope === 'project') return a.project === undefined ? 'covers' : 'overlap';
  if (!a.task || !b.task) return 'disjoint';
  if (a.task === b.task) return 'same';
  if (taskScope(tasks, b.task).chain.includes(a.task)) return 'covers';
  return taskScope(tasks, a.task).chain.includes(b.task) ? 'inside' : 'disjoint';
}

/** `project v2`, `root` or `tree AO-0051`, as the log prints a scope. */
export function scopeText(s: ScopeOf): string {
  if (s.scope === 'tree') return `tree ${s.task ?? '?'}`;
  return s.project === undefined ? 'root' : `project ${s.project}`;
}

function whereText(s: ScopeOf): string {
  if (s.scope === 'tree') return `under ${s.task ?? '?'}`;
  return s.project === undefined ? 'in the whole root' : `in project ${s.project}`;
}

/**
 * The log of one root: its records and decided votes, newest first, each with its scope and its
 * state. A decided vote has no stored scope unless `swarmup decide --scope` wrote one: it is the
 * tree of its task, or the whole root without a task, and its project is read from the task now,
 * so existing votes need no migration.
 */
export function logEntries(
  root: Root,
  decisions: Decision[],
  tasks: Map<string, ScopeTask>,
): LogEntry[] {
  const named = (p: string | undefined): string | undefined =>
    typeof p === 'string' && p.trim() ? root.projectName(p) : undefined;
  const entries: LogEntry[] = [];
  for (const d of decisions) {
    const m = d.meta;
    const base = { root: root.name, id: m.id, replaced: [], state: 'recorded' as const };
    if (m.kind === 'record') {
      const scope: DecisionScope = m.scope === 'tree' && m.task ? 'tree' : 'project';
      entries.push({
        ...base,
        kind: 'record',
        text: m.question,
        scope,
        project: named(m.project) ?? (scope === 'tree' ? tasks.get(m.task!)?.project : undefined),
        task: m.task,
        source: m.source,
        by: m.created_by,
        recorded_by: m.recorded_by,
        at: m.created_at,
        supersedes: (m.supersedes ?? []).filter((x) => x !== m.id),
        narrows: (m.narrows ?? []).filter((x) => x !== m.id),
      });
    } else if (d.outcome) {
      const o = d.outcome;
      // A stored `tree` needs a task to be the top of; without one the vote covers the root.
      const stored = o.scope === 'tree' && !m.task ? undefined : o.scope;
      const earlier = d.outcomes.slice(0, -1).reverse();
      entries.push({
        ...base,
        kind: 'vote',
        text: `${m.question} → ${o.choice}`,
        scope: stored ?? (m.task ? 'tree' : 'project'),
        project:
          stored === 'project' ? named(o.project) : m.task ? tasks.get(m.task)?.project : undefined,
        task: m.task,
        by: o.decided_by,
        at: o.at,
        supersedes: [],
        narrows: [],
        ...(earlier.length > 0
          ? { revised: earlier.map((e) => ({ choice: e.choice, at: e.at, by: e.decided_by })) }
          : {}),
      });
    }
  }
  const all = [...tasks.keys()].map((id) => taskScope(tasks, id));
  for (const e of entries) {
    const by = entries.filter((r) => r.supersedes.includes(e.id) || r.narrows.includes(e.id));
    if (by.length === 0) continue;
    e.replaced = by.map((r) => ({
      by: r.id,
      how: r.supersedes.includes(e.id) ? 'superseded' : 'narrowed',
      where: whereText(r),
    }));
    if (e.scope === 'tree') {
      // Per task: a project record covers a tree only while every task in the tree is in it.
      const left = all.filter((t) => covers(e, t) && !by.some((r) => covers(r, t)));
      if (left.length === 0) e.state = 'superseded';
      else e.in_force_for = left.map((t) => t.id).sort();
    } else if (by.some((r) => ['same', 'covers'].includes(scopeRelation(r, e, tasks)))) {
      e.state = 'superseded';
    }
  }
  return entries.sort(newestFirst);
}

/** The log of one root, with the tasks its scopes were matched against. */
export function decisionLog(
  root: Root,
  nowMs: number,
): { entries: LogEntry[]; tasks: Map<string, ScopeTask> } {
  const tasks = rootTasks(root);
  const all = listDecisionIds(root).map((id) => readDecisionFiles(root, id, nowMs));
  return { entries: logEntries(root, all, tasks), tasks };
}

/** The most decisions a run prompt, `swarmup start` and the other task commands list. */
export const DECISIONS_CAP = 30;

/**
 * The decisions in force for a task as run prompts and `swarmup start`, `show`, `verdict` and
 * `answer` print them (AO-0109, "Run prompts"): a heading, one line per decision, newest first
 * and `DECISIONS_CAP` at most, then how to list the rest. `entries` come from `inForce`. With
 * `check`, the lines that tell a run what to do on a conflict follow. No decisions, no lines.
 */
export function decisionLines(
  task: string,
  entries: Array<Pick<LogEntry, 'id' | 'at' | 'text'>>,
  opts: { check?: boolean } = {},
): string[] {
  const shown = entries.slice(0, DECISIONS_CAP);
  const first = shown[0];
  if (!first) return [];
  const lines = [
    `Decisions in force for ${task} (follow them; newest first):`,
    ...shown.map((e) => `- ${e.id} (${localTime(e.at).slice(0, 10)}): ${e.text}`),
  ];
  const more = entries.length - shown.length;
  if (more > 0) lines.push(`${more} more: swarmup decisions --log --task ${task}`);
  if (opts.check) {
    lines.push(
      "If your plan or a choice you are about to make conflicts with one, don't work around it:",
      `finish with \`swarmup ask ${task} "contradiction with ${first.id}: ..."\`.`,
    );
  }
  return lines;
}

/** The topic whose learn notes the import turns into records (AO-0309). */
export const DECISIONS_TOPIC = 'decisions';

const NOTE_SOURCE = /^(?:\.\/)?kb\/decisions\/([^/]+)\.md$/i;

/** The slug of the `kb/decisions/<slug>.md` note a record names as its source, else null. */
export function noteSourceSlug(source: string | undefined): string | null {
  return NOTE_SOURCE.exec((source ?? '').trim().replace(/\\/g, '/'))?.[1] ?? null;
}

/** The records of a log whose source is the decisions-topic note `slug`, newest first. */
export function noteRecords(entries: LogEntry[], slug: string): LogEntry[] {
  return entries.filter((e) => e.kind === 'record' && noteSourceSlug(e.source) === slug);
}

/**
 * The slugs of the decisions-topic notes the log replaces for `task`: a record names the note as
 * its source and has the task in its scope, in force there or hidden by a later record. Inside
 * that scope `inForce` gives the current rule, so the note is not prompt guidance for the task;
 * a task outside the scope keeps the note.
 */
export function recordedNoteSlugs(entries: LogEntry[], task: TaskScope): Set<string> {
  const out = new Set<string>();
  for (const e of entries) {
    const slug = e.kind === 'record' ? noteSourceSlug(e.source) : null;
    if (slug && covers(e, task)) out.add(slug);
  }
  return out;
}

/** A message of the desktop PM chat, as swarmupd returns it for a `chat:<id>` source. */
export interface ChatSourceMessage {
  id: string;
  role: string;
  at: string;
  text: string;
  from?: string;
  channel?: string;
}

/**
 * Why a chat message cannot be the source of a decision, or null when it can: only a message a
 * person wrote in the app counts. A reply of the PM and a channel post that mentions it do not.
 */
export function chatSourceRefusal(m: ChatSourceMessage): string | null {
  if (m.role !== 'user') return 'it is a reply of the agent, not a message a person wrote';
  if (m.channel) {
    return `it is a post in #${m.channel}, not a chat message: quote the post from its task, or the person records it`;
  }
  if (!m.from || !isHuman(m.from)) return 'no person wrote it';
  if (!m.text.trim()) return 'it has no text';
  return null;
}

/** The body of a record with a chat source: the author, the time and the words, as a quote. */
export function chatQuote(m: ChatSourceMessage): string {
  const lines = m.text.trim().split('\n');
  return [
    `> ${m.from}, ${m.at}, in the PM chat:`,
    '>',
    ...lines.map((l) => `> ${l}`.trimEnd()),
  ].join('\n');
}

/** The files of one decision that mirror both ways, relative to its folder. */
function decisionFiles(dir: string): string[] {
  const plain = (p: string): boolean => {
    try {
      return lstatSync(p).isFile();
    } catch {
      return false;
    }
  };
  const out = ['decision.md', 'outcome.md'].filter((n) => plain(join(dir, n)));
  for (const sub of ['ballots', 'outcomes']) {
    let names: string[] = [];
    try {
      names = readdirSync(join(dir, sub));
    } catch {
      // No such folder.
    }
    for (const n of names.sort()) if (plain(join(dir, sub, n))) out.push(`${sub}/${n}`);
  }
  return out;
}

/**
 * Decision files that two roots (a project root and its Master Repo copy) both hold with
 * different content, as `D-0042/decision.md`. The mirror copies a file one side lacks and never
 * overwrites one, so these stay as they are until a person looks: the mirror notes them and
 * `swarmup doctor` reports them.
 */
export function decisionConflicts(a: Root, b: Root): string[] {
  const out: string[] = [];
  const theirs = new Set(listDecisionIds(b));
  const text = (file: string): string => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  for (const id of listDecisionIds(a).sort()) {
    if (!theirs.has(id)) continue;
    const other = new Set(decisionFiles(decisionDir(b, id)));
    for (const f of decisionFiles(decisionDir(a, id))) {
      if (!other.has(f)) continue;
      if (text(join(decisionDir(a, id), f)) !== text(join(decisionDir(b, id), f))) {
        out.push(`${id}/${f}`);
      }
    }
  }
  return out;
}
