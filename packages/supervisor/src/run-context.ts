import type { OpsEvent, TaskView, Workspace } from '@swarmup/core';
import { foldBrief, OPEN_STATUSES } from '@swarmup/core';
import { closedSinceBrief } from './task-criteria.js';

/**
 * Run context: what a task run would otherwise fetch before its first edit, inline in its prompt.
 * The median work run made 15 tool calls before its first edit (`scripts/orientation.mjs`, 631
 * runs, 2026-11-07 to 2026-11-21), several of them `swarmup show` on the task, its parent and its
 * milestone. The prompt now carries the task text, its recent thread and its chain of parents
 * with their briefs, each capped, and `swarmup show ID` stays the place for the rest.
 */

/** Most characters of the task text the prompt quotes. */
export const BODY_MAX = 3_000;
/** Most characters of the thread the prompt quotes, newest events first. */
export const THREAD_MAX = 4_000;
/** Most characters of one thread event. */
export const ENTRY_MAX = 600;
/** Most characters of the newest review request and the newest verdict: what the run acts on. */
export const FOCUS_MAX = 1_500;
/** Most parents the chain lists, nearest first. */
export const CHAIN_DEPTH = 4;
/** Most characters of a parent's summary when it has no brief: its first paragraph. */
export const SUMMARY_MAX = 300;
/** Most characters of a brief in the chain: the nearest parent's, then the others'. */
export const BRIEF_MAX = 1_500;
export const FAR_BRIEF_MAX = 600;
/** Most parents a PM's inbox run lists as briefs to refresh. */
export const BRIEF_REFRESH_MAX = 8;

/**
 * The event types a thread quotes: what people and agents said or decided. Claims, renewals, run
 * starts and ends, merges, plan events and briefs are left out; the chain shows briefs.
 */
const THREAD_TYPES = new Set([
  'comment',
  'verdict',
  'ask',
  'answer',
  'review',
  'review-fallback',
  'handoff',
  'assign',
  'delegate',
  'block',
  'unblock',
  'checkpoint',
  'progress',
  'start',
  'done',
  'reopen',
  'release',
  'park',
]);

export interface ThreadItem {
  event: string;
  at: string;
  actor: string;
  /** The event type, with its verdict or addressee: `verdict changes`, `ask -> human:dawid`. */
  label: string;
  text: string;
  cut: boolean;
}

export interface ChainItem {
  ref: string;
  title: string;
  type: string;
  status: string;
  /** The brief when the task has one, else the first paragraph of its text. */
  summary: string;
  cut: boolean;
  brief?: { actor: string; at: string };
}

export interface RunContext {
  body: string;
  bodyCut: boolean;
  thread: ThreadItem[];
  /** Thread events left out because the thread reached {@link THREAD_MAX}. */
  earlier: number;
  /** The task's parent, its parent and so on, nearest first. */
  chain: ChainItem[];
  /** The task's own brief, when it is a parent that has one. */
  brief?: { actor: string; at: string; text: string; cut: boolean };
}

/** Text cut to `max` characters at a line or word end where one is near, with a mark. */
export function cut(text: string, max: number): { text: string; cut: boolean } {
  const t = text.trim();
  if (t.length <= max) return { text: t, cut: false };
  let end = t.lastIndexOf('\n', max);
  if (end < max * 0.6) end = t.lastIndexOf(' ', max);
  if (end < max * 0.6) end = max;
  return { text: `${t.slice(0, end).trimEnd()} …`, cut: true };
}

