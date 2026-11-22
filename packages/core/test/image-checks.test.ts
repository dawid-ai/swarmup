import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Criterion } from '../src/index.js';
import {
  countChars,
  criteriaOf,
  imageDimensions,
  imageRefs,
  parseDoneWhen,
  runCriteria,
} from '../src/index.js';
import { tempDir } from './helpers.js';

// W8 phase 2 checks: image-alt, image-size (PNG and JPEG headers read without a dependency),
// and char-count's urls_as, which counts each link as X does.

/** The first bytes of a PNG: the signature and an IHDR chunk with the size. */
function png(width: number, height: number, pad = 0): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ihdr,
    Buffer.alloc(pad),
  ]);
}

/** The first bytes of a JPEG: SOI, an APP0 segment, then a baseline SOF0 with the size. */
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01,
    0x00, 0x00,
  ]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

function files(map: Record<string, string | Buffer>): string {
  const dir = tempDir();
  for (const [path, body] of Object.entries(map)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

function check(id: string, name: string, args: Record<string, unknown>): Criterion {
  return criteriaOf([{ id, kind: 'check', check: name as Criterion['check'], args }])[0]!;
}

describe('image-alt', () => {
  it('finds Markdown and HTML images outside code, with their alt text', () => {
    const refs = imageRefs(
      [
        '# Post',
        '![A card](assets/card.png)',
        '![](assets/bare.png)',
        '```',
        '![](not-an-image.png)',
        '```',
        '<img src="a.jpg" alt="Logo">',
        "<img src='b.jpg'>",
        '<img alt="  " src=c.jpg>',
        '![ref alt][card]',
      ].join('\n'),
    );
    expect(refs).toEqual([
      { src: 'assets/card.png', alt: 'A card', line: 2 },
      { src: 'assets/bare.png', alt: '', line: 3 },
      { src: 'a.jpg', alt: 'Logo', line: 7 },
      { src: 'b.jpg', alt: null, line: 8 },
      { src: 'c.jpg', alt: '  ', line: 9 },
      { src: 'card', alt: 'ref alt', line: 10 },
    ]);
  });

  it('passes when every image has alt text and names the lines that do not', async () => {
    const cwd = files({
      'posts/good.md': '![A card](card.png)\n<img src="x.png" alt="X">\n',
      'posts/bad.md': 'Intro\n\n![](card.png)\n<img src="x.png">\n',
    });
    const good = await runCriteria([check('alt', 'image-alt', { path: 'posts/good.md' })], {
      cwd,
    });
    expect(good.alt).toMatchObject({ result: 'pass', evidence: expect.stringMatching(/2 images/) });
    const all = await runCriteria([check('alt', 'image-alt', { path: 'posts/*.md' })], { cwd });
    expect(all.alt!.result).toBe('fail');
    expect(all.alt!.evidence).toContain(
      'posts/bad.md: 2 of 2 images have no alt text (line 3 card.png, line 4 x.png)',
    );
  });

  it('needs a path', () => {
    expect(() => parseDoneWhen([{ kind: 'check', check: 'image-alt', args: {} }])).toThrow(
      /needs args\.path/,
    );
  });
});

describe('image-size', () => {
  it('reads the size of a PNG and a JPEG from their headers', () => {
    expect(imageDimensions(png(1200, 630))).toEqual({ type: 'png', width: 1200, height: 630 });
    expect(imageDimensions(jpeg(1600, 900))).toEqual({ type: 'jpeg', width: 1600, height: 900 });
    expect(imageDimensions(Buffer.from('GIF89a......'))).toBeNull();
    expect(imageDimensions(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
  });

  it('checks every matched image against the size and the file size limit', async () => {
    const cwd = files({
      'assets/og/a.png': png(1200, 630),
      'assets/og/b.jpg': jpeg(1200, 630),
      'assets/og/c.png': png(800, 600),
      'assets/og/big.png': png(1200, 630, 3000),
      'assets/og/note.txt': 'not an image',
    });
    const ok = await runCriteria(
      [check('og', 'image-size', { path: 'assets/og/[ab].*', width: 1200, height: 630 })],
      { cwd },
    );
    expect(ok.og).toMatchObject({ result: 'pass' });
    expect(ok.og!.evidence).toContain('assets/og/a.png: png 1200x630, 1 KB');
    expect(ok.og!.evidence).toContain('assets/og/b.jpg: jpeg 1200x630');
    const bad = await runCriteria(
      [
        check('og', 'image-size', {
          path: ['assets/og/c.png', 'assets/og/big.png', 'assets/og/note.txt'],
          width: 1200,
          height: 630,
          max_kb: 2,
        }),
      ],
      { cwd },
    );
    expect(bad.og!.result).toBe('fail');
    expect(bad.og!.evidence).toContain('assets/og/c.png: 800x600, wants 1200x630');
    expect(bad.og!.evidence).toContain('assets/og/big.png: 3 KB, wants at most 2 KB');
    expect(bad.og!.evidence).toContain('assets/og/note.txt: not a PNG or JPEG');
  });

  it('needs a path, a width and a height in whole pixels', () => {
    const spec = (args: Record<string, unknown>) => [
      { kind: 'check' as const, check: 'image-size' as const, args },
    ];
    expect(() => parseDoneWhen(spec({ path: 'a.png', height: 630 }))).toThrow(/needs args\.width/);
    expect(() => parseDoneWhen(spec({ path: 'a.png', width: 1.5, height: 630 }))).toThrow(
      /needs args\.width/,
    );
    expect(() => parseDoneWhen(spec({ path: 'a.png', width: 1, height: 1, max_kb: 'x' }))).toThrow(
      /args\.max_kb must be a number/,
    );
  });
});

describe('char-count urls_as', () => {
  it('counts each http(s) link as the given number of characters', () => {
    const long = `Read it: https://github.com/example/project/blob/main/docs/a-very-long-path.md.`;
    expect(countChars(long)).toBe([...long].length);
    // "Read it: " (9) + 23 for the link + the closing "." (1).
    expect(countChars(long, 23)).toBe(33);
    expect(countChars('a http://x.y b https://z.io/q?x=1', 23)).toBe('a  b '.length + 46);
    expect(countChars('no links here', 23)).toBe(13);
  });

  it('lets an X post with a long link pass at 280', async () => {
    const link = `https://example.com/${'p'.repeat(300)}`;
    const cwd = files({ 'posts/x.md': `Launch day. ${link}\n\n---\n\nSecond post.\n` });
    const args = { path: 'posts/x.md', per: 'block', separator: '---', max: 280 };
    const raw = await runCriteria([check('x', 'char-count', args)], { cwd });
    expect(raw.x!.result).toBe('fail');
    const asX = await runCriteria([check('x', 'char-count', { ...args, urls_as: 23 })], { cwd });
    expect(asX.x).toMatchObject({ result: 'pass' });
    expect(asX.x!.evidence).toContain('the longest 35 characters');
    expect(() =>
      parseDoneWhen([
        { kind: 'check', check: 'char-count', args: { path: 'a', max: 1, urls_as: -1 } },
      ]),
    ).toThrow(/args\.urls_as must be a number/);
  });
});
