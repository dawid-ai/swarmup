import type { OpsEvent } from '@swarmup/core';
import { runtimeOf } from '@swarmup/core';
import type { Invocation } from './runtimes.js';
import type { RunRecord } from './runs.js';
import { cut, utc } from './run-context.js';

/**
 * Session resume after `changes`: when a task's work comes back with a `changes` verdict (from
 * its reviewer, or from swarmupd's merge, `opsd:merge`) to the agent whose run did the work, the
 * next work run resumes that run's session instead of starting from a blank one. The session
 * still holds what the run read and why it chose what it did, so the run spends its budget on
 * the fix instead of orienting again.
 */

/** Hours after its run ended that a session may still be resumed (`swarmupd.resume_max_hours`). */
export const RESUME_MAX_HOURS = 24;

/** Most characters of the verdict the resumed prompt quotes. */
export const RESUME_VERDICT_MAX = 4_000;

/** Most characters of each other event since the run that the resumed prompt quotes. */
const RESUME_EVENT_MAX = 800;

/** The event types that say something the resumed run should read, besides the verdict. */
const SINCE_TYPES = new Set(['comment', 'answer', 'review-fallback', 'reopen', 'assign']);

export interface ResumeInput {
  /** `swarmupd.resume_on_changes`. */
  enabled: boolean;
  /** `swarmupd.resume_max_hours`. */
  maxHours: number;
  /** The agent the new run is for. */
  agent: string;
  /** The task, as its root and id. */
  root: string;
  task: string;
  /** The folder the new run starts in. */
  cwd: string;
  /** The task's events. */
  events: readonly OpsEvent[];
  /** The run records swarmupd holds, in any order. */
  runs: readonly RunRecord[];
  now: number;
  /** The new run's token budget, when it has one. */
  tokenBudget?: number;
  /** Whether a folder still exists. */
  exists: (dir: string) => boolean;
  samePath: (a: string, b: string) => boolean;
}

export type ResumeDecision =
  | { resume: true; session: string; run: RunRecord; verdict: OpsEvent; since: OpsEvent[] }
  | { resume: false; why: string };

/** A work run on the task: not a review, question, helper, chat turn, plan check or inbox run. */
function workRunOn(r: RunRecord, root: string, task: string): boolean {
  return (
    r.root === root &&
    r.task === task &&
    !r.review &&
    !r.question &&
    !r.parent &&
    !r.chat &&
    !r.plan_check &&
    !r.inbox
  );
}

const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Whether the next work run of `agent` on the task resumes the session of its previous one. It
 * does only when every condition holds:
 *
 * 1. `resume_on_changes` is on, and the runtime is Claude or Codex.
 * 2. The newest work run on the task is this agent's (so the same runtime), it ended on its own
 *    (`exit`, exit code 0), and swarmupd recorded its session id.
 * 3. The newest verdict on the task asks for `changes`, came after that run ended, and answers a
 *    review this agent asked for; no run started and no review was asked on the task since. A
 *    run on another machine shows as a `run-start` event only, so the events count too.
 * 4. The new run starts in the same folder, and it still exists.
 * 5. The run ended less than `maxHours` ago.
 * 6. With a token budget, the earlier run used less than half of it: the resumed session carries
 *    its whole context.
 *
 * Otherwise the run starts fresh, and `why` says which condition failed.
 */
export function resumeDecision(p: ResumeInput): ResumeDecision {
  const no = (why: string): ResumeDecision => ({ resume: false, why });
  if (!p.enabled) return no('resume_on_changes is off');
  const runtime = runtimeOf(p.agent);
  if (runtime !== 'claude' && runtime !== 'codex') return no(`${runtime} runs do not resume`);
  const prev = p.runs
    .filter((r) => workRunOn(r, p.root, p.task))
    .sort(byId)
    .pop();
  if (!prev) return no('no earlier work run on the task');
  if (prev.agent !== p.agent) return no(`the last work run was ${prev.agent}'s`);
  if (runtimeOf(prev.agent) !== runtime) return no('another runtime');
  if (prev.status !== 'ended' || !prev.ended_at) return no(`run ${prev.id} has not ended`);
  if (prev.reason !== 'exit' || prev.exit !== 0) {
    return no(`run ${prev.id} ended with ${prev.reason ?? 'no reason'}, exit ${prev.exit ?? '-'}`);
  }
  if (!prev.session) return no(`run ${prev.id} has no session id`);
  const events = [...p.events].sort(byId);
  const ended = Date.parse(prev.ended_at);
  const verdicts = events.filter((e) => e.type === 'verdict');
  const verdict = verdicts[verdicts.length - 1];
  if (!verdict || verdict.verdict !== 'changes') return no('the newest verdict is no `changes`');
  if (Date.parse(verdict.at) < ended) return no(`the verdict is older than run ${prev.id}`);
  const before = events.filter((e) => e.id < verdict.id);
  const after = events.filter((e) => e.id > verdict.id);
  // The verdict answers this agent's work: the review it closes is the agent's own.
  const asked = before.filter((e) => e.type === 'review').pop();
  if (!asked || asked.actor !== p.agent) return no(`the verdict answers no review by ${p.agent}`);
  const started = after.find((e) => e.type === 'run-start' && e.run !== prev.id);
  if (started) return no(`run ${started.run ?? '?'} started on the task since the verdict`);
  if (after.some((e) => e.type === 'review')) return no('a review was asked since the verdict');
  if (!p.samePath(prev.cwd, p.cwd)) return no(`the run starts in ${p.cwd}, not ${prev.cwd}`);
  if (!p.exists(prev.cwd)) return no(`${prev.cwd} is gone`);
  const age = p.now - ended;
  if (age > p.maxHours * 3_600_000) return no(`run ${prev.id} ended over ${p.maxHours} h ago`);
  if (p.tokenBudget !== undefined && prev.tokens * 2 > p.tokenBudget) {
    return no(`run ${prev.id} used ${prev.tokens} of a ${p.tokenBudget}-token budget's half`);
  }
  const since = events.filter(
    (e) =>
      e.id !== verdict.id &&
      Date.parse(e.at) >= ended &&
      SINCE_TYPES.has(e.type) &&
      e.body.trim() !== '',
  );
  return { resume: true, session: prev.session, run: prev, verdict, since };
}

