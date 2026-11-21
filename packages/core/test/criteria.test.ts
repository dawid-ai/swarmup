import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  criteriaOf,
  criterionWhat,
  defaultRunCommand,
  doneWhenArg,
  linkTargets,
  parseCriteriaResults,
  parseDoneWhen,
  parsePlan,
  readDoneWhen,
  runCriteria,
} from '../src/index.js';
import type { Criterion } from '../src/index.js';
import { setup, tempDir } from './helpers.js';

// Typed success criteria in `done_when` and per-criterion verdicts. Plain strings stay prose
// criteria, so tasks filed before the types read as before.

describe('parseDoneWhen', () => {
  it('keeps plain strings as prose with position ids, and reads typed objects', () => {
    const entries = parseDoneWhen([
      'npm test passes',
      { id: 'tests', kind: 'command', run: 'pnpm test -- --changed main' },
      { id: 'links', kind: 'check', check: 'links-resolve', args: { path: 'content/post.md' } },
      { id: 'voice', kind: 'rubric', rubric: 'rubrics/brand-voice.md', pass: 0.8 },
      { id: 'angle', kind: 'human', ask: 'Does the intro make the pricing change clear?' },
      { id: 'map', kind: 'map' },
      { kind: 'prose', text: 'no id given' },
    ]);
    expect(entries?.[0]).toBe('npm test passes');
    const criteria = criteriaOf(entries);
    expect(criteria.map((c) => `${c.id}:${c.kind}`)).toEqual([
      'c1:prose',
      'tests:command',
      'links:check',
      'voice:rubric',
      'angle:human',
      'map:map',
      'c7:prose',
    ]);
    expect(criterionWhat(criteria[1]!)).toBe('`pnpm test -- --changed main`');
    expect(criterionWhat(criteria[2]!)).toBe('links-resolve path=content/post.md');
    expect(criterionWhat(criteria[3]!)).toBe('rubrics/brand-voice.md, passes at 0.8');
  });

  it('reads text with one check per line as before', () => {
    expect(parseDoneWhen('- npm test passes\n2. the page loads')).toEqual([
      'npm test passes',
      'the page loads',
    ]);
    expect(parseDoneWhen([' ', ''])).toBeUndefined();
  });

  it('refuses a bad kind, missing fields, bad check args and a duplicate id', () => {
    expect(() => parseDoneWhen([{ kind: 'vibe' }])).toThrow(/kind must be one of/);
    expect(() => parseDoneWhen([{ kind: 'command' }])).toThrow(/run must be text/);
    expect(() => parseDoneWhen([{ kind: 'check', check: 'spellcheck' }])).toThrow(/unknown check/);
    expect(() =>
      parseDoneWhen([{ kind: 'check', check: 'word-count', args: { path: 'a' } }]),
    ).toThrow(/min or args.max/);
    expect(() =>
      parseDoneWhen([{ kind: 'check', check: 'regex', args: { path: 'a', pattern: '(' } }]),
    ).toThrow(/bad pattern/);
    expect(() => parseDoneWhen([{ kind: 'rubric', rubric: 'r.md', pass: 2 }])).toThrow(/0 to 1/);
    expect(() => parseDoneWhen(['a', { id: 'c1', kind: 'map' }])).toThrow(/two done_when criteria/);
  });

  it('reads a hand-edited bad entry as prose instead of failing', () => {
    expect(readDoneWhen(['ok', { kind: 'vibe' }])).toEqual(['ok', '{"kind":"vibe"}']);
  });

  it('takes a --done-when value in braces as YAML, anything else as text', () => {
    expect(doneWhenArg('{id: tests, kind: command, run: npm test}')).toEqual({
      id: 'tests',
      kind: 'command',
      run: 'npm test',
    });
    expect(doneWhenArg('npm test: passes')).toBe('npm test: passes');
  });
});

