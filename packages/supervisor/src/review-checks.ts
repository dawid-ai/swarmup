import { redactSecrets, runtimeOf } from '@swarmup/core';
import type { MergeConfig } from './config.js';
import type { CommandResult } from './merge.js';

/**
 * The checks swarmupd ran on the commit a review request names, for a reviewer that cannot run
 * them itself (AO-0296). A Codex run of a role that does not write has a sandbox that keeps the
 * checkout and its worktrees read-only and has no network, so a build, a test run and an install
 * all fail there. swarmupd runs the root's merge `checks` outside the sandbox, in a worktree of
 * its own, and the review run's prompt carries the results.
 */
export interface ReviewChecks {
  /** The commit the checks ran on; missing when swarmupd found none or could not run them. */
  commit?: string;
  /** The work as the review names it, such as `abc1234 on branch claude/x`. */
  what?: string;
  /** When the checks ended, in ms. */
  at: number;
  /** The commands of `swarmupd.merge.<root>.checks`, in order. */
  commands: string[];
  /** One result per command that ran; the list ends at the first that failed. */
  results: CommandResult[];
  /** Why no check ran. */
  note?: string;
}

/**
 * Whether swarmupd runs the checks before a review run of `agent`: the run is a Codex run of a
 * role that does not write, and the root's merge setting names checks. Other reviewers run them
 * themselves, in a worktree.
 */
export function needsReviewChecks(
  agent: string,
  writes: boolean,
  on: boolean,
  cfg: MergeConfig | undefined,
): cfg is MergeConfig {
  return on && !writes && runtimeOf(agent) === 'codex' && (cfg?.checks?.length ?? 0) > 0;
}

/** How much of a failed command's output the prompt quotes; the log file has all swarmupd kept. */
const PROMPT_LINES = 60;
const PROMPT_CHARS = 4_000;

function tail(output: string): string {
  const lines = redactSecrets(output).replace(/\r\n?/g, '\n').trimEnd().split('\n');
  const text = lines.slice(-PROMPT_LINES).join('\n');
  return text.length > PROMPT_CHARS ? text.slice(-PROMPT_CHARS) : text;
}

function outcome(r: CommandResult): string {
  return r.ok ? 'passed' : `failed (${r.why ?? 'exit ?'})`;
}

/**
 * The lines a review run's prompt ends with: each check swarmupd ran and its result, the end of a
 * failed one's output, and the checks that did not run after it. `log` is the file with the whole
 * output, when there is one.
 */
export function reviewChecksNote(c: ReviewChecks, log?: string): string {
  const lines = [''];
  if (c.note || !c.commit) {
    lines.push(
      `swarmupd did not run the checks of this review: ${c.note ?? 'it found no commit'}.`,
      'Your sandbox cannot run them either: name them in your verdict as not run, with this reason,',
      'and judge from the diff.',
    );
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    `Checks swarmupd ran for this review, on ${c.what ?? c.commit} (commit ${c.commit.slice(0, 12)}, as it is,`,
    'not rebased), in a worktree of its own, outside your sandbox:',
  );
  for (const r of c.results) lines.push(`- \`${r.command}\`: ${outcome(r)}`);
  const skipped = c.commands.slice(c.results.length);
  for (const s of skipped) lines.push(`- \`${s}\`: not run, an earlier check failed`);
  const failed = c.results.find((r) => !r.ok);
  if (failed) {
    const out = tail(failed.output);
    lines.push(
      out ? `The end of what \`${failed.command}\` printed:` : 'It printed nothing.',
      ...(out ? out.split('\n').map((l) => `    ${l}`) : []),
    );
  }
  if (log) lines.push(`The whole output is in ${log.replace(/\\/g, '/')}.`);
  lines.push(
    'Your sandbox cannot build, install or test, so do not run these yourself: name each command',
    'and its result in your verdict as run by swarmupd. A failed check is a reason to ask for',
    'changes unless the output shows that the machine failed, not the code.',
  );
  return `${lines.join('\n')}\n`;
}

/** The whole output swarmupd kept of each check, for a file in the run's scratch folder. */
export function reviewChecksLog(c: ReviewChecks): string {
  const parts = [`Checks of ${c.what ?? c.commit ?? 'the review'}${c.note ? `: ${c.note}` : ''}`];
  for (const r of c.results) {
    parts.push('', `$ ${r.command}: ${outcome(r)}`, redactSecrets(r.output).trimEnd());
  }
  return `${parts.join('\n')}\n`;
}
