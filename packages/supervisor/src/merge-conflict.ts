import { MERGE_ACTOR } from '@swarmup/core';
import type { Git } from './diff.js';

/**
 * The words of a send-back whose merge conflicts with the base: `swarmupd did not merge <work>:
 * it conflicts with <base> (<commit>)`. Wake and the review prompt find such send-backs by them.
 */
export const MERGE_CONFLICT = 'it conflicts with';

/** The fields of a task event that {@link isMergeConflictBack} reads. */
export interface ConflictEvent {
  type: string;
  actor?: string;
  verdict?: string;
  body?: string;
}

/** True for swarmupd's send-back of approved work whose merge conflicts with the base. */
export function isMergeConflictBack(e: ConflictEvent): boolean {
  return (
    e.type === 'verdict' &&
    e.verdict === 'changes' &&
    e.actor === MERGE_ACTOR &&
    /^swarmupd did not merge [^\n]*: it conflicts with /.test(e.body ?? '')
  );
}

/**
 * The prompt lines for a review that follows a conflict send-back, or an empty string. When the
 * newest verdict on the task is that send-back and the reviewed commit `to` keeps the approved
 * commit and adds merges, the reviewer checks only how the merges resolved the conflicts; commits
 * besides the merges are named for a full review. Read-only.
 */
export async function resolutionNote(
  git: Git,
  events: ConflictEvent[],
  to: string,
  base: string,
): Promise<string> {
  const back = [...events].reverse().find((e) => e.type === 'verdict');
  if (!back || !isMergeConflictBack(back)) return '';
  const named = /^swarmupd did not merge ([0-9a-f]{7,40})\b/.exec(back.body ?? '')?.[1];
  if (!named) return '';
  let approved: string;
  try {
    approved = (await git(['rev-parse', '--verify', '-q', `${named}^{commit}`])).trim();
    if (!approved) return '';
    await git(['merge-base', '--is-ancestor', approved, to]);
  } catch {
    // The approved commit is gone or the reviewed work does not keep it: a full review.
    return '';
  }
  // The commits the branch added since the approval, leaving out the base's own: those came in
  // with the merge and were reviewed and merged before.
  const list = async (args: string[]): Promise<string[]> =>
    (await git(['rev-list', ...args, `${approved}..${to}`, `^${base}`]))
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  let merges: string[];
  let others: string[];
  try {
    merges = await list(['--merges']);
    others = await list(['--no-merges']);
  } catch {
    return '';
  }
  if (merges.length === 0) return '';
  const short = (c: string): string => c.slice(0, 7);
  const lines = [
    '',
    `This review follows a merge conflict. ${short(approved)} was approved, but it conflicted with`,
    `${base}, and the branch now merges ${base} into it. The rest of the work was reviewed already:`,
    'review only how the conflicts were resolved, with',
    ...merges.map((m) => `- \`git show --remerge-diff ${short(m)}\``),
    'Approve unless the resolution drops or breaks either side.',
  ];
  if (others.length > 0) {
    lines.push(
      `The branch also has ${others.length} commit(s) since ${short(approved)} besides the merge:`,
      `review those in full (\`git log -p --no-merges ${short(approved)}..${short(to)}\`).`,
    );
  }
  return `${lines.join('\n')}\n`;
}
