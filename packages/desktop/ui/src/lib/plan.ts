// A milestone's plan in the app (AO-0110): the rows of edit mode, what the app sends as an edited
// plan, and the texts the inbox, the task panel and the board show. Pure functions, so they are
// tested without a browser. The plan's rules (keys, owners, reviewers, cycles, the 25-item limit)
// live in core alone: the app sends the rows and shows what swarmupd refuses.
import type { OpsEvent, PlanProgress, PlanRow, Task } from '../types';

/** Minutes as a plan's estimate sum reads: `45 min`, `6 h`, `1 h 30 min`. Same form as core's. */
export function minutesText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * An estimate (`30m`, `2h`, `1d` = 8 h) in minutes, for the sum edit mode shows while you type;
 * null for text swarmupd would refuse.
 */
export function estimateMinutes(text: string): number | null {
  const m = /^([0-9]+)(m|h|d)$/.exec(text.trim());
  const n = m ? Number(m[1]) : 0;
  if (!m || n <= 0) return null;
  return n * (m[2] === 'm' ? 1 : m[2] === 'h' ? 60 : 480);
}

/** `3 items, 6 h`: a plan's size, as the inbox and the panel's header say it. */
export function planSize(items: number, minutes: number): string {
  return `${items} item${items === 1 ? '' : 's'}, ${minutesText(minutes)}`;
}

/** One row of edit mode: a plan item as text fields. */
export interface EditRow {
  /** Stable across edits and reorders, for React keys; never sent. */
  uid: number;
  key: string;
  title: string;
  owner: string;
  estimate: string;
  /** The keys it waits for, separated by commas or spaces. */
  after: string;
  done_when: string;
  review: string;
  type: string;
  priority: string;
  /** Kept as proposed: edit mode has no field for them. */
  body?: string;
  for?: string;
  /**
   * The task the item already has. Its title, `done_when`, reviewer, type and priority live in
   * the task's file and never change in place, so those fields are read-only; **Replace item**
   * removes the item and adds it again under a new key.
   */
  task?: string;
}

let uidSeq = 0;

/** The rows edit mode starts from: the plan that waits, field by field. */
export function editRows(items: readonly PlanRow[]): EditRow[] {
  return items.map((i) => ({
    uid: ++uidSeq,
    key: i.key,
    title: i.title,
    owner: i.owner,
    estimate: i.estimate,
    after: i.after.join(', '),
    done_when: i.done_when ?? '',
    review: i.review ?? '',
    type: i.type ?? '',
    priority: i.priority ?? '',
    ...(i.body ? { body: i.body } : {}),
    ...(i.for ? { for: i.for } : {}),
    ...(i.task ? { task: i.task } : {}),
  }));
}

/** The keys an `after` field names. */
export function afterKeys(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).filter(Boolean))];
}

/** One item of the plan the app sends: the fields of a plan file, empty ones left out. */
export interface PlanItemOut {
  key: string;
  title: string;
  owner: string;
  estimate: string;
  after?: string[];
  done_when?: string;
  review?: string;
  type?: string;
  priority?: string;
  body?: string;
  for?: string;
}

/** The rows as the plan `plan-approve` takes: what a plan file holds, in the rows' order. */
export function planOf(
  rows: readonly EditRow[],
  notes?: string,
): { notes?: string; items: PlanItemOut[] } {
  const items = rows.map((r) => {
    const after = afterKeys(r.after);
    const opt = (v: string | undefined): string | undefined => v?.trim() || undefined;
    const item: PlanItemOut = {
      key: r.key.trim(),
      title: r.title.trim(),
      owner: r.owner.trim(),
      estimate: r.estimate.trim(),
    };
    if (after.length > 0) item.after = after;
    for (const f of ['done_when', 'review', 'type', 'priority', 'body', 'for'] as const) {
      const v = opt(r[f]);
      if (v) item[f] = v;
    }
    return item;
  });
  return { ...(notes?.trim() ? { notes: notes.trim() } : {}), items };
}

/** Whether the rows differ from the plan that waits: only then the app sends an edited plan. */
export function planEdited(rows: readonly EditRow[], proposed: readonly PlanRow[]): boolean {
  return JSON.stringify(planOf(rows).items) !== JSON.stringify(planOf(editRows(proposed)).items);
}

/** The estimate sum of the rows, and how many estimates swarmupd would refuse. */
export function rowsMinutes(rows: readonly EditRow[]): { minutes: number; bad: number } {
  let minutes = 0;
  let bad = 0;
  for (const r of rows) {
    const m = estimateMinutes(r.estimate);
    if (m === null) bad++;
    else minutes += m;
  }
  return { minutes, bad };
}

