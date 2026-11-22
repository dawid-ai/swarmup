// Near-duplicate task titles, for a finding filed again after the same work was done or parked.
// Word overlap, not meaning: it only has to catch a second finding for the same bug, which tends
// to reuse the words of the first.

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'into',
  'that',
  'this',
  'when',
  'not',
  'are',
  'was',
  'its',
  'has',
  'have',
  'but',
  'out',
  'all',
  'any',
  'can',
  'does',
  'doesn',
]);

/** The words of a title that carry meaning: lowercase, three letters or more, no stop words. */
export function titleWords(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    // A plain plural matches its singular: "tests" and "test".
    .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
  return new Set(words);
}

/** How alike two titles are, from 0 to 1: shared words over all words (Jaccard). */
export function titleSimilarity(a: string, b: string): number {
  const x = titleWords(a);
  const y = titleWords(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

/** Two titles alike enough to name one as a possible duplicate of the other. */
export const DUPLICATE_SIMILARITY = 0.6;

/**
 * Whether `b` likely names the same work as `a`: two shared words and alike enough, or three
 * shared words and half alike, since longer titles add words of their own.
 */
export function likelyDuplicate(a: string, b: string): boolean {
  const x = titleWords(a);
  const y = titleWords(b);
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  const sim = titleSimilarity(a, b);
  return (shared >= 2 && sim >= DUPLICATE_SIMILARITY) || (shared >= 3 && sim >= 0.5);
}
