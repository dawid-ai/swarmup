/** Where an approved task's work is, as its last review request names it. */
export interface MergeSource {
  /** The commit the reviewer approved, when the review names one. */
  commit?: string;
  branch?: string;
}

/** A name ends at a space, a colon, a comma, a bracket or a full stop that ends a sentence. */
const NAME = '`?([A-Za-z0-9._/-]+?)`?(?=[\\s:,;)]|\\.(?:\\s|$)|$)';

/** What a review request names as the work to merge. */
export interface ReviewSources {
  /** `<commit> on branch <name>`, the form the agent skill and swarmupd's own leftover reviews use. */
  named?: MergeSource;
  /**
   * The word after each other `branch`, in order. Prose gives words that are no branch ("this
   * branch does not touch it"), so only a name that is a branch in the repo counts.
   */
  loose: string[];
}

/**
 * Reads what a review request names: `<commit> on branch <name>`, and each `branch <word>`. The
 * commit may be in code font or bold, as event text is Markdown: a request that wrote the commit
 * in code font named no commit before, and the merge took an older request's branch for it
 * (AO-0325).
 */
export function reviewSources(text: string): ReviewSources {
  const both = new RegExp(`\\b([0-9a-f]{7,40})[\`*]{0,3}\\s+on\\s+branch\\s+${NAME}`, 'm').exec(
    text,
  );
  const named = both ? { commit: both[1], branch: both[2] } : undefined;
  const loose: string[] = [];
  for (const m of text.matchAll(new RegExp(`\\bbranch\\s+${NAME}`, 'gm'))) {
    if (m[1] !== named?.branch && !loose.includes(m[1]!)) loose.push(m[1]!);
  }
  return named ? { named, loose } : { loose };
}

/**
 * The words of a review request that look like commit ids: 7 to 40 hex digits with a digit and a
 * letter among them, each once, in order. Prose gives words that are no commit, so a caller
 * asks the repo about each.
 */
export function reviewCommits(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g)) {
    if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}