/** A key no row has: `base`, then `base2`, `base3`. */
export function freshKey(rows: readonly EditRow[], base: string): string {
  const taken = new Set(rows.map((r) => r.key.trim()));
  if (base && !taken.has(base)) return base;
  const stem = base.replace(/[0-9]+$/, '') || 'item';
  for (let n = 2; ; n++) {
    const key = `${stem}${n}`;
    if (!taken.has(key)) return key;
  }
}

/** The rows with a new, empty item at the end, owned like the last one. */
export function addRow(rows: readonly EditRow[]): EditRow[] {
  const last = rows[rows.length - 1];
  return [
    ...rows,
    {
      uid: ++uidSeq,
      key: freshKey(rows, `item${rows.length + 1}`),
      title: '',
      owner: last?.owner ?? '',
      estimate: '',
      after: '',
      done_when: '',
      review: '',
      type: '',
      priority: '',
    },
  ];
}

/** `after` without `key`, or with `to` in its place. */
function renameAfter(after: string, key: string, to?: string): string {
  const keys = afterKeys(after);
  if (!keys.includes(key)) return after;
  return keys.flatMap((k) => (k === key ? (to ? [to] : []) : [k])).join(', ');
}

/** The rows without one item; no other item waits for it any more. */
export function removeRow(rows: readonly EditRow[], uid: number): EditRow[] {
  const gone = rows.find((r) => r.uid === uid);
  if (!gone) return [...rows];
  return rows
    .filter((r) => r.uid !== uid)
    .map((r) => ({ ...r, after: renameAfter(r.after, gone.key.trim()) }));
}

/** The rows with one item moved up (`-1`) or down (`1`). */
export function moveRow(rows: readonly EditRow[], uid: number, by: -1 | 1): EditRow[] {
  const at = rows.findIndex((r) => r.uid === uid);
  const to = at + by;
  if (at < 0 || to < 0 || to >= rows.length) return [...rows];
  const out = [...rows];
  [out[at], out[to]] = [out[to]!, out[at]!];
  return out;
}

/**
 * **Replace item**: the item that has a task goes, and a copy without a task takes its place
 * under a new key, with every `after` that named the old key moved to the new one. The approval
 * parks the old task and creates the new one.
 */
export function replaceRow(rows: readonly EditRow[], uid: number): EditRow[] {
  const old = rows.find((r) => r.uid === uid);
  if (!old) return [...rows];
  const key = freshKey(rows, `${old.key.trim().replace(/[0-9]+$/, '')}2`);
  return rows.map((r) => {
    if (r.uid !== uid) return { ...r, after: renameAfter(r.after, old.key.trim(), key) };
    // The copy is a new item: it has no task, and `for` names what the old item served.
    const copy: EditRow = { ...old, uid: ++uidSeq, key };
    delete copy.task;
    delete copy.for;
    return copy;
  });
}

const LABEL = 'milestone:';

/**
 * The milestone a card belongs to in the board's **Milestone** lanes: the id in a task's
 * `milestone:` label, or a milestone's own id, so it heads its lane. Null for any other task.
 */
export function milestoneOf(t: Pick<Task, 'id' | 'type' | 'labels'>): string | null {
  const label = (t.labels ?? []).find((l) => l.startsWith(LABEL) && l.length > LABEL.length);
  if (label) return label.slice(LABEL.length);
  return t.type === 'milestone' ? t.id : null;
}

/** A milestone card's progress line: `4/7 done, 9 h of 14 h`, or the plan that waits. */
export function progressText(p: PlanProgress): string {
  if (p.total === 0 && p.pending)
    return `plan waits: ${planSize(p.pending.items, p.pending.minutes)}`;
  const parked = p.parked > 0 ? `, ${p.parked} parked` : '';
  return `${p.done}/${p.total} done${parked}, ${minutesText(p.spent)} of ${minutesText(p.minutes)}`;
}

/** One step of a milestone's check: what the checker recorded, and how it reads. */
export interface CheckStep {
  event: OpsEvent;
  label: string;
  tone: 'ok' | 'warn' | 'info';
}

/**
 * The check history of a milestone: after its first approved plan, the checker's evidence
 * (checkpoints), each failed check (the fix tasks it added, or its question after the third),
 * and the pass that closed it.
 */
export function checkHistory(events: readonly OpsEvent[]): CheckStep[] {
  const from = events.findIndex((e) => e.type === 'plan-approve');
  if (from < 0) return [];
  const out: CheckStep[] = [];
  for (const e of events.slice(from + 1)) {
    if (e.pending) continue;
    if (e.type === 'checkpoint') out.push({ event: e, label: 'Check evidence', tone: 'info' });
    else if (e.type === 'plan-amend' && e.plan_kind === 'fix') {
      out.push({ event: e, label: 'Check failed: fix tasks added', tone: 'warn' });
    } else if (e.type === 'ask') {
      out.push({ event: e, label: 'Check failed: question', tone: 'warn' });
    } else if (e.type === 'done') out.push({ event: e, label: 'Check passed', tone: 'ok' });
  }
  return out;
}
