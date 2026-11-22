// The word-level prose diff of the task panel's Work section (W8): shared runs, additions and
// deletions by word, and a whole-block fallback for huge inputs.
import { describe, expect, it } from 'vitest';
import { WORD_DIFF_MAX_TOKENS, wordDiff, wordTokens } from '../ui/src/lib/diff';

/** The diff as one string, `[+added]` and `[-deleted]`. */
function marked(before: string, after: string): string {
  return wordDiff(before, after)
    .map((p) => (p.op === 'add' ? `[+${p.text}]` : p.op === 'del' ? `[-${p.text}]` : p.text))
    .join('');
}

describe('wordDiff', () => {
  it('marks a changed word and keeps the rest shared', () => {
    expect(marked('The agents ship code fast.', 'The agents ship copy fast.')).toBe(
      'The agents ship [-code][+copy] fast.',
    );
  });

  it('marks added and deleted words, and rebuilds both versions', () => {
    const before = 'SwarmUp runs agents on one queue.';
    const after = 'SwarmUp runs Claude and Codex agents on one shared queue.';
    const parts = wordDiff(before, after);
    const side = (keep: 'add' | 'del'): string =>
      parts
        .filter((p) => p.op === 'same' || p.op === keep)
        .map((p) => p.text)
        .join('');
    expect(side('del')).toBe(before);
    expect(side('add')).toBe(after);
    expect(parts.some((p) => p.op === 'add' && p.text.includes('Claude and Codex'))).toBe(true);
    expect(parts.every((p) => p.op !== 'del')).toBe(true);
  });

  it('merges neighbouring runs of one kind', () => {
    const parts = wordDiff('a b c', 'x y z');
    expect(parts.map((p) => p.op)).toEqual(['del', 'add']);
  });

  it('treats a new file as all added and equal text as all shared', () => {
    expect(wordDiff('', 'New post.')).toEqual([{ op: 'add', text: 'New post.' }]);
    expect(wordDiff('Same.', 'Same.')).toEqual([{ op: 'same', text: 'Same.' }]);
    expect(wordDiff('', '')).toEqual([]);
  });

  it('falls back to one deletion and one addition past the token limit', () => {
    const big = 'word '.repeat(WORD_DIFF_MAX_TOKENS);
    const parts = wordDiff(big, `${big}more`);
    expect(parts).toEqual([
      { op: 'del', text: big },
      { op: 'add', text: `${big}more` },
    ]);
  });

  it('splits words, whitespace and punctuation', () => {
    expect(wordTokens("It's 280 chars, max!")).toEqual([
      "It's",
      ' ',
      '280',
      ' ',
      'chars',
      ',',
      ' ',
      'max',
      '!',
    ]);
  });
});
