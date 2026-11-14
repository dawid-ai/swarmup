/** Where an approved task's work is, as its last review request names it. */
export interface MergeSource {
  /** The commit the reviewer approved, when the review names one. */
  commit?: string;
  branch?: string;
}

/**
 * Where a name in code font ends: at a space, a bracket, a quote, a mark of punctuation or a full
 * stop that ends a sentence. Not at a character that goes on with a ref: in `` `feature`-old `` or
 * `` `feature`/next `` the span holds part of a longer word, so it names no branch `feature`.
 */
const CODE_END = '(?=[\\s:,;)\\]}>!?\'"]|\\.(?:\\s|$)|$)';
/**
 * A name in code font, whole: a code span holds its text as written, so `__wip__` there is the
 * branch `__wip__` and no bold `wip` (AO-0325). Bold may stand around the span: up to three marks
 * open it (`o1` to `o3`) and the same marks close it, innermost first. A mark after the span that
 * closes nothing goes on with a longer word: in `` `feature`_ `` the span names no branch
 * `feature`.
 */
const CODE_NAME = `(?<o1>[*_])?(?<o2>[*_])?(?<o3>[*_])?\`(?<code>[^\`\\s]+)\`\\k<o3>\\k<o2>\\k<o1>${CODE_END}`;
/**
 * A name outside code font ends at a space, a colon, a comma, a bracket or a full stop that ends
 * a sentence. It may be bold.
 */
const BARE_NAME = '\\*{0,3}(?<bare>[A-Za-z0-9._/-]+?)\\*{0,3}(?=[\\s:,;)]|\\.(?:\\s|$)|$)';
/** Two named groups: `code`, the name of a code span, else `bare`. Read them with `nameOf`. */
const NAME = `(?:${CODE_NAME}|${BARE_NAME})`;

/**
 * A commit id starts and ends where no letter or digit adjoins it. `\b` does not do: `_` is a
 * word character, so it finds no commit in `__cc3d803__`, the underscore form of bold.
 */
const START = '(?<![0-9A-Za-z])';
const END = '(?![0-9A-Za-z])';
/**
 * The digits of a commit id, in either case: git reads `023F19E` as it reads `023f19e`, so a
 * request that writes the id in capitals names the same commit (AO-0325). The functions here
 * return it in lower case, as git prints it.
 */
const HEX = '[0-9A-Fa-f]{7,40}';

/** A name without the underscores of `_name_` or `__name__`; they are part of a name only unpaired. */
function plain(name: string): string {
  const m = /^(_{1,3})([^_].*?)\1$/.exec(name);
  return m ? m[2]! : name;
}

/**
 * The name `NAME` matched: a code span's text as it is, a bare name without the underscores of
 * emphasis.
 */
function nameOf(m: RegExpExecArray): string {
  return m.groups!.code ?? plain(m.groups!.bare!);
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
 * commit and the name may be in code font or bold (`**x**` or `__x__`), as event text is
 * Markdown: a request that wrote the commit in code font named no commit before, and the merge
 * took an older request's branch for it (AO-0325). A name in code font keeps its text as written,
 * underscores included: `` `__wip__` `` is the branch `__wip__`. A span that a longer word runs on
 * from (`` `feature`-old ``, `` `feature`_ ``) names no branch.
 */
export function reviewSources(text: string): ReviewSources {
  const both = new RegExp(`${START}(${HEX})[\`*_]{0,3}\\s+on\\s+branch\\s+${NAME}`, 'm').exec(text);
  const named = both ? { commit: both[1]!.toLowerCase(), branch: nameOf(both) } : undefined;
  const loose: string[] = [];
  for (const m of text.matchAll(new RegExp(`\\bbranch\\s+${NAME}`, 'gm'))) {
    const name = nameOf(m);
    if (name !== named?.branch && !loose.includes(name)) loose.push(name);
  }
  return named ? { named, loose } : { loose };
}

/** A word that says the next one is a commit, with what may stand between the two. */
const LABEL = /\b(?:commits?|sha|hash|rev|revision)[:=]?\s*[`*_]{0,3}$/i;
/** What opens code font or bold: an underscore does so only where no word runs into it. */
const OPENS = /(?:[`*]|(?<![0-9A-Za-z])_{1,3})$/;
const CLOSES = /^[`*_]/;
/** What stands between two commits of a list: `commits 1234567, 7654321 and abcdefa`. */
const LIST = /^[`*_]{0,3}(?:\s*,\s*(?:and\s+)?|\s+and\s+)[`*_]{0,3}$/;

/**
 * The words of a review request that look like commit ids, each once, in order and in lower
 * case: 7 to 40 hex digits, written in either case. In plain prose such a word counts only with a digit and a letter among them, which
 * leaves out numbers, dates and words (`20261114`, `defaced`). A commit id can be all digits or
 * all letters too, so any such word counts where the text says it is one: after `commit`, `sha`,
 * `hash` or `rev` (and the others of a list that starts so), or in code font or bold (AO-0325).
 * Prose still gives words that are no commit, so a caller asks the repo about each.
 */
export function reviewCommits(text: string): string[] {
  const out: string[] = [];
  const word = new RegExp(`${START}${HEX}${END}`, 'g');
  /** Where the last commit of a labeled list ended. */
  let listEnd = -1;
  for (const m of text.matchAll(word)) {
    const before = text.slice(0, m.index);
    const end = m.index + m[0].length;
    const labeled = LABEL.test(before) || (listEnd >= 0 && LIST.test(text.slice(listEnd, m.index)));
    if (labeled) listEnd = end;
    const marked = OPENS.test(before) && CLOSES.test(text.slice(end));
    const sha = m[0].toLowerCase();
    const mixed = /[0-9]/.test(sha) && /[a-f]/.test(sha);
    if ((labeled || marked || mixed) && !out.includes(sha)) out.push(sha);
  }
  return out;
}
