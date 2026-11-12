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

/** Reads what a review request names: `<commit> on branch <name>`, and each `branch <word>`. */
export function reviewSources(text: string): ReviewSources {
  const both = new RegExp(`\\b([0-9a-f]{7,40})\\s+on\\s+branch\\s+${NAME}`, 'm').exec(text);
  const named = both ? { commit: both[1], branch: both[2] } : undefined;
  const loose: string[] = [];
  for (const m of text.matchAll(new RegExp(`\\bbranch\\s+${NAME}`, 'gm'))) {
    if (m[1] !== named?.branch && !loose.includes(m[1]!)) loose.push(m[1]!);
  }
  return named ? { named, loose } : { loose };
}