describe('typed criteria on a task', () => {
  it('round-trips typed criteria through task.md, and settles ids in the view', () => {
    const { as, rootDir } = setup();
    const meta = as('human:dawid').newTask({
      title: 'Write the post',
      doneWhen: [
        'the intro is short',
        { id: 'words', kind: 'check', check: 'word-count', args: { path: 'post.md', max: 900 } },
      ],
    });
    const file = readFileSync(join(rootDir, 'tasks', meta.id, 'task.md'), 'utf8');
    expect(file).toContain('kind: check');
    const v = as('claude:writer').view(meta.id);
    expect(v.meta.done_when?.[1]).toEqual({
      id: 'words',
      kind: 'check',
      check: 'word-count',
      args: { path: 'post.md', max: 900 },
    });
    expect(v.criteria?.map((c) => c.id)).toEqual(['c1', 'words']);
  });

  it('keeps the milestone rule of exactly one criterion, typed or not', () => {
    const { as } = setup();
    const h = as('human:dawid');
    const one = h.newTask({
      title: 'Ship it',
      type: 'milestone',
      doneWhen: [{ id: 'up', kind: 'check', check: 'url-ok', args: { url: 'https://x.invalid' } }],
    });
    expect(one.done_when).toHaveLength(1);
    expect(() =>
      h.newTask({ title: 'Two', type: 'milestone', doneWhen: ['a', { kind: 'map' }] }),
    ).toThrow(/exactly one/);
  });

  it('takes a string or one typed criterion as a plan item done_when', () => {
    const doc = parsePlan(
      YAML.stringify({
        items: [
          { key: 'a', title: 'A', owner: '*:engineer', estimate: '1h', done_when: 'it works' },
          {
            key: 'b',
            title: 'B',
            owner: '*:engineer',
            estimate: '1h',
            done_when: { id: 'tests', kind: 'command', run: 'npm test' },
          },
        ],
      }),
    );
    expect(doc.items[0]!.done_when).toBe('it works');
    expect(doc.items[1]!.done_when).toEqual({ id: 'tests', kind: 'command', run: 'npm test' });
    expect(() =>
      parsePlan(
        YAML.stringify({
          items: [
            { key: 'a', title: 'A', owner: '*:qa', estimate: '1h', done_when: { kind: 'x' } },
          ],
        }),
      ),
    ).toThrow(/kind must be one of/);
  });
});

describe('swarmup new and checkable criteria', () => {
  it('notes work without a checkable criterion, and stays quiet with one', () => {
    const { as } = setup();
    const h = as('human:dawid');
    const plain = h.addTask({ title: 'Fix it', type: 'bug', doneWhen: ['it is fixed'] });
    expect(plain.notes?.[0]).toMatch(/no checkable criterion: add a `command` criterion/);
    const typed = h.addTask({
      title: 'Fix it',
      doneWhen: [{ kind: 'command', run: 'npm test' }],
    });
    expect(typed.notes).toBeUndefined();
    expect(h.addTask({ title: 'An idea', type: 'idea' }).notes).toBeUndefined();
  });

  it('refuses work without one where the root sets require_checkable_criteria', () => {
    const { as, rootDir } = setup();
    const config = join(rootDir, 'config.yml');
    writeFileSync(config, `${readFileSync(config, 'utf8')}require_checkable_criteria: true\n`);
    const h = as('human:dawid');
    expect(() => h.addTask({ title: 'Write docs', type: 'docs' })).toThrow(
      /require_checkable_criteria/,
    );
    const ok = h.addTask({
      title: 'Write docs',
      type: 'docs',
      doneWhen: [{ kind: 'check', check: 'file-exists', args: { path: 'docs/a.md' } }],
    });
    expect(ok.meta.id).toBeTruthy();
    // An agent's proposal is a finding, which the rule leaves alone; nothing is written on a refusal.
    const proposal = as('claude:engineer').addTask({ title: 'Refactor the sync' });
    expect(proposal.meta.type).toBe('finding');
    expect(as('human:dawid').list({ all: true })).toHaveLength(2);
  });
});

