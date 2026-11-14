/** Where an approved task's work is, as its last review request names it. */
export interface MergeSource {
  /** The commit the reviewer approved, when the review names one. */
  commit?: string;
  branch?: string;
}

/**
 * A name ends at a space, a colon, a comma, a bracket or a full stop that ends a sentence. It may
 * be in code font or bold.
 */
const NAME = '[`*]{0,3}([A-Za-z0-9._/-]+?)[`*]{0,3}(?=[\\s:,;)]|\\.(?:\\s|$)|$)';

/**
 * A commit id starts and ends where no letter or digit adjoins it. `\b` does not do: `_` is a
 * word character, so it finds no commit in `__cc3d803__`, the underscore form of bold.
 */
const START = '(?<![0-9A-Za-z])';
const END = '(?![0-9A-Za-z])';

/** A name without the underscores of `_name_` or `__name__`; they are part of a name only unpaired. */
function plain(name: string): string {
  const m = /^(_{1,3})([^_].*?)\1$/.exec(name);
  return m ? m[2]! : name;
}

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
 * commit and the name may be in code font or bold (`**x**` or `__x__`), as event text is Markdown: a request that wrote the commit
 * in code font named no commit before, and the merge took an older request's branch for it
 * (AO-0325).
 */
export function reviewSources(text: string): ReviewSources {
  const both = new RegExp(
    `${START}([0-9a-f]{7,40})[\`*_]{0,3}\\s+on\\s+branch\\s+${NAME}`,
    'm',
  ).exec(text);
  const named = both ? { commit: both[1], branch: plain(both[2]!) } : undefined;
  const loose: string[] = [];
  for (const m of text.matchAll(new RegExp(`\\bbranch\\s+${NAME}`, 'gm'))) {
    const name = plain(m[1]!);
    if (name !== named?.branch && !loose.includes(name)) loose.push(name);
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
  const word = new RegExp(`${START}(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}${END}`, 'g');
  for (const m of text.matchAll(word)) {
    if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}
