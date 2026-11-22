import { describe, expect, it } from 'vitest';
import type { CheckDeps, Criterion, FetchedPage } from '../src/index.js';
import {
  criteriaOf,
  PAGE_MAX_BYTES,
  PAGE_TIMEOUT_MS,
  pageText,
  parseDoneWhen,
  runCriteria,
} from '../src/index.js';
import { tempDir } from './helpers.js';

// W8 phase 3: the `page-contains` check reads the published page, after publishing only. The
// fetcher is injected, so no test reaches the network.

function check(args: Record<string, unknown>): Criterion {
  return criteriaOf(
    parseDoneWhen([{ id: 'page', kind: 'check', check: 'page-contains', args, when: 'publish' }]),
  )[0]!;
}

const PAGE = `<html><head><title>Launch</title><script>var secret = "banned";</script></head>
<body><h1>SwarmUp &amp; friends</h1><p>Read it on <a href="https://github.com/you/swarmup">GitHub</a>.</p></body></html>`;

function fetcher(page: FetchedPage | Error) {
  const seen: Array<{ url: string; timeoutMs: number; maxBytes: number }> = [];
  const fetchPage: NonNullable<CheckDeps['fetchPage']> = async (url, opts) => {
    seen.push({ url, ...opts });
    if (page instanceof Error) throw page;
    return page;
  };
  return { seen, fetchPage };
}

async function run(c: Criterion, deps: Partial<CheckDeps>) {
  const out = await runCriteria([c], {
    cwd: tempDir(),
    phase: 'publish',
    url: 'https://x.com/you/status/1',
    ...deps,
  });
  return out[c.id]!;
}

describe('page-contains', () => {
  it('checks the published URL for wanted and banned strings', async () => {
    const f = fetcher({ status: 200, text: PAGE });
    const r = await run(
      check({
        from: 'published',
        contains: ['SwarmUp & friends', 'github.com/you/swarmup'],
        absent: 'revolutionary',
      }),
      { fetchPage: f.fetchPage },
    );
    expect(r).toEqual({
      result: 'pass',
      evidence:
        'https://x.com/you/status/1 has "SwarmUp & friends", "github.com/you/swarmup"; has none of "revolutionary"',
    });
    expect(f.seen).toEqual([
      { url: 'https://x.com/you/status/1', timeoutMs: PAGE_TIMEOUT_MS, maxBytes: PAGE_MAX_BYTES },
    ]);
  });

  it('fails on a missing or banned string, ignoring case unless asked', async () => {
    const f = fetcher({ status: 200, text: PAGE });
    const r = await run(check({ url: '{url}', contains: ['Missing words'], absent: ['GITHUB'] }), {
      fetchPage: f.fetchPage,
    });
    expect(r.result).toBe('fail');
    expect(r.evidence).toBe('https://x.com/you/status/1 lacks "Missing words"; has "GITHUB"');
    const exact = await run(check({ url: '{url}', absent: ['GITHUB'], 'case-sensitive': true }), {
      fetchPage: f.fetchPage,
    });
    expect(exact.result).toBe('pass');
  });

  it('fails on a bad status, an error, or no published URL, and notes a cut page', async () => {
    const notFound = await run(check({ url: 'https://example.com/a', contains: 'x' }), {
      fetchPage: fetcher({ status: 404, text: '' }).fetchPage,
    });
    expect(notFound).toEqual({ result: 'fail', evidence: 'https://example.com/a answered 404' });
    const down = await run(check({ from: 'published', contains: 'x' }), {
      fetchPage: fetcher(new Error('timed out')).fetchPage,
    });
    expect(down.evidence).toBe('https://x.com/you/status/1: timed out');
    const none = await run(check({ from: 'published', contains: 'x' }), {
      url: undefined,
      fetchPage: fetcher({ status: 200, text: 'x' }).fetchPage,
    });
    expect(none.result).toBe('fail');
    expect(none.evidence).toMatch(/no published URL/);
    const cut = await run(check({ from: 'published', contains: 'Launch' }), {
      fetchPage: fetcher({ status: 200, text: PAGE, truncated: true }).fetchPage,
    });
    expect(cut.result).toBe('pass');
    expect(cut.evidence).toMatch(/only the first 2 MB read/);
  });

  it('never runs at merge, and is refused without when: publish', async () => {
    const f = fetcher({ status: 200, text: PAGE });
    const merge = await runCriteria([check({ from: 'published', contains: 'x' })], {
      cwd: tempDir(),
      fetchPage: f.fetchPage,
    });
    expect(merge).toEqual({});
    expect(f.seen).toEqual([]);
    expect(() =>
      parseDoneWhen([
        { kind: 'check', check: 'page-contains', args: { from: 'published', contains: 'x' } },
      ]),
    ).toThrow(/reads the published page, so it runs only after publishing: add when: publish/);
  });

  it('needs one URL source and something to look for', () => {
    const parse = (args: Record<string, unknown>): unknown =>
      parseDoneWhen([{ kind: 'check', check: 'page-contains', args, when: 'publish' }]);
    expect(() => parse({ contains: 'x' })).toThrow(/needs args.url or args.from/);
    expect(() => parse({ url: 'https://a.b', from: 'published', contains: 'x' })).toThrow(
      /not both/,
    );
    expect(() => parse({ from: 'draft', contains: 'x' })).toThrow(/from must be published/);
    expect(() => parse({ from: 'published' })).toThrow(/needs args.contains or args.absent/);
    expect(() => parse({ from: 'published', contains: [] })).toThrow(/needs args.contains/);
  });

  it('reads a page as text without scripts, tags or entities', () => {
    expect(pageText(PAGE)).toBe(' Launch SwarmUp & friends Read it on GitHub . ');
    expect(pageText('a&#39;b&#x41;&nbsp;&bogus;')).toBe("a'bA &bogus;");
  });
});