describe('the criteria event', () => {
  it('replaces or extends the list, and folds the latest change over task.md', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'Post', owner: 'claude:writer', doneWhen: ['the intro is short'] });
    h.setCriteria(
      '1',
      [{ id: 'words', kind: 'check', check: 'word-count', args: { path: 'p.md', min: 10 } }],
      {
        add: true,
      },
    );
    let v = as('claude:writer').view('1');
    expect(v.criteria?.map((c) => c.id)).toEqual(['c1', 'words']);
    expect(v.meta.done_when).toEqual(['the intro is short']);
    h.setCriteria('1', ['only this now']);
    v = as('claude:writer').view('1');
    expect(v.criteria).toEqual([{ id: 'c1', kind: 'prose', text: 'only this now' }]);
  });

  it('lets only the creator, a person or a PM change them, and keeps a milestone at one', () => {
    const { as } = setup();
    as('human:dawid').newTask({ title: 'Post', owner: 'claude:writer' });
    expect(() => as('claude:writer').setCriteria('1', ['easier check'])).toThrow(
      /changes its criteria/,
    );
    as('human:dawid').newTask({ title: 'Goal', type: 'milestone', doneWhen: ['it ships'] });
    expect(() => as('human:dawid').setCriteria('2', ['more'], { add: true })).toThrow(
      /exactly one/,
    );
  });

  it('drops the results of a criterion that changes, and keeps the others', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({
      title: 'Post',
      doneWhen: [
        { id: 'a', kind: 'prose', text: 'first' },
        { id: 'b', kind: 'prose', text: 'second' },
      ],
    });
    h.recordCriteriaCheck('1', { a: { result: 'pass' }, b: { result: 'fail' } });
    h.setCriteria('1', [
      { id: 'a', kind: 'prose', text: 'first' },
      { id: 'b', kind: 'prose', text: 'second, reworded' },
    ]);
    const v = h.view('1');
    expect(v.criteriaResults?.a?.result).toBe('pass');
    expect(v.criteriaResults?.b).toBeUndefined();
    expect(() => h.recordCriteriaCheck('1', { zz: { result: 'pass' } })).toThrow(
      /no criterion 'zz'/,
    );
  });
});

describe('verdicts with criteria', () => {
  function inReview() {
    const ctx = setup();
    ctx.as('human:dawid').newTask({
      title: 'Post',
      owner: 'claude:writer',
      doneWhen: [
        'the intro names the price',
        { id: 'tests', kind: 'command', run: 'npm test' },
        { id: 'angle', kind: 'human', ask: 'Is the pricing change clear?' },
      ],
    });
    const w = ctx.as('claude:writer');
    w.start('1', 'draft');
    w.review('1', 'T-0001: draft in post.md, `npm test` passed');
    return ctx;
  }

  it('stores results on the verdict and shows each as the last result', () => {
    const { as } = inReview();
    const res = as('human:dawid').verdict('1', 'changes', 'the intro skips the price', undefined, {
      c1: { result: 'fail', note: 'no price in the intro' },
      angle: { result: 'pass' },
    });
    expect(res.events[0]!.criteria?.c1?.result).toBe('fail');
    expect(res.view.criteriaResults?.c1).toMatchObject({ result: 'fail', type: 'verdict' });
    expect(res.view.criteriaResults?.angle?.result).toBe('pass');
  });

  it('refuses an unknown id, and an approval with a failed criterion unless --force', () => {
    const { as } = inReview();
    const h = as('human:dawid');
    expect(() => h.verdict('1', 'approve', 'ok', undefined, { nope: { result: 'pass' } })).toThrow(
      /no criterion 'nope'/,
    );
    expect(() => h.verdict('1', 'approve', 'ok', undefined, { c1: { result: 'fail' } })).toThrow(
      /approve marks c1 fail/,
    );
    const forced = as('human:dawid', { force: true }).verdict(
      '1',
      'approve',
      'ok anyway',
      undefined,
      {
        c1: { result: 'fail' },
      },
    );
    expect(forced.view.status).toBe('done');
    expect(forced.events[0]!.forced).toBe(true);
  });

  it('notes the judged criteria a verdict leaves without a result', () => {
    const { as } = inReview();
    const res = as('human:dawid').verdict('1', 'approve', 'reads well', undefined, {
      c1: { result: 'pass' },
    });
    expect(res.notes?.join('\n')).toMatch(/no result for angle/);
    expect(res.notes?.join('\n')).not.toMatch(/tests/);
  });

  it('reads results as a mapping of id to a word or an object', () => {
    expect(
      parseCriteriaResults({
        criteria: { c1: 'pass', c2: { result: 'FAIL', note: ' x ', score: 0.4 } },
      }),
    ).toEqual({ c1: { result: 'pass' }, c2: { result: 'fail', note: 'x', score: 0.4 } });
    expect(() => parseCriteriaResults({ c1: 'maybe' })).toThrow(/pass, fail or na/);
    expect(() => parseCriteriaResults(['c1'])).toThrow(/mapping/);
  });
});

