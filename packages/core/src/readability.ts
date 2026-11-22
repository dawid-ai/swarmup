// The `readability` check's score (W8): the Flesch-Kincaid grade level of a Markdown file's prose.
// The formula, the Markdown stripping, the word and sentence rules and the syllable heuristic are
// all pinned here, with no dictionary, so every machine gets the same number for the same text.

/** The prose of a Markdown file as units: each paragraph, heading, list item or table row. */
export function proseUnits(markdown: string): string[] {
  let src = markdown.replace(/\r\n/g, '\n');
  // YAML front matter.
  if (src.startsWith('---\n')) {
    const end = src.indexOf('\n---', 4);
    if (end >= 0) src = src.slice(src.indexOf('\n', end + 4) + 1);
  }
  // Fenced code blocks, line by line.
  let fence: string | null = null;
  const lines: string[] = [];
  for (const line of src.split('\n')) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
      lines.push('');
      continue;
    }
    lines.push(fence ? '' : line);
  }
  const text = lines
    .join('\n')
    // HTML comments, then tags.
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Images: neither the alt text nor the address is read as prose.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, ' ')
    // Links keep their text, not their address.
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/<[^>\n]*>/g, ' ')
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    // Inline code.
    .replace(/`[^`\n]*`/g, ' ');
  const units: string[] = [];
  let para: string[] = [];
  const flush = (): void => {
    if (para.length > 0) units.push(para.join(' '));
    para = [];
  };
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    // Link reference definitions, rules and table separators hold no prose.
    if (/^\[[^\]]+\]:/.test(line) || /^([-*_=]\s*){3,}$/.test(line) || /^[|:\-\s]+$/.test(line)) {
      flush();
      continue;
    }
    line = line.replace(/^(>\s*)+/, '');
    if (!line) {
      flush();
      continue;
    }
    const heading = /^#{1,6}\s+/.test(line);
    const item = /^([-*+]|\d+[.)])\s+/.test(line);
    const row = line.startsWith('|');
    if (heading || item || row) flush();
    para.push(
      line
        .replace(/^#{1,6}\s+/, '')
        .replace(/^([-*+]|\d+[.)])\s+/, '')
        .replace(/\|/g, ' ')
        .trim(),
    );
    if (heading || row) flush();
  }
  flush();
  return units;
}

/** A word: letters, with inner apostrophes (`don't`). Numbers and symbols are not words. */
const WORD_RE = /\p{L}+(?:['’]\p{L}+)*/gu;

/** The words of a piece of text, as {@link WORD_RE} reads them. */
export function wordsOf(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}

/**
 * The syllables of one word, by a fixed heuristic: accents dropped and only `a` to `z` kept; a
 * word of three letters or fewer is one syllable; otherwise drop a final `es` or `e` after a
 * consonant other than `l`, or a final `ed`, and a leading `y`, then count the runs of one or
 * two vowels (`aeiouy`), and at least one.
 */
export function syllables(word: string): number {
  const w = word
    .normalize('NFD')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (w.length <= 3) return 1;
  const core = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  return Math.max(1, core.match(/[aeiouy]{1,2}/g)?.length ?? 0);
}

/** What the `readability` check measures of a text. */
export interface ReadabilityStats {
  words: number;
  sentences: number;
  syllables: number;
  /** The Flesch-Kincaid grade level, to one decimal; null when the text has no words. */
  grade: number | null;
}

/**
 * The Flesch-Kincaid grade level of a Markdown file's prose:
 * `0.39 * words / sentences + 11.8 * syllables / words - 15.59`, rounded to one decimal.
 *
 * Front matter, fenced code, inline code, HTML, images and link addresses are left out (a link
 * keeps its text). Each paragraph, heading, list item and table row is its own unit. A sentence
 * ends at `.`, `!` or `?` followed by a space or the end of the unit, and a unit's words after
 * its last such mark make one more sentence, so a heading without a full stop is one sentence.
 */
export function readability(markdown: string): ReadabilityStats {
  let words = 0;
  let sentences = 0;
  let syl = 0;
  for (const unit of proseUnits(markdown)) {
    for (const part of unit.split(/[.!?]+(?=\s|$)/)) {
      const ws = wordsOf(part);
      if (ws.length === 0) continue;
      sentences++;
      words += ws.length;
      for (const w of ws) syl += syllables(w);
    }
  }
  if (words === 0) return { words, sentences, syllables: syl, grade: null };
  const grade = 0.39 * (words / sentences) + 11.8 * (syl / words) - 15.59;
  return { words, sentences, syllables: syl, grade: Math.round(grade * 10) / 10 };
}
