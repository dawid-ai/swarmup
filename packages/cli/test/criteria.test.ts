import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';

// `swarmup new --done-when {YAML}`, `swarmup criteria`, `swarmup criteria check` and the
// per-criterion flags of `swarmup verdict`.

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function repo(): string {
  const d = temp('swarmup-criteria-');
  execFileSync('git', ['init', '-q'], { cwd: d, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: d, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], {
    cwd: d,
    windowsHide: true,
  });
  return d;
}

async function swarmup(
  cwd: string,
  actor: string,
  argv: string[],
  stdin?: string,
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const env = {
    SWARMUP_CONFIG: join(cwd, 'none.yml'),
    SWARMUP_AGENT: actor,
    SWARMUP_STATE_DIR: join(cwd, '.state'),
  } as NodeJS.ProcessEnv;
  const code = await run(argv, {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env,
    cwd,
    ...(stdin !== undefined ? { readStdin: () => stdin } : {}),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function project(): Promise<string> {
  const d = repo();
  await swarmup(d, 'human:dawid', ['init', '--name', 'demo', '--human', 'human:dawid']);
  return d;
}

describe('swarmup new with typed criteria', () => {
  it('takes a criterion in braces, prints the table in show, and notes a task with none', async () => {
    const d = await project();
    const made = await swarmup(d, 'human:dawid', [
      'new',
      'Write the post',
      '--done-when',
      'the intro names the price',
      '--done-when',
      '{id: words, kind: check, check: word-count, args: {path: post.md, max: 900}}',
    ]);
    expect(made.out).toBe('T-0001');
    expect(made.err).toBe('');
    const shown = (await swarmup(d, 'human:dawid', ['show', '1'])).out;
    expect(shown).toContain(
      [
        'done when:',
        '  id     kind   result  what',
        '  c1     prose  -       the intro names the price',
        '  words  check  -       word-count path=post.md max=900',
      ].join('\n'),
    );
    const plain = await swarmup(d, 'human:dawid', ['new', 'Fix it', '--type', 'bug']);
    expect(plain.err).toMatch(/note: T-0002: the task has no checkable criterion/);
    const badKind = await swarmup(d, 'human:dawid', ['new', 'X', '--done-when', '{kind: vibe}']);
    expect(badKind.code).toBe(2);
  });
});

describe('swarmup criteria', () => {
  it('adds and replaces criteria with events, and prints them', async () => {
    const d = await project();
    await swarmup(d, 'human:dawid', ['new', 'Post', '--done-when', 'it reads well']);
    const added = await swarmup(d, 'human:dawid', [
      'criteria',
      '1',
      '--add',
      '{id: faq, kind: check, check: file-exists, args: {path: faq.md}}',
    ]);
    expect(added.code).toBe(0);
    expect(added.out).toContain('  faq  check  -       file-exists path=faq.md');
    const set = await swarmup(
      d,
      'human:dawid',
      ['criteria', '1', '--set-file', '-', '-m', 'only the link check'],
      'done_when:\n  - id: links\n    kind: check\n    check: links-resolve\n    args: {path: post.md}\n',
    );
    expect(set.code).toBe(0);
    const json = JSON.parse((await swarmup(d, 'human:dawid', ['criteria', '1', '--json'])).out) as {
      criteria: { id: string }[];
    };
    expect(json.criteria.map((c) => c.id)).toEqual(['links']);
    const shown = (await swarmup(d, 'human:dawid', ['show', '1'])).out;
    expect(shown).toMatch(/human:dawid +criteria: only the link check/);
  });

  it('runs the command and check criteria, prints and records the results', async () => {
    const d = await project();
    writeFileSync(join(d, 'post.md'), 'See [the FAQ](faq.md).');
    await swarmup(d, 'human:dawid', [
      'new',
      'Post',
      '--done-when',
      'it reads well',
      '--done-when',
      '{id: ok, kind: command, run: node -e "process.exit(0)"}',
      '--done-when',
      '{id: links, kind: check, check: links-resolve, args: {path: post.md}}',
    ]);
    const checked = await swarmup(d, 'human:dawid', ['criteria', 'check', '1']);
    expect(checked.code).toBe(1);
    expect(checked.out).toMatch(/^ok +pass/m);
    expect(checked.out).toMatch(/^links +fail +post\.md: 1 of 1 links do not resolve: faq\.md/m);
    expect(checked.out).not.toMatch(/^c1/m);
    writeFileSync(join(d, 'faq.md'), 'FAQ');
    const again = await swarmup(d, 'human:dawid', ['criteria', 'check', '1']);
    expect(again.code).toBe(0);
    const shown = (await swarmup(d, 'human:dawid', ['show', '1'])).out;
    expect(shown).toContain('  links  check    pass    links-resolve path=post.md');
    expect(shown).toMatch(/criteria-check: Checked 2 criteria in .*: all passed\./);
    const dry = await swarmup(d, 'human:dawid', [
      'criteria',
      'check',
      '1',
      '--no-record',
      '--json',
    ]);
    expect(JSON.parse(dry.out)).toMatchObject({
      ok: { result: 'pass' },
      links: { result: 'pass' },
    });
  });
});

describe('swarmup verdict with criteria', () => {
  async function inReview(): Promise<string> {
    const d = await project();
    await swarmup(d, 'human:dawid', [
      'new',
      'Post',
      '--to',
      'claude:writer',
      '--done-when',
      'the intro names the price',
      '--done-when',
      '{id: angle, kind: human, ask: Is the pricing change clear?}',
    ]);
    await swarmup(d, 'claude:writer', ['start', '1', 'draft']);
    await swarmup(d, 'claude:writer', ['review', '1', 'T-0001: draft in `post.md`, reads fine']);
    return d;
  }

  it('takes --pass and --fail inline, and refuses approve with a fail without --force', async () => {
    const d = await inReview();
    const refused = await swarmup(d, 'human:dawid', [
      'verdict',
      '1',
      'approve',
      'fine',
      '--fail',
      'c1:no price',
    ]);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/approve marks c1 fail/);
    const unknown = await swarmup(d, 'human:dawid', [
      'verdict',
      '1',
      'changes',
      'x',
      '--pass',
      'zz',
    ]);
    expect(unknown.code).toBe(2);
    const sent = await swarmup(d, 'human:dawid', [
      'verdict',
      '1',
      'changes',
      'T-0001: name the price',
      '--fail',
      'c1:the intro has no price',
      '--pass',
      'angle',
    ]);
    expect(sent.code).toBe(0);
    const shown = (await swarmup(d, 'human:dawid', ['show', '1'])).out;
    expect(shown).toContain('  c1     prose  fail    the intro names the price');
    expect(shown).toContain('verdict by human:dawid: the intro has no price');
    expect(shown).toContain('  angle  human  pass    Is the pricing change clear?');
  });

  it('reads --criteria-file from stdin as YAML or JSON', async () => {
    const d = await inReview();
    const res = await swarmup(
      d,
      'human:dawid',
      ['verdict', '1', 'approve', 'T-0001: reads well', '--criteria-file', '-'],
      JSON.stringify({ c1: { result: 'pass', evidence: 'intro, line 1' }, angle: 'pass' }),
    );
    expect(res.code).toBe(0);
    expect(res.err).toBe('');
    const both = await swarmup(d, 'human:dawid', [
      'verdict',
      '1',
      'approve',
      '-',
      '--criteria-file',
      '-',
    ]);
    expect(both.code).toBe(2);
  });
});