/**
 * The invocation that resumes `session` instead of starting a new one, or null when the
 * runtime cannot resume this run.
 *
 * - Claude: the same command with `--resume <session>`, put right after `-p` because
 *   `--add-dir` at the end takes every value after it.
 * - Codex (`codex exec resume`, 0.167): it takes no `--sandbox`, `-C` or `--add-dir`, so only a
 *   run that started with `--sandbox danger-full-access` (a writing run in its task worktree)
 *   resumes, with `--dangerously-bypass-approvals-and-sandbox`, which is the same access. The
 *   process starts in the run's folder, as `-C` did. Sandboxed Codex runs start fresh.
 *
 * `baseLen` is the number of the provider's own `args` in front of the runtime's.
 */
export function resumeInvocation(
  inv: Invocation,
  runtime: string,
  session: string,
  baseLen = 0,
): Invocation | null {
  // A session id is a UUID; anything that could read as a flag never reaches the command line.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(session)) return null;
  const base = inv.args.slice(0, baseLen);
  const rest = inv.args.slice(baseLen);
  if (runtime === 'claude') {
    const p = rest.indexOf('-p');
    if (p < 0 || rest.includes('--resume') || rest.includes('--session-id')) return null;
    return {
      ...inv,
      args: [...base, ...rest.slice(0, p + 1), '--resume', session, ...rest.slice(p + 1)],
    };
  }
  if (runtime !== 'codex' || rest[0] !== 'exec') return null;
  const sandbox = rest.indexOf('--sandbox');
  if (sandbox < 0 || rest[sandbox + 1] !== 'danger-full-access') return null;
  const keep: string[] = [];
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--sandbox' || a === '-C' || a === '--add-dir') {
      i++;
      continue;
    }
    if (a === '-') continue;
    keep.push(a);
  }
  return {
    ...inv,
    args: [
      ...base,
      'exec',
      'resume',
      ...keep,
      '--dangerously-bypass-approvals-and-sandbox',
      session,
      '-',
    ],
  };
}

export interface ResumePromptInput {
  agent: string;
  task: string;
  /** The run whose session resumes. */
  run: string;
  verdict: OpsEvent;
  /** Other events since that run ended: comments, answers. */
  since: readonly OpsEvent[];
}

/**
 * The prompt of a resumed run: a short delta, since the session holds the first prompt with the
 * role, the rules and the task. It quotes the verdict and what else was said since the run.
 */
export function resumePrompt(p: ResumePromptInput): string {
  const merge = p.verdict.actor === 'opsd:merge';
  const v = cut(p.verdict.body, RESUME_VERDICT_MAX);
  const lines = [
    `swarmupd resumed your earlier session of ${p.task} (run ${p.run}); continue from it. You are`,
    `${p.agent}; the role, the rules and the task of your first prompt in this session still hold.`,
    '',
    merge
      ? `swarmupd could not merge the approved work and sent ${p.task} back (${utc(p.verdict.at)}, ${p.task}#${p.verdict.id}${v.cut ? ', cut' : ''}):`
      : `${p.verdict.actor} asked for changes (${utc(p.verdict.at)}, ${p.task}#${p.verdict.id}${v.cut ? ', cut' : ''}):`,
    ...v.text.split('\n').map((l) => (l.trim() ? `> ${l.trimEnd()}` : '>')),
  ];
  if (p.since.length > 0) {
    lines.push('', 'Also since your run:');
    for (const e of p.since) {
      const c = cut(e.body, RESUME_EVENT_MAX);
      const to = e.to ? ` -> ${e.to}` : '';
      lines.push(`- ${utc(e.at)} ${e.actor} ${e.type}${to} (${p.task}#${e.id}):`);
      lines.push(...c.text.split('\n').map((l) => (l.trim() ? `  > ${l.trimEnd()}` : '  >')));
    }
  }
  lines.push(
    '',
    `Run \`swarmup start ${p.task}\` with a one-line plan for the fix, fix what the verdict asks in`,
    'the same folder, commit, and finish with exactly one finishing command, as before. Files may',
    'have changed since your run: read a file again before you edit it.',
    `\`swarmup show ${p.task}\` has the whole thread.`,
    `Before you stop, run \`swarmup sync --session-end\`.`,
  );
  return `${lines.join('\n')}\n`;
}
