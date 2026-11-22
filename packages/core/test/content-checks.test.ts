import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  criteriaOf,
  criterionWhat,
  expandPaths,
  globRegExp,
  markdownHeadings,
  parseDoneWhen,
  runCriteria,
  textParts,
} from '../src/index.js';
import type { Criterion } from '../src/index.js';
import { tempDir } from './helpers.js';

// The W8 checks for content work (char-count, contains, heading-structure, front-matter), path
// globs for every check, and post-publish criteria.

function files(map: Record<string, string>): string {
  const dir = tempDir();
  for (const [f, text] of Object.entries(map)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return dir;
}

function check(id: string, name: string, args: Record<string, unknown>): Criterion {
  return criteriaOf(parseDoneWhen([{ id, kind: 'check', check: name, args }]))[0]!;
}

async function one(dir: string, c: Criterion) {
  return (await runCriteria([c], { cwd: dir }))[c.id]!;
}

const THREAD = [
  '---',
  'channel: x',
  'status: draft',
  'task: LC-0004',
  '---',
  '1/ SwarmUp runs a team of agents on one queue. 🧵',
  '',
  '---',
  '',
  '2/ ' + 'é'.repeat(270),
  '',
  '---',
  '',
  '3/ ' + 'a'.repeat(300),
  '',
].join('\n');

describe('char-count', () => {
  it('counts code points per block between separator lines, front matter left out', async () => {
    const dir = files({ 'posts/x-thread.md': THREAD });
    const r = await one(
      dir,
      check('len', 'char-count', {
        path: 'posts/x-thread.md',
        per: 'block',
        separator: '---',
        max: 280,
      }),
    );
    expect(r.result).toBe('fail');
    expect(r.evidence).toMatch(/1 of 3 blocks out of range \(block 3 has 303\)/);
    // 'é' is one code point, so block 2 (273) passes; a UTF-16 count would also be 273, and an
    // emoji counts as one, not two.
    expect(textParts('a 🧵', 'file')[0]).toBe('a 🧵');
    const ok = await one(
      dir,
      check('len', 'char-count', {
        path: 'posts/x-thread.md',
        per: 'block',
        separator: '---',
        max: 310,
      }),
    );
    expect(ok.result).toBe('pass');
    expect(ok.evidence).toMatch(/3 blocks, the longest 303 characters/);
  });

  it('splits blocks at blank lines without a separator, and counts lines and whole files', async () => {
    expect(textParts('a\n\n\nb b\n\nc', 'block')).toEqual(['a', 'b b', 'c']);
    expect(textParts('one\n\n two \n', 'line')).toEqual(['one', 'two']);
    const dir = files({ 'title.txt': 'Show HN: SwarmUp, a queue for coding agents\n' });
    const r = await one(dir, check('t', 'char-count', { path: 'title.txt', max: 80, min: 10 }));
    expect(r.result).toBe('pass');
    expect(r.evidence).toMatch(/has 43 characters/);
    const lines = await one(
      dir,
      check('t', 'char-count', { path: 'title.txt', per: 'line', max: 20 }),
    );
    expect(lines.result).toBe('fail');
  });

  it('refuses bad arguments when the criterion is set', () => {
    expect(() => check('x', 'char-count', { path: 'a.md' })).toThrow(/min or args.max/);
    expect(() => check('x', 'char-count', { path: 'a.md', max: 5, per: 'word' })).toThrow(
      /per must be/,
    );
  });
});

describe('contains', () => {
  const dir = () =>
    files({
      'post.md':
        '---\nurl: https://hidden.example\n---\nGet it at https://github.com/dawid-ai/swarmup today.\n',
    });

  it('wants every text by default, ignoring case, and names what is missing', async () => {
    const d = dir();
    const ok = await one(
      d,
      check('c', 'contains', { path: 'post.md', text: ['GITHUB.COM/dawid-ai/swarmup'] }),
    );
    expect(ok.result).toBe('pass');
    const missing = await one(
      d,
      check('c', 'contains', { path: 'post.md', text: ['swarmup', 'pricing'] }),
    );
    expect(missing.result).toBe('fail');
    expect(missing.evidence).toMatch(/lacks "pricing"/);
    // Front matter is not the post: a URL only there does not count.
    const hidden = await one(
      d,
      check('c', 'contains', { path: 'post.md', text: 'hidden.example' }),
    );
    expect(hidden.result).toBe('fail');
  });

  it('takes any with mode any, case with case-sensitive, and none with expect false', async () => {
    const d = dir();
    expect(
      (
        await one(
          d,
          check('c', 'contains', { path: 'post.md', text: ['nope', 'today'], mode: 'any' }),
        )
      ).result,
    ).toBe('pass');
    expect(
      (
        await one(
          d,
          check('c', 'contains', { path: 'post.md', text: 'GET IT', 'case-sensitive': true }),
        )
      ).result,
    ).toBe('fail');
    const banned = await one(
      d,
      check('c', 'contains', { path: 'post.md', text: ['revolutionary', 'Today'], expect: false }),
    );
    expect(banned.result).toBe('fail');
    expect(banned.evidence).toMatch(/has "Today"/);
    const clean = await one(
      d,
      check('c', 'contains', {
        path: 'post.md',
        text: ['revolutionary', 'game-changer'],
        expect: false,
      }),
    );
    expect(clean.result).toBe('pass');
  });
});

describe('heading-structure', () => {
  it('wants one h1, no skipped level and the required headings in order', async () => {
    const good =
      '# Fund\n\n## Who we are\n\n### Team\n\n## What we build\n\n```\n# not a heading\n```\n';
    const d = files({ 'good.md': good, 'bad.md': '# A\n\n### Skipped\n\n# Two\n\n## Why\n' });
    const ok = await one(
      d,
      check('h', 'heading-structure', {
        path: 'good.md',
        headings: ['## Who we are', 'What we build'],
      }),
    );
    expect(ok.result).toBe('pass');
    const order = await one(
      d,
      check('h', 'heading-structure', {
        path: 'good.md',
        headings: ['What we build', 'Who we are'],
      }),
    );
    expect(order.result).toBe('fail');
    expect(order.evidence).toMatch(/no heading "Who we are" in order/);
    const bad = await one(d, check('h', 'heading-structure', { path: 'bad.md' }));
    expect(bad.result).toBe('fail');
    expect(bad.evidence).toMatch(/2 level-1 headings/);
    expect(bad.evidence).toMatch(/skips from h1 to h3/);
    const loose = await one(
      d,
      check('h', 'heading-structure', { path: 'bad.md', 'single-h1': false, 'no-skip': false }),
    );
    expect(loose.result).toBe('pass');
    expect(markdownHeadings(good).map((h) => h.text)).toEqual([
      'Fund',
      'Who we are',
      'Team',
      'What we build',
    ]);
  });
});

describe('front-matter', () => {
  it('wants the keys, and values that match the patterns', async () => {
    const d = files({
      'a.md': '---\nchannel: x\nstatus: draft\ndate: 2026-12-15\ntags: [launch, ai]\n---\nBody\n',
      'b.md': 'No front matter\n',
      'c.md': '---\nchannel: [x\n---\n',
    });
    const ok = await one(
      d,
      check('f', 'front-matter', {
        path: 'a.md',
        keys: ['channel', 'status'],
        match: { date: '^\\d{4}-\\d{2}-\\d{2}$', tags: '^[a-z]+$' },
      }),
    );
    expect(ok.result).toBe('pass');
    const bad = await one(
      d,
      check('f', 'front-matter', { path: 'a.md', keys: ['task'], match: { status: '^approved$' } }),
    );
    expect(bad.result).toBe('fail');
    expect(bad.evidence).toMatch(/no task/);
    expect(bad.evidence).toMatch(/status "draft" does not match/);
    expect(
      (await one(d, check('f', 'front-matter', { path: 'b.md', keys: ['x'] }))).evidence,
    ).toMatch(/no front matter/);
    expect(
      (await one(d, check('f', 'front-matter', { path: 'c.md', keys: ['x'] }))).evidence,
    ).toMatch(/not YAML/);
    expect(() => check('f', 'front-matter', { path: 'a.md' })).toThrow(/keys or args.match/);
    expect(() => check('f', 'front-matter', { path: 'a.md', match: { a: '(' } })).toThrow(
      /bad pattern/,
    );
  });
});

describe('path globs', () => {
  it('match within a segment with * and across folders with **', () => {
    expect(globRegExp('posts/*.md').test('posts/x.md')).toBe(true);
    expect(globRegExp('posts/*.md').test('posts/a/x.md')).toBe(false);
    expect(globRegExp('posts/**/*.md').test('posts/x.md')).toBe(true);
    expect(globRegExp('posts/**/*.md').test('posts/a/b/x.md')).toBe(true);
    expect(globRegExp('assets/og/card-?.png').test('assets/og/card-1.png')).toBe(true);
    expect(globRegExp('[ab].md').test('b.md')).toBe(true);
  });

  it('check every matching file, and fail on a glob that matches none', async () => {
    const d = files({
      'posts/x-one.md': 'short\n',
      'posts/x-two.md': 'a much longer post than the limit\n',
      'posts/README.md': 'not a post\n',
    });
    expect(expandPaths(d, 'posts/x-*.md').paths).toEqual(['posts/x-one.md', 'posts/x-two.md']);
    const r = await one(d, check('len', 'char-count', { path: 'posts/x-*.md', max: 10 }));
    expect(r.result).toBe('fail');
    // The failing file comes first in the evidence.
    expect(r.evidence!.split('\n')[0]).toMatch(/posts\/x-two\.md has 33 characters/);
    expect(r.evidence).toMatch(/posts\/x-one\.md has 5 characters/);
    const none = await one(d, check('w', 'word-count', { path: 'drafts/*.md', max: 10 }));
    expect(none.result).toBe('fail');
    expect(none.evidence).toMatch(/no file matches drafts\/\*\.md/);
    expect((await one(d, check('e', 'file-exists', { path: 'posts/*.md' }))).result).toBe('pass');
    expect((await one(d, check('e', 'file-exists', { path: 'posts/*.txt' }))).evidence).toMatch(
      /missing: posts\/\*\.txt/,
    );
    const re = await one(
      d,
      check('r', 'regex', { path: ['posts/*.md'], pattern: 'post', expect: false }),
    );
    expect(re.result).toBe('fail');
  });
});

describe('post-publish criteria', () => {
  it('run only in the publish phase, with {url} read as the published URL', async () => {
    const entries = parseDoneWhen([
      { id: 'exists', kind: 'check', check: 'file-exists', args: { path: 'a.md' } },
      { id: 'live', kind: 'check', check: 'url-ok', args: { url: '{url}' }, when: 'publish' },
    ]);
    const criteria = criteriaOf(entries);
    expect(criterionWhat(criteria[1]!)).toBe('url-ok url={url} (after publish)');
    const d = files({ 'a.md': 'x' });
    const seen: string[] = [];
    const fetchStatus = async (url: string) => {
      seen.push(url);
      return 200;
    };
    const merge = await runCriteria(criteria, { cwd: d, fetchStatus });
    expect(Object.keys(merge)).toEqual(['exists']);
    const after = await runCriteria(criteria, {
      cwd: d,
      fetchStatus,
      phase: 'publish',
      url: 'https://x.com/s/1',
    });
    expect(Object.keys(after)).toEqual(['live']);
    expect(after.live!.result).toBe('pass');
    expect(seen).toEqual(['https://x.com/s/1']);
    expect(() => parseDoneWhen([{ kind: 'map', when: 'later' }])).toThrow(/when must be publish/);
  });
});
