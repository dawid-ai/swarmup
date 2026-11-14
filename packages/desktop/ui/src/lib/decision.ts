// The decision log in the app (AO-0109): what the forms send as a decision mark, and how the
// Decisions view words a log entry. No React here, so the rules are tested on their own.
import type { LogEntry } from '../types';

/** Longest one line of a recorded decision, in characters; the same limit as core's. */
export const DECISION_TEXT_MAX = 200;

/** Characters as core counts them: code points, not UTF-16 units. */
export function decisionLength(text: string): number {
  return [...text.trim()].length;
}

/**
 * The first sentence of a message, as the one line a **Decision** field starts with: the first
 * line that says something, without Markdown markers, images and links' targets, up to the first
 * sentence end. The period at its end is dropped; `0.3.0` and `v2.1` hold no sentence end.
 */
export function firstSentence(message: string): string {
  const line =
    message
      .split(/\r?\n/)
      .map((l) =>
        l
          .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
          .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
          .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)*/, '')
          .replace(/[*_`]/g, '')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .find((l) => l !== '') ?? '';
  const end = /[.!?](?=\s|$)/.exec(line);
  const sentence = end ? line.slice(0, end.index + 1) : line;
  return sentence.replace(/\.$/, '').trim();
}

/**
 * The decision an ask says it contradicts, as `D-0007`, or null. Runs and the PM name it as
 * `contradiction with D-0007: ...` (the run prompt's wording).
 */
export function contradicted(text: string | undefined | null): string | null {
  const m = /contradiction with (D-\d+)/i.exec(text ?? '');
  return m ? `D-${m[1]!.slice(2).padStart(4, '0')}` : null;
}

/** `project v2`, `root` or `tree AO-0051`, as `swarmup decisions --log` prints a scope. */
export function scopeText(e: Pick<LogEntry, 'scope' | 'project' | 'task'>): string {
  if (e.scope === 'tree') return `tree ${e.task ?? '?'}`;
  return e.project === undefined ? 'root' : `project ${e.project}`;
}

/** A task event as a source: `AO-0107#<event id>`, with or without its root. */
const EVENT_REF = /^((?:[A-Za-z0-9._-]+\/)?[A-Za-z][A-Za-z0-9]*-\d+)#([0-9A-HJKMNP-TV-Z]{26})$/;

/** Where a decision's words are: a task event, the PM chat, a vote or a file. */
export function logOrigin(e: Pick<LogEntry, 'kind' | 'source' | 'scope' | 'task'>):
  | { kind: 'event'; task: string; ref: string }
  | { kind: 'chat' | 'vote' | 'none' }
  | {
      kind: 'file';
      file: string;
    } {
  if (e.kind === 'vote') return { kind: 'vote' };
  if (e.source?.startsWith('chat:')) return { kind: 'chat' };
  const event = e.source ? EVENT_REF.exec(e.source) : null;
  if (event) return { kind: 'event', task: event[1]!, ref: e.source! };
  if (e.source) return { kind: 'file', file: e.source };
  return { kind: 'none' };
}

/** How a decision was replaced, and for which tasks it still holds; the log's notes. */
export function logNotes(e: Pick<LogEntry, 'state' | 'replaced' | 'in_force_for'>): string[] {
  if (e.state === 'superseded') {
    return [`superseded by ${[...new Set(e.replaced.map((r) => r.by))].join(', ')}`];
  }
  const notes = e.replaced.map((r) => `${r.how} ${r.where} by ${r.by}`);
  const left = e.in_force_for ?? [];
  if (left.length > 0) {
    const more = left.length > 5 ? ` and ${left.length - 5} more` : '';
    notes.push(`in force for ${left.slice(0, 5).join(', ')}${more}`);
  }
  return notes;
}

/** What a form's **Decision** control holds. */
export interface MarkValue {
  on: boolean;
  /** The one line. */
  line: string;
  /** **Project-wide**: the whole project, not the task and the tasks below it. */
  projectWide: boolean;
  /** The decision this one replaces, from **Accept change** on a contradiction. */
  replaces?: string;
  /** **Only this task tree**: an exception to `replaces`, not a replacement. */
  treeOnly: boolean;
}

/** Why a form must not send the mark yet, or null. Off, it never holds a form back. */
export function markProblem(m: MarkValue): string | null {
  if (!m.on) return null;
  const n = decisionLength(m.line);
  if (n === 0) return 'Write the decision in one line, or turn Decision off';
  if (/[\r\n]/.test(m.line.trim())) return 'A decision is one line';
  if (n > DECISION_TEXT_MAX) {
    return `A decision is one line of ${DECISION_TEXT_MAX} characters at most; this one has ${n}`;
  }
  return null;
}

/**
 * The fields a task write carries for the mark: `decision` and `scope` (`--decision` and
 * `--scope` of the CLI). A replacement sends `supersedes` without a scope, so the record takes
 * the old decision's scope; **Only this task tree** sends `narrows`, and the record covers the
 * task's tree. Off: no fields.
 */
export function markFields(m: MarkValue): Record<string, unknown> {
  if (!m.on) return {};
  const decision = m.line.trim();
  if (m.replaces) {
    return m.treeOnly
      ? { decision, scope: 'tree', narrows: [m.replaces] }
      : { decision, supersedes: [m.replaces] };
  }
  return { decision, scope: m.projectWide ? 'project' : 'tree' };
}