/** The first paragraph of a task's text, at most three lines and {@link SUMMARY_MAX} characters. */
export function summaryOf(body: string, max = SUMMARY_MAX): { text: string; cut: boolean } {
  const paras = body.trim().split(/\n\s*\n/);
  // A heading alone is no summary: take the paragraph under it.
  const first = paras.find((p) => p.trim() && !/^#+\s/.test(p.trim())) ?? paras[0] ?? '';
  const lines = first.trim().split('\n');
  const head = lines.slice(0, 3).join('\n');
  const c = cut(head, max);
  return { text: c.text, cut: c.cut || lines.length > 3 || paras.length > 1 };
}

/** `2026-11-21 06:40 UTC`: unambiguous whatever the zone of the PC that reads the prompt. */
export function utc(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function labelOf(e: OpsEvent): string {
  const what = e.verdict ? `${e.type} ${e.verdict}` : e.type;
  return e.to ? `${what} -> ${e.to}` : what;
}

/**
 * The newest thread events that fit `max` characters, oldest first, and how many earlier ones
 * were left out. The newest review request and the newest verdict get {@link FOCUS_MAX}, every
 * other event {@link ENTRY_MAX}. The newest event is always in, even when it alone is over `max`.
 */
export function threadOf(
  events: readonly OpsEvent[],
  max = THREAD_MAX,
): { items: ThreadItem[]; earlier: number } {
  const said = [...events]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .filter((e) => THREAD_TYPES.has(e.type) && (e.body.trim() || e.next?.trim()));
  const focus = new Set<string>();
  for (const type of ['review', 'verdict']) {
    const newest = said.filter((e) => e.type === type).pop();
    if (newest) focus.add(newest.id);
  }
  const items: ThreadItem[] = [];
  let used = 0;
  for (let i = said.length - 1; i >= 0; i--) {
    const e = said[i]!;
    const full = e.next?.trim() ? `${e.body.trim()}\nNext: ${e.next.trim()}` : e.body.trim();
    const c = cut(full, focus.has(e.id) ? FOCUS_MAX : ENTRY_MAX);
    const item = { event: e.id, at: e.at, actor: e.actor, label: labelOf(e), ...c };
    const size = c.text.length + item.label.length + item.actor.length + 30;
    if (items.length > 0 && used + size > max) return { items: items.reverse(), earlier: i + 1 };
    used += size;
    items.push(item);
  }
  return { items: items.reverse(), earlier: 0 };
}

/** The ref of a task's parent: parents live in the task's root. */
function parentRef(v: TaskView): string | undefined {
  return v.meta.parent ? `${v.root}/${v.meta.parent}` : undefined;
}

/**
 * The context of a run on `ref`: the task text, its thread and its chain of parents. Reads the
 * task's events and each parent's; a parent that cannot be read ends the chain.
 */
export function runContext(ws: Workspace, ref: string): RunContext {
  const v = ws.view(ref);
  const shown = ws.showEvents(ref);
  const body = cut(shown.body, BODY_MAX);
  const { items, earlier } = threadOf(shown.events);
  const own = foldBrief(shown.events);
  const chain: ChainItem[] = [];
  const seen = new Set([`${v.root}/${v.meta.id}`]);
  let next = parentRef(v);
  while (next && chain.length < CHAIN_DEPTH && !seen.has(next)) {
    seen.add(next);
    let pv: TaskView;
    let pe: { body: string; events: OpsEvent[] };
    try {
      pv = ws.view(next);
      pe = ws.showEvents(next);
    } catch {
      break;
    }
    const b = foldBrief(pe.events);
    const s = b ? cut(b.body, chain.length === 0 ? BRIEF_MAX : FAR_BRIEF_MAX) : summaryOf(pe.body);
    chain.push({
      ref: pv.meta.id,
      title: pv.meta.title,
      type: pv.meta.type,
      status: pv.status,
      summary: s.text,
      cut: s.cut,
      ...(b ? { brief: { actor: b.actor, at: b.at } } : {}),
    });
    next = parentRef(pv);
  }
  const ownBrief = own ? cut(own.body, BRIEF_MAX) : undefined;
  return {
    body: body.text,
    bodyCut: body.cut,
    thread: items,
    earlier,
    chain,
    ...(own && ownBrief
      ? { brief: { actor: own.actor, at: own.at, text: ownBrief.text, cut: ownBrief.cut } }
      : {}),
  };
}

const quote = (text: string, indent = ''): string[] =>
  text.split('\n').map((l) => (l.trim() ? `${indent}> ${l.trimEnd()}` : `${indent}>`));

/** The prompt lines of a run's context. */
export function runContextLines(task: string, c: RunContext): string[] {
  const lines = [
    '',
    `Context of ${task}, so you need not look it up; \`swarmup show <id>\` has the rest (every`,
    'event, the `done when:` list, attachments).',
  ];
  if (c.body) {
    lines.push('', `Task text${c.bodyCut ? ' (cut)' : ''}:`, ...quote(c.body));
  }
  if (c.brief) {
    lines.push(
      '',
      `Brief of ${task} (by ${c.brief.actor}, ${utc(c.brief.at)}${c.brief.cut ? ', cut' : ''}):`,
      ...quote(c.brief.text),
    );
  }
  if (c.thread.length > 0) {
    lines.push(
      '',
      c.earlier > 0
        ? `Thread, newest last (${c.earlier} earlier event(s) left out):`
        : 'Thread, newest last:',
    );
    for (const t of c.thread) {
      lines.push(`- ${utc(t.at)} ${t.actor} ${t.label} (${task}#${t.event}):`);
      lines.push(...quote(t.text, '  '));
    }
  }
  if (c.chain.length > 0) {
    lines.push('', 'Parents, nearest first:');
    for (const p of c.chain) {
      const what = p.brief
        ? `brief by ${p.brief.actor}, ${utc(p.brief.at)}${p.cut ? ', cut' : ''}`
        : p.cut
          ? 'first paragraph'
          : 'text';
      lines.push(`- ${p.ref} (${p.type}, ${p.status}): ${p.title}. ${cap(what)}:`);
      if (p.summary) lines.push(...quote(p.summary, '  '));
    }
  }
  return lines;
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** A parent whose children closed after its brief was written, or that has none yet. */
export interface BriefRefresh {
  ref: string;
  title: string;
  type: string;
  /** The children closed since the brief, oldest first. */
  closed: string[];
  /** When the current brief was written; absent when it has none. */
  briefAt?: string;
}

/**
 * Parents whose brief is behind their children, for a PM's inbox run: an open milestone with a
 * child closed (`done`) after its brief, or with closed children and no brief yet, and any other
 * open parent that has a brief with a child closed after it. A parent that never had a brief and
 * is no milestone is left out, so the PM writes briefs where they matter. A child's close time is
 * its last event (`updatedAt`), so an event on it after the close, such as the merge, counts as
 * well. Most {@link BRIEF_REFRESH_MAX}, oldest close first.
 */
export function briefsToRefresh(ws: Workspace, views: readonly TaskView[]): BriefRefresh[] {
  const kids = new Map<string, TaskView[]>();
  for (const v of views) {
    if (!v.meta.parent || v.status !== 'done') continue;
    const key = `${v.root}/${v.meta.parent}`;
    const list = kids.get(key) ?? [];
    list.push(v);
    kids.set(key, list);
  }
  const out: Array<BriefRefresh & { since: string }> = [];
  for (const v of views) {
    const ref = `${v.root}/${v.meta.id}`;
    const closed = kids.get(ref);
    if (!closed || !OPEN_STATUSES.has(v.status)) continue;
    let brief;
    try {
      brief = foldBrief(ws.showEvents(ref).events);
    } catch {
      continue;
    }
    const ids = closedSinceBrief(
      v.meta.type,
      brief,
      closed.map((k) => ({ id: k.meta.id, status: k.status, updatedAt: k.updatedAt })),
    );
    if (ids.length === 0) continue;
    out.push({
      ref: v.meta.id,
      title: v.meta.title,
      type: v.meta.type,
      closed: ids,
      ...(brief ? { briefAt: brief.at } : {}),
      since: closed.find((k) => k.meta.id === ids[0])!.updatedAt,
    });
  }
  return out
    .sort((a, b) => Date.parse(a.since) - Date.parse(b.since))
    .slice(0, BRIEF_REFRESH_MAX)
    .map(({ since: _since, ...r }) => r);
}

/** The prompt lines that ask a PM to refresh the briefs {@link briefsToRefresh} found. */
export function briefRefreshLines(briefs: readonly BriefRefresh[]): string[] {
  if (briefs.length === 0) return [];
  const lines = [
    '',
    'Briefs to refresh: children closed under these parents since their brief was written. After',
    'your inbox, read each with `swarmup show ID` and write its new brief with',
    '`swarmup brief ID --body-file -` (Markdown, about 20 lines: outcome, done, next, open',
    'questions, decisions in force). Work runs on its children read it in their prompt.',
  ];
  for (const b of briefs) {
    const when = b.briefAt ? `brief of ${utc(b.briefAt)}` : 'no brief yet';
    lines.push(`- ${b.ref} (${b.type}) ${b.title}: ${b.closed.join(', ')} closed; ${when}`);
  }
  return lines;
}