describe('runCriteria', () => {
  function project(): string {
    const dir = tempDir();
    mkdirSync(join(dir, 'content', 'img'), { recursive: true });
    writeFileSync(
      join(dir, 'content', 'post.md'),
      [
        '---',
        'title: A post with front matter words',
        '---',
        'Pricing changes on Monday. See [the FAQ](faq.md#top), ![a chart](img/chart.png),',
        '[the site](https://example.com/page), [missing](gone.md) and [mail](mailto:a@b.c).',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'content', 'faq.md'), 'FAQ');
    writeFileSync(join(dir, 'content', 'img', 'chart.png'), '');
    writeFileSync(
      join(dir, 'index.html'),
      '<a href="content/faq.md">faq</a> <img src="/content/img/chart.png">',
    );
    return dir;
  }
  const check = (id: string, name: string, args: Record<string, unknown>): Criterion =>
    ({ id, kind: 'check', check: name, args }) as Criterion;

  it('runs file-exists, regex and word-count against files', async () => {
    const cwd = project();
    const r = await runCriteria(
      [
        check('there', 'file-exists', { path: ['content/post.md', 'content/faq.md'] }),
        check('gone', 'file-exists', { path: 'content/nope.md' }),
        check('price', 'regex', { path: 'content/post.md', pattern: 'pricing', flags: 'i' }),
        check('nolorem', 'regex', { path: 'content/post.md', pattern: 'lorem', expect: false }),
        check('long', 'word-count', { path: 'content/post.md', min: 100 }),
        check('short', 'word-count', { path: 'content/post.md', max: 40 }),
        check('nofile', 'word-count', { path: 'content/none.md', max: 40 }),
        { id: 'prose', kind: 'prose', text: 'reads well' },
      ],
      { cwd },
    );
    expect(r.there?.result).toBe('pass');
    expect(r.gone).toEqual({ result: 'fail', evidence: 'missing: content/nope.md' });
    expect(r.price?.result).toBe('pass');
    expect(r.nolorem?.result).toBe('pass');
    expect(r.long?.result).toBe('fail');
    expect(r.long?.evidence).toMatch(/has \d+ words; wants at least 100/);
    expect(r.short?.result).toBe('pass');
    expect(r.nofile).toEqual({ result: 'fail', evidence: 'no file content/none.md' });
    expect(r).not.toHaveProperty('prose');
  });

  it('resolves relative links, skips web links unless url-ok, and checks them through fetch', async () => {
    const cwd = project();
    const asked: string[] = [];
    const fetchStatus = async (url: string): Promise<number> => {
      asked.push(url);
      return url.includes('example.com') ? 404 : 200;
    };
    const r = await runCriteria(
      [
        check('links', 'links-resolve', { path: 'content/post.md' }),
        check('web', 'links-resolve', { path: 'content/post.md', 'url-ok': true }),
        check('html', 'links-resolve', { path: 'index.html' }),
      ],
      { cwd, fetchStatus },
    );
    expect(r.links?.result).toBe('fail');
    expect(r.links?.evidence).toBe('content/post.md: 1 of 3 links do not resolve: gone.md');
    expect(r.web?.evidence).toMatch(
      /2 of 4 links do not resolve: .*example\.com\/page answered 404/,
    );
    expect(r.html).toEqual({ result: 'pass', evidence: 'index.html: 2 links resolve' });
    expect(asked).toEqual(['https://example.com/page']);
  });

  it('passes url-ok on 2xx and 3xx, and fails on other statuses and errors', async () => {
    const statuses: Record<string, number> = { 'https://a.test': 200, 'https://b.test': 301 };
    const fetchStatus = async (url: string, timeoutMs: number): Promise<number> => {
      expect(timeoutMs).toBe(10_000);
      if (url === 'https://down.test') throw new Error('timed out');
      return statuses[url] ?? 500;
    };
    const r = await runCriteria(
      [
        check('ok', 'url-ok', { url: ['https://a.test', 'https://b.test'] }),
        check('bad', 'url-ok', { url: 'https://c.test' }),
        check('down', 'url-ok', { url: 'https://down.test' }),
      ],
      { cwd: tempDir(), fetchStatus },
    );
    expect(r.ok?.result).toBe('pass');
    expect(r.bad).toEqual({ result: 'fail', evidence: 'https://c.test answered 500' });
    expect(r.down).toEqual({ result: 'fail', evidence: 'https://down.test: timed out' });
  });

  it('runs commands through the runner it is given, and map only with a map check', async () => {
    const ran: string[] = [];
    const r = await runCriteria(
      [
        { id: 'ok', kind: 'command', run: 'npm test' },
        { id: 'bad', kind: 'command', run: 'npm run lint' },
        { id: 'map', kind: 'map' },
      ],
      {
        cwd: 'X',
        runCommand: async (command, cwd) => {
          ran.push(`${cwd}:${command}`);
          return command === 'npm test'
            ? { ok: true, output: '9 passed' }
            : { ok: false, output: '2 problems', why: 'exit 1' };
        },
      },
    );
    expect(ran).toEqual(['X:npm test', 'X:npm run lint']);
    expect(r.ok).toEqual({ result: 'pass', evidence: '9 passed' });
    expect(r.bad).toEqual({
      result: 'fail',
      evidence: '2 problems',
      note: '`npm run lint` failed (exit 1)',
    });
    expect(r.map?.result).toBe('na');
    const mapped = await runCriteria([{ id: 'map', kind: 'map' }], {
      cwd: 'X',
      mapCheck: async () => ({ result: 'pass', evidence: 'covered' }),
    });
    expect(mapped.map).toEqual({ result: 'pass', evidence: 'covered' });
  });

  it('runs a real command in a shell with the default runner', async () => {
    const cwd = tempDir();
    const ok = await defaultRunCommand('node -e "console.log(41 + 1)"', cwd);
    expect(ok).toMatchObject({ ok: true });
    expect(ok.output).toContain('42');
    const bad = await defaultRunCommand('node -e "process.exit(3)"', cwd);
    expect(bad).toMatchObject({ ok: false, why: 'exit 3' });
  });

  it('finds Markdown, reference and HTML link targets', () => {
    expect(
      linkTargets('[a](x.md "t") ![b](<y.png>)\n[ref]: ./r.md\n<a href="h.html">h</a>'),
    ).toEqual(['x.md', 'y.png', './r.md', 'h.html']);
  });
});
