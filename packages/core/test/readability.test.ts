import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Criterion } from '../src/index.js';
import {
  criteriaOf,
  parseDoneWhen,
  proseUnits,
  readability,
  runCriteria,
  syllables,
} from '../src/index.js';
import { tempDir } from './helpers.js';

// W8 phase 3: the `readability` check, a pinned Flesch-Kincaid grade level of a file's prose.

function files(map: Record<string, string>): string {
  const dir = tempDir();
  for (const [path, body] of Object.entries(map)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

function check(args: Record<string, unknown>): Criterion {
  return criteriaOf([{ id: 'r', kind: 'check', check: 'readability', args }])[0]!;
}

const EASY = 'The cat sat on the mat. The dog ran.';
const HARD = 'Organizational responsibilities necessitate comprehensive documentation.';

describe('the pinned score', () => {
  it('counts syllables with a fixed heuristic', () => {
    expect(syllables('the')).toBe(1);
    expect(syllables('simple')).toBe(2);
    expect(syllables('readability')).toBe(5);
    expect(syllables('organizational')).toBe(6);
    expect(syllables('necessitate')).toBe(4);
    // Accents dropped: `cafe`, whose final `e` after a consonant is silent by the rule.
    expect(syllables('café')).toBe(1);
    expect(syllables('rhythm')).toBe(1);
  });

  it('gives the same grade for the same text', () => {
    expect(readability(EASY)).toEqual({ words: 9, sentences: 2, syllables: 9, grade: -2 });
    expect(readability(HARD)).toEqual({ words: 5, sentences: 1, syllables: 25, grade: 45.4 });
    expect(readability('```\ncode\n```\n').grade).toBeNull();
  });

  it('reads prose only: no front matter, code, link addresses or images', () => {
    const md = [
      '---',
      'title: Organizational documentation necessitates',
      '---',
      '# Launch notes',
      '',
      'Read [the guide](https://example.com/very/long/organizational/path) today.',
      'It is short! See `organizationalResponsibilities` too.',
      '',
      '```ts',
      'const organizational = comprehensive;',
      '```',
      '',
      '- first item',
      '- second item',
      '',
      '![Organizational chart](assets/org.png) <b>Bold</b> https://example.com/x',
      '',
      '| Name | Note |',
      '| --- | --- |',
      '| One | Two |',
      '',
      '[guide]: https://example.com/ref',
    ].join('\n');
    expect(proseUnits(md)).toEqual([
      'Launch notes',
      'Read the guide today. It is short! See   too.',
      'first item',
      'second item',
      'Bold',
      'Name   Note',
      'One   Two',
    ]);
    const r = readability(md);
    // Heading, three sentences, two items, the bold line and two table rows.
    expect(r.sentences).toBe(9);
    expect(r.words).toBe(20);
  });
});

describe('the readability check', () => {
  it('passes or fails on the grade, with the numbers as evidence', async () => {
    const d = files({ 'posts/easy.md': EASY, 'posts/hard.md': HARD });
    const easy = await runCriteria([check({ path: 'posts/easy.md', max_grade: 8 })], { cwd: d });
    expect(easy.r).toMatchObject({ result: 'pass' });
    expect(easy.r!.evidence).toBe(
      'posts/easy.md: Flesch-Kincaid grade -2 (9 words, 2 sentences, 1.00 syllables per word); wants grade at most 8',
    );
    const all = await runCriteria([check({ path: 'posts/*.md', max_grade: 8 })], { cwd: d });
    expect(all.r!.result).toBe('fail');
    expect(all.r!.evidence!.split('\n')[0]).toMatch(/^posts\/hard\.md: Flesch-Kincaid grade 45\.4/);
    const floor = await runCriteria([check({ path: 'posts/easy.md', min_grade: 0 })], { cwd: d });
    expect(floor.r!.result).toBe('fail');
  });

  it('fails a file with no prose and a missing file', async () => {
    const d = files({ 'code.md': '```\nx\n```\n' });
    const r = await runCriteria([check({ path: ['code.md', 'none.md'], max_grade: 8 })], {
      cwd: d,
    });
    expect(r.r!.result).toBe('fail');
    expect(r.r!.evidence).toContain('code.md: no prose to score');
    expect(r.r!.evidence).toContain('no file none.md');
  });

  it('needs a grade bound, numbers, and a floor under the ceiling', () => {
    const parse = (args: Record<string, unknown>): unknown =>
      parseDoneWhen([{ kind: 'check', check: 'readability', args }]);
    expect(() => parse({ path: 'a.md' })).toThrow(/needs args.max_grade or args.min_grade/);
    expect(() => parse({ path: 'a.md', max_grade: 'eight' })).toThrow(/max_grade must be a number/);
    expect(() => parse({ path: 'a.md', min_grade: 9, max_grade: 8 })).toThrow(/above/);
    expect(() => parse({ max_grade: 8 })).toThrow(/needs args.path/);
    expect(parse({ path: 'a.md', min_grade: -1 })).toHaveLength(1);
  });
});
