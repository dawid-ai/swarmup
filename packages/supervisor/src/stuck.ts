import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { OpsEvent } from '@swarmup/core';
import { redactSecrets } from '@swarmup/core';

/**
 * Stuck runs (AO-0173 follow-up): a task whose runs keep ending without finishing, and without
 * any work between them, is stopped instead of started again. codex:engineer ran 171 times on
 * AO-0173: each run failed every shell call in its sandbox, wrote nothing on the task, and ended
 * with exit 0, so swarmupd freed the task and started the next run a few seconds later.
 */

/**
 * Events that swarmupd and a run write around the run and that show no work on the task. `renew`
 * is the lease swarmupd extends while a run lives: a run that sits out its budget renews before
 * it ends and still did nothing.
 */
const NO_WORK = new Set(['claim', 'run-start', 'run-end', 'release', 'start', 'renew']);

/** The release note swarmupd writes when a run ends without finishing. */
const UNFINISHED = /^run \S+ ended \(.*\) without finishing/;

/** How much of a run log's end {@link runFailure} reads. */
const TAIL_BYTES = 64 * 1024;
/** Distinct error lines kept, and the length of each. */
const MAX_ERRORS = 3;
const MAX_ERROR_CHARS = 300;
const MAX_SAID_CHARS = 600;

/**
 * How many runs in a row ended on the task without finishing, counted back from its last event
 * until an event that shows work: progress, a comment, an ask or answer, a review or verdict, a
 * handoff, a person's release.
 */
export function unfinishedRuns(events: OpsEvent[]): number {
  let n = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (!NO_WORK.has(e.type)) break;
    if (e.type === 'release') {
      if (!UNFINISHED.test(e.body ?? '')) break;
      n++;
    }
  }
  return n;
}

/** What a run's log says about why it ended: its error lines and its last message. */
export interface RunFailure {
  /** Distinct error lines, first seen first, with how often each came. */
  errors: { text: string; count: number }[];
  /** The agent's last message, such as Codex saying it was blocked. */
  said?: string;
}

/** Reads the end of a run log (Claude stream-json, Codex `--json`, or plain text). */
export function runFailure(log: string): RunFailure {
  const errors = new Map<string, number>();
  let said: string | undefined;
  const addError = (text: string): void => {
    const t = clean(text).slice(0, MAX_ERROR_CHARS);
    if (t) errors.set(t, (errors.get(t) ?? 0) + 1);
  };
  for (const line of tail(log).split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    if (s.startsWith('{')) {
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(s) as Record<string, unknown>;
      } catch {
        continue;
      }
      const item = o.item as Record<string, unknown> | undefined;
      if (o.type === 'item.completed' && item?.type === 'agent_message') {
        if (typeof item.text === 'string') said = item.text;
      } else if (o.type === 'error' && typeof o.message === 'string') {
        addError(o.message);
      } else if (o.type === 'result' && typeof o.result === 'string') {
        said = o.result;
        if (o.is_error === true) addError(o.result);
      } else if (o.type === 'assistant') {
        const text = assistantText(o);
        if (text) said = text;
      }
      continue;
    }
    // Plain lines are the runtime's own stderr, such as Codex's `ERROR codex_core::...`.
    if (/\bERROR\b|\bfatal:|\bpanicked\b|^Error:/.test(s)) addError(stripStamp(s));
  }
  return {
    errors: [...errors].slice(0, MAX_ERRORS).map(([text, count]) => ({ text, count })),
    said: said ? clean(said).slice(0, MAX_SAID_CHARS) || undefined : undefined,
  };
}

/** The first error line, or the last message, as a short key for one kind of failure. */
export function failureKey(f: RunFailure): string {
  const first = f.errors[0]?.text ?? f.said ?? 'no error in the run log';
  // Paths, ids and numbers differ from run to run; the kind of failure does not.
  return first
    .replace(/[A-Za-z]:[\\/][^\s"')]+|\/[^\s"')]+\/[^\s"')]+/g, '<path>')
    .replace(/\b[0-9A-Fa-f-]{8,}\b|\d+/g, '#')
    .slice(0, 120);
}

/** Markdown bullets on what the log says, or an empty string when it says nothing. */
export function failureNote(f: RunFailure): string {
  const lines = f.errors.map(
    (e) => `- Error${e.count > 1 ? ` (${e.count} times)` : ''}: ${plain(e.text)}`,
  );
  if (f.said) lines.push(`- Last message: ${plain(f.said)}`);
  return lines.join('\n');
}

function tail(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    // Drop a line cut at the start of the window.
    return size > len ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assistantText(o: Record<string, unknown>): string {
  const content = (o.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c: { type?: string; text?: string }) => (c?.type === 'text' ? (c.text ?? '') : ''))
    .join(' ')
    .trim();
}

function stripStamp(s: string): string {
  return s.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z?\s+/, '');
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Log text on one line with secret-looking lines removed, before it is cut to length: a cut token
 * no longer matches a pattern, and a whole one makes the workspace refuse the event that quotes
 * it, so the release, block and finding would all fail and leave the task claimed.
 */
function clean(s: string): string {
  return oneLine(redactSecrets(s));
}

/** Text safe inside a Markdown bullet: no code spans or fences to break. */
function plain(s: string): string {
  return s.replace(/`/g, "'");
}
