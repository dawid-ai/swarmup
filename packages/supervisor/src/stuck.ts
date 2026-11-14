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

/**
 * The first paragraph of the block swarmupd writes when it stops a stuck task. {@link stuckRun}
 * reads the run back from it, so `swarmup report` can count that run as `stuck`.
 */
export function stuckNote(
  ref: string,
  streak: number,
  run: { id: string; agent: string; reason?: string; exit?: number | null },
): string {
  return (
    `${ref}: swarmupd stopped starting this task. ${streak} runs of ${run.agent} in a row ended ` +
    `without finishing and with no work on the task; the last was run ${run.id} ` +
    `(${run.reason}, exit ${run.exit ?? '-'}).`
  );
}

const STUCK_NOTE = /swarmupd stopped starting this task\.[^\n]*? the last was run (\S+) \(/;

/** The run a stuck block names as the last unfinished one, or null for any other text. */
export function stuckRun(body: string | undefined): string | null {
  return STUCK_NOTE.exec(body ?? '')?.[1] ?? null;
}

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

/** Events that leave a change request waiting for its author as it was: notes on the task. */
const AFTER_VERDICT = new Set(['comment', 'priority', 'learn', 'finding']);

/**
 * The `changes` verdicts a task got in a row, oldest first, when the newest of them still waits
 * for its author (AO-0288): nothing but notes came after it. An approval, a reopen and an earlier
 * stop by `watch` (swarmupd's block for the PM) end the row, so the count starts again after the
 * PM's decision. Empty when the task waits for something else.
 */
export function changesRounds(events: OpsEvent[], watch: string): OpsEvent[] {
  let at = events.length - 1;
  while (at >= 0 && AFTER_VERDICT.has(events[at]!.type)) at--;
  if (events[at]?.type !== 'verdict' || events[at]!.verdict !== 'changes') return [];
  const rounds: OpsEvent[] = [];
  for (; at >= 0; at--) {
    const e = events[at]!;
    if (e.type === 'reopen' || (e.type === 'block' && e.actor === watch)) break;
    if (e.type !== 'verdict') continue;
    if (e.verdict !== 'changes') break;
    rounds.unshift(e);
  }
  return rounds;
}

/** One verdict as a bullet of the block for the PM: who gave it, when, and its text, cut short. */
export function roundNote(e: OpsEvent, n: number): string {
  const text = (e.body ?? '').replace(/\s+/g, ' ').trim();
  const cut = text.length > MAX_SAID_CHARS ? `${text.slice(0, MAX_SAID_CHARS)}…` : text;
  return `- Round ${n}, ${e.actor}, ${e.at.slice(0, 10)}: ${cut || '(no text)'}`;
}

/** Text safe inside a Markdown bullet: no code spans or fences to break. */
function plain(s: string): string {
  return s.replace(/`/g, "'");
}
